# Team collaboration rollout and shutdown

This runbook covers staged rollout, observation, fault drills and non-destructive shutdown for Team collaboration. It does not authorize merge, push or production deployment.

## Release decision

Feature flags default to `off` and accept only `on` or `off`.

| Phase | Flags | Capability | Evidence required before opening |
| --- | --- | --- | --- |
| B — manual collaboration | `TEAM_COLLABORATION=on`, others `off` | Teams, invitations, tasks, shared sessions, direct Agent calls and frozen Context | Release gate, browser B01–B08, live L01–L06 |
| C — bounded autorun | B plus `TEAM_AUTORUN=on` on Relay and event worker | Coordinator/worker runs with frozen call, concurrency and wall-time budgets | Phase B evidence plus R05–R08 fault drills |
| D — shared Memory | B/C plus `TEAM_MEMORY_BRIDGE=on`, `RELAY_EXTENSIONS=enabled`, `RELAY_EXTENSION_V2=enabled` | Existing shared installation binding, exact published references, per-receiver injection | Phase B evidence plus M01–M04 and Memory/provider health |

At this repository checkpoint, automated unit, integration and build evidence can make a phase a **release candidate** only. Keep all three flags off until the browser and live evidence files are completed and hashed into a release report. iOS has no Team UI in this release.

## Preflight

1. Run `scripts/test-team-collaboration.sh --scope release` from a clean candidate SHA.
2. Complete `scripts/verification/team/scenarios.md`; rerun the gate with `TEAM_VERIFY_BROWSER_EVIDENCE` and `TEAM_VERIFY_REAL_AGENT_EVIDENCE`.
3. Verify database backups and incremental migrations. Never plan a rollback that drops Team tables or rewrites retained history.
4. Confirm Relay and event-worker use identical flags and artifacts. Phase D also requires a healthy Memory provider catalog, Extension v2 grants and provider version.
5. Query `/api/team/capabilities` as a normal authenticated user. The Web must follow this response; a frontend environment variable is not sufficient.
6. Verify the protected `/internal/metrics` endpoint and log pipeline before enabling writes.

## Observability

Prometheus labels are deliberately bounded and contain no request, run, call, session, Team, user, daemon or content values.

| Signal | Meaning |
| --- | --- |
| `pocketctl_team_dispatch_total{operation,outcome}` | Claimed dispatch outcomes, including sent, receipt, timeout and blocked paths |
| `pocketctl_team_dispatch_latency_seconds{operation,outcome}` | Pending claim attempt through transport handoff |
| `pocketctl_team_receipt_latency_seconds{operation,status}` | Transport handoff through authenticated daemon receipt |
| `pocketctl_team_uncertain_total{reason}` | Unknown external outcomes requiring reconciliation |
| `pocketctl_team_duplicate_suppressed_total{source}` | Process, admission, daemon or receipt replay suppression |
| `pocketctl_team_budget_stops_total{dimension}` | Frozen call, concurrency or duration budget stops in the event worker |
| `pocketctl_team_context_injection_failures_total{stage}` | Shared Context prepare, receipt mismatch or rejection failures |

The structured `[team-observability] call correlation` log contains only `requestId`, `runId`, `callId` and operation. Join it with persisted `collaboration_calls`; never add prompts, responses, Context/Memory payloads, tokens or credentials to metrics or operational evidence. Event-worker budget signals must be collected from the worker process/log stream as well as Relay logs.

Initial alerts should use a baseline rather than fixed traffic assumptions:

- any sustained rise in `uncertain`, context receipt mismatch or internal-error outcomes;
- p95 receipt latency approaching the 30-second acceptance timeout;
- duplicate suppression or budget stops increasing unexpectedly after a release;
- pending/dispatched calls or running runs that remain older than their configured deadlines.

## Rollout

1. Deploy schema and code with every Team flag off. Confirm personal sessions and Memory are healthy.
2. Open Phase B to an allowlisted environment by setting `TEAM_COLLABORATION=on` on Relay; keep autorun and Memory bridge off.
3. Complete a real two-user/two-host call, then observe for at least one normal operating window. Expand only with zero unresolved uncertain calls.
4. For Phase C, set `TEAM_AUTORUN=on` on both Relay and the event worker. Confirm the worker reports schema readiness and creates no calls beyond frozen budgets.
5. For Phase D, first validate Extension/Memory health and grants, then set `TEAM_MEMORY_BRIDGE=on` on Relay. Confirm exact-source search, two distinct receiver receipts and no personal/private fallback.

Do not open a later phase merely because its UI renders. Capability discovery, real provider receipts and retained database state are authoritative.

## Reconciliation queries

Run read-only queries before restart, after restart and before declaring a drain complete:

```sql
SELECT state, count(*) FROM collaboration_calls GROUP BY state ORDER BY state;
SELECT state, count(*) FROM collaboration_runs GROUP BY state ORDER BY state;
SELECT state, count(*) FROM collaboration_context_deliveries GROUP BY state ORDER BY state;
SELECT count(*) AS pending_calls FROM collaboration_calls WHERE state IN ('pending', 'dispatched', 'accepted', 'uncertain');
```

For every `uncertain` call, correlate the request/run/call IDs with daemon/provider evidence. Do not turn an unknown outcome into a retry. Record the final operator decision and preserve the original row.

## Fault drills

- **Worker restart:** terminate after lease acquisition; a replacement must fence the old lease and must not repeat uncertain work.
- **Relay restart:** restart with a persisted pending call; polling may resume pending dispatch but must not redispatch accepted/uncertain work.
- **Daemon restart/disconnect:** cut the socket after receipt; call and Context delivery become uncertain until reconciled.
- **Duplicate request:** replay identical and conflicting idempotency keys; identical work is reused/suppressed, conflicting content is rejected.
- **Old daemon:** remove v1 Team capability advertisement; it remains visible as unavailable and receives no command.
- **Member removal:** revoke during an open subscription and before dispatch; future reads, dispatch and Memory injection fail closed.
- **Memory off:** disable bridge while personal Memory remains enabled; Team binding/history remain, new shared reads/injections stop.
- **Budget exhaustion:** exercise call, concurrency and duration limits; no new provider call occurs after the stop.

## Independent shutdown drills

### Disable automatic collaboration

1. Restart Relay with `TEAM_AUTORUN=off` first so new run mutations return `team_feature_disabled`; leave the current event worker running temporarily.
2. Let already scheduled calls settle. Pause/cancel controllable runs and reconcile uncertain calls.
3. When no run is `ready`/`running` and no call is pending/dispatched/accepted, restart the event worker with `TEAM_AUTORUN=off`.
4. Verify direct manual Team calls still work and historical runs remain readable.

### Disable shared Memory

1. Set `TEAM_MEMORY_BRIDGE=off` and restart Relay. Do not disable personal Memory or delete bindings.
2. Verify capabilities report `memory_bridge=false`; new binding and shared compile/injection paths fail closed.
3. Let already accepted native calls finish, reconcile missing injection receipts, and verify personal Memory still compiles normally.
4. Retain Team bindings, source tombstones, published knowledge and audit history under their existing lifecycle rules.

### Disable Team writes

1. At the ingress/load balancer, temporarily reject new mutation requests under `/api/team/*` while retaining authenticated reads and operational access.
2. Keep Relay dispatch running until no call is pending/dispatched/accepted. Reconcile every uncertain row; do not retry it automatically.
3. Set `TEAM_AUTORUN=off`, then `TEAM_COLLABORATION=off` on Relay and event worker and restart them.
4. Verify capabilities show writes disabled, new mutations return `team_feature_disabled`, personal features work, and retained Team history remains readable to authorized members.

If an emergency cannot wait for a clean drain, turn the relevant flag off, preserve database state, and mark every unresolved external operation for reconciliation. Never delete collaboration tables as rollback.

## Evidence and sign-off

Archive the release report, browser record, live-Agent record, sanitized metric snapshots, reconciliation counts and all failure/retest notes together. The report must name the exact phase approved. Merge, push and deployment remain separate authorized actions.
