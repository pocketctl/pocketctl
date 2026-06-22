## Context

HostsView 页面已完成基础 i18n 架构接入（`useLocale` composable, `t()` 函数），但约 20+ 处文本仍为硬编码中文。现有 `zh.json`/`en.json` 已覆盖大部分业务 key（335 个），但 HostsView 特有文本缺失。

翻译系统通过 `useLocale()` 的 `t(key, params?)` 函数工作，支持 `{{param}}` 模板替换。当前 `locale` 值从 localStorage 或浏览器语言自动检测。

## Goals / Non-Goals

**Goals:**
- HostsView 所有用户可见文本使用 `t()` 翻译调用
- 新增 ~20 个 i18n key，zh/en 双语言覆盖
- 复用 3 个已定义但未使用的 key（`settings.version_pending`、`common.cancel`、`dashboard.token_usage`）

**Non-Goals:**
- 不改变配置对话框的文本（RegisterDaemonDialog 已有自己的 i18n 覆盖）
- 不改变 exportReport() 生成的 Markdown 内容（导出数据使用中英混合可接受，非 UI 文本）
- 不改动其他视图页面
- 不引入新的 i18n 框架或语言包

## Decisions

1. **Toast/Confirm 带变量的文本用 `t()` 的 params 参数**——如 `` `已复制 ${conn}` `` → `t('hosts.copy_toast', { info: conn })`，用 `{{info}}` 占位
2. **`statusLabel()` 改为调用 t()**——`'在线'` → `t('hosts.status_online')`，`'离线'` → `t('hosts.status_offline')`。这是高频调用入口，改一个函数覆盖所有 UI 位置
3. **`agentVersionLabel()`/`agentMetaLabel()` 的 fallback 改为 t()**——移除硬编码回退值，全部走翻译
4. **新增 key 命名沿用现有约定**——`hosts.*` 前缀用于主机专属文本，`dashboard.*` 用于通用仪表盘文本，`common.*` 用于通用 UI 文本
