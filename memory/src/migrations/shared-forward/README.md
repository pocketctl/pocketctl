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
