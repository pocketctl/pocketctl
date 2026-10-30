/** Called only after schema, accounting and required workers have initialized. */
export async function finishDatabaseStartup(deps: {
  isShuttingDown(): boolean
  markReady(): void
  repairMetadata(): Promise<unknown>
  reportMetadataError(error: unknown): void
}): Promise<void> {
  if (deps.isShuttingDown()) return
  deps.markReady()
  // Missing historical model/effort is a display projection, not an accounting
  // or schema prerequisite. Its event scan may hit the statement timeout.
  // Catch both synchronous and asynchronous failures outside the ready gate.
  void Promise.resolve().then(() => {
    if (!deps.isShuttingDown()) return deps.repairMetadata()
  }).catch(deps.reportMetadataError)
}
