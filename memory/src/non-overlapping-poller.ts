/** Concurrent ticks share one pass; shutdown closes admission before draining it. */
export function createNonOverlappingPoller(run: () => Promise<void>) {
  let pending: Promise<void> | undefined
  let stopped=false
  return {
    runOnce():Promise<void>{
      if(stopped)return Promise.resolve()
      if(pending)return pending
      pending=run().finally(()=>{pending=undefined})
      return pending
    },
    async stop():Promise<void>{stopped=true;await pending},
  }
}
