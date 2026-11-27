import { extractConclusions } from './conclusion-extractor.js'
import type { ConclusionEvidence } from './conclusion-validator.js'
import type { ModelUsage, TextGenerator } from '../ports/text-generator.js'

export type ExtractionInput = Parameters<typeof extractConclusions>[1]
export type ExtractionResult = Awaited<ReturnType<typeof extractConclusions>>
type Task = Extract<ExtractionResult, { ok: true }>['tasks'][number]
const windowSize = 64_000

/** Keep positions in the same sanitized UTF-16 string the evidence writer verifies. */
function* dialogueWindows(sources: ConclusionEvidence[]) {
  let batch: ConclusionEvidence[] = []
  let offsets = new Map<string, number>()
  let remaining = windowSize
  for (const source of sources) {
    let start = 0
    while (start < source.text.length) {
      if (!remaining || offsets.has(source.id)) {
        yield { sources: batch, offsets }
        batch = []
        offsets = new Map()
        remaining = windowSize
      }
      let end = Math.min(source.text.length, start + remaining)
      if (end < source.text.length) {
        // Preserve words/sentences when possible and never split a surrogate pair.
        const boundary = source.text.lastIndexOf(' ', end - 1)
        if (boundary >= end - 512 && boundary >= start) end = boundary + 1
        if (/[\uD800-\uDBFF]/.test(source.text.charAt(end - 1))) end--
      }
      if (end === start) {
        remaining = 0
        continue
      }
      batch.push({ ...source, text: source.text.slice(start, end) })
      offsets.set(source.id, start)
      remaining -= end - start
      start = end
    }
  }
  if (batch.length) yield { sources: batch, offsets }
}

function usageTotal(prior: ModelUsage | undefined, current: ModelUsage | undefined) {
  if (!current) return prior
  if (!prior) return current
  return {
    model: prior.model === current.model ? prior.model : 'mixed',
    inputTokens: prior.inputTokens + current.inputTokens,
    outputTokens: prior.outputTokens + current.outputTokens,
    costMicros: (prior.costMicros ?? 0) + (current.costMicros ?? 0),
  }
}

export async function extractDialogueConclusions(
  generator: TextGenerator|undefined,
  input: ExtractionInput,
  extractWindow?: (input:ExtractionInput,index:number)=>Promise<ExtractionResult>,
  origins?:Map<Task,number[]>,
): Promise<ExtractionResult> {
  if(!generator&&!extractWindow)return {ok:false,code:'budget_unavailable',retryable:true}
  if (input.sources.reduce((n, s) => n + s.text.length, 0) <= windowSize)
    return extractWindow ? extractWindow({...input,maxSpanLength:4000},0) : extractConclusions(generator!, { ...input, maxSpanLength: 4000 })
  const tasks: Task[] = []
  const resumed = new Map<string, Task>()
  let usage: ModelUsage | undefined
  let index = 0
  for (const window of dialogueWindows(input.sources)) {
    let result: ExtractionResult
    const windowInput = {
        ...input,
        sources: window.sources,
        maxSpanLength: 4000,
        requestKey: input.requestKey + ':window:' + index,
    }
    if (extractWindow) result=await extractWindow(windowInput,index++)
    else try {
      index++
      result=await extractConclusions(generator!,windowInput)
    } catch {
      return { ok: false, code: 'provider_result_unknown', retryable: false, usage }
    }
    const priorUsage = usage
    usage = usageTotal(usage, result.usage)
    if (!result.ok) {
      // A partial billed request cannot restart as a fresh, free budget refusal.
      if (!extractWindow && priorUsage && (result.code === 'budget_exceeded' || result.code === 'budget_unavailable'))
        return {
          ok: false,
          code: 'provider_result_unknown',
          detail: 'partial_dialogue_extraction',
          retryable: false,
          usage,
        }
      return { ...result, usage }
    }
    for (const task of result.tasks) {
      const spans = task.spans.map((span) => {
        const offset = window.offsets.get(span.event_id)!
        return { ...span, start: span.start + offset, end: span.end + offset }
      })
      const prior = task.task_id && resumed.get(task.task_id)
      if (prior) {
        origins?.get(prior)?.push(index-1)
        prior.spans.push(...spans)
        prior.conclusions.push(...task.conclusions)
        prior.rejections.push(...task.rejections)
      } else {
        const entry = { ...task, spans }
        origins?.set(entry,[index-1])
        tasks.push(entry)
        if (task.task_id) resumed.set(task.task_id, entry)
      }
    }
  }
  if (!usage) throw Error('dialogue_usage_missing')
  return { ok: true, tasks, usage }
}
