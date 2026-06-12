<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>用户协议</h3>
        <button class="close-btn" @click="$emit('close')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="update-date">更新日期：2026年6月10日</div>

        <section>
          <h4>一、服务说明</h4>
          <p>pocketctl 是一款远程 AI 编程助手管理工具。通过本服务，您可以：</p>
          <ol>
            <li>远程监控运行在开发机上的 AI 编程会话（如 Claude Code、Codex）。</li>
            <li>查看会话状态、消息历史、工具调用详情。</li>
            <li>通过移动设备发送消息和管理会话。</li>
            <li>接收任务完成和错误提醒的推送通知。</li>
          </ol>
        </section>

        <section>
          <h4>二、账户注册与安全</h4>
          <ol>
            <li>您需要通过手机号码验证注册账户。</li>
            <li>您应妥善保管账户信息，不得将账户转让或借给他人使用。</li>
            <li>您对账户下的所有活动承担责任。</li>
            <li>如发现账户被盗用，请立即联系我们。</li>
          </ol>
        </section>

        <section>
          <h4>三、使用规范</h4>
          <p>您同意在使用本服务时：</p>
          <ol>
            <li>遵守中华人民共和国法律法规。</li>
            <li>不利用本服务从事违法活动或侵犯他人权益。</li>
            <li>不尝试攻击、干扰或破坏服务的正常运行。</li>
            <li>不利用本服务对他人计算机系统进行未授权访问。</li>
          </ol>
        </section>

        <section>
          <h4>四、知识产权</h4>
          <ol>
            <li>pocketctl 软件、界面设计、商标等知识产权归我们所有。</li>
            <li>您通过本服务创建的内容（如会话记录）归您所有。</li>
            <li>您授予我们在提供服务范围内使用您内容的必要许可。</li>
          </ol>
        </section>

        <section>
          <h4>五、付费条款</h4>
          <ol>
            <li>本服务目前提供免费使用。</li>
            <li>未来可能推出付费订阅计划，届时将另行公告。</li>
            <li>付费服务的具体条款将在订阅页面明确说明。</li>
          </ol>
        </section>

        <section>
          <h4>六、服务变更与中断</h4>
          <ol>
            <li>我们保留随时修改或中断服务的权利。</li>
            <li>重大变更将提前 30 天通知用户。</li>
            <li>因不可抗力导致的服务中断，我们不承担责任。</li>
          </ol>
        </section>

        <section>
          <h4>七、免责声明</h4>
          <ol>
            <li>本服务按「现状」提供，不做任何明示或暗示的保证。</li>
            <li>对于因使用本服务造成的任何直接或间接损失，我们的赔偿责任不超过您在过去 12 个月内支付的费用总额。</li>
            <li>您应自行备份重要数据，我们不对数据丢失承担责任。</li>
          </ol>
        </section>

        <section>
          <h4>八、协议终止</h4>
          <ol>
            <li>您可随时通过应用内「退出登录」并联系客服删除账户来终止本协议。</li>
            <li>我们保留在您违反本协议时终止服务的权利。</li>
            <li>协议终止后，我们将在合理期限内删除您的数据。</li>
          </ol>
        </section>

        <section>
          <h4>九、适用法律与争议解决</h4>
          <ol>
            <li>本协议受中华人民共和国法律管辖。</li>
            <li>如有争议，双方应友好协商解决。</li>
            <li>协商不成的，任何一方可向我们所在地人民法院提起诉讼。</li>
          </ol>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineEmits<{ close: [] }>()
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
