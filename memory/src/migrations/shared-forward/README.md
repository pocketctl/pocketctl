# Forward-only namespace transfer

This is a dedicated maintenance executable. It imports neither application
initialization nor schema migrations. It never starts a Worker/model, changes
running DSNs, activates source modes, deletes the source, or creates backups.
Physical transfer verification is a separate gate from business acceptance.

Prerequisites:

- The reviewed source is the separate Memory database in `public`; the target
  already has the reviewed current Memory schema in `memory` and the closed
  shared contract. Every table must match its reviewed schema-version roster
  (187 tables at schema84, 191 at schema96); additive metadata is not invented
  in an older source.
- Drain the old database, revoke PUBLIC CONNECT, and fence every other LOGIN
  role with CONNECT. A dedicated read-only source role or explicit administrator
  observes it with server-enforced read-only connections. Other source backends
  cause refusal. The tool does not alter roles or terminate other connections.
- Stop target Memory processes and fence target runtime writers. Relay can keep
  using its own `public`. Target activation must remain false and modes must be
  legacy-feed/paused. Non-superuser LOGIN roles with target Memory DML privileges
  cause refusal. The target administrator needs staging DDL and the transaction
  local replication setting; runtime roles receive no such privileges.
- All target business tables must be empty. Only the fresh retention/control
  singleton rows may be replaced. The current migration registry is preserved.
  Use W5's reviewed mapping, capacity/window and deployment evidence before
  production; this command's successful exit does not replace those gates.

Set `SHARED_FORWARD_SOURCE_URL` and `SHARED_FORWARD_TARGET_URL` in the maintenance
process environment. There is no runtime DSN fallback. Create a private identity
file with exact `{source:{database,role,serverAddress,serverPort},target:{...}}`.
Server address/port are PostgreSQL's own observed identity, including when a
tunnel is used. Reports contain only fingerprints, schema metadata and digests.

```sh
# Run from memory/. Do not put connection URLs on the command line.
node dist/migrations/shared-forward/cli.js plan \
  --identity /private/identity.json --output /private/new-plan \
  --migration-id '<reviewed-uuid>' --code-sha '<frozen-40-character-sha>'

node dist/migrations/shared-forward/cli.js apply \
  --identity /private/identity.json --manifest /private/new-plan/copy-manifest.json \
  --capacity /private/reviewed-capacity.json \
  --output /private/new-apply-receipt \
  --migration-id '<same-uuid>' --code-sha '<same-sha>'

# After interruption, keep the same manifest and use a new report directory.
# Replace apply with resume; verify is independently read-only.
```

`apply` and `resume` require a private capacity evidence file. Bind
`schemaVersion: 1`, `kind: "memory-forward-capacity"`, `manifestHash`,
`migrationId`, `codeSha`, `sourceIdentity` and `targetIdentity` to the frozen
version 2 copy manifest. Supply UTC `measuredAt` and `validUntil` with a maximum
one-hour validity (strict ISO UTC, seconds or three fractional digits), and
`measurements` containing the measured `forward-only`
capacity-plan input. Copy/index duration must fit the remaining window. Include
existing allocation, current free space, target, staging allocation (measured
zero for the direct table transaction), temporary indexes, WAL, mapping material and growth, and an auditable
`evidenceId`. All sizes/durations are decimal strings. The command recomputes
capacity and safety margin before opening write connections, after scans or
lock waits, and before target mutations/transaction commits;
it never accepts a supplied `ready` flag. Expiry stops at the existing atomic
checkpoints. Remeasure before resuming with the same manifest. This admission
does not measure disk space itself or replace W5's actual rehearsal evidence;
invented/example measurements do not authorize production transfer.

The version 2 manifest binds identities, source/target shape, default-expression
and constraint-definition SHA-256 digests, function hashes,
indexes, triggers/ACLs, primary-key ordering, complete row counts/digests, original
column order, sequence values/settings and per-row byte limits. PostgreSQL row
JSON remains an opaque string: native bigint and JSON numbers never pass through
JavaScript's JSON parser. All database reads use UTC/ISO, hex bytea and explicit
float precision, with row_security=off; a role unable to see the full RLS relation
is rejected rather than silently exporting a filtered subset. Source and target
each have their own snapshot.

SQL default and constraint expressions can contain credentials. The manifest
records their digests, never their raw definitions. Version 1 copy manifests
are refused before opening a database connection. Freeze a version 2 plan only
against the original closed, pristine target; this is not permission to create
a replacement copy plan over target business state that has already advanced.

Rows retain an individual limit of 32 MiB (configurable downward via
`--max-row-bytes`). SQL withholds an oversized row body before returning it to
the driver. Writes concatenate opaque PostgreSQL row JSON into bounded arrays:
at most 128 rows / 8 MiB, or one larger admitted row. PostgreSQL parses the
array with json_populate_recordset; JavaScript never parses its numbers.
Measure the actual transfer window/WAL in W5. No row body is written
to reports, logs or local material. Unknown tables, missing PKs, unsupported
types/generated expressions, required new-column transforms or incompatible
sequence settings stop the operation.

The target table is locked before its initial digest is checked. Bounded rows
are then inserted directly into that closed table in the same transaction;
there is no second table or duplicate set of indexes. The streamed source
digest, copied legacy-column digest and complete target-column digest are
checked before the checkpoint and table data commit atomically. An interruption
after any accepted row rolls back the unfinished table and its checkpoint.
The private per-migration namespace remains empty for earlier resume compatibility.
User/FK triggers are bypassed only by the
administrator's transaction-local replication setting; constraints and unique
indexes still apply. Complete FK anti-joins (including MATCH FULL) are explicitly
checked after all tables, as cycles prevent relying on import order. Reviewed
generated columns are recomputed and compared. All original UUIDs, bytes, dates,
governance/budget state and JSON values are retained; the registry is the explicit
exception. Functions/permissions come from the target migrator, not dump rewriting.

Each version 2 checkpoint attests the complete current target row shape as well
as verifying the legacy source-column projection. Resume and verify reject
changes confined to newly added target columns, including typed source fields;
they cannot silently accept a new binding or privacy state just because every
legacy column still matches.

SIGINT/SIGTERM close both dedicated sockets, rolling back the unfinished table
and removing the unfinished report/reservation. Already committed checkpoints
remain. SIGKILL likewise rolls back the open database transaction, but may leave
a private report staging directory/reservation to inspect after the process is
confirmed dead. Resume checks the same manifest/schema/source and all completed
target digests before proceeding. Changed target data/sequence state is refused;
the tool never overwrites it with older source state. Repair current target
authority forward under a separately reviewed plan, never replay the old DB as
a fallback. Existing backups are neither created nor cleaned up by this tool.

Receipt limitations remain explicit: current Relay privacy/control overlays,
semantic JSON dependency closure, typed binding/bootstrap, capacity/WAL/locking
measurements, shadow/business acceptance and activation are separate work. This
tool does not establish them by copying bytes. Source body-retention/unknown
provenance flags remain unchanged. A changed target is not an invitation to
generate a new blanket copy plan: nonpristine target business state is rejected.

The manifest also binds a narrowly defined governance physical profile. If the
frozen source has already removed `knowledge_claims_active_identity_variant_idx`,
the plan records removal of that exact obsolete global v1 index from the empty,
closed target. Planning and verification are read-only. Apply validates both
catalogs, all source/initial-target digests and sequences, then drops only the
exact reviewed target index under an exclusive lock. No source governance
control, generation, knowledge or budget is rewritten. A changed index with the
same name is rejected. Resume accepts the bound prepared target and never
recreates the obsolete index; per-generation v1/v2 uniqueness stays enforced.

The additive `paged-cleanup` v4 executable handles deterministic bounded privacy
pages with immutable original membership and exact durable receipts. It requires
separate current native schema/capture installation and does not reinterpret the
older transfer/cleanup formats. See [MAINTENANCE.md](./MAINTENANCE.md#explicit-paged-privacy-cleanup-v4)
for configuration, supported adapter boundaries, native commit fences, limits,
resume behavior and the separate activation/business acceptance gates.
# 原 UUID 的有限规范引用绑定

物理复制及完整核验成功后，`original-reference-binding-cli.js` 显式绑定一个个人 Session 的1..256个已获 M0 `unique-hot` / `unique-cold` 证明的原 UUID。该工具不接入应用启动，不处理 Team semantic，也不授权删除。先完成当前隐私补齐、原库连接隔离、目标 Memory 写入隔离和必要 native/source contract；目标个人 mode 必须允许当前受控 reader，但应用仍停写。

```sh
node dist/migrations/shared-forward/original-reference-binding-cli.js \
  --input /private/path/original-binding-page.json --output /private/path/new-binding-receipt
```

URL 仅经既有专用 `SHARED_FORWARD_SOURCE_URL` / `SHARED_FORWARD_TARGET_URL` 注入。输入为 `{source,target,copy,scope,root,mappings}`：两库身份均包含精确 `database,databaseOid,role,serverAddress,serverPort`；`copy` 使用新版完整复制核验产生的 `forward-verification.json`（含两库身份、migrationId和source_events checkpoint/原列名册）；`scope/root` 为当前个人授权事实；`mappings` 为固定 M0 原结果，保留 unknown identity manifest。不要把 Journal 字符串版本转为 shared SourceVersion。

每页重验两库实际身份、原库冻结、目标写入隔离及原 checkpoint；逐条将目标原始列与仍保留的旧库按 PostgreSQL opaque JSON 摘要比较，不经 JS 重编码正文或大整数。原 unknown manifest 仍绑定旧库 xmin，不把复制后的 xmin 当作原库 xmin。通过当前 reader 取得真实版本三元组并验证正文，全部正文 IO 在 BEGIN 前完成；短事务内取现有 personal commit fence、规范投影互斥锁和目标 xmin CAS。任何一行变化整页回滚；已提交页可用同一证明幂等续作。原 UUID、origin、正文、原 hash、classification、provenance 均不改，仅写已验证规范引用字段；unknown 不补 sequence/lineage。回执只含元数据，文件0600/目录0700，拒绝覆盖。此操作不替代全量迁移、active FK/JSON闭包、隐私补齐或业务验收。

`retained-inbox-v1-original-identity` 还会从已冻结原源重新读取 Inbox 原身份、xmin、信封 hash 和回收标记，并用当前受控 reader 正文重建原信封 hash；任何变化整页拒绝。原正文保真比较、commit fence、CAS、UUID和未知序列约束相同。

同一入口也支持 `unique-cold`；必须经 `MEMORY_SHARED_ARCHIVE_DIRECTORY` 与 `MEMORY_SHARED_ARCHIVE_NAMESPACE` 配置现有只读归档，缺配置、对象损坏或当前 storage 不符均拒绝。`retained-ingress-key-v1-original-identity` 从原源有界重读业务 key，重算原 ingress hash，并在提交事务中重验实际唯一索引和当前 event key、持有该事件行锁。业务 event_id 不写回执；原 key、正文、provenance、UUID 不改。此分支同样要求当前 controlled reader、完整 copy receipt、原 xmin、commit fence 和整页 CAS。

## 必要原 Memory custody，未解决 canonical 关系

`necessary-original-custody-cli.js --input FILE --output NEW_DIR` 是另一个显式有限操作。输入为 `{source,target,copy,scope,root,sourceEventIds}`，身份及 URL 注入方式与上文一致。每页1..256个原UUID、同一个当前个人Session；仅接受无原业务key、无留存Feed/Inbox、原可信provenance为空的feed行。必须有当前accepted candidate所关联原episode manifest中的顶层显式source_event_id，或精确同installation/Session的artifact→source FK。普通文字、嵌套未知形状、同文及未引用行不能证明必要性。

显式输入 `necessity:"accepted-session"` 只用于同一当前个人 retained_history Session 的原引用闭合：该Session必须仍有关联的accepted候选及有效episode，原/目标candidate revision、status、episode state、digest、manifest和handles摘要一致，提交屏障内再次验证。它允许没有literal packet handle的该Session原单元格，仍要求无原稳定业务key、无Feed/Inbox、原正文/hash与空provenance完全相同；不替代canonical映射，也不把canonical身份未知当成缺失。默认 `literal-reference` 及通用M0限制不变，from_now、Team和无当前accepted依赖的Session拒绝。canonical writer的全Session unproven/conflict门保持不变。

显式 `discoveryWitness:{canonicalKey}` 仅与 `accepted-session` 一起用于原 `session_discovered`、无turn、空可信provenance的后续观察。原稳定key与literal event_id、实际唯一ingress索引必须一致；受控reader核验当前同owner/Session的canonical冷热正文，要求原时间更晚且正文不同，classification一致。存留Inbox/Feed必须独立通过原信封/正文证明；提交前重验准备时的canonical版本、行xmin、index和Feed。它只保留原UUID/单元格，witness不作为replacement，不补canonical等价/缺失或producer顺序。冷witness使用 `MEMORY_SHARED_ARCHIVE_DIRECTORY` 与 `MEMORY_SHARED_ARCHIVE_NAMESPACE`，缺失或损坏均拒绝。

它复用完整物理copy/checkpoint与逐原列opaque SQL摘要证明，校验原正文hash、当前个人/native权限与保留限制，并在同一commit fence中重验accepted依赖、锁定metadata和整页xmin CAS。原正文保留于复制后的同一单元格，绑定既有`legacy_archive` adapter，以原UUID作为key；不声称Relay等价、canonical缺失、去重或删除许可。原UUID、正文/hash、classification、provenance均不改，unknown不补sequence。提交后以现有controlled legacy reader核验；若该检查失败，目标保持关闭并前向修复，已提交custody不指回旧权威。原始输入、manifest和新回执可幂等续作，拒绝覆盖输出。

这不是M0 canonical身份证明：原`unproven` canonical结论继续保留，回执明确`canonicalIdentityResolved:false`及`canonicalAbsenceProven:false`。当前实现不接入应用启动，不支持组织/Team、未知全局JSON形状或未审历史全量保留。

## 个人 direct-launch 的有限隐私操作

`personal-direct-privacy-cli.js` 提供 `plan|apply|verify --input FILE [--manifest FILE] --output NEW_DIR`。输入为 `{database:{database,databaseOid,role,serverAddress,serverPort},scope:{personalInstallationId,organizationInstallationId},installationIds,units}`，仅经 `SHARED_FORWARD_TARGET_URL` 注入 URL。输出0600/目录0700且拒绝覆盖。目标必须已复制、关闭激活、应用排空且 Memory writer NOLOGIN；它不改变 mode、DSN、预算、正文或发布状态。

该专用路径维持通用 collector 的4096保护不变：个人 Session 根最多4096，每个既有元数据通道按真实PK分页256行，单cell8MiB、单页16MiB。SQL逐一验证所有显式标量/数组拼写与原installation/FK；不解析正文、普通UUID文字，不提升provenance。重复已验证引用压缩为有限根和通道摘要，不构造全局retained authority。组织必须仍是当前保留范围，若出现组织来源历史、Team引用、未评审Session数组、无法闭合的FK或超限则拒绝。合法SQL NULL无显式引用。独立user-accepted capsules保留原值。

当前Session不存在且无删除事实时，仅添加拒绝，原source cells继续保留；不声称canonical缺失或可删除。需要限制的Session若仍有episode/artifact/task/context依赖，或删除Session仍有原source行，交给既有显式前向修复，不在本入口清理。当前控制、scope或membership变化也拒绝。apply先只锁关闭的Memory表并分页核对摘要，再在10秒窗口锁当前public控制并以READ COMMITTED重读权限、写墓碑；公共控制锁内不扫描正文或重新分页全历史。同计划可验证和幂等续作；不自动激活。

`collectPersonalDirectClosure(...,{databaseLayout:'original-schema84'})` 仅供原库只读预检：要求server READ ONLY、repeatable snapshot、实际schema84及既有187表精确名册；只省略该版本原本不存在的四个后续表。该结果带独立layout标签，不能当作目标已复制/补齐的证明。目标apply只使用copied-target布局。

定向M0的retained identity planner仅在同一对只读RR Snapshot对象内复用已读取的scope/session元数据；以弱引用隔离不同快照，最多4096个scope/session键。它不缓存当前native authority、正文/归档、controlled reader或commit fence，也不将规划结果转为访问许可。新快照重新读取控制事实；原unknown lineage/sequence及原UUID/body约束不变。


搬迁cursor按128个小单元格分页（每个最多32KiB，整页小正文上限4MiB，PK另限4KiB/行）。大行仅返回原PK，再在同一RR快照/已锁目标表内单条读取，仍受原maxRowBytes门及总batch8MiB门约束；LATERAL使用OFFSET 0保证每个原行只计算一次opaque JSON，避免规划器展开重复编码。PostgreSQL row JSON全程不parse，64位数值、JSON及hash顺序不改变。

操作可显式设置 `--wal-checkpoint-bytes 67108864`（64KiB..128MiB）。该值写入copy manifest并绑定hash，plan/apply/resume/verify必须相同。copy在实际WAL LSN增量到阈值后用同一目标管理员连接执行CHECKPOINT，仍在原表事务内，不提交表或改PG配置、不手工移除WAL；checkpoint失败会让当前未提交表失败，已提交表保持前向resume。单个batch仍可越过阈值，其他数据库并发WAL也计入，不能把阈值当物理WAL上限。CLI保存 `copy-resource-observation.json`，区分累计生成量、观测物理值与真正容量准入；最终磁盘安全余量、峰值及有效窗口仍由独立capacity evidence准入，不由checkpoint回执授权切换。

运行容量准入在开始写入前预留完整copy/index预计时长；运行中持有不可变证据并反复验证身份、容量及同一不超过1小时的绝对deadline，不重复预留已经执行中的完整时长，也不能修改原输入延长期限。启用WAL checkpoint时，每批实际物理WAL相对运行开始时的增量还必须不超过已准入的walBytes；超出即拒绝当前表事务，先前已提交表保留供前向续作。该门是观察后停止，不声称物理WAL硬上限，容量仍需覆盖单批超量和当前已分配空间。
