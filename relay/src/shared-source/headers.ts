/** Explicit rollout flag; legacy runtimes keep the original one-statement
 * Journal write until the independently installed contract is verified. */
export function sharedSourceHeadersEnabled(env:Record<string,string|undefined>=process.env):boolean {
 const mode=env.RELAY_SHARED_SOURCE_HEADERS??'off'
 if(!['off','enabled'].includes(mode))throw Error('invalid_shared_source_headers_mode')
 return mode==='enabled'
}
