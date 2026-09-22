/**
 * Session title generation using OpenAI-compatible providers.
 * MiMo-V2.6-Flash is preferred when configured; DeepSeek remains the
 * compatibility path and the timeout fallback.
 * Generates a concise title (≤15 chars) from the first user+assistant messages.
 *
 * 失败语义：MiMo 非超时失败直接返回空串；MiMo 超时转入现有 DeepSeek
 * 重试路径。两者均不可用或 DeepSeek 重试耗尽后返回空串，不返回截断串。
 *
 * 空串让 relay（router.ts 的 `if (!title) return`）跳过写库，title 保持默认占位
 * 状态（hasDefaultTitle 仍为 true），由 daemon 的定时退避任务重新触发，
 * 不再依赖新消息。配合内部重试及 daemon 上限 5 次请求处理偶发故障。
 */

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const MIMO_API_URL = 'https://api.xiaomimimo.com/v1/chat/completions';
const MIMO_MODEL = 'mimo-v2.6-flash';
// DeepSeek-V4-Flash 实测通常 1-3s (non-thinking)；thinking 首包可能更久。title 生成
// 是异步的 (relay 收到 generate_title_request 后后台调用，不阻塞 daemon/用户)，给 20s。
const TITLE_PROVIDER_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;          // 初次失败后最多重试 2 次（共 3 次尝试）
const BASE_BACKOFF_MS = 500;    // 指数退避基数：500ms → 1000ms
const MAX_BACKOFF_MS = 5_000;   // 单次退避上限
const MAX_TITLE_LEN = 15;

type TitleProvider = 'MiMo' | 'DeepSeek';

interface TitleProviderOptions {
  name: TitleProvider;
  apiUrl: string;
  model: string;
  apiKey: string;
  maxTokenField: 'max_tokens' | 'max_completion_tokens';
}

const SYSTEM_PROMPT = `You are a session title generator. Based on the conversation, generate a concise session title.

Rules:
- Maximum 15 characters
- Summarize the core task/intent
- No quotes, no trailing punctuation
- Detect the language from the user message, NOT the assistant message
- Return ONLY the title text, no explanation`;

const LOCALE_HINT = (locale: string) => `The user's UI language is ${locale}.
- Prefer generating the title in ${locale}.
- If the user message is already in ${locale}, keep that language.
- If the user message is in a different language, generate the title in ${locale}.`;

/**
 * Generate a concise session title using DeepSeek-V4-Flash.
 *
 * 失败（key 未配 / 重试耗尽 / 空内容）一律返回空串 —— 调用方据此保持 title
 * 默认占位状态，等待下次重触发。绝不返回 fallback 截断串污染默认判定。
 *
 * @param userMessage - The first user message from the session
 * @param assistantMessage - The first assistant response from the session
 * @param locale - Optional UI locale for language preference (e.g. "zh", "en")
 * @returns A cleaned title string (≤15 chars), or '' on any failure
 */
export async function generateTitle(userMessage: string, assistantMessage: string, locale?: string, sessionId?: string): Promise<string> {
  const context: Record<string, string> = sessionId ? { sessionId } : {};
  const systemContent = locale ? `${SYSTEM_PROMPT}\n\n${LOCALE_HINT(locale)}` : SYSTEM_PROMPT;
  const userContent = `User message: ${userMessage}\n\nAssistant reply: ${assistantMessage}`;
  const raw = await generateWithPreferredProvider(systemContent, userContent, MAX_TITLE_LEN, context, 'session');
  return raw ? cleanTitle(raw) : '';
}

/** Single OpenAI-compatible call. Throws a bounded provider error on failure. */
async function callProviderOnce(provider: TitleProviderOptions, systemContent: string, userContent: string, maxLen: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(provider.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        // Both current Flash models default to thinking. Title generation is
        // bounded summarization, so preserve the output budget for the title.
        thinking: { type: 'disabled' },
        [provider.maxTokenField]: Math.min(64, Math.max(32, maxLen * 2)),
        temperature: 0.3,
        stream: false,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      if (response.status === 429) console.warn(`[title] ${provider.name} 429${retryAfterMs ? ` (Retry-After ${retryAfterMs}ms)` : ''}`);
      const err = new Error(`${provider.name} API ${response.status} ${response.statusText}`);
      (err as any).retryable = retryable;
      (err as any).retryAfterMs = retryAfterMs;
      (err as any).code = response.status === 408 ? 'timeout' : 'http_error';
      throw err;
    }
    const data = await response.json() as any;
    return data?.choices?.[0]?.message?.content?.trim() || '';
  } catch (err: any) {
    // AbortError（超时）→ 可重试。不重写 err.message: node 的 AbortError 实为 DOMException,
    // 其 message 是只读 getter, 赋值会抛 TypeError, 反而吞掉 retryable 让本该重试 3 次
    // 的超时只试 1 次就放弃。
    if (err?.name === 'AbortError') {
      const timeoutError = new Error(`${provider.name} API timeout`);
      (timeoutError as any).retryable = true;
      (timeoutError as any).code = 'timeout';
      throw timeoutError;
    }
    // 裸 fetch 网络错误（TypeError "fetch failed" 等）→ 可重试
    else if (err?.retryable === undefined) { err.retryable = true; err.code = 'network'; }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function mimoProvider(): TitleProviderOptions | undefined {
  const apiKey = process.env.MIMO_API_KEY;
  return apiKey ? {
    name: 'MiMo', apiUrl: MIMO_API_URL, model: MIMO_MODEL, apiKey,
    maxTokenField: 'max_completion_tokens',
  } : undefined;
}

function deepSeekProvider(): TitleProviderOptions | undefined {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  return apiKey ? {
    name: 'DeepSeek', apiUrl: DEEPSEEK_API_URL, model: DEEPSEEK_MODEL, apiKey,
    maxTokenField: 'max_tokens',
  } : undefined;
}

async function generateWithPreferredProvider(
  systemContent: string,
  userContent: string,
  maxLen: number,
  context: Record<string, string>,
  kind: 'session' | 'subagent',
): Promise<string> {
  const mimo = mimoProvider();
  if (mimo) {
    try {
      const raw = await callProviderOnce(mimo, systemContent, userContent, maxLen);
      if (raw) return raw;
      console.warn(`[title] ${kind} MiMo returned empty content`, context);
      return '';
    } catch (err: any) {
      if (err?.code !== 'timeout') {
        console.error(`[title] ${kind} MiMo API call failed: ${err?.message || String(err)}`, context);
        return '';
      }
      console.warn(`[title] ${kind} MiMo timed out, falling back to DeepSeek`, context);
    }
  }

  const deepSeek = deepSeekProvider();
  if (!deepSeek) {
    console.log('[title] no configured title provider, skipping LLM title generation', context);
    return '';
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const label = `attempt ${attempt + 1}/${MAX_RETRIES + 1}`;
    try {
      const raw = await callProviderOnce(deepSeek, systemContent, userContent, maxLen);
      if (raw) return raw;
      console.warn(`[title] ${kind} DeepSeek returned empty content (${label})`, context);
    } catch (err: any) {
      const message = err?.message || String(err);
      if (!err?.retryable || attempt >= MAX_RETRIES) {
        console.error(`[title] ${kind} DeepSeek API call failed (${label}): ${message}`, context);
        break;
      }
      const delay = err.retryAfterMs ?? backoffMs(attempt);
      console.warn(`[title] ${kind} ${label} failed (${message}), retrying in ${delay}ms`, context);
      await sleep(delay);
      continue;
    }
    if (attempt >= MAX_RETRIES) break;
    await sleep(backoffMs(attempt));
  }
  return '';
}

/** Parse Retry-After header (delta-seconds or HTTP-date) into ms, capped at MAX_BACKOFF_MS. */
function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const secs = parseInt(header, 10);
  if (!Number.isNaN(secs)) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    return Math.min(Math.max(0, date.getTime() - Date.now()), MAX_BACKOFF_MS);
  }
  return undefined;
}

/** Exponential backoff: BASE_BACKOFF_MS * 2^attempt, capped at MAX_BACKOFF_MS. */
function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Clean up DeepSeek-generated title: strip quotes, punctuation, enforce length */
function cleanTitleLen(title: string, maxLen: number): string {
  title = title.replace(/^["'"「『「]|["'"」』」]$/g, '');
  title = title.replace(/[.,，。！!?？;；:：]+$/, '');
  if (title.length > maxLen) title = title.slice(0, maxLen);
  return title.trim() || '';
}
function cleanTitle(title: string): string { return cleanTitleLen(title, MAX_TITLE_LEN); }

const MAX_SUBAGENT_TITLE_LEN = 20;

const SUBAGENT_SYSTEM_PROMPT = (agentType: string) => `You are a subagent task title generator. The parent agent dispatched a "${agentType}" subagent for a specific task. From the subagent's task prompt below, generate a concise task-oriented title.

Rules:
- Maximum 20 characters
- Format: "<action verb> · <target file/scope>" (e.g. "审查 · docker-compose.prod.yml", "探索 · relay/src", "深挖 · SENSITIVE-TOBS")
- Summarize the concrete task/target, NOT the generic agent type
- No quotes, no trailing punctuation
- Detect language from the task message; if the user's UI language is given, prefer it
- Return ONLY the title text`;

/**
 * Generate a task-oriented title for a subagent based on its task prompt + agent_type.
 * 失败一律返回 '' (调用方据此保持 title NULL)。复用 MiMo-first provider 路由。
 */
export async function generateSubagentTitle(userMessage: string, agentType: string, locale?: string): Promise<string> {
  const systemContent = locale ? `${SUBAGENT_SYSTEM_PROMPT(agentType)}\n\n${LOCALE_HINT(locale)}` : SUBAGENT_SYSTEM_PROMPT(agentType);
  const raw = await generateWithPreferredProvider(
    systemContent,
    `Subagent task prompt: ${userMessage}`,
    MAX_SUBAGENT_TITLE_LEN,
    {},
    'subagent',
  );
  return raw ? cleanTitleLen(raw, MAX_SUBAGENT_TITLE_LEN) : '';
}
