/**
 * The client's one HTTP seam for POSTs.
 *
 * Every component that writes to the Host used to carry its own copy of the
 * fetch boilerplate — the same `{ method, headers, cache, body }` block plus
 * a `.json().catch(() => null)` — five times over, and the copies drifted
 * (one missed `accept`, another the status fallback). This module is the
 * single definition.
 *
 * Two faces, one raw core:
 *   - `postJson` returns the parsed body (or null when the response is not
 *     JSON): for call sites that must READ a refusal (AccountForm branches
 *     on `code` / `retryAfterMs` / `detail`).
 *   - `postJsonOrThrow` demands `ok:true` and throws otherwise: for the
 *     switches (ProviderSwitch, DrawSwitch, ModelPicker) that only care
 *     whether the write landed. The thrown message carries the Host's own
 *     `error` prose, or `HTTP <status>` when the body is not JSON.
 *
 * The Host answers HTTP 200 for every expected outcome and signals success
 * or refusal in the body's `ok` field, so neither face inspects
 * `response.ok` — `postJsonOrThrow` falls back to the status only when the
 * body is unusable, which is the same fallback the pre-split code used.
 */

/** A Host JSON answer; every field is optional because the fallback is the
 * body itself (null) or a plain string, never a promise of shape. */
export interface ApiBody {
  ok?: boolean;
  error?: string | null;
  code?: string;
  detail?: string;
  retryAfterMs?: number;
  /** Anything else the Host put in the body (e.g. the snapshot data). */
  [key: string]: unknown;
}

/** One POST with the panel's fixed request shape; the parsed body or null. */
async function postRaw(path: string, payload: Record<string, unknown>): Promise<{ status: number; body: ApiBody | null }> {
  // 序列化在 fetch 之外：它失败是**客户端 bug**（把 DOM 事件/React fiber 当值传了），
  // 不是网络问题。曾经两者共用一个 catch，于是循环引用被报成「网络层失败」
  // （2026-10-24 事故：ToggleSwitch 把 React 事件对象交给了 handler）。
  let bodyText: string;
  try {
    bodyText = JSON.stringify(payload);
  } catch (error) {
    throw new Error(`POST ${path}: the request payload is not serializable (client bug, not a network fault): ${error instanceof Error ? error.message : String(error)}`);
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      cache: "no-store",
      body: bodyText
    });
  } catch (error) {
    // 网络层失败（相对路径解析不到 / 被拦截 / Host 未起）：把真实原因带出去。
    // 「无法连接本机 Host」这句不带 URL 与异常，排查时等于没说。
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`POST ${path} failed at the network layer (${reason})`);
  }
  const body = await response.json().catch(() => null) as ApiBody | null;
  if (body === null) {
    // 非 JSON：路由不存在（旧 Host 构建）或网关层拒绝——带上状态码与路径。
    throw new Error(`POST ${path} returned non-JSON HTTP ${response.status}`);
  }
  return { status: response.status, body };
}

/**
 * POST and return the parsed body. Network-layer failures and non-JSON answers
 * THROW with the path and status (see {@link postRaw}): a caller that renders
 * "cannot reach the Host" without them cannot be debugged from the screen.
 */
export function postJson(path: string, payload: Record<string, unknown>): Promise<ApiBody | null> {
  return postRaw(path, payload).then(({ body }) => body);
}

/** POST and demand `ok:true`; refuse by throwing the Host's own wording. */
export async function postJsonOrThrow(path: string, payload: Record<string, unknown>): Promise<ApiBody> {
  const { status, body } = await postRaw(path, payload);
  if (body === null || body.ok !== true) {
    throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${status}`);
  }
  return body;
}