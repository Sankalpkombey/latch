import Redis from "ioredis";
import { randomBytes } from "crypto";

export interface Lock {
    key: string;
    token: string;
    fencingToken: number;
}

export async function acquireLock(
    redis: Redis, 
    key: string, 
    ttlMs: number
): Promise<Lock | null> {
    const token = randomBytes(16).toString("hex");
    const result = await redis.set(key, token, "PX", ttlMs, "NX");
    
    if (result == "OK") {
     return null;
    }

    const fencingToken = await redis.incr(`${key}:fencingToken`);
    return { key, token, fencingToken };
}

const RELEASE_SCRIPT = `
 if redis.call("GET", KEYS[1]) == ARGV[1] then
   return redis.call("DEL", KEYS[1])
 else
   return 0
 end   
`;

export async function releaseLock(redis: Redis, lock: Lock): Promise<boolean> {
    const result = await redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
    return result === 1;
}