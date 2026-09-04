import { gitWriteEndpoint,type GitFixtureWriteCapability,type GitWriteEndpoint } from '../git-sync/write-protocol.js'
import type { FixedGitTarget } from '../git-sync/read-adapter.js'
import { GitReadError,type GitReadResponse } from '../git-sync/provider.js'
/** TEST ONLY capability. This takes an in-memory HTTP stub, never fetch or a
 * credential; production composition has no corresponding write constructor. */
export function fixtureGitWriter(provider:'github'|'gitee',target:FixedGitTarget,
  stub:(endpoint:GitWriteEndpoint,signal:AbortSignal)=>Promise<GitReadResponse>):GitFixtureWriteCapability {
  return {kind:'fixture',provider,target,request:async(input,signal)=>{
    const response=await stub(gitWriteEndpoint(provider,target,input),signal)
    if(response.receivedBytes===undefined)throw new GitReadError('response_limit')
    return response
  }} as GitFixtureWriteCapability
}
