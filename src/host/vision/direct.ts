/**
 * 直连路径：用 `fetch` 调用商汤 OpenAI 兼容 `chat/completions`。
 *
 * `redirect: 'error'`（凭据请求拒重定向）；超时用 `AbortSignal.timeout`。
 * 单模型（用户选择）；HTTP 失败抛出的错误带 `status` 与 `body`，供上层把
 * 429/401 按套件教义回池（bridge.ts 的 VisionFeedback）。
 *
 * 纯函数 + 可注入 `fetchImpl`。
 *
 * @module dsh-sensenova-suite/vision/direct
 */

/** chat-completions base URL 幂等追加。 */
export function chatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions") || base.endsWith("/llm/chat-completions")) return base;
  return `${base}/chat/completions`;
}

/** 从响应 JSON 提取文本。 */
export function extractText(data: Record<string, unknown>): string {
  const choices = data["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (typeof first === "object" && first !== null) {
      const message = (first as Record<string, unknown>)["message"];
      if (typeof message === "object" && message !== null) {
        const content = (message as Record<string, unknown>)["content"];
        if (typeof content === "string") return content;
      }
    }
  }
  throw new Error(
    `SenseNova API response had no choices[0].message.content; raw response: ${JSON.stringify(data).slice(0, 800)}`,
  );
}

export interface PostChatOptions {
  apiBase: string;
  model: string;
  content: Array<Record<string, unknown>>;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * 一次 POST（server.py `_post_chat` 的 fetch 版）。HTTP 错误带状态码与响应体摘要；
 * 网络/超时错误带原因。**凭据请求拒重定向**（`redirect: 'error'`）。
 */
export async function postChat(options: PostChatOptions): Promise<Record<string, unknown>> {
  const url = chatUrl(options.apiBase);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`SenseNova request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
  try {
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: options.content }],
      }),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 800);
      const error = new Error(`SenseNova API returned HTTP ${response.status} for ${url}: ${body}`) as Error & { status?: number; body?: string };
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}
