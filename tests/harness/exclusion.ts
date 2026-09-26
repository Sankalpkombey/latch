import { setup, teardown, runWorker } from "./helpers";

async function runExclusionTest() {
    const key = "exclusion-test-key";
    const ttlMs = 2000;

    await setup(key);

    const [resA, resB] = await Promise.allSettled([
        runWorker({
            role: "A",
            key,
            ttlMs,
            wait: null,
            holdDurationMs: 3000,
            useWatchdog: true,
            staleExtendTtlMs: null,
        }),
        runWorker({
            role: "B",
            key,
            ttlMs,
            wait: { until: "key-exists", thenMs: 2200 },
            holdDurationMs: 0,
            useWatchdog: true,
            staleExtendTtlMs: null,
        }),
    ]);

    if (resA.status === "rejected") throw resA.reason;
    if (resB.status === "rejected") throw resB.reason;

    const reportA = resA.value;
    const reportB = resB.value;

    console.log("Worker A report:", reportA);
    console.log("Worker B report:", reportB);

    let allPassed = true;

    if(!(reportA.acquired && !reportB.acquired)) {
        console.error("FAILED: exclusion");
        allPassed = false;
    }

    if(!(reportB.pttlAtAttempt !== null && reportB.pttlAtAttempt > 0)) {
        console.error("FAILED: pttlAtAttempt");
        allPassed = false;
    }

    if(reportA.acquiredAt !== null && reportB.attemptedAt < reportA.acquiredAt) {
        console.error("FAILED: attemptedAt < acquiredAt");
        allPassed = false;
    }

    if(reportA.releasedAt !== null && reportB.attemptedAt > reportA.releasedAt) {
        console.error("FAILED: attemptedAt > releasedAt");
        allPassed = false;
    }

    if(!allPassed) {
        process.exitCode = 1;
        return;
    }

    console.log("All exclusion test assertions passed.");
}

runExclusionTest()
    .catch((err) => {
        console.error("Error during exclusion test:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await teardown();
        } catch (err) {
            console.error("Error during teardown:", err);
            process.exitCode = 1;
        }
    });