<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>{{ t('settings.privacy_policy') }}</h3>
        <button class="close-btn" @click="$emit('close')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="update-date">{{ locale === 'zh' ? '更新日期：2026年8月26日' : 'Updated: August 26, 2026' }}</div>

        <!-- Chinese version -->
        <template v-if="locale === 'zh'">
        <section>
          <h4>一、我们处理的信息</h4>
          <p>pocketctl（以下简称“我们”）为提供跨设备 AI 编程会话控制服务，会处理以下信息：</p>
          <ol>
            <li>账户信息：邮箱地址、显示名称，以及邮箱验证码或 OAuth 设备授权产生的账户和令牌标识。</li>
            <li>设备与推送信息：设备型号、操作系统版本、设备标识符、推送令牌和应用环境。</li>
            <li>主机与连接信息：主机名、Daemon 标识、在线状态、网络地址、IP 地址和 User-Agent。</li>
            <li>会话内容与元数据：工作目录、会话标题、提示词、回复、命令、路径、差异内容、工具输入输出、审批与问题、错误、状态、时间和用量信息。</li>
            <li>Memory 信息：在您显式开启 Memory 后，我们会从已同步的会话事件生成有界且按规则筛选的 Episode Packet，并处理由此提取的记忆候选、您审核接受的记忆、证据引用、向量表示、反馈和功能设置。</li>
            <li>候补名单信息：您主动提交的 iOS Beta 通知邮箱。</li>
          </ol>
        </section>
        <section>
          <h4>二、处理目的</h4>
          <ol>
            <li>账户认证、设备授权和安全审计。</li>
            <li>在客户端、Relay 与 Daemon 之间路由控制消息，并持久化事件以支持历史记录和断线重放。</li>
            <li>发送任务完成、错误、审批、问题和主机状态等通知。</li>
            <li>执行配额统计、故障排查、滥用防护和服务改进。</li>
            <li>在您显式同意并开启相应功能后，提取、审核、保存和检索个人工程记忆；Memory 默认关闭。</li>
          </ol>
          <p>我们不会出售您的个人信息。</p>
        </section>
        <section>
          <h4>三、第三方处理者</h4>
          <ol>
            <li>腾讯云邮件服务（SES）：处理收件邮箱、验证码和必要的服务邮件内容。</li>
            <li>DeepSeek：在服务配置了 API Key 且触发标题生成时，处理用于生成标题的用户消息和助手回复；在您对 Memory 模型出口显式同意并开启提取后，还会处理经筛选、截断和脱敏规则生成的有界 Episode Packet，用于记忆候选提取。未配置或未开启相应功能时不会执行该调用。</li>
            <li>阿里云百炼 DashScope：仅在您对 Memory 模型出口显式同意并开启向量功能后，使用 qwen3.7-text-embedding 处理待索引的已接受记忆文本和检索查询，以生成向量嵌入；未配置或未开启时不会调用。</li>
            <li>Apple Push Notification Service（APNs）：处理设备推送令牌和通知载荷。通知预览可能包含会话标题、主机名、命令、路径、审批摘要或问题内容。</li>
          </ol>
          <p>第三方服务依据其自身条款处理数据，其处理地域可能不同于我们的主要服务地域。</p>
        </section>
        <section>
          <h4>四、存储与传输安全</h4>
          <ol>
            <li>生产环境客户端与服务之间使用 HTTPS/WSS（TLS）传输。</li>
            <li>iOS 认证令牌存储于 Keychain，Web 访问令牌仅保存在当前页面内存中，刷新令牌使用 HttpOnly Cookie。</li>
            <li>Relay 会处理并存储会话事件，并可以读取当前会话事件内容。</li>
            <li>主要数据库、基础设施日志和第三方处理服务可能位于不同地域，具体取决于实际部署与服务商配置。</li>
            <li>Memory 的模型 API Key 仅保存在服务端；模型出口按安装独立控制，关闭相应功能会停止后续文本提取或向量模型调用。</li>
          </ol>
        </section>
        <section>
          <h4>五、保存与删除</h4>
          <ol>
            <li>账户、主机、会话、事件及已接受的 Memory 记忆通常在账户有效期间保存，直至您删除相关数据、安装或账户；待审核候选和技术作业数据按产品与运维清理规则处理。</li>
            <li>删除账户会触发对当前业务数据库中关联账户数据的删除。</li>
            <li>Nginx 访问日志、Relay 审计日志、第三方服务日志和备份按照各自的运维保留周期清理，可能不会与账户删除同步完成。</li>
            <li>iOS Beta 候补邮箱保存至完成通知、您请求删除或候补计划终止。</li>
          </ol>
        </section>
        <section>
          <h4>六、您的权利</h4>
          <ol>
            <li>在应用中查看和更新账户资料。</li>
            <li>导出当前产品支持导出的账户和会话数据。</li>
            <li>通过“设置 → 账户 → 删除账户”删除账户和当前业务数据。</li>
            <li>通过关闭推送权限、退出候补名单或联系我们撤回可撤回的处理同意。</li>
            <li>在 Memory 设置中关闭提取或向量功能会停止后续相应模型调用；删除记忆、安装或账户会触发当前业务数据库中对应 Memory 数据的删除或失效处理。</li>
          </ol>
        </section>
        <section>
          <h4>七、未成年人和政策更新</h4>
          <p>本服务不面向 14 岁以下未成年人。我们更新本政策时会修改版本和生效日期；重大变更将通过应用内通知、网站或电子邮件告知。</p>
        </section>
        <section>
          <h4>八、联系我们</h4>
          <p>如需行使权利或咨询本政策，请通过应用内“帮助与反馈”或邮箱 james_2001_2001@163.com 联系我们。</p>
        </section>
        </template>

        <!-- English version -->
        <template v-else>
        <section>
          <h4>1. Information We Process</h4>
          <p>pocketctl (&quot;we&quot;) processes the following information to provide cross-device control of AI coding sessions:</p>
          <ol>
            <li>Account information: email address, display name, and account or token identifiers created by email verification or OAuth device authorization.</li>
            <li>Device and push information: device model, operating-system version, device identifiers, push token, and app environment.</li>
            <li>Host and connection information: hostname, Daemon identifier, online state, network address, IP address, and User-Agent.</li>
            <li>Session content and metadata: working directory, title, prompts, responses, commands, paths, diffs, tool inputs and outputs, approvals, questions, errors, status, timestamps, and usage.</li>
            <li>Memory information: after you explicitly enable Memory, we generate a bounded, policy-filtered Episode Packet from synchronized session events and process extracted memory candidates, memories you accept, evidence references, vector representations, feedback, and feature settings.</li>
            <li>Waitlist information: an email address you submit for iOS Beta notifications.</li>
          </ol>
        </section>
        <section>
          <h4>2. Purposes</h4>
          <ol>
            <li>Account authentication, device authorization, and security auditing.</li>
            <li>Routing control messages among clients, Relay, and Daemon, and persisting events for history and reconnect replay.</li>
            <li>Sending task, error, approval, question, and host-status notifications.</li>
            <li>Quota measurement, troubleshooting, abuse prevention, and service improvement.</li>
            <li>After your explicit consent and activation of the relevant feature, extracting, reviewing, retaining, and retrieving personal engineering memories. Memory is off by default.</li>
          </ol>
          <p>We do not sell your personal information.</p>
        </section>
        <section>
          <h4>3. Third-Party Processors</h4>
          <ol>
            <li>Tencent Cloud Simple Email Service (SES): processes recipient email addresses, verification codes, and necessary service-email content.</li>
            <li>DeepSeek: when an API key is configured and title generation is triggered, processes user messages and assistant responses used to create a title. After your explicit consent to Memory model egress and activation of extraction, it also processes a bounded Episode Packet produced by filtering, truncation, and redaction rules for memory candidate extraction. The applicable call is not made when unconfigured or disabled.</li>
            <li>Alibaba Cloud Model Studio DashScope: only after your explicit consent to Memory model egress and activation of vector features, qwen3.7-text-embedding processes accepted-memory text to be indexed and retrieval queries to produce vector embeddings. It is not called when unconfigured or disabled.</li>
            <li>Apple Push Notification Service (APNs): processes device push tokens and notification payloads. Notification previews may contain a session title, hostname, command, path, approval summary, or question content.</li>
          </ol>
          <p>Third parties process data under their own terms, and their processing regions may differ from our primary service region.</p>
        </section>
        <section>
          <h4>4. Storage and Transport Security</h4>
          <ol>
            <li>Production client-to-service traffic uses HTTPS/WSS (TLS).</li>
            <li>iOS authentication tokens are stored in Keychain. Web access tokens stay in page memory, while refresh tokens use an HttpOnly cookie.</li>
            <li>Relay processes and stores session events and can read current session-event content.</li>
            <li>Primary databases, infrastructure logs, and third-party processors may operate in different regions according to the actual deployment and provider configuration.</li>
            <li>Memory model API keys remain server-side. Model egress is controlled per installation; disabling the relevant feature stops future text-extraction or vector-model calls.</li>
          </ol>
        </section>
        <section>
          <h4>5. Retention and Deletion</h4>
          <ol>
            <li>Account, host, session, event, and accepted Memory data is generally retained while your account is active, until you delete applicable data, the installation, or the account. Pending candidates and technical job data follow product and operational cleanup rules.</li>
            <li>Account deletion triggers deletion of associated account data from the current application database.</li>
            <li>Nginx access logs, Relay audit logs, third-party service logs, and backups follow separate operational retention cycles and may not be deleted synchronously with the account.</li>
            <li>An iOS Beta waitlist email is retained until notification is complete, you request deletion, or the waitlist program ends.</li>
          </ol>
        </section>
        <section>
          <h4>6. Your Rights</h4>
          <ol>
            <li>View and update account profile information in the app.</li>
            <li>Export account and session data supported by the current product.</li>
            <li>Delete your account and current application data through Settings → Account → Delete Account.</li>
            <li>Withdraw applicable consent by disabling push permissions, leaving the waitlist, or contacting us.</li>
            <li>Disabling extraction or vector features in Memory settings stops future calls to the corresponding model. Deleting a memory, installation, or account triggers deletion or invalidation of corresponding Memory data in the current application database.</li>
          </ol>
        </section>
        <section>
          <h4>7. Minors and Policy Updates</h4>
          <p>The service is not directed to children under 14. When this policy changes, we update its version and effective date; material changes will be communicated in the app, on the website, or by email.</p>
        </section>
        <section>
          <h4>8. Contact</h4>
          <p>To exercise your rights or ask about this policy, use Help &amp; Feedback in the app or email james_2001_2001@163.com.</p>
        </section>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useLocale } from '../composables/useLocale'
defineEmits<{ close: [] }>()
const { locale, t } = useLocale()
</script>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fade-in 0.15s ease; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px; width: 620px; max-width: 90vw; max-height: 80vh; overflow-y: auto; animation: slide-up 0.2s ease; }
.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; position: sticky; top: 0; background: var(--surface); z-index: 1; }
.modal-header h3 { font-size: 18px; font-weight: 700; color: var(--fg); margin: 0; }
.close-btn { background: none; border: none; color: var(--fg-tertiary); cursor: pointer; padding: 4px; border-radius: 6px; display: flex; transition: color 0.15s; }
.close-btn:hover { color: var(--fg); }

.modal-body { font-size: 14px; color: var(--fg-secondary); line-height: 1.7; }
.update-date { font-size: 13px; color: var(--fg-tertiary); margin-bottom: 20px; }
section { margin-bottom: 20px; }
section h4 { font-size: 15px; font-weight: 600; color: var(--fg); margin: 0 0 8px; }
section p { margin: 0 0 8px; }
section ol { margin: 0 0 8px; padding-left: 24px; }
section li { margin-bottom: 4px; }
section a { color: var(--accent); text-decoration: none; }
section a:hover { text-decoration: underline; }

@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

@media (max-width: 768px) {
  .overlay { align-items: flex-end; }
  .modal { width: 100%; max-width: 100%; border-radius: 16px 16px 0 0; padding: 20px 16px; padding-bottom: max(20px, env(safe-area-inset-bottom)); max-height: 90vh; }
}
</style>
