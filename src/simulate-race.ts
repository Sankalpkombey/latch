import Redis from "ioredis";
import { acquireLock } from "./lock";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

let highestToken = 0;
const criticalSection: string[] = [];

function protectedWrite(workerlabel: string, fencingToken: number) {
    if (fencingToken > highestToken) {
        highestToken = fencingToken;
        criticalSection.push(workerlabel);
        console.log(`Worker ${workerlabel} did its work`);
    } else {
        console.log(`Worker ${workerlabel} was denied access to the critical section`);
    }
}

async function workerA(redis: Redis){
    const lock = await acquireLock(redis, "test-key", 2000)
    console.log("Worker A acquired:", lock);

    await delay(4000);

    
    protectedWrite("A", lock?.fencingToken ?? 0);
    console.log("Worker A did its work (think it still owns the lock)")
}

async function workerB(redis: Redis) {
    
    await delay(2500);
    const lock = await acquireLock(redis, "test-key", 2000)
    console.log("Worker B did its work");

    if(lock) {
        protectedWrite("B", lock.fencingToken);
        console.log("Worker B did its work");
    }
}

async function main(){
    const redis = new Redis(6379);

    try{
    const promise1 = workerA(redis);
    const promise2 = workerB(redis);
    const [result1, result2] = await Promise.all([promise1, promise2]);

    console.log(result1, result2)
    } catch(error){
        console.error('Error fetching data:', error)
    }

    console.log("Final critical section:", criticalSection);
    await redis.quit()
}

main();