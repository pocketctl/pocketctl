import { createFixedGitReadCapability,type FixedGitTarget } from './read-adapter.js'
import type { GitTransport } from './transport.js'
export function createGiteeReadCapability(options:{target:FixedGitTarget;transport:GitTransport}) {
  return createFixedGitReadCapability('gitee',options)
}
