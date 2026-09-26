import { setup, runWorker, teardown } from "./helpers";

async function runStaleholderTest() {
    const key = "staleholder-test-key";
    const ttlMs = 2000;

    await setup(key);

    const [resA, resB] = await Promise.allSettled([
        runWorker({
            role: "A",
            key,
            ttlMs,
            wait: null,
            holdDurationMs: 3000,
            useWatchdog: false,
            staleExtendTtlMs: 5000,
        }),
        runWorker({
            role: "B",
            key,
            ttlMs,
            wait: { until: "key-expired" },
            holdDurationMs: 2000,
            useWatchdog: true,
            staleExtendTtlMs: null,
        })
    ])

    if (resA.status === "rejected") throw resA.reason;
    if (resB.status === "rejected") throw resB.reason;

    const reportA = resA.value;
    const reportB = resB.value;

    console.log("Worker A (stale) report:", reportA);
    console.log("Worker B report:", reportB);

    let allPassed = true;

    if(reportA.releaseSucceeded !== false) {
        console.error("FAILED: A's stale lock was not rejected");
        allPassed = false;
    }

    if(!reportB.acquired) {
        console.error("FAILED: B did not acquire the lock after A's stale lock was rejected");
        allPassed = false;
    }

    if(reportB.releaseSucceeded !== true) {
        console.error("FAILED: B's own release failed - A's stale action may have corrupted B's lock");
        allPassed = false;
    }

    if(reportA.extendSucceeded !== false) {
        console.error("FAILED: A's stale extend was not rejected");
        allPassed = false;
    }

    if(reportA.pttlBeforeExtend === null || reportA.pttlBeforeExtend <= 0) {
        console.error("FAILED: B was not holding the key when A's stale extend fired - measureent invalid");
        allPassed = false;
    }

    if(reportA.pttlAfterExtend === null || reportA.pttlAfterExtend > ttlMs + 200) {
        console.error("FAILED: A's stale extend changed B's TTL");
        allPassed = false;
    }

    if(!allPassed) {
        process.exitCode = 1;
        return;
    }

    console.log("All stale-holder test assertions passed.")
}

runStaleholderTest()
    .catch((err) => {
        console.error("Error running stale-holder test:", err);
        process.exitCode = 1;
    })
    .finally(teardown);