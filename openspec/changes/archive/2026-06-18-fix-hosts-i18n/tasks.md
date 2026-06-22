## 1. Add i18n keys

- [x] 1.1 Add `hosts.*` keys to zh.json: `status_online`, `status_offline`, `agent_info_pending`, `token_host_total`, `token_today_consumed`, `token_month_consumed`, `token_no_records`, `kick_title`, `kick_desc`, `kick_confirm`, `kick_toast`, `unregister_title`, `unregister_desc`, `unregister_confirm`, `unregister_toast`, `upgrade_failed`, `copy_toast`, `rename_toast`, `upgrade_success`, `upgrade_error`, `alias_prompt`
- [x] 1.2 Add `hosts.*` keys to en.json with English translations
- [x] 1.3 Add `common.processing` key to both zh.json and en.json

## 2. Fix template hardcoded text

- [x] 2.1 Replace "版本待上报" in agent placeholder (line 161) with `t('settings.version_pending')` (existing key)
- [x] 2.2 Replace "等待 daemon 上报 Agent 信息" (line 162) with `t('hosts.agent_info_pending')`
- [x] 2.3 Replace "Token 消耗" section title (line 169) with `t('dashboard.token_usage')` (existing key)
- [x] 2.4 Replace "主机总计"/"今日消耗"/"本月消耗" (lines 171-173) with `t('hosts.token_host_total')` / `t('hosts.token_today_consumed')` / `t('hosts.token_month_consumed')`
- [x] 2.5 Replace "暂无会话消耗记录" (line 198) with `t('hosts.token_no_records')`
- [x] 2.6 Replace "取消" button (line 271) with `t('common.cancel')` (existing key)
- [x] 2.7 Replace "处理中…" loading text (line 273) with `t('common.processing')`

## 3. Fix script hardcoded text

- [x] 3.1 Replace `statusLabel()` return values "在线"/"离线" with `t('hosts.status_online')`/`t('hosts.status_offline')`
- [x] 3.2 Replace `agentVersionLabel()` fallback "版本待上报" with `t('settings.version_pending')` (existing key)
- [x] 3.3 Replace `agentMetaLabel()` fallback values "有新版本可用"/"已安装 · 最新"/"版本待上报" with `t()` calls
- [x] 3.4 Replace `showToast('升级请求发送失败')` (lines 461, 466) with `t('hosts.upgrade_failed')`
- [x] 3.5 Replace `showToast(\`已复制 ${conn}\`)` (line 568) with `t('hosts.copy_toast', { info: conn })`
- [x] 3.6 Replace `confirmKick()` dialog text (lines 601-605) with `t()` calls
- [x] 3.7 Replace `confirmUnregister()` dialog text (lines 619-625) with `t()` calls
- [x] 3.8 Replace `showToast(\`已踢下线「${name}」\`)` (line 605) with `t('hosts.kick_toast', { name })`
- [x] 3.9 Replace `startRename()` prompt (line 637) with `t('hosts.alias_prompt')`
- [x] 3.10 Replace `showToast(\`已重命名为「${name}」\`)` (line 641) with `t('hosts.rename_toast', { name })`
- [x] 3.11 Replace `showToast()` upgrade result messages (lines 672, 695-696) with `t()` calls

## 4. Verify

- [x] 4.1 Switch locale to "en" and verify: status labels, agent version texts, token section, dialogs, toasts all display English
- [x] 4.2 Switch locale to "zh" and verify all texts display Chinese (no regression)
- [x] 4.3 Run `npm test` in web/ to confirm existing tests pass
