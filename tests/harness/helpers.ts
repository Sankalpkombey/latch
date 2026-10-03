import {spawn, ChildProcess} from "child_process";
import path from "path";
import Redis from "ioredis";

export interface WorkerReport {
    worker: "A" | "B";
    acquired: boolean;
    fencingToken: number | null;
    token: string | null;
    attemptedAt: number;
    acquiredAt: number | null;
    releasedAt: number | null;
    pttlAtAttempt: number | null;  // only meaningful when acquired == false
    releaseSucceeded: boolean | null;  // only meaningful when acquired == true
    pttlBeforeExtend: number | null;
    extendSucceeded: boolean | null;
    pttlAfterExtend: number | null;
    lostRightAfterBlock: boolean | null;
    wroteAt: number | null;
    lostLater: boolean | null;
}

export type AcquireWait =
    | null                                        // don't wait: this worker creates the key
    | { until: "key-exists"; thenMs: number }     // wait for the key to exist, then wait this long
    | { until: "key-expired" };                   // wait for the key to appear, then for it to expire

export interface WorkerConfig {
    role: "A" | "B";
    key: string;
    ttlMs: number;
    wait: AcquireWait;
    holdDurationMs: number;
    useWatchdog: boolean;  // default: true
    staleExtendTtlMs: number | null;  // extend after the hold
    blockAfterAcquireMs: number | null;  // block after acquiring the lock
    resourceKey: string | null;
}

const redis = new Redis(6379);

let redisErrorReported = false;
redis.on("error", (err) => {
    if (redisErrorReported) return;
    redisErrorReported = true;
    console.error(`[harness] redis error: ${err.message}`);
});

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

async function setup(key: string) {
    await redis.del(key);
    const exists = await redis.exists(key);
    if (exists !== 0) throw new Error(`Failed to delete key ${key} during setup`);
}

async function teardown() {
    await redis.quit();
}

export { setup, runWorker, teardown, redis, live };