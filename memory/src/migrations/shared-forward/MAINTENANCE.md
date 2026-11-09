# Source credential fence and current privacy overlay

This administrator executable is separate from the copy engine and application.
Imports do not start migrations, API, Worker, model calls or tasks. It never
changes the running DSN, opens activation, creates backups or restores old state.
After any target writes, repair the current target forward; never reopen the old
Memory DSN. These component receipts do not close W4/T6.4 or business acceptance.

## Configuration and prerequisites

Build with `npm run build` in `memory/`, then use
`node dist/migrations/shared-forward/source-maintenance-cli.js --help`.
Set `SHARED_MAINTENANCE_URL` in the dedicated maintenance process environment.
There is no runtime URL fallback and URLs are forbidden in the configuration
file and command line. The connection must be a dedicated superuser
administrator. Source observation and all plan/verify operations use
server-enforced read-only connections. Database OID is mandatory; all identity
fields below are strings and must be independently reviewed from the actual
server, including server address/port observed through any tunnel:

```sql
SELECT current_database() AS database, current_user AS role,
       d.oid::text AS "databaseOid", inet_server_addr()::text AS "serverAddress",
       inet_server_port()::text AS "serverPort"
FROM pg_database d WHERE d.datname=current_database();
```

Store a regular, nonsymlink JSON configuration file with mode 0600 (maximum
8 MiB). The source configuration is exactly this shape; replace each example
with reviewed facts:

```json
{
  "database": {"expected": {
    "database": "reviewed_old_memory", "databaseOid": "12345",
    "role": "dedicated_maintenance_admin",
    "serverAddress": "reviewed_server_address", "serverPort": "5432"
  }},
  "units": {"api": "reviewed-memory-api.service",
            "worker": "reviewed-memory-worker.service", "freshInstall": false},
  "oldMemoryRole": "dedicated_old_memory_runtime",
  "targetRoles": ["reviewed_target_memory", "reviewed_target_relay"],
  "reviewedConnectRoles": ["dedicated_old_memory_runtime"]
}
```

Source must be a dedicated legacy Memory `public` database with the migration
registry, the reviewed Memory table roster, and no unknown business tables or
shared-target contract. The old role cannot be privileged, have memberships in
either direction, have dependencies/backends in other databases, equal the
administrator, or overlap the reviewed target roles. No password is read or reset.
Other exact ACL grantees may be reviewed for **database-local CONNECT revocation**;
the tool changes LOGIN only for the old Memory role. Unknown grantees/peers and
unknown source owner roles are refused. At most 16 reviewed grantees and 256 idle
old-role backends are allowed. Before any cluster-wide NOLOGIN, every other
database that the old role can CONNECT to is inspected through an independently
identity-checked, server-read-only administrator connection (maximum 128 DBs).
Effective business relation/column/sequence rights, business schema CREATE, and
callable SECURITY DEFINER routines cause refusal even when granted only through
PUBLIC and no old-role-specific dependency/backend exists. DB identity/ACL and
negative effective-capability proofs are bound in the version 2 source manifest
and rechecked before apply/verify. Failure to inspect a DB is refusal, never proof
of dedication. Apply refreshes both systemd shows after that inventory and before
opening its mutation transaction. A source shared with another service needs a
separate reviewed repair, never widening these allowlists to bypass refusal.

The overlay config replaces the three role fields with
`"installationIds": ["exact-reviewed-installation-uuid"]` and binds the current
shared target identity. Maximums are 16 installations, 16 copied membership
bindings, 4096 source sessions and 4096 relevant withdrawals. The current Memory
schema, hardened shared contracts and live Relay control metadata must already
exist. Target `activation_ready` must be false, every mode legacy-feed/paused,
all non-superuser runtime LOGIN writers fenced, and existing writer/admin
backends drained. Offline NOINHERIT LOGIN roles are also checked across all
roles they can SET ROLE to: PostgreSQL 16+ SET privilege semantics, and a
conservative MEMBER closure on older servers. Removing inherited table rights
alone is insufficient. The same exported writer-fence helper is usable by the
physical copy engine. The tool does not provision or migrate these contracts.

Both operations execute actual `systemctl show` for **both** configured units,
outside DB transactions, with a 5-second timeout and 16-KiB output limit per
process. Both must be loaded/inactive, dead (or failed substate), and MainPID 0.
`not-found` is accepted only with explicit `freshInstall:true`, including systemd
exit metadata identifying an absent unit. There is no `--drained`/`--ready` flag.
Evidence older than 15 seconds is rejected before mutation/overlay commit.
Tests may inject the process/probe dependency; CLI always uses the real probe.

## Plan, review, apply, verify

```sh
# Run from memory/. Each output directory must be new; parent must exist.
node dist/migrations/shared-forward/source-maintenance-cli.js fence plan \
  --config /private/source.json --output /private/source-plan

# Review maintenance-manifest.json; preserve its exact fingerprint and 0600 mode.
node dist/migrations/shared-forward/source-maintenance-cli.js fence apply \
  --config /private/source.json --manifest /private/source-plan/maintenance-manifest.json \
  --output /private/source-apply
node dist/migrations/shared-forward/source-maintenance-cli.js fence verify \
  --config /private/source.json --manifest /private/source-plan/maintenance-manifest.json \
  --output /private/source-verify

# After verified physical copy, run the current target overlay before any reopen.
node dist/migrations/shared-forward/source-maintenance-cli.js overlay plan \
  --config /private/target.json --output /private/overlay-plan
node dist/migrations/shared-forward/source-maintenance-cli.js overlay apply \
  --config /private/target.json --manifest /private/overlay-plan/maintenance-manifest.json \
  --output /private/overlay-apply
node dist/migrations/shared-forward/source-maintenance-cli.js overlay verify \
  --config /private/target.json --manifest /private/overlay-plan/maintenance-manifest.json \
  --output /private/overlay-verify
```

Version 1 source/overlay manifests are rejected; regenerate and review version 2
plans against current frozen identities and current target facts.

The source manifest freezes role OID/name/attributes, memberships, exact DB ACL
and grantee identities, and exact idle backend PID/role/start/metadata identities.
Application names are hashed before leaving PostgreSQL; query text is never
selected. Plan is read-only. Apply admits only the original or exact fully
restrictive ACL state, commits NOLOGIN and exact CONNECT revocation, then
terminates only still-idle exact reviewed backends. New/active backends abort.
`assertFrozenMemorySource` is reused as the final authoritative verification.
A 5-second drain timeout leaves the credential fence restrictive; it never
re-enables LOGIN or restores grants. Repeat apply with the same manifest and a
new report directory after identifying the blocker.

Overlay freezes the copied local scope plus **current** Relay grant, owner,
member, parent scope, config, session delete/ownership, accepted delivery revoke,
artifact revoke and withdrawal metadata. Any scope/fact drift aborts; re-review
current target facts rather than re-copying stale source state. Apply takes
NOWAIT SHARE locks on Relay control/session metadata (never events/archives) and
short Memory metadata locks to cover concurrent insertion/deletion as well as
existing facts. A hard 10-second client transaction deadline closes the dedicated socket, with
5-second statement/1-second lock limits. PostgreSQL may need the remainder of
the bounded current statement to observe disconnect and release its transaction;
verify actual backend drain before resuming. These are bounded maintenance locks; production
Relay latency and scale still require W5 rehearsal and an actual maintenance
window. A busy lock or exceeded bound aborts without target partial writes.

Overlay discovers retained sources independently of the continued existence of
`source_sessions` or delivery receipts. It traverses the existing reviewed
`JSON_COLUMN_POLICY` reference roster, plus typed evidence/artifact/provenance
metadata, using server-side allowlisted extraction. Explicit source/artifact/
episode/session identities, arrays and Team submission/decision provenance are
bound with original row keys and metadata SHA-256 fingerprints. Arbitrary text,
excerpts, model output and UUID-looking strings are never interpreted as sources
or returned to the administrator. Unknown nonindependent references remain exact
reviewed repair objects and refuse apply. Limits are 4096 roots/reference nodes/
capsules and 8 MiB per selected metadata column scan; limits fail closed.

The metadata-only authority adapter checks the persisted original Team principal,
binding, participant and target identities/revisions against current membership,
Team/session/installation/scope state, daemon filter and acceptance metadata.
It never selects an arbitrary principal or resolves canonical bodies. A changed
binding/removed participant restricts only its exact source root; independently
accepted capsules retain their separate ownership and still follow the global
Team v2 withdrawal contract. Explicit Team v2 provenance with an incomplete or
noncanonical global submission/decision tuple is unresolved even for an accepted
capsule and refuses apply/verify. Team v1 calls must be completed/failed/cancelled/
blocked; v2 independent acceptance does not require original-call terminality.
Acceptance/submission/spec metadata participates in the same NOWAIT SHARE locks
through commit, including against normal public-only Relay writers. Personal source filtering uses current daemon and
agent applicability, including unchanged filter configuration with changed source
metadata. Verified legacy archives retain their proven original owner identity;
unknown legacy/team authority is not inferred.

Mutations are restricted to exact existing policy barriers: Memory Session
tombstones, global delivery withdrawals, the affected copied membership's
`state='revoked'`, and monotonic shared-scope tombstones. Unaffected memberships,
roots and installations are preserved. Installation/config changes without a safe
scoped refresh adapter conservatively hold only the affected installation at
`integrity_error`; purging/purged states stay terminal. No canonical public row,
capsule/knowledge body, budget, uncertain effect or archive object is changed,
and no task/model/cleanup Worker is started.

Receipts separate `barrierApplied` and `currentRestrictionsVerified` from a
computed `privacyCatchupReadyForReopen`: it can be true for a fully resolved
scope whose current restrictions are enforced and which has no pending cleanup
or authority repair. A retained independent capsule scope protected by a global
withdrawal can satisfy this gate without deleting its body. `reopeningReady` and
`activationAuthorized` remain false because activation and business acceptance
are separate. Exact `pendingForwardRepair` objects identify source cleanup,
member/scope/config repair, and unresolved original authority. They do not
authorize blanket deletion or activation.

## Cancellation and remaining boundaries

SIGINT/SIGTERM abort and close dedicated sockets; an unfinished target transaction
rolls back. The source LOGIN/ACL fence may already be committed before draining;
it remains in force and the same manifest can resume using apply. Reports use
`ReportBundle`: 0700 directories, 0600 files, exclusive reservation, atomic final
publication, no overwrite and removal of unfinished staging/reservations on
ordinary cancellation. SIGKILL may leave private staging requiring inspection
only after confirming process death. Reports contain hashes/control keys only,
never credentials, source/canonical bodies, archive objects or query text. SQL
bigint/OID/PID metadata is serialized as decimal strings.

The reviewed explicit metadata roster is not permission to parse future unknown
JSON schemas or infer provenance from ordinary text. Unknown references,
cross-installation publication/grant dependencies, malformed Team provenance,
and unavailable current authority require exact forward repair and fresh review.
This component does not execute physical source-body purge, refresh a changed
installation's grant configuration, or establish the final migration activation
and business gates. Current Relay facts can change after a verify; reopening
needs a fresh final authority gate. Physical-copy equality is not current privacy
proof, and a successful scoped catch-up receipt is not a reopen permit.

Run the cross-database source-fence integration suite as a separate serial stage
(or `--no-file-parallelism`) and do not overlap it with other DB-drain tests. Its
read-only admin inventory intentionally creates visible peer backends in other
owned test DBs; the target drain predicate correctly refuses such peers. Do not
exempt scanners by application name or weaken production admission for tests.

## Actual forward privacy cleanup

`cleanup` consumes the exact version 2 overlay manifest after applying its
barriers. It runs administrator maintenance code only. It imports the existing
session purge repository and uses its caller-owned transaction path; it never
constructs an API, Worker, model provider, backup or rollback process.

```sh
# Existing administrator connection is supplied through SHARED_MAINTENANCE_URL.
# Supply the CURRENT trusted tombstone keyring through the environment, using
# the installed secret source, as JSON [{"version":"...","key":"..."}].
# Do not generate replacement keys for maintenance.
# SHARED_MAINTENANCE_TOMBSTONE_KEYS must not be written into config/manifests.
npm run migration:source-maintenance -- cleanup plan --config /private/admin.json --overlay /private/overlay/maintenance-manifest.json --output /private/cleanup-plan
npm run migration:source-maintenance -- cleanup apply --config /private/admin.json --manifest /private/cleanup-plan/maintenance-manifest.json --output /private/cleanup-apply
npm run migration:source-maintenance -- cleanup verify --config /private/admin.json --manifest /private/cleanup-plan/maintenance-manifest.json --output /private/cleanup-verify
# After interruption or an uncertain COMMIT response, reuse the SAME manifest.
npm run migration:source-maintenance -- cleanup resume --config /private/admin.json --manifest /private/cleanup-plan/maintenance-manifest.json --output /private/cleanup-resume
```

All paths are examples. Use private 0600 config/manifest files, new report
directories and the previously reviewed exact database identity, installation
set, API/Worker unit names and drained service evidence. `plan` and `verify`
are read-only. Each object is one bounded transaction page, with SQL statement
5s / lock 1s timeouts and a 10s hard wall. Cancel closes the dedicated connection.
A previously committed object stays committed and authoritative.

The existing repository policy closure is not generally paginated. This adapter
therefore admits **at most 1024 affected dependency rows and 8 MiB of affected
row JSON per reviewed manifest page**, across a fixed catalog of at most 256
known Memory relations. This is not a whole-database or whole-installation row
limit. Exact selected Session roots, event/episode/candidate/bundle/pack IDs and
operational metadata predicates define the page. Unrelated Sessions, inbox rows
and source bodies are never serialized merely to compute a global hash. The
real regression retains 1500 unrelated Sessions and 5000 unrelated source rows
in the same installation while cleaning one selected Session.

Rows are hashed inside PostgreSQL, exporting only names/counts/bytes/digests.
Known outside-surface tables are explicitly classified preserve-untouched;
unknown catalog tables refuse, and column shape is fingerprint-bound rather
than silently expanding the reviewed plan.
The same frozen dependency predicates and schema roster are checked before each
object; affected relations are locked NOWAIT. The administrator's direct
Session mutation adapter allowlists the mature repository's narrow DML surface.
Both runtime writers remain fenced. Other administrators must coordinate the
exclusive maintenance window. Independent capsule metadata is freshly checked
by exact original capsule IDs, not a global body scan.

This stage supports bounded ordinary Session cleanup with episode-owned Claims
and reviewed Skill archive/source dependencies. Such plans use manifest version
2 with accepted-support closure policy version2. Earlier linked closure policy
version1 refuses without changing prior receipts; fresh review is required.
Existing raw-only manifest version1 plans retain their exact negative-edge proof and
checkpoint prefix. The positive adapter freezes primary/reference identifiers,
all affected Claim versions/evidence/capsules and replacement-support episodes,
Context packs, Skill tasks/runs/candidates/versions/publication/replay children,
and the actual FK descendants and native Git connection effects. A fixed table
surface rejects unreviewed children. The mature purge repository owns every
content mutation; its pure identity descriptor supplies exact prospective HMAC
tombstones and idempotent reindex keys, which the DML adapter admits explicitly.

An already-applied Session barrier also requires physical cleanup of restored
Skill replay history. The mature Session repository repeats its existing
`tombstone AFTER INSERT` replay-run deletion predicate after an idempotent
barrier INSERT, so retained historical cases cannot survive merely because
`ON CONFLICT DO NOTHING` skipped that trigger. The positive closure includes
the selected historical case, its parent run, every other case in that run,
and related Git snapshot/connection effects. The otherwise unrelated current
Skill, immutable version and publication head remain independently owned.

Linked apply/resume takes NOWAIT Memory child-table locks before recomputing the
closure from the original frozen identifiers, even after roots disappeared.
Current column/default, PK-column, FK-definition and trigger/function metadata
is bound to the plan. CHECK constraints, non-PK UNIQUE constraints and standalone
index definitions are outside this fingerprint; no full catalog audit is claimed.
Generated governance changes after the frozen per-installation sequence floor,
logical tombstones and selected-connection Git retention/fence records are
included in checkpoint state. No source bodies or SQL definitions are exported.
There is a conservative pre-mutation row allowance for native output records;
actual row JSON remains bounded by 1024 rows / 8 MiB. Oversize reasons identify
linked dependency/output limits; larger objects still require page subdivision.

Cross-Session typed source dependencies use a new manifest/linked policy version3
with exact-source policy version2; earlier exact-source1 is explicitly unsupported,
and ordinary version2 receipts are never implicitly
upgraded, and unknown versions refuse before receipt writes. Original source-event
and artifact UUID/FKs plus `memory-episode-packet-v6` manifest handles discover the
bounded affected episode family. Retained inventory and exact cleanup share one
reference-key definition, array expansion and owner joins. Exact cleanup covers
the full `JSON_COLUMN_POLICY` reference roster (including source_version, which
retained inventory deliberately excludes), plus source provenance/artifact details.
The exact negative scan also covers the existing episode document/summary,
candidate structured-content and Skill archive document channels. Every declared
reference channel is included automatically; its fixed roster/key contract hash
is bound by exact-source2. A changed contract refuses old exact receipts rather
than silently accepting a narrower scanner.

Scalar/plural snake/camel source-event, artifact and episode IDs are matched by
exact handle value; UUID case is normalized, and sibling spellings cannot mask
one another. Session and canonical Session handles use their original installation
scope. Unreviewed Session-array spellings are recognized only to refuse; they do
not create retained/source authority. Known packet manifests proceed only through
the typed version/ownership proof. Unreviewed matching reference shapes in bundle
spans (even without source FKs), Context selected references, curation, promotion,
Team, Git and the other declared channels refuse before mutation or checkpoint
acceptance. Ordinary prose containing UUID strings is not a source handle.

Already authorized raw source/Session rows remain under the original native
removal policy. Exact valid independently accepted excerpt/capsule locators retain
their existing independent ownership; an orphan/mismatch cannot claim this
exception, and Team-v2 global withdrawal remains effective. No other matching
metadata becomes deletion authority. Queries keep matching/extraction server-side,
return only bounded typed candidates or a refusal bit, and never serialize/hash
all installation bodies. Existing actual affected-row/byte bounds and SQL/physical
deadlines remain. Unknown packet/provenance/owner proof fails closed. Frozen
original source/artifact/episode/Session identifiers remain negative roots after
legitimate deletion. Narrow plans lock every reference-channel writer table as
well as the original native child boundary before their last check; late edges
refuse apply, resume and verify without widening the stored scope.

The exact native invalidation primitive shares the mature Claim/version,
accepted-support, pointer/HMAC/tombstone and feedback policy with Session purge.
It removes unsupported versions/evidence, minimizes exact linked feedback and
clears the affected episode's compiled document, evidence manifest and summary.
The episode remains `invalidated` with its original UUID/source digest and audit
run/reservation links. Native state-change triggers remove dependent Skill archives
and invalidate Git/operational outputs. No replacement excerpt, source UUID/digest
retargeting, recompile/model/Git call or other-Session tombstone is created. Other
Session raw facts, independent episodes, valid accepted excerpts/capsules and
independent published assets retain their ownership. Exact Skill/extraction
attempt generation, budget-reservation and usage-outbox links participate in the
version3 checkpoint state and preserve incurred or provider-result-unknown facts.

Canonical aliases, mixed Team roots, unknown source provenance and original-owner
transfer/uninstall/retention proof remain refused. Large affected objects still
need deterministic page subdivision; these 1024-row/8MiB bounds are refusal limits,
not a scalable whole-Session implementation. Formal T6.4 remains pending those
successors and runtime/production acceptance. Privacy readiness never grants
activation or reopening authority.

Existing session tombstones do not skip physical cleanup. The mature repository
preserves separately accepted evidence while deleting the original session's
source/derived data. Mixed Team roots with both revoked and current original
authority refuse generic Session purge: a future exact UUID/dependency adapter
must preserve the unaffected reader's raw source. Unknown original authority,
owner transfers, revision regression, and unresolved retained references refuse.
Revoked installation retention remains explicitly not-ready; it is never
converted into user uninstall authority or an installation purge.

Configuration repair copies only current trusted same-owner Relay status,
config version, granted scopes, subscriptions, enabled services and event
filter. It preserves local operational policy, consent, costs, reserved or
uncertain attempts, and terminal/integrity holds. Membership repair follows
scope-control mirror policy: exact current roles/revision/state, closed
nonactive validity, with the installed Skill/Git invalidation triggers required.
Scope repair advances trusted same-owner lifecycle state/epoch, preserving
scope tombstones and separately owned accepted knowledge. Native policy effects
that would alter protected policy/budget or independently supported accepted
capsules fail closed and roll back the page. A valid accepted_excerpt must match
its capsule by installation/version and user_accepted retention. Such support
preserves its Version and is eligible as an independent replacement; orphan or
mismatched capsule ownership refuses before Session mutation. Session cleanup
protects every capsule and has no capsule deletion exemption. Maintenance holds
and historical privacy fences are not removed.

Original retained roots/provenance remain bound to fresh Relay authority even
when physical source rows disappear. The initial dependency manifest is never
rewritten after cleanup. Durable checkpoints store exact before/after hashes;
resume compares the current namespace with the last committed affected post-state,
rather than demanding that legitimately deleted original rows still exist.
New Relay privacy facts, Memory rows, or changed dependencies require new review.
Final verification checks actual source absence, checkpoint completion, current
authority, protected metadata and fencing. `privacyCatchupReadyForReopen` can
be true while `reopeningReady` and `activationAuthorized` stay false. Activation,
service reopening and product acceptance remain separate work.

### Explicit maintenance-only catalog object

Only `cleanup apply|resume` may create
`shared.memory_forward_cleanup_steps`. This is a maintenance receipt table,
**not** a runtime schema migration, canonical source, retained knowledge table,
or permission to activate. Future pre-migration object review must classify it
as administrator-owned maintenance metadata and preserve or explicitly review
its receipts; do not add it to runtime schema startup or the Memory body roster.
Its exact audited structure is:

```sql
CREATE TABLE shared.memory_forward_cleanup_steps (
  plan_hash text NOT NULL,
  step bigint NOT NULL,
  object_hash text NOT NULL,
  before_hash text NOT NULL,
  after_hash text NOT NULL,
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (plan_hash, step)
);
REVOKE ALL ON shared.memory_forward_cleanup_steps FROM PUBLIC;
```

The connected administrator owns it. All nonowner ACL grants, alternate column
shape/defaults, extra constraints, RLS, triggers and rewrite rules are refused;
no runtime role receives access. Rows contain only plan/object/dependency
fingerprints, ordinal and commit-time observation. A lost receipt response is
recovered by reading the durable contiguous prefix. Deleting or editing this
ledger is not a repair procedure.

Empty raw `source_events.source_provenance` no longer consumes the retained
reference-row budget. Native roots are still independently enumerated. Empty
artifact details may be skipped only when the existing FK target proves the
same installation and Session; nonempty or mismatched metadata remains in the
explicit bounded retained scan. Reference-bearing historical metadata above
4096 rows/8 MiB still refuses and needs a paged retained-closure adapter.

Checkpoint ACL audit includes both table `relacl` and every ordinary column's
`attacl`: even a column-only SELECT or UPDATE grant to PUBLIC, a runtime LOGIN,
or a NOLOGIN capability role refuses before plan/checkpoint use or cleanup.
Explicit owner column privileges are allowed; nonowner grants are not silently
revoked. Configuration versions are compared as decimal strings with bigint;
trusted Relay versions below the latest target version refuse during planning
and before every apply/resume batch. Same-version metadata policy is unchanged.

For legacy version 1 plans, unsupported Skill and episode-owned knowledge edges
remain live negative facts. Version 2 plans instead prove their exact positive
closure, refusing any new identifier edge before mutation or checkpoint use.
Apply/resume locks the evidence/archive/source/task-run child relations NOWAIT
and rechecks original frozen source/episode IDs before any mutation or completion
acceptance. A legitimate linked witness added after planning refuses rather than
entering the original plan through FK/trigger cascades. Read-only verification
rechecks the same negative facts in its current snapshot; completed source rows
may remain legitimately absent without reconstructing or widening their IDs.

## Explicit paged privacy cleanup (v4)

`paged-cleanup` is a separate manifest format. Never pass a v1–3 cleanup plan
as a v4 directory or use the older overlay as an unbounded prerequisite. The
initial v4 adapter covers proved direct personal Relay roots, original native
headers and hashes, bounded native Claim/Skill components, and minimal retained
fee skeletons. Proved typed cross-Session source loss may invalidate its dependent
episode without deleting the other Session or its raw sources. Independent native
Session `compile_context` generations paginate only when their exact subject hash
and installation are proved and no job/output linkage remains unresolved.
Already cancelled generations remain unchanged; uncertain fees and existing
errors retain their original values. Native personal Skill grant snapshots and
exact body-free job payloads are classified explicitly; unknown JSON body fields
refuse. Alias/Team/legacy-archive ownership, unknown original provenance, unsupported
cross-root graphs and unresolved operational families refuse. Such a refusal is
not a completed privacy repair. Full owner lifecycle and actual runtime reopening
acceptance remain separate gates.

Use the explicit Node 22 maintenance executable after installing the reviewed
schema separately. Schema 95 changes the native Skill Session tombstone function
so already settled cancelled tasks receive no redundant timestamp update. It
retains locks and all native effects for mutable associated runs, generations,
archives and jobs. It adds no business table; the current roster is 190. This
migration does not make the public whole-Session purge bounded. Plan and verify
never run schema migrations, create metadata tables, advance sequences or start
models/jobs.

Prepare private files with mode 0600. `roots.json` contains only exact reviewed
`[{"installationId":"<uuid>","sessionId":"<native-session-id>"}]` entries.
`config.json` contains the exact server-observed database identity, fixed
installation IDs, stopped API/Worker systemd unit names, and
`reviewedCatalogHash` from an independently reviewed current catalog inventory.
A newly observed catalog hash is a review candidate, not authorization. The
connection URL and existing trusted HMAC keyring are supplied only through
`SHARED_MAINTENANCE_URL` and `SHARED_MAINTENANCE_TOMBSTONE_KEYS`; neither belongs in
configuration, arguments, manifests or receipts.

From `memory/`:

```sh
node dist/migrations/shared-forward/source-maintenance-cli.js paged-cleanup plan --config config.json --roots roots.json --output plan-v4
node dist/migrations/shared-forward/source-maintenance-cli.js paged-cleanup apply --config config.json --manifest plan-v4 --output apply-receipt-v4
node dist/migrations/shared-forward/source-maintenance-cli.js paged-cleanup resume --config config.json --manifest plan-v4 --output resume-receipt-v4
node dist/migrations/shared-forward/source-maintenance-cli.js paged-cleanup verify --config config.json --manifest plan-v4 --output verify-receipt-v4
```

Every output directory must be new. The manifest directory is private, atomic,
streamed and immutable; it contains typed original identities, hashes, counts,
explicit retained reasons and receipt bindings, never source prose or bodies.
Apply alone may install the four exact administrator-owned
`shared.memory_forward_cleanup_v4_{plans,pages,items,receipts}` tables after
catalog/identity/ACL validation. They have no defaults, runtime grants, RLS,
policies, rules or triggers. Their exact tables, primary indexes, constraints,
row/array types and owner/column permissions are audited on every use; an unknown
same-prefix object is not exempted from catalog validation.

These four private checkpoint tables are created with exactly
`autovacuum_enabled=false`. Background maintenance must not compete with their
NOWAIT write fences. This setting does not change any Memory business or Relay
source table or the cluster policy; PostgreSQL may still force anti-wraparound
maintenance, which remains a normal lock refusal. An earlier unpublished
checkpoint shape without this option refuses; apply does not alter or upgrade it.
After authenticating/loading all manifest parts, each apply/resume explicitly
ANALYZEs each of the four tables in its own fully fenced setup transaction before
exhaustive seal/state joins. Each operation keeps the 5-second SQL, 1-second lock
and 10-second physical bounds. Statistics never authenticate rows or replace
original-ID checks; their refresh changes neither row content nor xmin. Plan and
verify remain read-only and never analyze. Capacity accounting must include the
four tables and their existing primary indexes, retained dead tuples, WAL from
checkpoint/receipt writes, and the measured ANALYZE and per-window costs. Future
checkpoint reclamation needs its own reviewed scope; automatic pruning or an
additional maintenance index is not provided here.

Raw discovery splits deterministic keyset prefixes by both row count and byte
work, reserving native audit metadata. The complete Memory source plus native
auxiliary JSON projection is bounded in the same SQL snapshot before decoding;
so are exact-source manifests and typed identity projections. The existing
1024 UTF-16-unit identity limit is checked before transfer, including compressed
TEXT and supplementary Unicode. Native event eligibility must match the actual
capture predicate (`none`/`completed` effects); pending native events refuse.

Unsupported running extraction or queued/running `extract_candidates` work
refuses before business writes and on every later original-ID check. Settled
unknown fee records keep their original errors and links. No new extraction
cancellation or replay adapter is implied.

All manifest parts load and seal before the first Memory business mutation.
Each page rechecks the same global closed/drained/exclusive target, frozen
configuration, catalog, original native identity and full original-key FK/JSON
closure, including original parents deleted by earlier pages. Native owner,
grant, daemon, Session, purge and source-root fences remain held through COMMIT;
Relay's native capture functions must be installed and reviewed. Source root
revision changes refuse. No canonical Relay payload/archive is read, rewritten
or deleted by this path.

The mutation budget remains 1024 rows including native effects/outputs, 8 MiB
of bounded work, statement timeout 5 seconds, lock timeout 1 second, and physical
transaction window 10 seconds. Independent components paginate; an indivisible
component refuses. Native audit outputs are bound to exact original or observed
native output keys and receipted in the same transaction. Full after-write
checks also cover native subtransaction effects. Fee/provider/lineage links and
pre-existing unknown/error facts are immutable; body-free invalidated skeletons
retain original primary keys rather than reparenting accounting.

The administrator metadata `pages` table also stores `page_state_hash`. Its
value alone is not a trust anchor. Each invocation authenticates actual private
file parts and builds a bounded rolling root from their original Node hashes,
SQL canonical hashes and exact metadata row versions. Later windows compare
that caller-held root; jointly modifying an old page and its SQL hash cannot
hide behind the stored receipt. Metadata row versions are concurrency fences,
not source birth/provenance evidence. The earlier unpublished development
checkpoint shape refuses precisely; no automatic metadata upgrade runs.

A lost COMMIT acknowledgement resumes from the exact durable contiguous receipt
prefix. Never delete, edit or restamp the manifest/checkpoint data to recover.
After all stored parts and the complete current original/edge/receipt prefix
are authenticated, already completed pages require no additional business
mutation. Each remaining page and final verification still performs every
current authority, original-ID, accounting, native-output and negative-channel
check. A changed source/edge/authority/catalog requires a fresh scoped review,
not a larger timeout or cap. SIGINT/SIGTERM/physical expiry send an exact backend
CancelRequest, prohibit further SQL/COMMIT, and separately confirm that backend
has gone using a bounded read-only observer. Protocol credentials are ephemeral
and never serialized. Cancellation cleanup is not an extension of the mutation
window or proof that every partial plan is ready.

Partial cleanup stays globally closed. Even a complete verification reports
`verificationScope:"fixed_original_personal_roots"`,
`globalRetainedAuthorityVerified:false`, `activationAuthorized:false` and
`reopeningReady:false`. Its privacy catch-up result applies only to the sealed
original roots and supported dependencies. Global unrelated retained-root
authority refresh, owner/uninstall/mixed-Team lifecycle completion, broad
job/output/Git/replay adapters and actual runtime reopening remain separate work.
The result does not authorize runtime activation or establish product acceptance.
This workflow creates no body/config backup, rollback artifact, paid replay or
production deployment.
