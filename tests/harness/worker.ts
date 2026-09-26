import Redis from "ioredis";
import { acquireLock, releaseLock, extendLock, startWatchdog } from "../../src/lock";
import type { WorkerConfig, WorkerReport } from "./helpers";

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

// Waits for the current holder's lock to expire: the key must first appear, then go away.
// Waiting only for absence would race the holder's own acquire.
async function pollForKeyToExpire(redis: Redis, key: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await redis.pttl(key) > 0) break;
        await sleep(20);
    }

    while (Date.now() < deadline) {
        if (await redis.pttl(key) <= 0) return;
        await sleep(20);
    }

    throw new Error(`key ${key} never expired within ${timeoutMs}ms`);
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
        token: null,
        attemptedAt: 0,
        acquiredAt: null,
        releasedAt: null,
        pttlAtAttempt: null,
        releaseSucceeded: null,
        pttlBeforeExtend: null,
        extendSucceeded: null,
        pttlAfterExtend: null,
    };

    if (config.wait !== null) {
        if (config.wait.until === "key-exists") {
            await pollUntilKeyExists(redis, config.key, 5000);
            await sleep(config.wait.thenMs);
        } else {
            await pollForKeyToExpire(redis, config.key, 5000);
        }
    }

    report.attemptedAt = Date.now();
    const lock = await acquireLock(redis, config.key, config.ttlMs);

    if(lock) {
        report.acquired = true;
        report.fencingToken = lock.fencingToken;
        report.token = lock.token;
        report.acquiredAt = Date.now();

        if (config.useWatchdog) {
            const watchdog = startWatchdog(redis, lock, config.ttlMs);
            await sleep(config.holdDurationMs);
            watchdog.stop();
        } else {
            await sleep(config.holdDurationMs);
        }

        if(config.staleExtendTtlMs !==null) {
            report.pttlBeforeExtend = await redis.pttl(config.key);
            report.extendSucceeded = await extendLock(redis, lock, config.staleExtendTtlMs);
            report.pttlAfterExtend = await redis.pttl(config.key);
        }

        const released = await releaseLock(redis, lock);
        report.releaseSucceeded = released;
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