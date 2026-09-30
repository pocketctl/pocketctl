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
        <div class="update-date">{{ locale === 'zh' ? '更新日期：2026年9月30日' : 'Updated: September 30, 2026' }}</div>

        <!-- Chinese version -->
        <template v-if="locale === 'zh'">
        <section>
          <h4>一、我们处理的信息</h4>
          <p>pocketctl（以下简称“我们”）为提供跨设备 AI 编程会话控制与 Team 协作服务，会处理以下信息：</p>
          <ol>
            <li>账户信息：邮箱地址、显示名称，以及邮箱验证码或 OAuth 设备授权产生的账户和令牌标识。</li>
            <li>设备与推送信息：设备型号、操作系统版本、设备标识符、推送令牌和应用环境。</li>
            <li>主机与连接信息：主机名、Daemon 标识、在线状态、网络地址、IP 地址和 User-Agent。</li>
            <li>会话内容与元数据：工作目录、会话标题、提示词、回复、命令、路径、差异内容、工具输入输出、审批与问题、错误、状态、时间和用量信息。</li>
            <li>Memory 信息：在您显式开启 Memory 后，我们会从已同步的会话事件生成有界且按规则筛选的 Episode Packet，并处理由此提取的记忆候选、您审核接受的记忆、证据引用、向量表示、反馈和功能设置。</li>
            <li>Team 协作信息：Team 名称、邀请邮箱、成员身份与权限、共享的主机与 Agent 信息、任务及负责人、共享会话消息与 Agent 回复、Context（目标、共识、待解决问题和引用）的版本、Agent 调用与自动协作 Run 的状态、用量及审计记录。</li>
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
            <li>按照 Team 成员、共享会话参与者和 Agent 所有者的权限，提供邀请、任务协作、消息共享、Agent 调用、自动协作 Run、Context 传递与协作历史重放。</li>
            <li>在您显式同意并开启相应功能后，提取、审核、保存和检索个人工程记忆；Memory 默认关闭。</li>
          </ol>
          <p>我们不会出售您的个人信息。</p>
        </section>
        <section>
          <h4>三、Team 协作与共享</h4>
          <ol>
            <li>Team 资料与任务按成员权限可见；共享会话中的消息、Agent 回复与 Context 按参与者权限可见。加入 Team 不会自动公开您已有的个人会话、完整原生会话历史或私有 Memory。您主动提交或由 Agent 回复到共享会话的内容，会成为相应权限范围内的协作记录。</li>
            <li>调用共享 Agent 时，协作消息、目标、相关共享历史和 Context 会传递到该 Agent 所有者的 Daemon 主机，并可能发送给其配置的模型服务。启动自动协作 Run 后，协调 Agent 可继续调用其他获授权的 Agent，向其传递协作内容；调用与结果记录由 Relay 保存。</li>
            <li>共享 Agent 不等于共享整个主机或将原生会话的控制权交给所有 Team 成员。主机所有者可接触本机执行产生的会话与文件；原生工具审批与问题仍按 Agent 所有者的授权机制处理，Team 消息或 Context 不能替代审批。</li>
            <li>Team Memory 需要单独绑定相应的共享安装或知识范围。共享 Context 中的 Memory 引用仅使用该范围内已发布且当前获授权的知识版本及证据，并校验参与者与执行接收者的读取权限。个人记忆不会仅因加入 Team 自动发布；从个人范围分享知识，需要按相应治理规则提交、审核与发布。</li>
            <li>在启用相应 Memory 处理后，获授权的共享目标、最终 Agent 回复和调用结果可进入 Memory 的筛选、提取与候选审核流程。私有原生会话完整历史、工具中间输出和隐藏的记忆注入正文不会被自动作为 Team 共享来源采集；如果您或 Agent 将其中的信息写入共享消息或回复，该内容仍可能被共享和处理。</li>
            <li>Team Memory 的提取、向量和模型出口仍受相应安装的功能设置、权限与同意控制。加入 Team 或绑定共享知识，不代表同意将所有个人数据发送给其他成员或模型服务。请在共享前确认内容与 Agent 配置适合相应的协作范围。</li>
          </ol>
        </section>
        <section>
          <h4>四、第三方处理者</h4>
          <ol>
            <li>腾讯云邮件服务（SES）：处理收件邮箱、验证码和必要的服务邮件内容。</li>
            <li>Xiaomi MiMo：在服务配置了 API Key 且触发标题生成时，优先处理用于生成标题的用户消息和助手回复；在您对 Memory 模型出口显式同意并开启提取后，还会通过 Batch API 处理经筛选、截断和脱敏规则生成的有界 Episode Packet，用于记忆候选提取。Batch 输入和结果文件按供应商规则默认保留 30 天；未配置或未开启相应功能时不会执行该调用。</li>
            <li>DeepSeek：在未配置 Xiaomi MiMo 或 MiMo 请求超时回退时，处理用于生成标题的用户消息和助手回复；在您对 Memory 模型出口显式同意并开启提取后，MiMo Batch 超时时还可能处理相同的有界 Episode Packet。未配置回退模型或未开启相应功能时不会执行该调用。</li>
            <li>阿里云百炼 DashScope：仅在您对 Memory 模型出口显式同意并开启向量功能后，使用 qwen3.7-text-embedding 处理待索引的已接受记忆文本和检索查询，以生成向量嵌入；未配置或未开启时不会调用。</li>
            <li>Team 中所调用 Agent 使用的模型服务商：协作消息、Context、获授权的记忆内容以及执行过程中的代码、文件或工具信息，可能由该 Agent 所有者配置的模型服务处理。具体接收方、处理地域和保存规则取决于 Agent 配置；请在授权协作前向 Agent 所有者确认。此类调用与上述 pocketctl 标题生成及 Memory 模型出口是不同的数据处理路径。</li>
            <li>Apple Push Notification Service（APNs）：处理设备推送令牌和通知载荷。通知预览可能包含会话标题、主机名、命令、路径、审批摘要或问题内容。</li>
          </ol>
          <p>第三方服务依据其自身条款处理数据，其处理地域可能不同于我们的主要服务地域。</p>
        </section>
        <section>
          <h4>五、存储与传输安全</h4>
          <ol>
            <li>生产环境客户端与服务之间使用 HTTPS/WSS（TLS）传输。</li>
            <li>iOS 认证令牌存储于 Keychain，Web 访问令牌仅保存在当前页面内存中，刷新令牌使用 HttpOnly Cookie。</li>
            <li>Relay 会处理并存储会话事件，并可以读取当前会话事件内容。</li>
            <li>主要数据库、基础设施日志和第三方处理服务可能位于不同地域，具体取决于实际部署与服务商配置。</li>
            <li>Memory 的模型 API Key 仅保存在服务端；模型出口按安装独立控制，关闭相应功能会停止后续文本提取或向量模型调用。</li>
          </ol>
        </section>
        <section>
          <h4>六、保存与删除</h4>
          <ol>
            <li>个人账户、主机、个人会话、事件及已接受的个人 Memory 记忆通常在账户有效期间保存，直至您删除相关数据、安装或账户；待审核候选和技术作业数据按产品与运维清理规则处理。Team 共享数据按下述共享范围另行处理。</li>
            <li>成功完成账户删除后，当前业务数据库中的关联个人账户数据会被删除。Team 关联可能影响账户删除的完成；如无法完成，请通过“帮助与反馈”或下方联系方式申请处理。</li>
            <li>退出 Team、被移除、撤销 Agent 共享、移除 Memory 绑定、结束或归档共享会话以及解散 Team，属于权限或协作状态变更，不会自动清空已保存的 Team 任务、共享消息、Context 版本、Agent 调用和 Run 历史。已发布的团队知识与个人源数据分开处理，也不会仅因原作者退出或删除个人源数据而自动删除；如需处理仍保留的共享内容，请联系我们。</li>
            <li>撤回共享或删除服务端数据不会自动删除其他成员已经查看、复制或导出的内容，也不会自动清理 Agent 主机上已产生的原生会话、文件或模型服务商保存的数据；这些副本由相应成员、主机所有者或服务商按其规则处理。</li>
            <li>Nginx 访问日志、Relay 审计日志、第三方服务日志和备份按照各自的运维保留周期清理，可能不会与账户删除同步完成。</li>
            <li>iOS Beta 候补邮箱保存至完成通知、您请求删除或候补计划终止。</li>
          </ol>
        </section>
        <section>
          <h4>七、您的权利</h4>
          <ol>
            <li>在应用中查看和更新账户资料。</li>
            <li>导出当前产品支持导出的账户和会话数据。</li>
            <li>通过“设置 → 账户 → 删除账户”发起账户删除；Team 共享资料的保留与删除范围见上文。</li>
            <li>通过关闭推送权限、退出候补名单或联系我们撤回可撤回的处理同意。</li>
            <li>在 Memory 设置中关闭提取或向量功能会停止后续相应模型调用；删除记忆、安装或账户会触发当前业务数据库中对应 Memory 数据的删除或失效处理。</li>
            <li>通过退出 Team、撤销自己共享的 Agent 或由有权限的管理者调整成员、参与者和 Memory 绑定，停止相应的后续访问或调用授权。已经接受的调用可能仍需完成结算；撤权不承诺立即中断主机上已开始的执行。需要处理已共享内容或账户删除受 Team 关联限制时，可联系我们。</li>
          </ol>
        </section>
        <section>
          <h4>八、未成年人和政策更新</h4>
          <p>本服务不面向 14 岁以下未成年人。我们更新本政策时会修改版本和生效日期；重大变更将通过应用内通知、网站或电子邮件告知。</p>
        </section>
        <section>
          <h4>九、联系我们</h4>
          <p>如需行使权利或咨询本政策，请通过应用内“帮助与反馈”或邮箱 james_2001_2001@163.com 联系我们。</p>
        </section>
        </template>

        <!-- English version -->
        <template v-else>
        <section>
          <h4>1. Information We Process</h4>
          <p>pocketctl (&quot;we&quot;) processes the following information to provide cross-device control of AI coding sessions and Team collaboration:</p>
          <ol>
            <li>Account information: email address, display name, and account or token identifiers created by email verification or OAuth device authorization.</li>
            <li>Device and push information: device model, operating-system version, device identifiers, push token, and app environment.</li>
            <li>Host and connection information: hostname, Daemon identifier, online state, network address, IP address, and User-Agent.</li>
            <li>Session content and metadata: working directory, title, prompts, responses, commands, paths, diffs, tool inputs and outputs, approvals, questions, errors, status, timestamps, and usage.</li>
            <li>Memory information: after you explicitly enable Memory, we generate a bounded, policy-filtered Episode Packet from synchronized session events and process extracted memory candidates, memories you accept, evidence references, vector representations, feedback, and feature settings.</li>
            <li>Team collaboration information: Team names, invitation email addresses, member identities and permissions, shared host and Agent information, tasks and holders, shared-session messages and Agent replies, versions of Context (goals, consensus, open questions, and references), and Agent-call and automated Run status, usage, and audit records.</li>
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
            <li>Providing invitations, task collaboration, message sharing, Agent calls, automated Runs, Context delivery, and collaboration-history replay according to Team-member, shared-session-participant, and Agent-owner permissions.</li>
            <li>After your explicit consent and activation of the relevant feature, extracting, reviewing, retaining, and retrieving personal engineering memories. Memory is off by default.</li>
          </ol>
          <p>We do not sell your personal information.</p>
        </section>
        <section>
          <h4>3. Team Collaboration and Sharing</h4>
          <ol>
            <li>Team information and tasks are visible according to member permissions; shared-session messages, Agent replies, and Context are visible according to participant permissions. Joining a Team does not automatically expose your existing personal sessions, complete native-session history, or private Memory. Content you submit or an Agent replies to a shared session becomes part of the collaboration record within the applicable permission scope.</li>
            <li>When a shared Agent is called, collaboration messages, goals, relevant shared history, and Context are delivered to the Agent owner's Daemon host and may be sent to its configured model services. After an automated Run starts, the coordinating Agent may continue calling other authorized Agents and passing collaboration content to them. Relay retains call and result records.</li>
            <li>Sharing an Agent does not share the entire host or give every Team member control of its native sessions. The host owner can access sessions and files produced locally. Native tool approvals and questions remain subject to the Agent owner's authorization mechanisms; Team messages or Context do not replace approval.</li>
            <li>Team Memory requires a separate binding to the applicable shared installation or knowledge scope. Memory references in shared Context use only published knowledge versions and evidence in that scope that remain authorized, with read permissions checked for participants and execution receivers. Personal memories are not automatically published when you join a Team; sharing knowledge from a personal scope requires submission, review, and publication under the applicable governance rules.</li>
            <li>When the relevant Memory processing is enabled, authorized shared goals, final Agent replies, and call outcomes may enter Memory filtering, extraction, and candidate-review workflows. Complete private native-session history, intermediate tool outputs, and hidden memory-injection text are not automatically collected as Team shared sources. If you or an Agent places that information in a shared message or reply, it may still be shared and processed.</li>
            <li>Team Memory extraction, vector features, and model egress remain controlled by the relevant installation's settings, permissions, and consent. Joining a Team or binding shared knowledge is not consent to send all personal data to other members or model services. Before sharing, confirm that the content and Agent configuration are appropriate for the collaboration scope.</li>
          </ol>
        </section>
        <section>
          <h4>4. Third-Party Processors</h4>
          <ol>
            <li>Tencent Cloud Simple Email Service (SES): processes recipient email addresses, verification codes, and necessary service-email content.</li>
            <li>Xiaomi MiMo: when an API key is configured and title generation is triggered, preferentially processes user messages and assistant responses used to create a title. After your explicit consent to Memory model egress and activation of extraction, it also processes a bounded Episode Packet through its Batch API for memory candidate extraction. Batch input and result files are retained for 30 days by default under the provider's rules; the applicable call is not made when unconfigured or disabled.</li>
            <li>DeepSeek: when Xiaomi MiMo is unconfigured or a MiMo request times out and fallback is available, processes user messages and assistant responses used to create a title. After your explicit consent to Memory model egress and activation of extraction, it may also process the same bounded Episode Packet after a MiMo Batch timeout. The applicable fallback call is not made when unconfigured or disabled.</li>
            <li>Alibaba Cloud Model Studio DashScope: only after your explicit consent to Memory model egress and activation of vector features, qwen3.7-text-embedding processes accepted-memory text to be indexed and retrieval queries to produce vector embeddings. It is not called when unconfigured or disabled.</li>
            <li>Model providers used by Agents called in Team: collaboration messages, Context, authorized memory content, and code, files, or tool information used during execution may be processed by model services configured by the Agent owner. Recipients, processing regions, and retention rules depend on that configuration; confirm them with the Agent owner before authorizing collaboration. These calls are separate from pocketctl title generation and Memory model egress described above.</li>
            <li>Apple Push Notification Service (APNs): processes device push tokens and notification payloads. Notification previews may contain a session title, hostname, command, path, approval summary, or question content.</li>
          </ol>
          <p>Third parties process data under their own terms, and their processing regions may differ from our primary service region.</p>
        </section>
        <section>
          <h4>5. Storage and Transport Security</h4>
          <ol>
            <li>Production client-to-service traffic uses HTTPS/WSS (TLS).</li>
            <li>iOS authentication tokens are stored in Keychain. Web access tokens stay in page memory, while refresh tokens use an HttpOnly cookie.</li>
            <li>Relay processes and stores session events and can read current session-event content.</li>
            <li>Primary databases, infrastructure logs, and third-party processors may operate in different regions according to the actual deployment and provider configuration.</li>
            <li>Memory model API keys remain server-side. Model egress is controlled per installation; disabling the relevant feature stops future text-extraction or vector-model calls.</li>
          </ol>
        </section>
        <section>
          <h4>6. Retention and Deletion</h4>
          <ol>
            <li>Personal account, host, personal-session, event, and accepted personal Memory data is generally retained while your account is active, until you delete applicable data, the installation, or the account. Pending candidates and technical job data follow product and operational cleanup rules. Team shared data is handled separately within the shared scope described below.</li>
            <li>When account deletion completes successfully, associated personal account data is deleted from the current application database. Team relationships may prevent account deletion from completing; if it cannot be completed, request assistance through Help &amp; Feedback or the contact details below.</li>
            <li>Leaving or being removed from a Team, revoking an Agent offer, removing a Memory binding, ending or archiving a shared session, or dissolving a Team changes permissions or collaboration state; it does not automatically erase stored Team tasks, shared messages, Context versions, Agent calls, or Run history. Published shared knowledge is handled separately from personal source data and is not automatically deleted solely because its author leaves or deletes the personal source. Contact us to request handling of retained shared content.</li>
            <li>Withdrawing sharing or deleting server-side data does not automatically delete content other members have already viewed, copied, or exported, native sessions or files created on Agent hosts, or data retained by model providers. Those copies are handled by the relevant member, host owner, or provider under their rules.</li>
            <li>Nginx access logs, Relay audit logs, third-party service logs, and backups follow separate operational retention cycles and may not be deleted synchronously with the account.</li>
            <li>An iOS Beta waitlist email is retained until notification is complete, you request deletion, or the waitlist program ends.</li>
          </ol>
        </section>
        <section>
          <h4>7. Your Rights</h4>
          <ol>
            <li>View and update account profile information in the app.</li>
            <li>Export account and session data supported by the current product.</li>
            <li>Initiate account deletion through Settings → Account → Delete Account; the retention and deletion scope for Team shared data is described above.</li>
            <li>Withdraw applicable consent by disabling push permissions, leaving the waitlist, or contacting us.</li>
            <li>Disabling extraction or vector features in Memory settings stops future calls to the corresponding model. Deleting a memory, installation, or account triggers deletion or invalidation of corresponding Memory data in the current application database.</li>
            <li>End the relevant authorization for future access or calls by leaving a Team, revoking your own Agent offer, or having an authorized manager adjust membership, participants, or Memory bindings. Already accepted calls may still need to settle; revocation does not promise immediate interruption of execution already started on a host. Contact us to request handling of shared content or account deletion affected by Team relationships.</li>
          </ol>
        </section>
        <section>
          <h4>8. Minors and Policy Updates</h4>
          <p>The service is not directed to children under 14. When this policy changes, we update its version and effective date; material changes will be communicated in the app, on the website, or by email.</p>
        </section>
        <section>
          <h4>9. Contact</h4>
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
