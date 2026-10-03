<template>
  <div v-if="open" class="dialog-backdrop" data-testid="team-create-dialog" @mousedown.self="emit('close')">
    <form ref="panel" class="dialog-card" role="dialog" aria-modal="true" :aria-label="t('team.create')" tabindex="-1" @keydown.esc.stop.prevent="emit('close')" @keydown.tab="trapFocus" @submit.prevent="submit">
      <header>
        <div><p>{{ t('team.create_kicker') }}</p><h2>{{ t('team.create') }}</h2></div>
        <button type="button" class="icon-button icon-btn flat" :aria-label="t('common.close')" @click="emit('close')"><WorkspaceIcon name="close" /></button>
      </header>
      <div class="dialog-scroll">
        <label class="team-form-field">
          <span>{{ t('team.name') }}</span>
          <input v-model.trim="name" maxlength="120" required data-testid="team-create-name" />
        </label>
        <label class="team-form-field team-description"><span>{{ t('team.description') }} <small>{{ t('team.optional') }}</small></span><textarea v-model.trim="description" maxlength="2000" rows="3" :placeholder="t('team.description_placeholder')" /></label>
        <details class="team-optional-fields"><summary>{{ t('replica.optional_team_setup') }}<WorkspaceIcon name="down" class="icon small" /></summary>
        <section>
          <h3>{{ t('team.add_my_agents') }} <small>{{ t('team.optional') }}</small></h3>
          <p>{{ t('team.create_agents_copy') }}</p>
          <TeamAgentPicker v-model="selectedAgentKeys" :candidates="candidates" :loading="candidatesLoading" :disabled="busy" />
        </section>
        <section>
          <h3>{{ t('team.invite_members') }} <small>{{ t('team.optional') }}</small></h3>
          <p>{{ t('team.invite_accounts_copy') }}</p>
          <label class="team-form-field">
            <span>{{ t('team.invite_emails') }}</span>
            <textarea v-model="emails" rows="3" :placeholder="t('team.invite_emails_placeholder')" data-testid="team-create-emails" />
          </label>
          <p class="boundary-copy">{{ t('team.no_email_delivery') }}</p>
        </section>
        <p class="notice">{{ t('team.one_person_team_copy') }}</p>
        </details>
      </div>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      <footer>
        <div><button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</button><button class="btn btn-primary" :disabled="busy || !name">{{ busy ? t('common.loading') : t('team.create') }}</button></div>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { TeamAgentCandidate } from '../../types/team'
import TeamAgentPicker from './TeamAgentPicker.vue'
import WorkspaceIcon from '../WorkspaceIcon.vue'

const props = withDefaults(defineProps<{
  open: boolean
  candidates: TeamAgentCandidate[]
  candidatesLoading?: boolean
  busy?: boolean
  error?: string
}>(), { candidatesLoading: false, busy: false, error: '' })
const emit = defineEmits<{
  close: []
  submit: [value: { name: string; description?: string; invitationEmails: string[]; agents: TeamAgentCandidate[] }]
}>()
const { t } = useLocale()
const panel = ref<HTMLElement|null>(null)
let previousFocus: HTMLElement|null = null
function trapFocus(event:KeyboardEvent) {
  const nodes=Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)') ?? []).filter(node=>!node.closest('details:not([open])'))
  if(event.shiftKey && document.activeElement === nodes[0]) {event.preventDefault();nodes.at(-1)?.focus()}
  else if(!event.shiftKey && document.activeElement === nodes.at(-1)) {event.preventDefault();nodes[0]?.focus()}
}
const name = ref('')
const description = ref('')
const emails = ref('')
const selectedAgentKeys = ref<string[]>([])
const candidateKey = (candidate: Pick<TeamAgentCandidate, 'daemon_id' | 'provider'>) => `${candidate.daemon_id}:${candidate.provider}`

watch(() => props.open, async open => {
  if (!open) {previousFocus?.focus();return}
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  name.value = ''
  description.value = ''
  emails.value = ''
  selectedAgentKeys.value = []
  await nextTick();panel.value?.querySelector<HTMLInputElement>('input')?.focus()
})

function submit(): void {
  const invitationEmails = [...new Set(emails.value.split(/[\s,;]+/).map(value => value.trim().toLowerCase()).filter(Boolean))]
  emit('submit', {
    name: name.value,
    ...(description.value ? {description: description.value} : {}),
    invitationEmails,
    agents: props.candidates.filter(candidate => selectedAgentKeys.value.includes(candidateKey(candidate))),
  })
}
</script>

<style scoped>
.dialog-backdrop { position: fixed; inset: 0; z-index: 110; display: grid; place-items: center; padding: 20px; background: rgba(3, 7, 18, .68); backdrop-filter: blur(4px); }
.dialog-card { width: min(620px, 100%); max-height: min(780px, calc(100dvh - 40px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 28px 80px rgba(0,0,0,.35); }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 17px 20px; }
header { border-bottom: 1px solid var(--border); } footer { border-top: 1px solid var(--border); } footer > span { max-width: 280px; color: var(--fg-tertiary); font-size: 10px; line-height: 1.6; } footer > div { display: flex; gap: 8px; }
header p { margin: 0 0 5px; color: var(--accent); font: 700 9px var(--font-mono); letter-spacing: .12em; text-transform: uppercase; } header h2 { margin: 0; font-size: 18px; }
.icon-button { width: 32px; height: 32px; border: 0; border-radius: 8px; color: var(--fg-secondary); background: transparent; font-size: 22px; cursor: pointer; }.icon-button:hover { background: var(--surface-hover); }
.dialog-scroll { overflow: auto; padding: 20px; }.dialog-scroll section { margin-top: 24px; }.dialog-scroll h3 { margin: 0 0 5px; font-size: 13px; }.dialog-scroll h3 small { color: var(--fg-tertiary); font-size: 10px; font-weight: 500; }.dialog-scroll section > p { margin: 0 0 12px; color: var(--fg-secondary); font-size: 11px; line-height: 1.6; }
.field { display: grid; gap: 7px; color: var(--fg-secondary); font-size: 11px; }.field input, .field textarea { width: 100%; padding: 10px 11px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg); background: var(--bg); font: inherit; resize: vertical; }.field input:focus, .field textarea:focus { outline: 2px solid var(--accent-muted); border-color: var(--accent); }
.boundary-copy { margin-top: 8px !important; padding: 9px 10px; border-left: 2px solid var(--warning); color: var(--fg-tertiary) !important; background: color-mix(in srgb, var(--warning) 6%, transparent); }
.dialog-error { margin: 0; padding: 9px 20px; color: var(--error); background: color-mix(in srgb, var(--error) 7%, transparent); font-size: 11px; }
@media (max-width: 620px) { .dialog-backdrop { padding: 0; align-items: end; }.dialog-card { max-height: 94dvh; border-radius: 16px 16px 0 0; } footer { align-items: stretch; flex-direction: column; } footer > div { display: grid; grid-template-columns: 1fr 1fr; } }

.dialog-backdrop { background:var(--overlay); backdrop-filter:blur(2px); }.dialog-card { width:550px; max-width:calc(100vw - 32px); max-height:90dvh; padding:24px; background:var(--bg); border-color:var(--border-light); border-radius:12px; box-shadow:var(--shadow-lg); }
header,footer { padding:0; border:0; }header { margin-bottom:20px; }header p { display:none; }header h2 { font-size:17px; font-weight:550; }.dialog-scroll { padding:0; }.dialog-scroll h3 { font-size:12px; font-weight:500; }.dialog-scroll section { margin-top:24px; }.field { gap:7px; font-size:12px; }.field input,.field textarea { padding:10px 11px; background:var(--surface); }.icon-button { width:30px; height:30px; border:1px solid var(--border); border-radius:6px; }
footer { flex-wrap:wrap; justify-content:flex-end; margin-top:24px; }footer > span { flex:1 1 100%; max-width:none; padding:11px 13px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:7px; font-size:12px; line-height:1.7; }
@media(max-width:768px){.dialog-backdrop{padding:16px}.dialog-card{padding:24px}}
.team-description { margin-top:18px; }.team-description small { color:var(--fg-tertiary); font-size:10px; }
</style>
