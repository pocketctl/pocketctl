/**
 * Session title generation using 智谱 GLM-4.6 API.
 * Generates a concise title (≤15 chars) from the first user+assistant messages.
 *
 * 失败语义（2026-07-04 改造）：
 * 任何失败 —— key 未配 / GLM HTTP 错误 / 超时 / 空内容 / 网络错误，且重试
 * MAX_RETRIES 次后仍失败 —— 都返回「空串」，而不是 fallback 截断串。
 *
 * 空串让 relay（router.ts:660 `if (!title) return`）跳过写库，title 保持
 * 默认占位状态（hasDefaultTitle 仍为 true），于是下次 daemon 有新消息再
 * 触发 generate_title_request 时，relay 会重新生成。这避免了旧逻辑里
 * 「一次 429 → fallback 写库 → title 不再是默认占位 → 永久锁死、不再生成」
 * 的问题。配合 title.ts 内部的重试 + daemon 侧的每轮重触发（上限 5 次），
 * 偶发 GLM 故障能自愈。
 */

const GLM_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const GLM_MODEL = 'glm-4.6';
const GLM_TIMEOUT_MS = 3_000;
const MAX_RETRIES = 2;          // 初次失败后最多重试 2 次（共 3 次尝试）
const BASE_BACKOFF_MS = 500;    // 指数退避基数：500ms → 1000ms
const MAX_BACKOFF_MS = 5_000;   // 单次退避上限
const MAX_TITLE_LEN = 15;

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
 * Generate a concise session title using GLM-4.6.
 *
 * 失败（key 未配 / 重试耗尽 / 空内容）一律返回空串 —— 调用方据此保持 title
 * 默认占位状态，等待下次重触发。绝不返回 fallback 截断串污染默认判定。
 *
 * @param userMessage - The first user message from the session
 * @param assistantMessage - The first assistant response from the session
 * @param locale - Optional UI locale for language preference (e.g. "zh", "en")
 * @returns A cleaned title string (≤15 chars), or '' on any failure
 */
export async function generateTitle(userMessage: string, assistantMessage: string, locale?: string): Promise<string> {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.log('[title] ZHIPU_API_KEY not set, skipping LLM title generation');
    return '';
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const label = `attempt ${attempt + 1}/${MAX_RETRIES + 1}`;
    try {
      const raw = await callGLMOnce(apiKey, userMessage, assistantMessage, locale);
      if (raw) return cleanTitle(raw);
      // GLM 200 但内容为空 —— 当作瞬时故障重试
      console.warn(`[title] GLM returned empty content (${label})`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      // 不可重试，或已用尽重试次数：放弃，返回空串
      if (!err?.retryable || attempt >= MAX_RETRIES) {
        console.error(`[title] GLM API call failed (${label}): ${msg}`);
        break;
      }
      const delay = err.retryAfterMs ?? backoffMs(attempt);
      console.warn(`[title] ${label} failed (${msg}), retrying in ${delay}ms`);
      await sleep(delay);
      continue;
    }
    // 走到这里 = 空内容，可重试；用完次数则跳出
    if (attempt >= MAX_RETRIES) break;
    await sleep(backoffMs(attempt));
  }
  return '';
}

/** Single GLM-4.6 call. Throws an Error tagged with retryable/retryAfterMs on failure. */
async function callGLMOnce(apiKey: string, userMessage: string, assistantMessage: string, locale?: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GLM_TIMEOUT_MS);

  try {
    const content = `User message: ${userMessage}\n\nAssistant reply: ${assistantMessage}`;
    const systemContent = locale ? `${SYSTEM_PROMPT}\n\n${LOCALE_HINT(locale)}` : SYSTEM_PROMPT;

    const response = await fetch(GLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        max_tokens: 32,
        temperature: 0.3,
        stream: false,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      if (response.status === 429) {
        console.warn(`[title] GLM 429 Too Many Requests${retryAfterMs ? ` (Retry-After ${retryAfterMs}ms)` : ''}`);
      }
      const err = new Error(`GLM API ${response.status} ${response.statusText}`);
      (err as any).retryable = retryable;
      (err as any).retryAfterMs = retryAfterMs;
      throw err;
    }

    const data = await response.json() as any;
    return data?.choices?.[0]?.message?.content?.trim() || '';
  } catch (err: any) {
    // AbortError（3s 超时）→ 可重试
    if (err?.name === 'AbortError') {
      err.message = 'GLM API timeout (3s)';
      err.retryable = true;
    } else if (err?.retryable === undefined) {
      // 裸 fetch 网络错误（TypeError "fetch failed" 等）→ 可重试
      err.retryable = true;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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

/** Clean up GLM-generated title: strip quotes, punctuation, enforce length */
function cleanTitle(title: string): string {
  // Strip surrounding quotes
  title = title.replace(/^["'"「『「]|["'"」』」]$/g, '');
  // Strip trailing punctuation
  title = title.replace(/[.,，。！!?？;；:：]+$/, '');
  // Enforce max length
  if (title.length > MAX_TITLE_LEN) {
    title = title.slice(0, MAX_TITLE_LEN);
  }
  return title.trim() || '';
}
