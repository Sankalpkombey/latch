import Redis from "ioredis";
import { acquireLock, startWatchdog } from "../../src/lock";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testDefiniteLoss(redis: Redis, theif: Redis) {
    const key = "loss-test-definite";
    await redis.del(key);

    const lock = await acquireLock(redis, key, 2000);
    if (!lock) throw new Error("setup failed");

    const watchdog = startWatchdog(redis, lock, 2000);

    await sleep(1200);

    await theif.set(key, "not-yours");

    await sleep(1200);

    const lost = watchdog.isLost();
    const err = watchdog.lastError();
    watchdog.stop();

    if (lost !== true) throw new Error(`FAILED definite-loss: islost() was ${lost}, expected true`);
    if (err !== null) throw new Error(`FAILED definite-loss: lastError() was ${err?.message}, expected null`)

    console.log("PASSED: definite-loss case");    
}

async function testCleanRelease(redis: Redis) {
    const key = "loss-test-clean";
    await redis.del(key);

    const lock = await acquireLock(redis, key, 2000);
    if (!lock) throw new Error("setup failed");

    const watchdog = startWatchdog(redis, lock, 2000);
    await sleep(1200);

    const beforeStop = watchdog.isLost();
    watchdog.stop();
    const afterStop = watchdog.isLost();

    if (beforeStop !== false) throw new Error(`FAILED clean-release: islost() before stop was ${beforeStop}`);
    if (afterStop !== false) throw new Error(`FAILED clean-release: isLost() after stop was ${afterStop}`);

    console.log("PASSED: clean-release case");
}

function createSlowEvalRedis(realRedis: Redis, slowEvalMs: number): Redis {
    return new Proxy(realRedis, {
        get(target, prop, receiver) {
            if(prop == "eval") {
                return async (...args: any[]) => {
                    await sleep(slowEvalMs);
                    return (target.eval as any)(...args);
                };
            }
            return Reflect.get(target, prop, receiver);
        }
    }) as Redis;
}
    
async function testStopWinsRace(realRedis: Redis) {
    const key = "loss-test-race";
    await realRedis.del(key);
    const ttlms = 2000;
    const slowEvalMs = 1500;

    const slowRedis = createSlowEvalRedis(realRedis, slowEvalMs);

    const lock = await acquireLock(realRedis, key, ttlms);
    if (!lock) throw new Error("setup failed");

    const watchdog = startWatchdog(slowRedis, lock, ttlms);

    await sleep(1200);
    watchdog.stop();

    // Must outlast firstTick (~1000) + slowEvalMs (1500) - stopTime (1200) = 1300ms,
    // otherwise we sample before the in-flight tick resolves and prove nothing.
    await sleep(1500);

    const lost = watchdog.isLost();
    if (lost !== false) throw new Error(`FAILED stop-wins-race: isLost() was ${lost}, expected false`);

    console.log("PASSED: stop-wins-race case");
}

async function main() {
    const redis = new Redis(6379);
    const theif = new Redis(6379);

    try {
        await testCleanRelease(redis);
        await testDefiniteLoss(redis, theif);
        await testStopWinsRace(redis)
        console.log("All loss-path assertions passed");
    } catch (err) {
        console.error(err);
        process.exitCode = 1;
    } finally {
        await redis.quit();
        await theif.quit();
    }
}

main()