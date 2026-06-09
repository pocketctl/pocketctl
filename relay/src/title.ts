/**
 * Session title generation using 智谱 GLM-4.6 API.
 * Generates a concise title (≤15 chars) from the first user+assistant messages.
 * Falls back to user message truncation on any failure.
 */

const GLM_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const GLM_MODEL = 'glm-4.6';
const GLM_TIMEOUT_MS = 3_000;
const MAX_TITLE_LEN = 15;

const SYSTEM_PROMPT = `你是一个标题生成器。根据用户的对话内容，生成一个简洁的 session 标题。

要求：
- 不超过15个字
- 概括核心任务/意图
- 不要使用引号、标点符号结尾
- 用用户消息的语言（中文/英文）回复
- 只返回标题文本，不要解释`;

/**
 * Generate a concise session title using GLM-4.6.
 * @param userMessage - The first user message from the session
 * @param assistantMessage - The first assistant response from the session
 * @returns A title string (≤15 chars), or a fallback truncation
 */
export async function generateTitle(userMessage: string, assistantMessage: string): Promise<string> {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.log('[title] ZHIPU_API_KEY not set, skipping LLM title generation');
    return fallbackTitle(userMessage);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GLM_TIMEOUT_MS);

    const content = `用户消息: ${userMessage}\n\n助手回复: ${assistantMessage}`;

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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[title] GLM API error: ${response.status} ${response.statusText}`);
      return fallbackTitle(userMessage);
    }

    const data = await response.json() as any;
    const title = data?.choices?.[0]?.message?.content?.trim();

    if (!title) {
      console.warn('[title] GLM returned empty content');
      return fallbackTitle(userMessage);
    }

    return cleanTitle(title);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn('[title] GLM API timeout (3s)');
    } else {
      console.error('[title] GLM API call failed:', err.message || err);
    }
    return fallbackTitle(userMessage);
  }
}

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

/** Fallback: truncate user message to MAX_TITLE_LEN characters */
function fallbackTitle(userMessage: string): string {
  const cleaned = userMessage.replace(/[\n\r]+/g, ' ').trim();
  if (cleaned.length <= MAX_TITLE_LEN) return cleaned;
  return cleaned.slice(0, MAX_TITLE_LEN);
}
