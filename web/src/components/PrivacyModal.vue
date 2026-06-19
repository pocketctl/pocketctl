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
        <div class="update-date">{{ locale === 'zh' ? '更新日期：2026年6月10日' : 'Updated: June 10, 2026' }}</div>

        <!-- Chinese version -->
        <template v-if="locale === 'zh'">
        <section>
          <h4>一、信息收集</h4>
          <p>pocketctl（以下简称"我们"）在提供服务过程中，可能收集以下信息：</p>
          <ol>
            <li>账户信息：手机号码，用于登录验证和账户识别。</li>
            <li>设备信息：设备型号、操作系统版本、设备标识符，用于推送通知和安全认证。</li>
            <li>使用数据：功能使用频率、操作日志，用于服务改进和问题排查。</li>
            <li>主机连接数据：主机名、IP 地址（仅在连接时临时使用），用于远程管理功能。</li>
          </ol>
        </section>
        <section>
          <h4>二、信息使用</h4>
          <p>我们收集的信息仅用于以下目的：</p>
          <ol>
            <li>提供核心服务：账户认证、会话管理、远程控制。</li>
            <li>推送通知：任务完成、错误提醒、主机状态变更。</li>
            <li>服务改进：分析使用模式，优化产品体验。</li>
            <li>安全保障：异常登录检测、欺诈防范。</li>
          </ol>
          <p>我们不会将您的个人信息出售给第三方。</p>
        </section>
        <section>
          <h4>三、第三方服务</h4>
          <p>本应用使用以下第三方服务：</p>
          <ol>
            <li>智谱 AI（GLM-4.6）：用于自动生成会话标题，仅传输会话首条消息摘要，不传输完整对话内容。</li>
            <li>Apple Push Notification Service（APNs）：用于 iOS 推送通知。</li>
          </ol>
          <p>上述第三方服务有独立的隐私政策，我们建议您查阅其相关政策。</p>
        </section>
        <section>
          <h4>四、数据存储与安全</h4>
          <ol>
            <li>数据存储在位于中国的云服务器上。</li>
            <li>所有网络通信均通过 HTTPS/WSS 加密传输。</li>
            <li>敏感信息（如认证令牌）使用 iOS Keychain 安全存储。</li>
            <li>数据库采用加密存储，定期备份。</li>
          </ol>
        </section>
        <section>
          <h4>五、用户权利</h4>
          <p>您享有以下权利：</p>
          <ol>
            <li>查看权：随时查看您的账户信息和使用数据。</li>
            <li>删除权：请求删除您的账户和所有相关数据。</li>
            <li>导出权：请求导出您的会话历史数据。</li>
            <li>撤回同意权：随时撤回对数据处理的同意。</li>
          </ol>
          <p>行使上述权利，请通过应用内「帮助与反馈」联系我们。</p>
        </section>
        <section>
          <h4>六、未成年人保护</h4>
          <p>本服务不面向 14 岁以下未成年人。如您为未成年人，请在监护人指导下使用本服务。</p>
        </section>
        <section>
          <h4>七、政策更新</h4>
          <p>我们可能不时更新本隐私政策。重大变更将通过应用内通知或电子邮件告知您。继续使用本服务即表示您同意更新后的政策。</p>
        </section>
        <section>
          <h4>八、联系我们</h4>
          <p>如您对本隐私政策有任何疑问，请通过以下方式联系我们：</p>
          <p>邮箱：<a href="mailto:james_2001_2001@163.com">james_2001_2001@163.com</a></p>
        </section>
        </template>

        <!-- English version -->
        <template v-else>
        <section>
          <h4>1. Information Collection</h4>
          <p>pocketctl ("we") may collect the following information while providing our services:</p>
          <ol>
            <li>Account information: Phone number, used for login verification and account identification.</li>
            <li>Device information: Device model, OS version, device identifiers, used for push notifications and security authentication.</li>
            <li>Usage data: Feature usage frequency, operation logs, used for service improvement and troubleshooting.</li>
            <li>Host connection data: Hostname, IP address (temporarily used during connection only), used for remote management.</li>
          </ol>
        </section>
        <section>
          <h4>2. Information Usage</h4>
          <p>The information we collect is used solely for the following purposes:</p>
          <ol>
            <li>Core services: Account authentication, session management, remote control.</li>
            <li>Push notifications: Task completion, error alerts, host status changes.</li>
            <li>Service improvement: Analyze usage patterns, optimize product experience.</li>
            <li>Security: Abnormal login detection, fraud prevention.</li>
          </ol>
          <p>We do not sell your personal information to third parties.</p>
        </section>
        <section>
          <h4>3. Third-Party Services</h4>
          <p>This application uses the following third-party services:</p>
          <ol>
            <li>Zhipu AI (GLM-4.6): Used to auto-generate session titles. Only the first message summary is transmitted, not the full conversation.</li>
            <li>Apple Push Notification Service (APNs): Used for iOS push notifications.</li>
          </ol>
          <p>The above third-party services have their own privacy policies. We recommend reviewing them.</p>
        </section>
        <section>
          <h4>4. Data Storage & Security</h4>
          <ol>
            <li>Data is stored on cloud servers located in China.</li>
            <li>All network communication is encrypted via HTTPS/WSS.</li>
            <li>Sensitive information (e.g., auth tokens) is securely stored using iOS Keychain.</li>
            <li>Databases use encrypted storage with regular backups.</li>
          </ol>
        </section>
        <section>
          <h4>5. User Rights</h4>
          <p>You have the following rights:</p>
          <ol>
            <li>Right to access: View your account information and usage data at any time.</li>
            <li>Right to deletion: Request deletion of your account and all related data.</li>
            <li>Right to export: Request export of your session history data.</li>
            <li>Right to withdraw consent: Withdraw consent for data processing at any time.</li>
          </ol>
          <p>To exercise these rights, contact us via "Help & Feedback" in the app.</p>
        </section>
        <section>
          <h4>6. Minors</h4>
          <p>This service is not intended for users under 14. If you are a minor, please use this service under guardian supervision.</p>
        </section>
        <section>
          <h4>7. Policy Updates</h4>
          <p>We may update this privacy policy from time to time. Significant changes will be communicated via in-app notifications or email. Continued use of the service constitutes acceptance of the updated policy.</p>
        </section>
        <section>
          <h4>8. Contact Us</h4>
          <p>If you have any questions about this privacy policy, please contact us:</p>
          <p>Email: <a href="mailto:james_2001_2001@163.com">james_2001_2001@163.com</a></p>
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
