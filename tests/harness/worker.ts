import Redis from "ioredis";
import { acquireLock, releaseLock, startWatchdog } from "../../src/lock";

interface WorkerConfig {
    role: "A" | "B";
    key: string;
    ttlMs: number;
    delayBeforeAttemptMs: number | null;  // null = don't wait for the key (role A creates it);
    holdDurationMs: number;
}

interface WorkerReport {
    worker: "A" | "B";
    acquired: boolean;
    fencingToken: number | null;
    attemptedAt: number;
    acquiredAt: number | null;
    releasedAt: number | null;
    pttlAtAttempt: number | null;  // only meaningful when acquired == false
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilKeyExists(redis: Redis, key: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pttl = await redis.pttl(key);
        if (pttl > 0) return;  // key exists and has life left
        await sleep(20);       // poll every 20ms
    }
    throw new Error(`key ${key} never appeared within ${timeoutMs}ms - did A acquire?`);
}

async function main() {
    const config: WorkerConfig = JSON.parse(process.argv[2]);
    const redis = new Redis(6379);

    // ioredis emits 'error' on every reconnect attempt, and without a listener Node
    // treats it as unhandled and floods stderr. Report only the first, so the parent's
    // failure message carries one useful line instead of forty.
    let redisErrorReported = false;
    redis.on("error", (err) => {
        if (redisErrorReported) return;
        redisErrorReported = true;
        console.error(`[worker ${config.role}] redis error: ${err.message}`);
    });

    const report: WorkerReport = {
        worker: config.role,
        acquired: false,
        fencingToken: null,
        attemptedAt: 0,
        acquiredAt: null,
        releasedAt: null,
        pttlAtAttempt: null,
    };

    if (config.delayBeforeAttemptMs !== null) {
        await pollUntilKeyExists(redis, config.key, 5000);
        await sleep(config.delayBeforeAttemptMs);
    }

    report.attemptedAt = Date.now();
    const lock = await acquireLock(redis, config.key, config.ttlMs);

    if(lock) {
        report.acquired = true;
        report.fencingToken = lock.fencingToken;
        report.acquiredAt = Date.now();

        const watchdog = startWatchdog(redis, lock, config.ttlMs);

        await new Promise((resolve) => setTimeout(resolve, config.holdDurationMs));

        watchdog.stop();
        await releaseLock(redis, lock);
        report.releasedAt = Date.now();

    } else {
        report.pttlAtAttempt = await redis.pttl(config.key);
    }

    await redis.quit();
    console.log(JSON.stringify(report));
}

main().catch((err) => {
    console.error(`[worker] fatal: ${err instanceof Error ? err.message : String(err)}`);
    // An open ioredis client would hold the event loop open, so exit rather than hang.
    process.exit(1);
});
