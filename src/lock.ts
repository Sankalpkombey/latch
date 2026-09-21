import Redis from "ioredis";
import { randomBytes } from "crypto";
import { performance } from "node:perf_hooks";

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

export interface Watchdog {
    stop: () => void;
    isLost: () => boolean;
    lastError: () => Error | null;
}

export interface WatchdogOptions {
    maxAttempts?: number;
    retryBaseMs?: number;
    expireBufferMs?: number;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export function startWatchdog(
    redis: Redis, 
    lock: Lock, 
    ttlMs: number,
    options: WatchdogOptions = {}
): Watchdog {
    const maxAttempts = options.maxAttempts ?? 3;
    const retryBaseMs = options.retryBaseMs ?? 50;
    const bufferMs = options.expireBufferMs ?? Math.min(ttlMs / 4, 250);

    let stopped = false;
    let lost = false;
    let lastError: Error | null = null;
    let timer: NodeJS.Timeout | null = null;

    let deadline = performance.now() + ttlMs;

    const stop = () => {
        stopped = true;
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const schedule = () => {
        if (stopped) return;
        const untilDeadline = deadline - bufferMs - performance.now();
        timer = setTimeout(tick, Math.max(1, Math.min(ttlMs / 2, untilDeadline)));
    };

    const tick = async() =>{
        timer = null;
        if (stopped) return;

        let attempts = 0;

        for(;;) {
            if (stopped) return;

            try {
                const extended = await extendLock(redis, lock, ttlMs);
                if(extended) {
                    deadline = performance.now() + ttlMs;
                    schedule();
                    return;
                }
                if(!stopped) {
                    lost = true;
                }
                stop();
                return;

            } catch(err) {
                lastError = err instanceof Error ? err : new Error(String(err))
            }

            attempts += 1;

            const remainingMs = deadline - performance.now();

            if (remainingMs <= bufferMs) {
                if(!stopped) {
                    lost = true;
                }
                stop();
                return;
            }

            if (attempts >= maxAttempts){
                schedule();
                return;
            }
            
            await sleep(Math.min(retryBaseMs * 2 ** (attempts - 1), remainingMs / 2));
       }
    };
    
    schedule();

    return {
        stop,
        isLost: () => lost,
        lastError: () => lastError
    };
}