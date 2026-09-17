import assert from "node:assert/strict";
import { test } from "node:test";
import Redis from "ioredis";
import { acquireLock } from "./lock";

test("test runner executes TypeScript", () => {
    assert.equal(typeof acquireLock, "function");
});

test("Redis is reachable on 6379", async () => {
    const redis = new Redis(6379, { lazyConnect: true, retryStrategy: () => null });
    try {
        assert.equal(await redis.ping(), "PONG");
    } finally {
        redis.disconnect();
    }
});
