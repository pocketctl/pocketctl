# 合成个人用量契约

personal-v1.json由本任务隔离数据库与真实EventMaterializer生成，只有合成主机/模型/会话。十进制字符串保留BIGINT精度，null表示未知，coverage不假定完整。API dashboard/会话/调用/覆盖共享同截止快照；fixture中的签名已替换为非凭据标识，不能用于真实请求。

含365/366天哨兵：9×1200=10800进入all，第366天1200排除；热图始终90天。工具10包含MCP3，Skill1独立。来源mapping测试见internal/usageanalytics与adapter的usage analytics测试。
