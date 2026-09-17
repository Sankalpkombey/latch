import Redis from "ioredis";
import { randomBytes } from "crypto";

export interface Lock {
    key: string;
    token: string;
    fencingToken: number;
}

const ACQUIRE_SCRIPT = `
 if redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2], "NX") then
   return redis.call("INCR", KEYS[2])
 else
   return false
 end
`;

export async function acquireLock(
    redis: Redis, 
    key: string, 
    ttlMs: number
): Promise<Lock | null> {
    const token = randomBytes(16).toString("hex");
    const fencingToken = await redis.eval(
        ACQUIRE_SCRIPT, 2, key, `${key}:fencingToken`, token, ttlMs
    );

    if (fencingToken === null) {
        return null;
    }

    return { key, token, fencingToken: Number(fencingToken) };
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

const EXTEND_SCRIPT = `
 if redis.call("GET", KEYS[1]) == ARGV[1] then
   return redis.call("PEXPIRE", KEYS[1], ARGV[2])
 else
   return 0
 end   
`;

export async function extendLock(
    redis: Redis, 
    lock: Lock, 
    ttlMs: number
): Promise<boolean> {
    const result = await redis.eval(EXTEND_SCRIPT, 1, lock.key, lock.token, ttlMs)
    return result === 1
}

export function startWatchdog(redis: Redis, lock: Lock, ttlMs: number): NodeJS.Timeout{
    const interval = setInterval(async() => {
        const extended = await extendLock(redis, lock, ttlMs);
        if(!extended){
            clearInterval(interval);
        }
    }, ttlMs / 2);

    return interval;
}