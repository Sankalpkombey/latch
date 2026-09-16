import Redis from "ioredis"
import { acquireLock, releaseLock } from "./lock"

async function main() {
    const redis = new Redis(6379);

    const lock = await acquireLock(redis, "test-key", 5000);
    console.log("Acquired", lock);

    if(lock) {
        const released = await releaseLock(redis, lock);
        console.log("Released:", released);
    }

    if(lock) {
        const releaseAgain = await releaseLock(redis, lock);
        console.log("Released again (should be false):", releaseAgain);
    }

    await redis.quit();
}

main();