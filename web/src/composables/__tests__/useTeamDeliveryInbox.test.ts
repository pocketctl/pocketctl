import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useTeamDeliveryInbox } from '../useTeamDeliveryInbox'
const api=vi.hoisted(()=>({listDeliveryInbox:vi.fn()}))
vi.mock('../../services/teamDeliveryClient',()=>api)
vi.mock('../useAuth',()=>({useAuth:()=>({user:ref({id:1}),accessToken:ref('fixture')})}))
vi.mock('../useEnv',()=>({getRelayOrigin:()=>''}))
let wrapper:ReturnType<typeof mount>
beforeEach(()=>vi.clearAllMocks());afterEach(()=>wrapper?.unmount())
test('detail revocation clears the team and rejects an earlier list even while refresh fails',async()=>{
 const item={item_id:'reminder',team_id:'team',task_id:'task',title:'protected'}
 api.listDeliveryInbox.mockResolvedValueOnce({items:[item]})
 let inbox!:ReturnType<typeof useTeamDeliveryInbox>
 wrapper=mount({setup(){inbox=useTeamDeliveryInbox();return()=>null}});await flushPromises()
 expect(inbox.items.value).toHaveLength(1)
 let resolve!:(value:unknown)=>void
 api.listDeliveryInbox.mockImplementationOnce(()=>new Promise(r=>resolve=r))
 const late=inbox.refresh()
 api.listDeliveryInbox.mockRejectedValueOnce(new Error('offline'))
 inbox.revokeTeam('team');expect(inbox.items.value).toEqual([])
 resolve({items:[item]});await late;await flushPromises();expect(inbox.items.value).toEqual([])
})
