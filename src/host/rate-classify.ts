/**
 * 429 / 失败分类层 —— 池编排的第 1 层，纯函数、无 peer。
 *
 * 三段来源拼成一个判据：
 *   1. `classify429Body`（design D1，2026-09-04 实测）：
 *      按 error.code 二分类——code 8 = rps/rpm 速率桶（quota:'rate'），
 *      code 429001 = inference tpm 限速（quota:'tpm'）；code 实测可能是数字或字符串。
 *      按 code 而非 message/type 分类：message 措辞随版本漂移，429001 的 type 实测为
 *      invalid_request_error 而非官方错误表标注的 quota_exceeded_error。
 *   2. 池类（pool）——「Allocated quota exceeded」形态（provider-config 文档记录、
 *      pi-ai 的 isQuotaExceededError 同款判据）：积分池耗尽，滚动 5h/周窗口自愈。
 *   3. 未知 429 形态兜底归 rate（轮转+可重试侧；宿主重试层有次数上限，不会卡死）。
 *
 * 分类结果是池层（key-orchestrator）与适配器共同消费的契约：
 * rate-tpm/rate-endpoint/rate-account → 计数踢出 + 换 key；rate-rps/rate-soft（两个
 * 速率桶形态，14s 级自愈）→ 换 key 但不计数（2026-10-31 他拍板，先 429003 后 code 8）；
 * pool → 记 (key, 组) 格子 + 换 key；auth(401) → 永久禁用。`retryFloorMs` 为
 * provider 实测退避下限（15s 覆盖速率桶 ≈1 个/14s 的完整补充周期）。
 * 「计不计踢出」的单一判据 = rateKindCountsStrike，adapter 与 vision 回调都从这取。
 *
 * @module dsh-sensenova-suite/rate-classify
 */

/** 配额类（速率桶）429 退避下限（毫秒）。2026-09-04 实测：速率桶补充 ≈1 个/14s，
 * 15s 覆盖一个完整补充周期。 */
export const QUOTA_RATE_RETRY_FLOOR_MS = 15_000;

/**
 * 429001 分级探测退避档位（毫秒）——不设长固定下限（60s/180s 均会把用户干锁在
 * 死等里），而是每次宿主重试各自重新探测，等待随连续 429001 次数递增
 * 3s → 5s → 10s → 15s → 20s → 25s → 30s 后封顶（每轮重置、不继承：任一成功即清零）。
 * 2026-09-04 定稿 3–15s 四档；2026-10-27 用户拍板放宽到 3–30s 八档（多会话
 * 反复耗干 TPM 桶的恢复窗口更长，探测节奏跟着放宽）。
 * 官方文档将 429 统一标注为 quota_exceeded_error 且建议「指数退避重试」，未公开数值；
 * 实测 key A 30k 请求 429001、key B 同刻通过 → per-key 限速差异，短探测 + 换 key 优先。
 */
export const TPM_PROBE_BACKOFF_STEPS_MS: readonly number[] = [3_000, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 30_000];

/**
 * 池类 429 的响应体特征（Allocated quota exceeded，provider-config docs 实测形态）。
 *
 * `insufficient_quota` 曾按名字列在这里，2026-10-31 依上游 freeapi 订正移出：它
 * 命名像「配额耗尽」、实为 tpm/rpm 速率限流（freeapi adapter.ts 明写「命名误导：
 * message 同为 tpm/rpm 限流」），归池类会把速率窗误记成 (key,组) 积分格——组内
 * 全中招时还会错误触发「换无可换」快速失败，而实测换 key 能绕开。现按 code 归
 * tpm 档（classify429Body 的 string-code 分支）。
 */
const POOL_EXHAUSTED_MARKERS: readonly string[] = [
  "allocated quota exceeded",
  "quota exceeded for the current window",
];

/**
 * 限流器的 code 族（2026-10-31 真 key 实测捕获）。
 *
 * 商汤把作用域写进了 code：`RateLimitExceeded.Endpoint*Exceeded` 与
 * `ModelAccount*RateLimitExceeded`。两类都按**配额类**处理（换 key），依据是
 * 同一时刻 A/C 200、B 429——作用域到不了端点，换 key 能绕开；B 换 kimi-k3 仍
 * 429，说明是这把 key 自己的窗口，不是单模型问题。
 *
 * 只按 code 判定，**不看 message**：实测里 `code=8` 与 `EndpointTPMExceeded`
 * 都会附带同一句 `inference exceeds tpm/rpm limit`，message 无法区分类型。
 */
const ENDPOINT_RATE_CODE = /^RateLimitExceeded\.Endpoint[A-Za-z0-9]*Exceeded$/i;
const ACCOUNT_RATE_CODE = /^ModelAccount[A-Za-z0-9]*RateLimitExceeded$/i;

/** 429 分类（rate 细分五档含 rate-soft，pool=积分池，unknown 兜底归 rate）。 */
export type RateLimitKind = "rate-rps" | "rate-tpm" | "rate-endpoint" | "rate-account" | "rate-soft" | "pool" | "unknown";

/**
 * 该全链分类是否计入「连续 3 次踢出」阈值——**单一判据**，adapter 与 vision
 * 回调都从这里取，不各自维护软硬名单。
 *
 * 只有窗口分钟级以上的重形态（tpm / endpoint / account）计数：持续命中才说明
 * 这把 key 值得关禁闭。两个速率桶形态（rate-rps = code 8、rate-soft = 429003）
 * 14s 级自愈，贴线限流时计入只会把健康 key 踢出池、缩小轮换面（2026-10-31
 * 他拍板：先 429003，随后 code 8 一并）。pool / unknown 另有口径（格子 / 只换不记）。
 */
export function rateKindCountsStrike(kind: RateLimitKind | undefined): boolean {
  return kind === "rate-tpm" || kind === "rate-endpoint" || kind === "rate-account";
}

/** provider 形状的 429 分类结果（quota:true 即速率/TPM/端点/账号类）。 */
export interface RateLimit429Classification {
  quota: boolean;
  retryFloorMs: number | undefined;
  /**
   * 配额子类：'rate'（code 8 速率桶）、'tpm'（code 429001 推理 token 限速）、
   * 'endpoint'（`RateLimitExceeded.Endpoint*Exceeded`）、'account'
   * （`ModelAccount*RateLimitExceeded`）、'rate-soft'（429003，观测多呈 rpm 且
   * 快速自愈——轮换不记 strike）。
   *
   * 后两者是 2026-10-31 实测新增：同一时刻 A/C 200、B 429，证明它们到不了
   * 「端点共享」——换 key 能绕开（B 换模型仍 429，说明是这把 key 自己的窗口）。
   * 旧结论「端点共享、换 key 无用」没有实测支撑，已推翻。
   */
  kind: "rate" | "tpm" | "endpoint" | "account" | "rate-soft" | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 429 响应体并按 error.code 分类（design D1，2026-09-04 实测；code 族扩充
 * 2026-10-31 真 key 实测）。
 *
 * - `8` → rate（速率桶）
 * - `429001` → tpm（推理 token 限速）
 * - `429003` → rate-soft（观测多呈 rpm 且快速自愈；轮换不记 strike——2026-10-31）
 * - `RateLimitExceeded.Endpoint*Exceeded` → endpoint
 * - `ModelAccount*RateLimitExceeded` → account
 * - `insufficient_quota` → tpm（freeapi 订正：命名误导，实为速率限流；2026-10-31
 *   从池类特征串移到这里）
 *
 * 其余（含无 code、非 JSON 体、解析失败）归非配额类，维持现行短退避语义。
 */
export function classify429Body(bodyText: string): RateLimit429Classification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { quota: false, retryFloorMs: undefined, kind: undefined };
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return { quota: false, retryFloorMs: undefined, kind: undefined };
  const code = parsed.error.code;
  if (typeof code !== "number" && typeof code !== "string") return { quota: false, retryFloorMs: undefined, kind: undefined };
  if (code === 8 || code === "8") return { quota: true, retryFloorMs: QUOTA_RATE_RETRY_FLOOR_MS, kind: "rate" };
  // 429003 → rate-soft（2026-10-31 他拍板）：样本 message 与 429001 全同、type 与
  // Endpoint 族全同（内容上区分不了），归速率桶是观测推断；后续实测它多呈 rpm 形态
  // 快速自愈——计入踢出阈值会把贴线限流的健康 key 踢出池，故轮换但不记 strike
  // （adapter/vision 侧按 kind 路由）。15s floor 照旧（只在换无可换的最终失败生效）。
  if (code === 429003 || code === "429003") return { quota: true, retryFloorMs: QUOTA_RATE_RETRY_FLOOR_MS, kind: "rate-soft" };
  if (code === 429001 || code === "429001") return { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: "tpm" };
  if (typeof code === "string") {
    // 短下限即可：轮换到下一把 key 是主动作，下限只在「池里换无可换」时才生效。
    // insufficient_quota：freeapi 实测 message 同为 tpm/rpm 限流措辞，命名误导、
    // 实为速率限流（曾按名字误归池类，2026-10-31 订正）——按 tpm 档换 key + 分级探测。
    if (code === "insufficient_quota") return { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: "tpm" };
    if (ENDPOINT_RATE_CODE.test(code)) return { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: "endpoint" };
    if (ACCOUNT_RATE_CODE.test(code)) return { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: "account" };
  }
  return { quota: false, retryFloorMs: undefined, kind: undefined };
}

/**
 * 分类层的完整分类：响应体文本 → 六类 + 退避下限。
 *
 * - code 8 → rate-rps（15s 下限）
 * - code 429001 → rate-tpm（3s 起分级）
 * - code 429003 → rate-soft（15s 下限；轮换不记 strike——2026-10-31 他拍板）
 * - `RateLimitExceeded.Endpoint*Exceeded` → rate-endpoint（3s 起，换 key 主动作）
 * - `ModelAccount*RateLimitExceeded` → rate-account（同上）
 * - 池类特征串（大小写不敏感）→ pool（15s 下限：池窗口分钟级自愈，硬重试无意义，
 *   15s 只是「换完一圈 key 再回来看」的节奏）
 * - 其余未知形态 → unknown（兜底按 rate 处理：轮转+可重试；宿主 maxRetries 封顶）
 */
export function classify429Full(bodyText: string): { kind: RateLimitKind; retryFloorMs: number | undefined } {
  const byCode = classify429Body(bodyText);
  if (byCode.kind === "rate") return { kind: "rate-rps", retryFloorMs: byCode.retryFloorMs };
  if (byCode.kind === "rate-soft") return { kind: "rate-soft", retryFloorMs: byCode.retryFloorMs };
  if (byCode.kind === "tpm") return { kind: "rate-tpm", retryFloorMs: byCode.retryFloorMs };
  if (byCode.kind === "endpoint") return { kind: "rate-endpoint", retryFloorMs: byCode.retryFloorMs };
  if (byCode.kind === "account") return { kind: "rate-account", retryFloorMs: byCode.retryFloorMs };
  const lower = bodyText.toLowerCase();
  if (POOL_EXHAUSTED_MARKERS.some((marker) => lower.includes(marker))) {
    return { kind: "pool", retryFloorMs: QUOTA_RATE_RETRY_FLOOR_MS };
  }
  return { kind: "unknown", retryFloorMs: undefined };
}

/**
 * Retry-After / RetryAfter 头解析。
 * 支持 HTTP 日期与秒数两种形态；结果交上层封顶（PROVIDER_RETRY_AFTER_CAP_MS）。
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? seconds * 1000 : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const delta = date - now;
  return delta > 0 ? delta : undefined;
}

/** 提交给 provider 重试层的延迟上限（毫秒）；池类下限与此一致（provider 实测定值）。 */
export const PROVIDER_RETRY_AFTER_CAP_MS = 60_000;
