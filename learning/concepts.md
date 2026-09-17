# Concepts

Record durable understanding, not every definition encountered.

## 2026-09-17: Lock renewal is liveness, not a safety guarantee

- **Learner's explanation:** "case B has died because the watchdog started at t=1200, first tick happened at 1950 and after the original ttl the lock is unrecoverable."
- **Corrected understanding:** Correct on the facts, with two precisions. (1) It is the *renewal* that is unrecoverable, not the lock — the key can be re-created by a fresh `SET NX`, but that is a new acquisition, never a restoration of the old ownership. (2) The mechanism is the compare gate closing: the renewal script runs `GET` on a key that no longer exists, Redis returns nil, `nil == ARGV[1]` is false, so it returns `0` and `PEXPIRE` is never reached. This is deliberate — the script only ever calls `PEXPIRE`, which cannot create a key, and the token compare stops it extending a key that has since become someone else's.
- **General rule:** the chain survives only while `startDelay + interval + (delay of any single tick) < ttl`. The shared slack budget is `ttl - interval - startDelay`; a late start and a late tick spend from the same pool. Once expiry happens before a successful renewal, no later renewal can recover it.
- **Example:** `acquireLock(key, 1500)` → key dies at t=1500. Watchdog started at t=0 → ticks at 750/1500/2250, chain holds, sample at t=3700 reads `true`. Watchdog started at t=1200 → first tick at 1950, 450ms too late, sample reads `false`. Identical code, identical matching TTL; only the start time differs.
- **Related concepts:** headroom per tick = `ttl - interval`; ownership loss must be surfaced to the caller; fencing tokens are the only defence when the process *stalls* rather than merely runs slow.

## 2026-09-17: Fencing-token order is fixed by making acquisition atomic

- **Learner's explanation:** "in new code there is no round trips w1 acquires, then stalls and then W2 acquires, W1 resumes to write but has lower token so it simply rejects."
- **Corrected understanding:** Correct on the ordering, with two tightenings. (1) It is still *one* round trip — what the change removed is the *gap between two* round trips, which is where the hazard lived. Winning the lock and being assigned a number are now the same atomic step, so no other acquire can interleave between them. (2) "…so it simply rejects" holds only if the guarded resource compares tokens. Nothing validates `fencingToken` today — `simulate-race.ts` checks it in-process, but a real stale writer would currently be believed. Correct token *ordering* is necessary but not sufficient; enforcement happens at the resource, in Phase 4.
- **Why the old code was broken:** with `SET` and `INCR` as separate round trips, W1 could win the lock, stall *before* the `INCR`, let the lock expire, and then increment after W2 had acquired — receiving a **higher** token than the client actually holding the lock, which is backwards and defeats fencing entirely.
- **Property now held:** token order equals acquisition order at Redis, by construction.
- **Example:** probe against Redis — the blocked second acquire returns `null` and leaves the counter at `1`, so a failed acquire never consumes a token; after release the next acquire takes `2`. `pttl` on the held key reads `4995`.
- **Related concepts:** atomicity is about the gap, not the round-trip count; monotonicity is now *atomic* but not *durable* (eviction under `allkeys-lru`, or a failover, can restart the counter at 1).
