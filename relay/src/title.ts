/**
 * Session title generation using 智谱 GLM-4.6 API.
 * Generates a concise title (≤15 chars) from the first user+assistant messages.
 * Falls back to user message truncation on any failure.
 */

const GLM_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const GLM_MODEL = 'glm-4.6';
const GLM_TIMEOUT_MS = 3_000;
const MAX_TITLE_LEN = 15;

const SYSTEM_PROMPT = `You are a session title generator. Based on the conversation, generate a concise session title.

Rules:
- Maximum 15 characters
- Summarize the core task/intent
- No quotes, no trailing punctuation
- Match the language of the user's message: if the user writes in English, the title MUST be in English; if in Chinese, in Chinese
- Detect the language from the user message, NOT the assistant message
- Return ONLY the title text, no explanation`;

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

    const content = `User message: ${userMessage}\n\nAssistant reply: ${assistantMessage}`;

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
