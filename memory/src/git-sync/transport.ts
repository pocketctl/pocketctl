import { GitReadError,type GitReadResponse } from './provider.js'
import { parseStrictJson } from './strict-json.js'

export const GIT_ORIGINS={github:'https://api.github.com',gitee:'https://gitee.com'} as const
export interface GitEndpoint {segments:string[];query?:Record<string,string>}
export type GitTransport=(endpoint:GitEndpoint,signal:AbortSignal)=>Promise<GitReadResponse>
/** Read-only fixed-origin transport. No redirects, retry, pagination, or returned
 * URLs are followed. fetch exposes decompressed bytes, not measured wire bytes. */
export function createGitTransport(options:{provider:keyof typeof GIT_ORIGINS;token:string;maxResponseBytes:number;fetch?:typeof fetch}):GitTransport {
  if(!options.token||options.token.length>8192||/[\r\n]/.test(options.token)||!Number.isSafeInteger(options.maxResponseBytes)||options.maxResponseBytes<1)throw new GitReadError('provider_target_invalid')
  const send=options.fetch??fetch
  return async(endpoint,signal)=>{
    if(endpoint.segments.length>12||endpoint.segments.some(v=>!v||v==='.'||v==='..'||v.length>512||/[\x00-\x1f]/.test(v)))throw new GitReadError('provider_target_invalid')
    const url=new URL((options.provider==='gitee'?'/api/v5':'')+'/'+endpoint.segments.map(encodeURIComponent).join('/'),GIT_ORIGINS[options.provider])
    for(const [key,value] of Object.entries(endpoint.query??{})){if(value.length>1024)throw new GitReadError('provider_target_invalid');url.searchParams.set(key,value)}
    const headers:Record<string,string>={accept:'application/json'}
    if(options.provider==='github'){headers.authorization=`Bearer ${options.token}`;headers['X-GitHub-Api-Version']='2026-03-10'}
    else url.searchParams.set('access_token',options.token) // documented v5 authentication, URL never escapes this closure
    let receivedBytes=0
    try {
      const response=await send(url,{method:'GET',headers,redirect:'error',signal}),reader=response.body?.getReader(),chunks:Uint8Array[]=[]
      if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;receivedBytes+=value.byteLength
        if(receivedBytes>options.maxResponseBytes){await reader.cancel();throw new GitReadError('response_limit')};chunks.push(value)}}finally{reader.releaseLock()}
      const retry=response.headers.get('retry-after'),retryAfterMs=retry&&/^\d+$/.test(retry)?Math.min(86_400_000,Number(retry)*1000):1000
      if(response.status!==200)return {status:response.status,receivedBytes,retryAfterMs}
      let body:unknown;try{body=parseStrictJson(Buffer.concat(chunks))}catch{throw new GitReadError('provider_unverifiable')}
      return {status:200,body,receivedBytes}
    }catch(error){
      // No original fetch exception, URL, body or token may escape.
      throw new GitReadError(error instanceof GitReadError?error.code:signal.aborted?'request_aborted':'provider_failure',
        error instanceof GitReadError?error.retryable:!signal.aborted,1000,receivedBytes)
    }
  }
}
