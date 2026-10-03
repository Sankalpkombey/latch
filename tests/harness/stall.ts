import { redis, setup, runWorker, teardown } from "./helpers";

const RESOURCE = "stall-test-log";

/**
 * CHARACTERIZATION TEST - it deliberately asserts that the safety violation happens.
 *
 * A blocks its own event loop past its TTL, so its watchdog can never tick and its lock
 * expires. B takes over. A then resumes, still believing it holds the lock, and its write
 * lands anyway. Phase 4's fencing consumer at the resource is what reverses this: once the
 * resource rejects stale tokens, A's entry must disappear from the log and the writers
 * assertion below must be inverted.
 */
async function testStallCharacterization() {
    const key = "stall-test-lock";
    const ttlMs = 2000;

    await setup(key);
    await redis.del(RESOURCE);

    const [resA, resB] = await Promise.allSettled([
        runWorker({
            role: "A",
            key,
            ttlMs,
            wait: null,
            holdDurationMs: 0,
            useWatchdog: true,
            staleExtendTtlMs: null,
            blockAfterAcquireMs: 3000,
            resourceKey: RESOURCE,
        }),
        runWorker({
            role: "B",
            key,
            ttlMs,
            wait: { until: "key-expired" },
            holdDurationMs: 2500,
            useWatchdog: true,
            staleExtendTtlMs: null,
            blockAfterAcquireMs: null,
            resourceKey: RESOURCE,
        })
    ])

    if (resA.status === "rejected") throw resA.reason;
    if (resB.status === "rejected") throw resB.reason;

    const reportA = resA.value;
    const reportB = resB.value;
    const log = await redis.lrange(RESOURCE, 0, -1);

    console.log("Worker A report:", reportA);
    console.log("Worker B report:", reportB);

    let allPassed = true;

    if(reportA.lostRightAfterBlock !== false) {
        console.error("FAILED: isLost() was not read synchronously after the block - the watchdog should still be blind here");
        allPassed = false;
    }

    if(reportA.lostLater !== true) {
        console.error("FAILED: the overdue tick never ran after the block - the watchdog should notice the loss late");
        allPassed = false;
    }

    if(!reportB.acquired) {
        console.error("FAILED: B never acquired the lock after A's stall - the scenario did not run");
        allPassed = false;
    }

    // CHARACTERIZATION: the lock failed to exclude A's stale write. B writes on entering
    // its critical section, A writes only after unblocking, so B must come first.
    const writers = log.map((entry) => entry.split(":")[0]);
    if(writers.length !== 2 || writers[0] !== "B" || writers[1] !== "A") {
        console.error(`FAILED: expected the resource to show B then A's stale write, got ${JSON.stringify(writers)}`);
        allPassed = false;
    }

    if(!allPassed) {
        process.exitCode = 1;
        return;
    }

    console.log("All stall characterization assertions passed (the violation above is expected).");
    console.log("Resource log:");
    for (const entry of log) {
        console.log("  " + entry);
    }
}

testStallCharacterization()
    .catch((err) => {
        console.error("Test failed with error:", err);
        process.exitCode = 1;
    })
    .finally(teardown);
