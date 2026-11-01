export function parseCodeSnapshot(input) {
  const mode = input.files[0]?.path
  if (mode === 'hang') while (true) {}
  if (mode === 'throw') throw new Error('PRIVATE_REPOSITORY_SNIPPET')
  if (mode === 'memory') {
    const retained = []
    while (true) retained.push(new Array(100_000).fill(retained.length))
  }
  const until = Date.now() + 180
  while (Date.now() < until) {}
  return {
    parserVersion: 'fixture', nodes: [], edges: [], contentHash: 'fixture',
    coverage: { files: {}, summary: { complete: 0, fileOnly: 0, unsupported: 0 } },
    sawParentEnv: process.env.CODEGRAPH_TEST_ENV_ONLY !== undefined,
  }
}
