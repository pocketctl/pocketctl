# Shared database R1 schema foundations

The target is Relay-owned `public`, Memory-derived `memory` and the versioned body-free contract in `shared`. Migration 85 fixes timestamp-only Git invalidation; 86 adds typed canonical refs; 87 aligns version ranges with signed bigint, while retaining original UUIDs, FK relationships and compatibility bodies. No mapping or body removal is applied by these migrations.

Use a dedicated migrator connection. The explicit database name argument must match the connected database; runtime `DATABASE_URL`/`MEMORY_DATABASE_URL` is never a migrator fallback.

```sh
# Existing separate Memory database, explicit legacy schema upgrade:
MEMORY_MIGRATION_DATABASE_URL="$migration_url" npm --prefix memory run migrate -- apply public expected_database

# Empty target Memory namespace beside an explicitly migrated Relay public:
MEMORY_MIGRATION_DATABASE_URL="$migration_url" \
MEMORY_MIGRATION_ROLES='{"memoryRole":"memory_runtime","relayRole":"relay_runtime","migratorRole":"schema_migrator"}' \
  npm --prefix memory run migrate -- apply memory expected_database

RELAY_MIGRATION_DATABASE_URL="$relay_migration_url" \
  npm --prefix relay run migrate -- apply expected_database
```

The three roles must already exist. Runtime roles cannot be database owners, schema owners, superusers or members of migrator/peer/escalating roles. Provisioning is an explicit admin operation: it transfers Memory/shared ownership, revokes PUBLIC schema CREATE and database TEMP, clears runtime/PUBLIC shared ACLs and grants a reviewed function whitelist. It changes default privileges only for the specified migrator. It grants Relay public DML, Memory its own DML and controlled shared functions; it does not create passwords. Review existing roles/ACLs before applying this administration operation outside a synthetic fixture.

Target Memory runtime uses `MEMORY_DATABASE_NAMESPACE=memory`; API/Worker verify schema/contracts and effective permissions without DDL. Relay detects the shared contract and also verifies without DDL; its standalone Worker checks the same role boundary. Runtime paths are catalog-first. The separate Relay migrator uses a controlled public-first DDL path. Missing/unknown contracts and wrong/default Memory namespace fail closed before schema initialization. Independent legacy public auto-bootstrap remains compatible for now; `MEMORY_SCHEMA_STARTUP=verify` or `RELAY_SCHEMA_STARTUP=verify` can opt it into verification only.

The contract starts `activation_ready=false`. Default Memory startup still refuses shared-shadow/shared-active. An explicit finite launch profile can admit the personal Session lane after its separate migration and activation gates. No migrator command below activates a mode, copies business data, changes subscriptions or selects a production DSN.

For the reviewed personal Session candidate, set migrator-only
`MEMORY_MIGRATION_SOURCE_TARGET_PROFILE=personal-relay-only` and
`MEMORY_MIGRATION_PRESERVED_INSTALLATIONS` to the complete comma-separated
preserved installation UUID set (personal **and** organization, 1..16 unique
IDs). Runtime uses `MEMORY_SHARED_SOURCE_PROFILE=personal-relay-only` and the
same set in `MEMORY_INSTALLATION_ALLOWLIST`, with namespace `memory` and startup
`verify`. Invalid launch inputs fail before the first database operation.

The migrator installs a target enumerator bound to that exact UUID set and
personal `relay_event` only. Runtime checks the executable definition, owner,
security/search path and stored set, then checks all live local installations
and their native owner facts. Missing/extra scopes, organization canonical
modes or definition drift refuse startup. Reapplying the migrator preserves
the stored choice and IDs; changing them requires drained modes. A later
unrelated personal activation cannot acquire a target from this enumerator.
Canonical jobs outside the frozen IDs and all raw Team kinds are terminally
rejected before body reading or billing. Existing organization legacy/control
work and its original consent remain available. The full Team implementation
is retained and dormant; this finite profile does not establish complete
migration, retained-history proof or production business acceptance.

Verification (synthetic data only): build `scripts/verification/shared-source-r1/Dockerfile` from the repository root, then run `node scripts/verification/shared-source-r1/run.mjs /absolute/new/evidence/directory`. It owns uniquely labelled temporary PG13/17 containers, uses separate test databases, serializes destructive schema fixtures, runs Node22 builds/suites, and records actual-data mapping and backup as not executed. It never opens a production connection.

Trusted canonical headers are an explicit Relay opt-in: after the Relay migrator installs `header_version=1` and the four reviewed `public.events` metadata columns, set `RELAY_SHARED_SOURCE_HEADERS=enabled` on Relay API and event Worker with `RELAY_EXTENSIONS=shadow` or `enabled`. Compose forwards the flag to both services; native services read their existing Relay EnvironmentFile. Relay verifies the known header contract before runtime startup and never adds these columns at startup. The flag alone does not enable Memory source modes.

The authenticated Journal sink freezes its original server sequence, canonical hash and the exact Feed-v1 classification in the same publish transaction. Replay reuses the original sequence, including repair after Journal pruning; it never treats MAX(sequence) as completion. No historical backfill runs at install. Persisted unknown Memory provenance remains unknown; conflicting headers/refs block. Before removing historical Journal rows, mapping must preserve old server sequences and unavailable reasons. Legacy publishers with the flag off retain their original single-statement Journal write.

Consumer wiring is versioned separately by consumer_version=1 and the current Memory schema (now96). Runtime verifies required controlled functions/EXECUTE capabilities before serving. The explicit legacy archive adapter keeps original Memory UUIDs, old sequences and provenance, pins the original owner/manifest and validates canonical body hashes separately from historical snapshot-envelope hashes. It reads only reviewed legacy_archive records; a missing canonical/Team source cannot fall through. Necessary historical bodies stay in place as a single authority, exempt from redundant-body deletion. Schema installation creates neither archive bindings nor backups. Original Team/unknown identities stay blocked when unprovable. See the change's legacy-archive-contract.md for its proof and lifecycle limits.

Migration89 records the input mode generation at snapshot start. Inbox/projector transactions hold a shared mode lock before local lifecycle locks; paused/shared-active reject legacy input, while shared-shadow preserves it. Landing/finalize reject a stale snapshot generation after pause/resume. Raw retention receipts and reclaimed source markers increment a body-free Memory-only revision; a receipt committed during archive IO invalidates the raw page. Retained evidence checks current content/authority separately from storage-only transitions. These components do not complete the all-worker mode fence or control capture: activation remains closed.

## 模式历史与单向提交

`mode_version=1` 是独立的迁移/启动合同。迁移器允许已知0→1升级，未知未来版本在DDL前拒绝；Memory runtime及启用shared header的Relay要求1。每个installation的`memory_source_modes`是持久输入代次历史，不能DELETE或重新分配installation ID；安装清理后保留无正文的opaque UUID/模式/代次屏障。停止输入使用`paused`及新的generation，不能通过删除模式记录恢复隐式generation1。runtime仍无该表的DML/TRUNCATE权限；管理者DDL重建不属于受支持的恢复路径。

原canonical-active执行的正向guard已经物理提交后，`transition_memory_source_mode`拒绝`legacy-feed`和`shared-shadow`，包括先paused再尝试旧输入的路径。允许保持paused或按新代次恢复shared-active；已发生费用/uncertain仍按独立账本完成，不清除或改写原execution历史。原执行回执是单向权威证明，不能在仍可切换模式的阶段被清理。影子未切换正向业务前的legacy输入仍使用原合同。该硬化不启用activation、不切DSN、不执行生产迁移。

## Accepted-delivery receipt 集合屏障

Relay显式迁移器安装`delivery_source_set_capture_version=1`，为`public.team_delivery_memory_sources`的INSERT/UPDATE/DELETE启用`memory_delivery_source_set_fence`。它复用既有submission privacy advisory命名空间，按OLD/NEW submission排序try独占锁；与持有同submission共享锁的最终消费者冲突时返回55P03并回滚，其他submission不受影响。Relay header启动与Team bootstrap要求精确marker/trigger；已知0可迁移升级，未知未来值在两服务DDL前拒绝。

该publisher屏障覆盖尚不存在的reader root；单个已知root的version/seal不能证明整个delivery集合完整。后续semantic group最终事务仍需先取同submission共享锁，在read committed新语句下重算有界完整roster并验证所有当前root/context/authority后再写派生结果。当前schema94只登记无正文、保留原始UUID/proof的preparatory语义元数据，`publishReady=false`，不把登记或publisher屏障当作完整语义consumer已启用。

## Trusted automatic input-start (Task 6)

The explicit Relay migration now installs native original-publication and installation-start capture (`native_input_start_contract=1`); the Memory migration installs `input_start_version=1`. For a fresh target, run the native Relay migrator first, then the Memory shared migrator, then Relay again to install shared capture and the reviewed role provisioner before starting a shared verify runtime. Existing shared input0 foundations may install native1 before Memory completes input1. Installed native/shared1 history loss is refused rather than reconstructed. Memory migrator entries check private native history before DDL. Runtime startup explicitly uses namespace/version verification plus the granted `shared.memory_input_start_ready()` definer capability, without native-table SELECT or DDL; unknown verification intents are rejected. Unknown future versions or missing capture hooks fail closed; independent legacy auto `initDB` remains supported. No old source gets a current-time/XID backfill.

New native `from_now` installations use their original MVCC snapshot, with a server ordinal only for same-transaction before/after ordering. Ordinary enumeration, direct ID and archive access enforce that start independently of the mutable Provider recovery checkpoint. Explicit `retained_history` and exact already-owned retained refs have separate current-authority policies. Old `from_now` installations with no immutable creation proof remain a migration/cutover gate; the mutable current Feed checkpoint is not proof of original start. The trusted archive decoder may hydrate an admitted head from a same-owner mixed chunk; it never returns excluded old heads, and all-old chunks remain denied. No activation or Feed retirement is implied.

See [the input-start contract](../../../../openspec/changes/unify-memory-relay-session-source/input-start-contract.md) for exact native/Team publication points, supported isolation, object/role/lifetime inventory, preserved Provider Snapshot recovery and the required later forward-migration policy. Dedicated synthetic suites use `INPUT_START_RELAY_TEST_DATABASE_URL` / `INPUT_START_MEMORY_TEST_DATABASE_URL`, exact matching NOSUPER fixture identities and an explicitly supplied same-host/DB `INPUT_START_FIXTURE_ADMIN_DATABASE_URL` for test role provisioning. Cross-service tests require a fresh compiled Relay build and record source/JS SHA identity.
