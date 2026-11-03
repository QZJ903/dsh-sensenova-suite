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
 *   - `QUOTA` / `ACCOUNT_QUOTA` — 额度耗尽类，fast-fail and let the panel say
 *     why.（2026-11-03 语义校准：旧注释断言「Token Plan pool is depleted」——但
 *     pool 类的请求侧识别（message 特征串）实测全部是限流误标已废，积分池耗尽的
 *     body 形状至今零样本；`QUOTA` 目前零生产者，`ACCOUNT_QUOTA` 唯一生产链 =
 *     「组内全部 key 持续限流升级」（tpm 持续判据，另行落地）+ console 通道。
 *     码位保留供接入。）
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
 * The strings mirror the `@deepseek-ai/dsh-llm` peer's error-code vocabulary
 * (`QUOTA_EXCEEDED_CODE = "QUOTA"`, `ACCOUNT_QUOTA_EXCEEDED_CODE =
 * "ACCOUNT_QUOTA"`, `EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"`). They are stable
 * protocol codes, not implementation details, so pinning them here is what the
 * qoder route does too. **手写镜像，无 import 防漂移**（2026-11-04 D6 定案）：
 * peer 的 `LlmError` 构造器 code 参数就是 string、不导出码表常量（peer
 * types/index.d.ts:71 实证），旧注释声称的「peer 改名会在 adapter 浮出」机制
 * 不存在——漂移由 retry.test / contract.test 的钉兜住；升 peer 版本先跑这两个
 * 套件。adapter 抛错面的完整码表见 {@link LLM_CODES}（quota 族经由本表展开）。
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
 * 适配器抛错面的完整码表（2026-11-04 D6a 单源化）：adapter.ts 的抛错码全部从
 * 这里取——同一个码在自家代码里不再有第二种写法（防内伤：string 码手滑写错
 * 本无 typecheck 兜底）。仍是手抄 peer 词汇表（见 QUOTA_CODES 注），不防外伤
 * （peer 改名），漂移靠钉。MODEL_NOT_FOUND 自造码与 ANTHROPIC_TRUNCATED 同理：
 * 平台形状的稳定协议码，peer 词表外的自留位。
 */
export const LLM_CODES = Object.freeze({
  ...QUOTA_CODES,
  /** 401 / 密钥缺失或无效。Not retried. */
  invalidCredential: "INVALID_CREDENTIAL",
  /** 上游 HTTP 非 2xx、无更细分类（4xx 族）。Not retried. */
  providerHttpError: "PROVIDER_HTTP_ERROR",
  /** 上游响应形状无法解析（SSE/JSON 破损）。Not retried. */
  providerProtocolError: "PROVIDER_PROTOCOL_ERROR",
  /** 请求参数问题（客户端错，重试无用）。Not retried. */
  invalidRequest: "INVALID_REQUEST",
  /** 模型 id 不可路由（404 形）。Not retried. */
  modelNotFound: "MODEL_NOT_FOUND",
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
