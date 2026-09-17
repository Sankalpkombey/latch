import Redis from "ioredis"
import { acquireLock, releaseLock, startWatchdog } from "./lock"

/* async function main() {
    const redis = new Redis(6379);

    const lock = await acquireLock(redis, "test-key", 1500);
    console.log("Acquired", lock);

    if(lock) {
        const released = await releaseLock(redis, lock);
        console.log("Released:", released);
    }

    if(lock) {
        const releaseAgain = await releaseLock(redis, lock);
        console.log("Released again (should be false):", releaseAgain);
    } 

    if(lock){
        const watchdog = startWatchdog(redis, lock, 4000)

        clearInterval(watchdog)
        await releaseLock(redis, lock);
    }

    await redis.quit();
}

main(); */

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(){
    const redis = new Redis(6379);

    const lock = await acquireLock(redis, "some-key", 1500);
    console.log("Acquired:", lock);

    if(lock) {
        
        const watchdog = startWatchdog(redis, lock, 1500);
    
        await delay(2500);

        const currentValue = await redis.get(lock.key);
        console.log("Still alive after original TTL would've expired:", currentValue === lock.token);

        clearInterval(watchdog)
        await releaseLock(redis, lock);
    }

    await redis.quit();
}

main();