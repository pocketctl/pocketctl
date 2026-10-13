# Phase 3 Product Pilot B

This is an approved, local-only, single-participant Product Effect pilot for
`user_id=4`. It is private and ignored by Git.

## Frozen boundaries

- Only PocketCtl work is in scope.
- Only tasks created at or after `manifest.json.window.activated_at_utc` enter
  Product Effect denominators.
- Older PocketCtl data may inform a baseline but cannot be relabeled as a Pilot
  result.
- Phase 2 Context stays off/shadow and shared Context injection stays disabled.
- Request/token budget plan A is a hard stop.
- Pilot artifacts are retained for seven days after collection/closure and are
  deleted sooner on request.
- There is no independent reviewer. A strict Phase 3 Product Effect PASS is not
  possible under participant plan B; results must remain PARTIAL/DEFERRED.

## Activation checklist

1. Deploy the accepted candidate to the local Docker test environment.
2. Verify Relay v2 and Memory shared-scope flags without printing secrets.
3. Verify migration 23, Provider credential exchange, Feed progress, and one
   short text plus embedding probe within budget A.
4. Record the successful activation time in the manifest. That time is the
   sample cutoff.
5. Use ordinary new PocketCtl tasks; do not manufacture successful outcomes.

## Evidence files

- `manifest.json`: authorization, scope, cutoff, budget, and Gate targets.
- `runtime-evidence.json`: deployment and real-provider probe evidence.
- `cases.jsonl`: eligible new-task cases only.
- `lifecycle.jsonl`: observed real governance lifecycle cases.
- `budget.json`: requests/tokens observed during the Pilot.
- `report.md`: final strict-roadmap Product Effect verdict.
