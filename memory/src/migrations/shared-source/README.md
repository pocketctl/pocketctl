# Shared-source M0 maintenance

独立只读工具，不启动 API/Worker/schema migration，不读取应用 DSN，不调用模型。首批提供 `inventory`、`map-plan`、`capacity-plan`，不包含 apply、copy、切换、删除或生产部署。

## 调用

在 checkout 使用 Node22 和 memory 的 tsx，或使用 Memory 运行镜像的 `node dist/migrations/shared-source/cli.js`。归档 codec 和 accepted-delivery builder 均来自独立纯包 `@pocketctl/session-source`，不再依赖 Relay 源码树或导入 db/startup。

```sh
npm --prefix memory run migration:shared-source -- --help
npm --prefix memory run migration:shared-source -- inventory \
  --identity /private/path/expected-identities.json \
  --output /private/path/new-inventory \
  --migration-id m0-20261106 --code-sha <40-character-source-sha>

npm --prefix memory run migration:shared-source -- map-plan \
  --identity /private/path/restored-identities.json \
  --output /private/path/new-mapping \
  --migration-id m0-20261106 --code-sha <40-character-source-sha> \
  --snapshot-id restored-backup-manifest-id --page-size 256

npm --prefix memory run migration:shared-source -- capacity-plan \
  --input /private/path/measured-capacity.json \
  --output /private/path/new-capacity \
  --migration-id m0-20261106 --code-sha <40-character-source-sha>
```

DB 凭据仅通过专用 `SHARED_SOURCE_MEMORY_URL` / `SHARED_SOURCE_RELAY_URL` 注入。不要把实际 URL、正文或完整报告加入 Git。已有应用的 `MEMORY_DATABASE_URL` 等不会被使用。

身份文件每库都必须有以下显式值，不能用 wildcard；可额外指定 `databaseOid`。`serverAddress`/`serverPort` 是数据库侧 `inet_server_addr()` / `inet_server_port()`，不是 Docker 对外映射端口或客户端主机名。文件只用于本地预期校验，报告只含身份指纹。

```json
{
  "memory": {"database":"memory_restore", "role":"inventory_reader", "serverAddress":"127.0.0.1", "serverPort":"5432", "mode":"isolated-restore"},
  "relay": {"database":"relay_restore", "role":"inventory_reader", "serverAddress":"127.0.0.1", "serverPort":"5432", "mode":"isolated-restore"}
}
```

`inventory` 可使用 `mode=inventory`。隔离演练的 `map-plan` 使用两库 `isolated-restore` 且数据库名有 test/restore/rehearsal 段。本次无备份实施也支持 Memory `frozen-maintenance` + Relay `live-readonly`：两个 identity 都必须填写相同 `maintenanceWindowId`，并与 `--snapshot-id` 一致。Memory 必须真实排空所有其他连接、撤销 PUBLIC CONNECT、隔离其他 LOGIN 角色；专用只读源角色不得有表写权限，显式管理员除外。工具只检查这些条件，不修改角色、停止服务或新建备份。其他用户的统计字段隐藏时仍统计全部其他 backend，不能把隐藏的 backend_type 当成无连接。

两个连接必须指向不同数据库身份。逐库 repeatable-read/read-only，statement_timeout=5s、lock_timeout=1s，默认只读与 row_security=off 在连接/事务中强制设置。RLS 无法读取全量时拒绝，不把过滤后的数据当全量。两库不是跨库一致快照，物理大小/统计也不受 MVCC 冻结；Relay 当前权限、墓碑与对象仍需在应用/提交时重验。

## 对象合同

当前用户选择 Memory 无备份、无回滚的单向迁移；`capacity-plan` 默认 `policy=forward-only`，不要求 restoreBytes/restoreSeconds，不创建备份或恢复副本，仍要求目标/COPY/索引/WAL/增长/安全空间实测。报告将取消的检查列为 `waivedChecks`，不标记恢复通过；显式 `policy=recoverable` 仅用于重现历史容量合同，不是本次上线方式。完整决策见 `openspec/changes/unify-memory-relay-session-source/forward-only-policy.md`。

`inventory.json` 与 `namespace-audit.json` 包括全部非系统 schema 中的表/列结构指纹、函数、触发器、索引、约束/FK、序列及归属、扩展、类型、视图、规则、RLS、权限、角色和默认权限。函数体、默认值和角色配置只存 hash，不导出潜在敏感字面量。ACL 显示 privilege/grantable，grantor/grantee 和 owner 使用指纹。函数另外给出固定 search_path、安全定义者及动态 SQL 等审计提示；提示或 hash 不证明动态 SQL 已安全。

冻结的 `table-policy.ts` 包含当前 schema96 的191个表名及建议分类；schema84来源对应187表子集。**建议不是迁移批准**。每个对象，包括已知表和 Relay 保留对象，都需要明确审阅其精确 definitionHash 后通过 `--object-plan FILE` 指定；新增对象及 hash 变化阻断。

```json
{"memory":{"table:public.source_events":{"action":"transform","definitionHash":"<reviewed-64-hex>"}},"relay":{}}
```

允许 `migrate-as-is / transform / retire-after-gate / derived-rebuild / audit-archive / retain-relay`。retire-after-gate 不执行删除。未分类对象保持 unclassified；不得为消除红灯把所有对象一律批准。对象权限/函数命名空间的实际迁移属于 R1 后续合同。

## 来源证明

- 保留 source UUID，以 Inbox、留存 Feed、snapshot 原 ID 或可信 persisted producer/Journal 关系查找 canonical IDs；不把 feed_id、source_seq、event id 混用，不按正文搜索认定来源。
- 联合校验 installation→owner、Session、turn、类型、canonical JSON SHA-256、classification、provenance 与 source sequence。来源与候选重复或版本冲突有独立结果，unknown 不升级可信。
- Journal已按保留策略移除时，原始Relay v1 Feed信封可提供原server sequence：必须同时精确匹配外层canonical身份/owner/Session、正文hash、内层source和subject、Memory provenance及重算后的classification。与native header、其他Feed witness或Journal矛盾仍拒绝；producer payload sequence不能替代server sequence，unknown不因此升级。
- 每页最多 256，keyset 遍历原 source UUID；单正文上限 32 MiB。`--max-rows` 明确生成 `fullMappingExecuted=false`。全遍历成功只表示每条都评估，不表示每条都证明成功。数据库错误/缺列/权限/超时使本次输出失败，不产出伪完整报告。
- 冷数据可加 `--archive-dir DIR --archive-namespace NAMESPACE`，仅接受本地恢复的对象树；复用 Relay codec 的 binding、压缩和原文 hash 校验，单缓存块，上限 32 MiB raw / 16 MiB compressed。远程 archive provider 未接入时保持 archive_unverified，不能凭 manifest 行通过。
- Team collaboration 依据真实事件集合、call、binding、participant 和 membership；delivery 依据 decision/submission/spec/无正文 capture receipt，用生产纯 builder 和 Memory adapter 重建比较，保持独立 source kind，无伪造 event lineage。缺对象/历史版本不可证明时阻断，不猜测。
- Relay 旧 deleted_sessions 缺 owner 字段，只有同时证实事件/owner 关联才给 known-deleted；否则 deletion_owner_unproven。撤回 delivery 使用权威 receipt。不存在候选不是合法删除证明。
- `--legacy-in-place plan` 显式启用只读历史custody规划：需要原Inbox/Feed/Journal/snapshot明确canonical身份、原hash，以及Memory/Relay个人owner scope/epoch/config/provider一致；按精确canonical key检查全部冷热metadata，不能按同文匹配。生成绑定两快照、原UUID/身份/顺序/hash格式及正文/分类/provenance hash的manifest，唯一必要正文留在原单元格。它不导出正文、不创建备份或执行绑定。unknown lineage保持unknown；缺证明仍为unproven，所有行deletionEligible=false。
- 历史 snapshot 的原 hash 可能覆盖整个四字段事件信封，而非仅 payload。仅在使用原 event ID、类型、时间和正文重算后精确命中原 hash 才识别该格式；输出分别记录 originalSourceHash/originalHashVersion 与 canonical contentHash。不改旧 digest，不据格式证明 owner/provenance，不以同文关联来源。
- 每条结果 `deletionEligible=false`。即便 replacementProven=true，active FK/JSON 依赖闭包、当前生产授权、reader 等价性、单向切换/修复与删除前复核尚未完成。Memory 备份/恢复/回滚列为 waived，不再作为未满足门槛。

## 证据、容量与退出码

输出新目录，父目录须已经存在；0600 文件、0700 目录；staging + 独占 reservation，全部文件同步后完成，拒绝覆盖既有目录。`run.json` 为完成回执。SIGINT/SIGTERM 取消连接，回滚释放事务并清理 staging/lock。SIGKILL/机器断电可能留下 `.partial-*`/`.lock`；应先核验进程已退出，再人工清理该次范围。不会自动覆盖或续写未审查的旧报告。

精确总数在同一只读 RR 快照内按最多 8192 个 UUID 主键分页累加，包含零 UUID；正文页明确按原生 UUID 列排序，避免 text 输出别名导致全表排序。每条语句仍保留 5 秒超时。安装事实、删除状态和 transport 是否存在按当前页读取；它们仅是该历史快照的元数据，原始正文/hash/身份 witness 仍逐条验证，正文 IO 前后的 fresh native authority 不缓存。不以统计估计代替总数，也不把 transport 缺失提升为来源证明。

已有完整扫描可另附 `--source-ids JSON_FILE` 定向复核。文件为1..4096个唯一小写UUID的JSON数组，在打开数据库前校验。该报告始终 `fullMappingExecuted=false`，单独记录选集hash、请求/缺失数量及 `selectedMappingExecuted/selectedProofsComplete`；任何缺失或未证明来源均不通过选集证明。它不改写、覆盖或冒充原全量报告，也不能仅凭选集声明完整active依赖闭包。

原 v1 Feed、Memory Inbox 和 canonical 热来源若能独立证明相同身份、owner/session/turn/type、正文/classification hash、毫秒时间和当前 scope custody，可为 `provenance_unknown` 记录独立原始身份 manifest。只接受原可信 provenance/classification 通道均无 Memory proof、无已知 Journal/header sequence 的有限情形。Feed 缺失可选 turn 与 SQL NULL 归一；正文中的 `memory_source` 只是受原正文 hash 约束的字节，不用它补 producer lineage、`non_skill`、sequence 或 sourceVersion。原 provenance 保持 unknown，原 body/UUID/hash 不改；当前 runtime 授权与绑定仍另行验证。

原 Feed 已裁剪时，原 Inbox 的不可变 v1 信封 hash 可提供独立证明：用原 Inbox 元数据和原 source 正文/classification 精确重建信封。传输已回收须同时有回收标记、data={}、classification={}；无标记的空值不得补入原正文。仍核验原身份、当前 owner/daemon/scope、xmin、canonical 正文及时间。缺失 turn 与 NULL、零毫秒时间字面量只作为有限候选，必须完整 hash 相同。记录 `retained-inbox-v1-original-identity` manifest，unknown 保持 unknown，不恢复 Journal 顺序、不授权读取或删除。Feed 仍存在但矛盾时不能转用此分支。

Feed/Inbox 都不存在时，只允许原 Memory `canonical_event_key=event_id:<原正文外层event_id>` 通过既有 Relay ingress hash 合同定位；要求实际 `idx_events_dedup(session_id,event_hash)` 为无条件、有效、ready 的唯一 btree 索引。候选仍须完整通过原正文/hash/classification/时间及当前 owner/daemon/scope 校验，冷正文须经真实归档 namespace、owner/epoch、压缩和原文 hash 校验。`retained-ingress-key-v1-original-identity` 仅导出 key/index 摘要，不导出业务 event_id，不建立 producer lineage、Journal 顺序或删除许可。缺失 key、矛盾 transport 或非唯一索引保持拒绝。

`--pre-native-logical plan` 只接受 nullable varchar(128)、无默认/identity/generated 且尚无 native authority/alias 表的预填准备态；已有值必须等于原 Session。它在 summary 显式标记，不接入 runtime；正式绑定仍要求完整当前 native contract。

`mapping-details.ndjson` 只含 source/installation UUID、typed canonical ID、原 hash/格式、content/classification hash、source version/sequence、身份关系、判断与原因；无 payload/session text/凭据。大整数为十进制字符串。`run.json` 绑定 codeSha、migrationId、运行 ID 和 snapshotId（隔离材料或已审维护窗口 ID）；未提交代码需在外部证据另附源码树 hash。

capacity 输入：

```json
{
  "policy":"forward-only", "existingAllocatedBytes":"15436462190", "freeBytes":"8958959616",
  "targetBytes":"0", "stagingBytes":"0", "temporaryIndexBytes":"0", "walBytes":"0",
  "mappingBytes":"0", "growthBytes":"0",
  "copySeconds":"0", "indexSeconds":"0",
  "evidenceId":"replace-with-actual-isolated-rehearsal-id"
}
```

以上 0 只是格式说明，不能作为真实测量。分别列出现存分配（不再次加进新增峰值）、目标/staging/临时索引/WAL/映射/增长实测；不要求 Memory 恢复副本。安全余量 max(向上取整新增峰值的30%,2GiB)，未来收益记0。缺任何测量/时长/evidenceId 或空间不足返回 not-ready。容量报告v2强制要求 stagingBytes：单表阶段包含目标表和全部复制索引的最大同时分配；WAL须覆盖staging与目标的实际写入。缺少staging实测同样返回not-ready；旧v1报告不足以批准row-staging迁移。始终 `migrationAuthorized=false`。

退出码：0=工具该项报告无未通过的门槛；2=参数/读取失败且无完成报告；3=报告完成但有阻断（map-plan 因闭包/切换未验收始终3）；130/143=中断。inventory 无分类批准时通常返回3。不要将非零3误作报告文件损坏或将0误作生产许可。

测试：`npm --prefix memory test -- src/__tests__/shared-source`；双版本隔离演练：`node scripts/verification/shared-source/run.mjs /private/path/new-evidence-dir`。脚本只启动有唯一名称/标签的临时 PG13/17 容器，结束删除自己的容器，不接触本机 daemon/已有容器或生产。

## 离线逐对象审核

`object-review-cli.js` 只读取脱敏目录元数据，不连接数据库。Memory 基线必须
由本仓库的 schema 84 在空隔离 PG13 数据库独立生成；不能把 live 目录复制成
Memory 基线。重建入口是
`scripts/verification/shared-source-r1/reproduce-catalog.mts`，只接受显式
`RUN_SYNTHETIC_CATALOG_REPRODUCTION=1`、loopback 和 `shared_catalog_*test` 空库。
`CATALOG_REPRODUCTION_TEST_URL` 仅经环境注入。参数是 live inventory 文件和新报告目录。
脚本记录每个 migration 语句哈希，重建已审 retention 两索引，并输出精确 FK
触发器等价证明、序列配置证明及 extension 成员。源表正文不会读取或导出。

```sh
# 在 Node22 的 memory/ 或对应运行镜像中执行。
node dist/migrations/shared-source/object-review-cli.js \
  --inventory /private/live/inventory.json \
  --baseline /private/reproduced/reproduced-inventory.json \
  --proofs /private/reproduced/reproduction-proofs.json \
  --relay-baseline /private/frozen-relay/inventory.json \
  --output /private/new-object-review
```

Relay 使用固定、已审保留目录：逐 key/hash 比对，不导入或删除 public 对象。
全局旧 Memory owner 在两库报告都标为 retire-after-gate，实际删除仍须当前依赖
核对。序列 live state 是时间点元数据，维护窗口排空后须刷新；不把正常序列
推进当 schema 漂移。每份 plan 都绑定本次精确 hash，新对象、未知对象、变更权限、
无效索引、缺失 Relay 保留对象或不完整 Memory 表名册均阻断。退出0仅代表目录
审核完成；2代表拒绝或不完整。固定范围仍须全量 mapping/active 闭包/容量验收。

来源summary穷尽列出10种状态，未出现也输出十进制字符串0；分开记录全遍历、
身份证明完整性、unknown provenance、必须保留的legacy正文和未解映射行数。
逐行custody获证仍不能替代active FK/JSON闭包、当前权限、容量和切换验收。
抽样不会使mappingProofsComplete为true。可选canonical header/storage列先从catalog
枚举再显式投影，不to_jsonb整条正文行；Inbox/Feed/snapshot等witness同样限制32MiB。


## Native Session alias source/storage identity contract

Relay 的 `public.session_aliases`（owner/original daemon/request daemon/immutable edge/revision/blocked）
与 `public.session_alias_revision` 是保留的原生路由控制；events.logical_source_session_id
是不可变逻辑来源，events/body document versions 的 body_session_id 是不可变 archive 存储身份，
object deletion 的 deletion_subject_session_id 是清理主体。native_session_alias_set、
native_session_authority、guard_native_alias_edge、guard_native_session_alias、
scrub_native_session_alias_owner、preserve_event_logical_session、adopt_native_session_owner、
guard_native_alias_privacy、preserve_native_archive_identity 及其触发器/索引/约束
必须进入新的独立冻结 Relay inventory。旧冻结目录上的任何新 key 或 definitionHash 变化继续阻断；
这些对象不进入 Memory TABLE_POLICY，也不获自动放行。新的逐对象审核只允许原样 retain-relay。

存在新 native identity 列时，mapping 使用 immutable logical Session 校验原 provenance/sequence/hash，
使用当前 native owner/完整 alias component/revision 校验路由，cold codec 使用 body_session_id；
缺失/null/冲突 storage identity、当前 owner/route 不符均拒绝。旧列完全不存在时只接受旧精确
manifest owner/session/epoch tuple。原 Session、UUID、正文 hash 与 provenance 都不重写。
文件 IO 及 cache 命中前后重新读取当前 native authority；frozen snapshot 的 schema/body 证据不能
替代最终 apply/COMMIT 的当前权限验证。新 native schema 必须显式迁移后才启动运行服务。

当前 owner 变更会关闭原 owner 的历史边和原 event owner；新 owner 的全新事件只在其当前
owner component 中授权。原 owner 旧 hop 的隐私标记不会授权/删除/撤销另一 owner 的新事实。
原 event user_id、logical Session、hash、provenance 均不随当前 owner 移动。匿名 adoption
只在当前 daemon account 的精确绑定与原 daemon 相同且原 owner NULL 时原子推进 native
Session/alias owner；不会提升原 NULL-owner event。

Snapshot v1 的原始 envelope/UUID/hash/occurred_at 保持原值。其已知 Date.toISOString()
毫秒序列化与独立 fresh native head 的完整时间戳分开验证；只接受该精确已知变换，
不使用任意时间容差，也不改写 canonical native timestamp。最终 source 冲突比较使用
已按 event ID/owner/logical Session/current route/type/body hash 证明的精确 native head witness。
未知/未来的 versioned source binding 拒绝。每代完整 logical Session/event roster 在 COMMIT
之前重新比对并持有当前 source fences；所有 body/archive IO 均先结束。

Native authority contract v3 使用单调 owner_boundary；真实 owner 变更建立永久边界，
历史 old-name forward lookup 仍拒绝，当前 component 不越过该边界，即使 A→B→A。
privacy block 不清除 owner boundary；旧 blocked/未知原因不推断为 owner boundary，继续拒绝。
原 Session/Memory retention tombstone 不清除。session_documents_route_fkey 只 cascade
session_id，metadata/upload owner guard 与 version immutable guard 保持原 owner；
后续当前 owner 的精确新路由边只授权路由字段变化，不提升旧正文或 metadata。
preserve_session_document_owner、session_document_owner/session_document_upload_owner 与
新 owner_boundary 列/约束定义均须进入新的独立 native inventory freeze/review。

owner_retired 是 events 与 document metadata 上单调的 server-owned 权限状态；真实 owner cut
在完整 native fence 内按 route 集合置位所有旧引用（包括 legacy foreign original），不修改
owner/source UUID/hash/provenance/payload/version。新事实使用新 canonical/document identity。
public.native_event_authority(bigint,integer) 证明原 logical Session、当前 route 与未退休的精确 event；
M0 的 currentNativeSessionAuthority 可接收受限 eventId，并通过独立短 READ COMMITTED
READ ONLY 连接在 IO/cache 前后读取该证明，绝不用原 RR snapshot 当当前权限。
events_owner_retirement/preserve_native_owner_retirement、document owner/version insert guards、
两处 owner_retired 与 owner_boundary 列和 native_event_authority 定义都必须进入独立 native freeze。
未知/缺少 required marker 或旧 blocked reason 不作猜测修复。原 legacy_archive 的 owner_changed/
privacy/retention barrier 原样保留；仅 native v3 canonical path 经每个 event 证明后接收 post-cut 新事实，
Memory session tombstone 仍无条件拒绝，绝不清除。

Owner cut 对 events/document metadata 作 set-based 更新与有序 FOR UPDATE NOWAIT；原生 fence
与独立行锁冲突会整条回滚。该方式不限制大 Session 的 CPU/WAL 工作量；继承调用方 statement
期限（未设置时 PostgreSQL 默认 0），不增加线上限额，不进行 per-install fanout 或外部 IO。
当前合成 fixture statement_timeout=10s/lock_timeout=1s；真实2CPU、WAL、容量与大批工作仍属
T7.3 未接受门禁。既有 content capture 记录退休 flag 变更，因此 retained physical COMMIT 仍比较
新 content revision；不引入新的 Session clock/epoch，也不把跨数据库观察描述为原 RR 原子快照。

R2 migration input guard 在 initDB 首次 DDL 与直接 native installer 之前只读检查输入：
已安装但无法证明 retirement 的 v1/v2/未知 native 版本拒绝；legacy0 如有已记录 owner_changed
history 也拒绝。有效 v3 的必需 event/document retirement field/guard 缺失属于 drift，
不自动 ADD DEFAULT FALSE；合法初始0和完整v3重复迁移保留正常工作与原 flags/barriers。
这不是历史 owner/incarnation 重建，也不清除旧 barrier。

Cooling 在 encode/PUT 之前、最终 publication 与 remaining-work 中使用同一 owner/retirement
边界：只接收当前 lease owner 的未退休 original event/document；原 NULL event 只保留既有
native custody 语义，绝不提升 original user/provenance。退休或已知 foreign original 热正文
留在原 canonical custody；其物理 hot 状态保留 Session mixed，但不造成当前 owner 的永久
partial retry。B 的正常新事实仍可 cooling/hydration，读取不会触碰保留的 A 对象。

Account erase 在完整 native fences 后、任何 team/extension/business DELETE/UPDATE 之前
检查既有 NONNULL foreign/mixed archive custody；发现后返回 typed
native_archive_custody_repair_required，不删除 A 行后虚报物理隐私完成，也不删除 B 活跃 chunk。
已证明 original NULL + 精确 A manifest/session/epoch/chunk custody 的引用会在 A manifest 前
清理，不把 custody owner 当作 original user。既有错误混合或无法证明/已丢失引用的历史对象
仍是 M0/forward repair gate；本轮不 repack、重写正文、推断历史 owner 或自动修复未知对象。
