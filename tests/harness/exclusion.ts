import {spawn, ChildProcess} from "child_process";
import path from "path";
import Redis from "ioredis";

interface WorkerReport {
    worker: "A" | "B";
    acquired: boolean;
    fencingToken: number | null;
    attemptedAt: number;
    acquiredAt: number | null;
    releasedAt: number | null;
    pttlAtAttempt: number | null;  // only meaningful when acquired == false
}

interface WorkerConfig {
    role: "A" | "B";
    key: string;
    ttlMs: number;
    delayBeforeAttemptMs: number | null;  // null = don't wait for the key (role A creates it);
    holdDurationMs: number;
}

const live = new Set<ChildProcess>();

process.on("exit", () => {
    for (const child of live) child.kill("SIGKILL");
});

function runWorker(config: WorkerConfig, timeoutMs = 15000): Promise<WorkerReport> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ["--import", "tsx", path.join(__dirname, "worker.ts"), JSON.stringify(config)],
            { stdio: ["ignore", "pipe", "pipe"] }
        );
        live.add(child);

        let output = "";
        let errors = "";
        let settled = false;

        const settle = (fn: (arg: any) => void, arg: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            live.delete(child);
            fn(arg);
        };

        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            settle(reject, new Error(`Worker ${config.role} timed out after ${timeoutMs}ms\n${errors}`));
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
            output += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
            errors += chunk.toString();
        });

        child.on("error", (err) => settle(reject, err));

        child.on("close", (code) => {
            if (code !== 0) {
                settle(reject, new Error(`Worker ${config.role} exited with code ${code}\n${errors}`));
                return;
            }
            try {
                settle(resolve, JSON.parse(output));
            } catch (err) {
                settle(reject, new Error(`bad JSON output from worker ${config.role}: ${err}\nstdout: ${output}\nstderr: ${errors}`));
            }
        });
    });
}

const redis = new Redis(6379);

// Same reason as in worker.ts: without a listener, ioredis reconnect attempts surface
// as unhandled error events and flood stderr.
let redisErrorReported = false;
redis.on("error", (err) => {
    if (redisErrorReported) return;
    redisErrorReported = true;
    console.error(`[harness] redis error: ${err.message}`);
});

async function setup(key: string) {
    await redis.del(key);
    const exists = await redis.exists(key);
    if (exists !== 0) throw new Error(`Failed to delete key ${key} during setup`);
}

async function teardown() {
    await redis.quit();
}

async function runExclusionTest() {
    const key = "exclusion-test-key";
    const ttlMs = 2000;

    await setup(key);

    const [resA, resB] = await Promise.allSettled([
        runWorker({
            role: "A",
            key,
            ttlMs,
            delayBeforeAttemptMs: null,
            holdDurationMs: 3000,
        }),
        runWorker({
            role: "B",
            key,
            ttlMs,
            delayBeforeAttemptMs: 2200,
            holdDurationMs: 0,
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
