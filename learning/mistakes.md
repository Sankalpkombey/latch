# Mistakes

Record meaningful bugs or recurring misconceptions. Preserve the original reasoning.

## 2026-09-17: Assertion sampled before the original TTL, so it could not fail

- **Problem:** The renewal test printed `true` while the watchdog was effectively doing nothing useful.
- **Mistake:** Reduced the observation delay to 1200ms while the lock's original TTL was 1500ms, so the sample landed *before* the original expiry. The key was alive on its own TTL, with no renewal required.
- **Original mental model:** "Sampling at some point after starting the watchdog checks whether renewal worked."
- **Correct mental model:** The sample must fall strictly between the original deadline and the renewed deadline: `originalTTL < sampleTime < currentDeadline`. Otherwise a boolean cannot distinguish "renewal worked" from "we looked too early."
- **Evidence:** With no watchdog at all — `SET ... PX 1500 NX`, sample at t=1200 → `true` (PTTL 290); sample at t=1700 → `false` (PTTL -2). The 1200ms sample passes with zero renewals.
- **Category:** Testing / verification design
- **Prevention:** Assert on `PTTL`, not existence. At t=1200 a healthy renewal reads ≈1050ms while no renewal reads 290ms — PTTL separates the two cases the boolean collapses into `true`. Write the expected timeline into the test so the sample point can be checked against it.
- **Follow-up exercise:** Make the assertion fail when the watchdog is disabled. Then add a second process as a competing worker so the test covers exclusion, not merely survival.

## 2026-10-03: A test that cannot fail still reports success

- **Problem:** `testCleanRelease` in `tests/harness/loss.ts` passed on every run while proving nothing. It stopped the watchdog at a moment when no tick was in flight, then sampled `isLost()` immediately — so no code path could ever have set the flag.
- **Mistake:** Treating a green run as evidence. Both of its assertions (`isLost()` false before and after `stop()`) hold whether or not the `if (!stopped)` guard exists in `startWatchdog`.
- **Original mental model (as the code implied):** a clean stop is enough to exercise the stop-vs-theft guard.
- **Correct mental model:** A test covers a branch only if something reaching that branch can change the outcome. To exercise the `if (!stopped)` guard a tick must be provably **in flight** when `stop()` runs, so its `false` resolution lands *after* the stop. `testStopWinsRace` achieves that with a slow-`eval` proxy; `testCleanRelease` did not, making it a weaker duplicate of a scenario already covered.
- **Evidence:** Deleting the `if (!stopped)` guard left `testCleanRelease` green. The removal is safe precisely because `testStopWinsRace` covers the strictly stronger case — a clean stop *with* an in-flight tick, which does go red.
- **Category:** Testing / verification design
- **Prevention:** Before trusting a green test, delete the guard it claims to cover and confirm the test goes red. A check that fires only intermittently is worse than no check, because a green run tells you nothing.
- **Follow-up exercise:** Apply the same treatment to the stall characterization test — shorten the block below the TTL and confirm the assertions reverse, so the stall is proven to be the *cause* of the loss.
- **Note:** recorded from the review discussion, not the learner's own words — edit if the reasoning is misrepresented.
