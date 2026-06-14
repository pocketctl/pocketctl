## ADDED Requirements

### Requirement: 主机管理页面路由
Web 客户端 SHALL 新增 `/hosts` 路由，完整还原 hosts.html 设计稿。

#### Scenario: 访问主机页面
- **WHEN** 用户点击 sidebar「主机」链接
- **THEN** 跳转到 `/hosts`，显示双栏布局（左列表 + 右详情）

#### Scenario: sidebar 链接
- **WHEN** 页面加载
- **THEN** sidebar 管理组显示「主机」链接（带 badge 计数），active 时高亮

### Requirement: 主机列表面板
左侧面板 SHALL 显示主机列表，含状态筛选、搜索、列表项。

#### Scenario: 状态筛选 Tab
- **WHEN** 用户点击「在线」/「离线」/「全部」
- **THEN** 列表按状态过滤，Tab 显示对应计数

#### Scenario: 搜索
- **WHEN** 用户在搜索框输入文字
- **THEN** 按 hostname/ip/os 模糊匹配实时过滤

#### Scenario: 列表项展示
- **WHEN** 渲染每台主机
- **THEN** 显示状态圆点（在线绿/离线灰/重启橙）、主机类型图标、名称、IP·OS、活跃会话数
- **AND** hover 显示 ⋯ 按钮，点击选中该主机

### Requirement: 主机详情面板
右侧面板 SHALL 显示选中主机的完整信息。

#### Scenario: 详情头部
- **WHEN** 选中主机
- **THEN** 显示图标、名称、状态 pill（在线绿/离线灰/重启橙）、IP·OS·架构

#### Scenario: 操作按钮组
- **WHEN** 主机在线
- **THEN** 显示「重启 daemon」+「强制踢下线」（红色）+「查看会话」
- **WHEN** 主机重启中
- **THEN** 显示「正在重启…」禁用按钮带 spinner
- **WHEN** 主机离线
- **THEN** 显示「等待重连」

#### Scenario: 资源监控条
- **WHEN** 主机在线
- **THEN** 显示 CPU/内存/磁盘进度条（<60% 绿/60-80% 橙/≥80% 红）+ 百分比
- **WHEN** 主机离线
- **THEN** 显示灰色空条 +「—」

#### Scenario: 连接信息网格
- **WHEN** 选中主机
- **THEN** 2列网格显示 IP、端口、daemon版本、系统、运行时长、最后心跳

#### Scenario: 会话摘要
- **WHEN** 选中主机
- **THEN** 显示活跃会话数（accent 色）+ 历史总会话数（灰色）+「查看全部」链接

### Requirement: 主机操作功能
 SHALL 支持以下操作（通过 ⋯ 菜单或详情按钮触发）。

#### Scenario: 复制连接信息
- **WHEN** 点击「复制连接信息」
- **THEN** ip:port 写入剪贴板 + Toast 提示

#### Scenario: 导出主机报告
- **WHEN** 点击「导出主机报告」
- **THEN** 生成 Markdown 文件下载（含全部主机信息）

#### Scenario: 编辑别名
- **WHEN** 点击「编辑别名」→ 输入新名 → Enter
- **THEN** 调用 PUT /api/daemons/:id/alias + Toast 撤销

#### Scenario: 重启 daemon
- **WHEN** 确认重启
- **THEN** 发送 daemon_restart 命令，状态切 reconnecting，等待重连恢复 online

#### Scenario: 强制踢下线
- **WHEN** 确认踢下线
- **THEN** 调用 POST /api/daemons/:id/forceKick，状态切 offline + Toast 撤销

#### Scenario: 注销主机
- **WHEN** 确认注销
- **THEN** 从列表移除（历史会话保留）+ Toast 撤销

### Requirement: 注册新主机弹窗
- **WHEN** 点击「注册主机」
- **THEN** 弹窗显示安装命令（curl + pocketctl connect --token）+ 复制按钮

### Requirement: 响应式 + 无障碍
- **WHEN** 屏幕宽度 ≤900px
- **THEN** 双栏变单栏，详情取消 sticky
- **WHEN** 键盘 Tab 聚焦列表项 + Enter/Space
- **THEN** 选中该主机
