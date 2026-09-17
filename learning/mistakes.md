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
