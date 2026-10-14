<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>{{ locale === 'zh' ? '用户协议' : 'User Agreement' }}</h3>
        <button class="close-btn" @click="$emit('close')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="update-date">{{ locale === 'zh' ? '更新日期：2026年10月13日' : 'Updated: October 13, 2026' }}</div>

        <!-- Chinese version -->
        <template v-if="locale === 'zh'">
        <section>
          <h4>一、服务说明</h4>
          <p>pocketctl 是一款跨设备 AI 编程助手控制工具，目前支持 Claude Code、Codex 和 OpenCode。服务可展示会话历史和工具调用、发送消息、处理审批或问题，并提供状态通知。</p>
        </section>
        <section>
          <h4>二、账户与安全</h4>
          <ol>
            <li>您可通过邮箱验证码或 OAuth 设备授权访问账户。</li>
            <li>您应妥善保护账户、设备和认证信息，不得转让账户。</li>
            <li>发现异常访问时，请立即退出相关设备并联系我们。</li>
          </ol>
        </section>
        <section>
          <h4>三、使用规范</h4>
          <ol>
            <li>遵守适用法律法规并仅控制您有权使用的主机和会话。</li>
            <li>不得利用本服务实施违法活动、侵犯他人权益、攻击服务或进行未授权访问。</li>
            <li>您应在执行高风险命令或批准 Agent 操作前自行核验其影响。</li>
          </ol>
        </section>
        <section>
          <h4>四、内容与知识产权</h4>
          <ol>
            <li>pocketctl 软件、界面和商标的相关权利归其权利人所有。</li>
            <li>您保留对自身代码和会话内容依法享有的权利。</li>
            <li>您授予我们为提供路由、存储、重放和通知功能所必需的有限处理权限。</li>
          </ol>
        </section>
        <section>
          <h4>五、费用说明</h4>
          <p>当前 Beta 不提供应用内购买或已生效的付费订阅。未来如开放付费服务，我们会在购买前提供价格、权益、续费、取消、退款和开票条款。</p>
        </section>
        <section>
          <h4>六、服务变更与可用性</h4>
          <p>Beta 服务可能变更、中断或调整权益。我们会尽合理努力维护服务并对重大变更作出通知，但不承诺服务始终无错误或不中断。</p>
        </section>
        <section>
          <h4>七、责任边界</h4>
          <p>AI Agent 可能生成错误或有风险的建议。您应审查代码、命令和工具操作并自行备份重要数据。在法律允许范围内，我们不对未经核验的 Agent 操作造成的间接损失承担责任。</p>
        </section>
        <section>
          <h4>八、终止与删除</h4>
          <ol>
            <li>退出登录只结束当前登录状态，不会删除账户。</li>
            <li>您可通过“设置 → 账户 → 删除账户”发起账户删除。关联个人数据、Team 共享资料及可能影响账户删除的 Team 关联，按隐私政策所述范围处理。</li>
            <li>基础设施日志、第三方日志和备份按照隐私政策所述的独立周期清理。</li>
          </ol>
          <ol>
            <li>个人会话按最后有效业务活动计算保留期限：连续严格超过 60 天无有效业务活动时自动归档并转为私有冷存储，严格超过 90 天时清除云端会话数据。有效活动、保护条件、删除范围及 Team 排除范围见隐私政策；达到期限不代表仍在执行或等待处理的会话会被立即删除。</li>
            <li>本规则自本版本在官方网站正式公示之日起生效，具体时间及历史数据过渡截止时间以正式公告为准。生效前已有会话享有至少 30 天清除过渡期；实际清除时间取最后有效业务活动后 90 天与公布的过渡截止时间中较晚者。</li>
            <li>生命周期维护由服务端按有效活动和保护条件自动执行，无需您对每次归档或清除另行批准。系统维护通知与 Agent 工具审批是不同功能；通知是否已读不控制维护执行，阅读历史、置顶、改标题和手工归档也不延长保留期限。</li>
            <li>归档后的历史和文档在清除前仍可按原有权限读取。已清除会话只能查看必要的操作摘要，正文不能通过通知恢复；分阶段清除的完成情况以系统结果为准。请在清除前使用产品支持的方式导出或另行保存需要长期保留的内容。服务端冷存储不替代您对重要项目文件和资料的独立备份。</li>
          </ol>
        </section>
        <section>
          <h4>九、法律适用与联系</h4>
          <p>本协议适用中华人民共和国法律。争议应先友好协商；如需联系我们，请使用应用内“帮助与反馈”或邮箱 james_2001_2001@163.com。</p>
        </section>
        </template>

        <!-- English version -->
        <template v-else>
        <section>
          <h4>1. Service</h4>
          <p>pocketctl is a cross-device control tool for AI coding assistants and currently supports Claude Code, Codex, and OpenCode. The service can show session history and tool calls, send messages, handle approvals or questions, and provide status notifications.</p>
        </section>
        <section>
          <h4>2. Account and Security</h4>
          <ol>
            <li>You may access an account through email verification or OAuth device authorization.</li>
            <li>You must protect account, device, and authentication information and must not transfer your account.</li>
            <li>If you discover unauthorized access, sign out affected devices and contact us promptly.</li>
          </ol>
        </section>
        <section>
          <h4>3. Acceptable Use</h4>
          <ol>
            <li>Follow applicable laws and control only hosts and sessions you are authorized to use.</li>
            <li>Do not use the service for unlawful activity, infringement, service attacks, or unauthorized access.</li>
            <li>Review the impact of high-risk commands and Agent actions before approving them.</li>
          </ol>
        </section>
        <section>
          <h4>4. Content and Intellectual Property</h4>
          <ol>
            <li>Rights in the pocketctl software, interface, and marks belong to their respective owners.</li>
            <li>You retain rights you lawfully hold in your code and session content.</li>
            <li>You grant us the limited processing permission necessary to provide routing, storage, replay, and notification functions.</li>
          </ol>
        </section>
        <section>
          <h4>5. Fees</h4>
          <p>The current Beta does not offer in-app purchases or an active paid subscription. Before any future paid service opens, we will provide pricing, entitlement, renewal, cancellation, refund, and invoicing terms.</p>
        </section>
        <section>
          <h4>6. Changes and Availability</h4>
          <p>The Beta service, availability, and entitlements may change or be interrupted. We use reasonable efforts to maintain the service and communicate material changes, but do not promise uninterrupted or error-free operation.</p>
        </section>
        <section>
          <h4>7. Responsibility</h4>
          <p>AI agents may produce incorrect or risky suggestions. You must review code, commands, and tool operations and maintain backups of important data. To the extent allowed by law, we are not responsible for indirect loss caused by unreviewed Agent actions.</p>
        </section>
        <section>
          <h4>8. Termination and Deletion</h4>
          <ol>
            <li>Signing out ends the current login state; it does not delete the account.</li>
            <li>You may initiate account deletion through Settings → Account → Delete Account. Associated personal data, Team shared content, and Team relationships that may affect account deletion are handled within the scope described in the Privacy Policy.</li>
            <li>Infrastructure logs, third-party logs, and backups are cleared on the separate cycles described in the Privacy Policy.</li>
          </ol>
          <ol>
            <li>Personal-session retention is calculated from the last valid business activity: sessions are automatically archived into private cold storage after strictly more than 60 consecutive days without valid business activity, and their cloud session data is purged after strictly more than 90 days. Valid activity, protection conditions, deletion scope, and Team exclusions are described in the Privacy Policy. Reaching a deadline does not immediately delete sessions still executing or awaiting processing.</li>
            <li>These rules take effect when this version is formally published on the official website. The formal notice states the effective time and historical transition deadline. Sessions that existed before the policy took effect receive at least a 30-day purge transition period. Their purge time is the later of 90 days after the last valid business activity and the published transition deadline.</li>
            <li>The server performs lifecycle maintenance automatically according to valid activity and protection conditions, without separate approval for each archive or purge. System maintenance notices and Agent tool approvals are different functions. Notice read status does not control maintenance, and reading history, pinning, editing titles, or manual archiving does not renew retention.</li>
            <li>Archived history and documents remain readable under the existing permissions until purge. Purged sessions expose only necessary operation summaries; notices cannot restore conversation bodies. Completion of staged purge is determined by system results. Before purge, use supported export features or separately save content you need to retain longer. Server-side cold storage does not replace independent backups of important project files and materials.</li>
          </ol>
        </section>
        <section>
          <h4>9. Governing Law and Contact</h4>
          <p>This agreement is governed by the laws of the People's Republic of China. The parties should first seek an amicable resolution. Contact us through Help &amp; Feedback in the app or at james_2001_2001@163.com.</p>
        </section>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useLocale } from '../composables/useLocale'
defineEmits<{ close: [] }>()
const { locale } = useLocale()
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

@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

@media (max-width: 768px) {
  .overlay { align-items: flex-end; }
  .modal { width: 100%; max-width: 100%; border-radius: 16px 16px 0 0; padding: 20px 16px; padding-bottom: max(20px, env(safe-area-inset-bottom)); max-height: 90vh; }
}
</style>
