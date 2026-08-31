<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import type { MemoryScopeMember } from '../../types/memory'

defineProps<{
  members: MemoryScopeMember[]
  canManage: boolean
  loading: boolean
}>()
const emit = defineEmits<{
  (e: 'changeRole', membershipId: string, roles: string[]): void
  (e: 'revoke', membershipId: string): void
}>()
const { t } = useLocale()
const ROLE_OPTIONS = ['reader', 'contributor', 'reviewer', 'publisher', 'policy_administrator', 'scope_administrator']
</script>

<template>
  <section class="memory-scope-members">
    <p v-if="loading" class="memory-governance-muted">{{ t('memory.governance.members.loading') }}</p>
    <table v-else class="memory-scope-members-table">
      <thead>
        <tr>
          <th>{{ t('memory.governance.members.member') }}</th>
          <th>{{ t('memory.governance.members.roles') }}</th>
          <th>{{ t('memory.governance.members.state') }}</th>
          <th v-if="canManage">{{ t('memory.governance.members.actions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="member in members" :key="member.membership_id">
          <td>{{ member.display_label }}</td>
          <td>
            <select v-if="canManage" :value="member.roles[0]"
                    @change="emit('changeRole', member.membership_id, [($event.target as HTMLSelectElement).value])">
              <option v-for="role in ROLE_OPTIONS" :key="role" :value="role">{{ role }}</option>
            </select>
            <template v-else>{{ member.roles.join(', ') }}</template>
          </td>
          <td>{{ member.state }}</td>
          <td v-if="canManage">
            <button v-if="member.state === 'active'" type="button"
                    @click="emit('revoke', member.membership_id)">
              {{ t('memory.governance.members.revoke') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
