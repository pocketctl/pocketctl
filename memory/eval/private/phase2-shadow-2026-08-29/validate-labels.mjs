import { readFileSync } from 'node:fs'

const base = new URL('./', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'))
const cases = readFileSync(new URL('cases.jsonl', base), 'utf8')
  .trim()
  .split(/\n+/)
  .map(line => JSON.parse(line))

const file = process.argv[2]
if (!file) throw new Error('usage: node validate-labels.mjs <human-labels.json>')
const data = JSON.parse(readFileSync(file, 'utf8'))
if (data.dataset_id !== manifest.dataset_id) throw new Error('dataset_id mismatch')

function gateSample(allCases, minimums) {
  const selected = []
  const seen = new Set()
  const add = evaluationCase => {
    if (evaluationCase && !seen.has(evaluationCase.case_id)) {
      seen.add(evaluationCase.case_id)
      selected.push(evaluationCase)
    }
  }
  for (const repository of manifest.repositories) {
    add(allCases.find(evaluationCase => evaluationCase.context.repository_key === repository))
  }
  for (const adapter of manifest.adapters) {
    add(allCases.find(evaluationCase => evaluationCase.context.agent === adapter))
  }
  const sessions = new Set(selected.map(evaluationCase => evaluationCase.trace.session_ref))
  for (const evaluationCase of allCases) {
    if (sessions.size >= minimums.sessions) break
    if (!sessions.has(evaluationCase.trace.session_ref)) {
      sessions.add(evaluationCase.trace.session_ref)
      add(evaluationCase)
    }
  }
  for (const evaluationCase of allCases) {
    if (selected.length >= minimums.eligible_turns) break
    add(evaluationCase)
  }
  return selected.slice(0, minimums.eligible_turns)
}

const evaluationCases = gateSample(cases, manifest.gate_minimums)
const expectedCaseIds = evaluationCases.map(evaluationCase => evaluationCase.case_id)
if (Array.isArray(data.evaluation_case_ids)
  && JSON.stringify(data.evaluation_case_ids) !== JSON.stringify(expectedCaseIds)) {
  throw new Error('evaluation_case_ids mismatch; export labels from the current labeling.html')
}

const expectedItems = new Map()
for (const evaluationCase of evaluationCases) {
  for (const item of evaluationCase.items) {
    expectedItems.set(`${evaluationCase.case_id}:${item.item_id}`, { evaluationCase, item })
  }
}

const labels = Array.isArray(data.labels) ? data.labels : []
const seenLabels = new Set()
const duplicateItems = []
const extraItems = []
const invalidItems = []
const validLabels = []
for (const label of labels) {
  const key = `${label.case_id}:${label.item_id}`
  if (!expectedItems.has(key)) {
    extraItems.push(key)
    continue
  }
  if (seenLabels.has(key)) duplicateItems.push(key)
  seenLabels.add(key)
  if (!manifest.labels.includes(label.label)) {
    invalidItems.push(key)
    continue
  }
  validLabels.push(label)
}
const missingItems = [...expectedItems.keys()].filter(key => !seenLabels.has(key))

const labelsByCase = new Map()
for (const label of validLabels) {
  if (!labelsByCase.has(label.case_id)) labelsByCase.set(label.case_id, [])
  labelsByCase.get(label.case_id).push(label.label)
}

const usefulTurns = evaluationCases.filter(evaluationCase =>
  (labelsByCase.get(evaluationCase.case_id) ?? []).includes('useful')).length
const irrelevantOrDuplicate = validLabels.filter(label =>
  ['irrelevant', 'duplicate'].includes(label.label)).length
const incorrect = validLabels.filter(label => label.label === 'incorrect').length
const harmful = validLabels.filter(label => label.label === 'harmful').length
const repositories = new Set(evaluationCases.map(c => c.context.repository_key).filter(Boolean)).size
const adapters = new Set(evaluationCases.map(c => c.context.agent)).size
const sessions = new Set(evaluationCases.map(c => c.trace.session_ref)).size
const pct = (numerator, denominator) => denominator
  ? Number((100 * numerator / denominator).toFixed(2))
  : 0

const coverage = {
  eligible_turns: evaluationCases.length,
  sessions,
  repositories,
  adapters,
  selected_items: expectedItems.size,
  labeled_items: validLabels.length,
  invalid_items: invalidItems.length,
  missing_items: missingItems.length,
  extra_items: extraItems.length,
  duplicate_items: duplicateItems.length,
}
const metrics = {
  should_inject_pct: pct(usefulTurns, evaluationCases.length),
  irrelevant_or_duplicate_pct: pct(irrelevantOrDuplicate, expectedItems.size),
  incorrect_pct: pct(incorrect, expectedItems.size),
  harmful_pct: pct(harmful, expectedItems.size),
}
const coveragePassed = Boolean(data.reviewer)
  && coverage.eligible_turns >= manifest.gate_minimums.eligible_turns
  && coverage.sessions >= manifest.gate_minimums.sessions
  && coverage.repositories >= manifest.gate_minimums.repositories
  && coverage.adapters >= manifest.gate_minimums.adapters
  && coverage.labeled_items === coverage.selected_items
  && coverage.invalid_items === 0
  && coverage.missing_items === 0
  && coverage.extra_items === 0
  && coverage.duplicate_items === 0
const report = {
  dataset_id: data.dataset_id,
  reviewer: data.reviewer ?? '',
  coverage,
  metrics,
  thresholds: {
    should_inject_pct_min: 70,
    irrelevant_or_duplicate_pct_max_exclusive: 10,
    incorrect_or_harmful_pct_max_exclusive: 1,
  },
  gate: {
    coverage: coveragePassed,
    should_inject: metrics.should_inject_pct >= 70,
    irrelevant_or_duplicate: metrics.irrelevant_or_duplicate_pct < 10,
    incorrect_or_harmful: pct(incorrect + harmful, expectedItems.size) < 1,
  },
}

console.log(JSON.stringify(report, null, 2))
if (!Object.values(report.gate).every(Boolean)) process.exitCode = 1
