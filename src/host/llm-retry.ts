/**
 * The directly-registered SenseNova provider's 429 retry policy — the peer-FREE
 * half of the 429 self-healing work.
 *
 * The *decision* (which failure classes this shared-pool provider retries) is
 * pure, so it lives here — importable on a clean checkout where the
 * `@deepseek-ai/dsh-llm` peer is not resolvable. `retryableCodes` is handed to
 * the peer's `resolveRetryPolicy` from `adapter.ts` (`providerRetryPolicy`,
 * which assembles the policy inline there — maxRetries/backoff live at that
 * call site, not here). `test/retry.test.mjs` and `test/contract.test.mjs` pin
 * the code list without importing that peer.
 *
 * The peer classifies a SenseNova 429 into two codes (`isQuotaExceededError` →
 * `rate.?limit` inside `classifyPiAiError`; the resolved policy is pinned by
 * the optional peer block at the end of `test/retry.test.mjs`, a SKIP when the
 * peer is absent):
 *
 *   - `QUOTA` / `ACCOUNT_QUOTA` — the Token Plan pool is depleted. Retrying
 *     cannot refill it, and the pool is SHARED across every model on this key,
 *     so hammering it only extends the cool-down (the same lesson `st-rotator`
 *     bakes into its AIMD limiter). Deliberately NOT retried: fast-fail and let
 *     the panel say why.
 *   - `RATE_LIMIT` — a transient throttle that self-clears. Retried, with a
 *     backoff biased longer than the peer default so one shared pool is not
 *     re-hit immediately: SenseNova's daytime rpm/tpm ceiling is aggressive
 *     (实测：`quota_exceeded_error` code 8 是
 *     per-minute rate cap), so we ride it out with more attempts and a gentler
 *     first step.
 *
 * @module dsh-sensenova-suite/llm-retry
 */

/**
 * The failure-class codes this provider reasons about, in peer-canonical
 * spelling.
 *
 * The strings mirror the `@deepseek-ai/dsh-llm` peer's error-code constants
 * (`QUOTA_EXCEEDED_CODE = "QUOTA"`, `ACCOUNT_QUOTA_EXCEEDED_CODE =
 * "ACCOUNT_QUOTA"`, `EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"`). They are stable
 * protocol codes, not implementation details, so pinning them here is what the
 * qoder route does too; `llm-adapter.ts` still imports the live constants from
 * the peer and passes them through `resolveRetryPolicy`, so a peer rename would
 * surface at the adapter, not silently drift here.
 */
export const QUOTA_CODES = Object.freeze({
  /** Depleted Token Plan pool (per-pool quota). Not retried. */
  quota: "QUOTA",
  /** Depleted account-level quota. Not retried. */
  accountQuota: "ACCOUNT_QUOTA",
  /** Empty/truncated response. Retried. */
  emptyResponse: "EMPTY_RESPONSE",
  /** Transient throttle (429 rate). Retried with backoff. */
  rateLimit: "RATE_LIMIT",
  /** Upstream 5xx. Retried. */
  server: "SERVER",
  /** Request deadline exceeded. Retried. */
  timeout: "TIMEOUT",
  /** Connection-level failure. Retried. */
  transport: "TRANSPORT"
});

/**
 * Anthropic 线流断尾专用码（2026-10-31）：平台 anthropic 线时好时坏，流在
 * message_stop 之前中断。自造码而不借用 TRANSPORT，是为了让「这个形态可重试」
 * 成为重试策略里的显式决策（而不是搭 TRANSPORT 的便车）——peer 的
 * `resolveRetryPolicy` 对 retryableCodes 只验非空字符串、不锁枚举（真机 asar
 * 实证），重试判定即 `retryableCodes.includes(failure.code)`。适配器还按它做
 * 内存级换线降级（adapter.ts 命中即 anthropicUnsupported.add）。
 */
export const ANTHROPIC_TRUNCATED_CODE = "ANTHROPIC_TRUNCATED";

/**
 * The failure classes this provider retries, in peer-canonical order.
 *
 * Excludes both quota codes on purpose: a depleted pool cannot be retried into
 * health, and retrying it against a shared credit pool only prolongs the
 * cool-down. `RATE_LIMIT` stays — transient throttles self-clear.
 * `ANTHROPIC_TRUNCATED_CODE` is the one non-peer code: ours, retried on purpose
 * (see its docstring) — the peer validates only non-empty unique strings.
 * @returns {string[]} the retryable code list (no duplicates, non-empty).
 */
export function retryableCodes() {
  return [
    QUOTA_CODES.emptyResponse,
    QUOTA_CODES.rateLimit,
    QUOTA_CODES.server,
    QUOTA_CODES.timeout,
    QUOTA_CODES.transport,
    ANTHROPIC_TRUNCATED_CODE
  ];
}
