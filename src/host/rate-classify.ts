/**
 * 429 / 失败分类层 —— 池编排的第 1 层，纯函数、无 peer。
 *
 * 三段来源拼成一个判据：
 *   1. `classify429Body`（design D1，2026-09-04 实测）：
 *      按 error.code 二分类——code 8 = rps/rpm 速率桶（quota:'rate'），
 *      code 429001 = inference tpm 限速（quota:'tpm'）；code 实测可能是数字或字符串。
 *      按 code 而非 message/type 分类：message 措辞随版本漂移，429001 的 type 实测为
 *      invalid_request_error 而非官方错误表标注的 quota_exceeded_error。
 *   2. 池类（pool）——**2026-11-03 请求侧信号归零**：旧判据为 message 子串
 *      （"allocated quota exceeded" / "quota exceeded for the current window"），
 *      实测全部命中限流（Throttling.AllocationQuota = workspace 分配配额节流、rpm
 *      形态；18 条真机 pool 日志均为限流误标、词条 2 无任何出处）——两个词条已删。
 *      积分池耗尽的 body 形状至今零样本，请求侧识别 = tpm 持续判据（同 key 首撞
 *      超 30min 仍无成功 ⇒ 打格；key-orchestrator 时钟 + llm-adapter 分派）；
 *      管线（pool429 → 打格 → 全组终止）由此重新有了生产者。
 *   3. 未知 429 形态兜底归 rate（轮转+可重试侧；宿主重试层有次数上限，不会卡死）。
 *
 * 分类结果是池层（key-orchestrator）与适配器共同消费的契约。**两个正交字段**：
 * `bucket`（tpm / rpm，由 code 里的桶类型决定）只决定**计不计踢出**；
 * `kind` 只作日志标签；退避值统一走 `PROBE_BACKOFF_STEPS_MS` 一套梯子
 * （2026-11-02 他拍板：不再分快慢两套——插件内 4 轮序列本身已 20-40s，
 * 远超 14s 桶补充周期，快窗口的 15s 静态 floor 失去依据）。
 * 「计不计踢出」的单一判据 = bucketCountsStrike，adapter 与 vision 回调都从这取。
 *
 * 为什么 strike 只认 TPM 桶（2026-11-02 定稿）：踢出阈值的前提是「持续命中说明
 * 这把 key 值得关禁闭」。RPM 桶 14s 级自愈，贴线限流时计入只会把健康 key 踢出池
 * （2026-10-31 他拍板：先 429003，随后 code 8 一并）。作用域（Endpoint/Account）
 * **零处置差异**，只保留作 kind 日志标签。
 *
 * @module dsh-sensenova-suite/rate-classify
 */

/**
 * 旧「速率桶 15s 静态下限」——2026-11-02 统一梯子后**已无生产读者**，仅保留常量
 * 供历史文档引用对照。新值统一走 PROBE_BACKOFF_STEPS_MS（3/5/10/15/30s）。
 */
export const QUOTA_RATE_RETRY_FLOOR_MS = 15_000;

/**
 * 配额类 429 的分级探测退避档位（毫秒）——**全配额类共用一套**（2026-11-02 拍板）。
 * 每次宿主重试各自重新探测，等待随连续命中次数递增
 * 3s → 5s → 10s → 15s → 30s 后封顶（每轮重置、不继承：任一成功即清零）。
 *
 * 2026-09-04 定稿 3–15s 四档；2026-10-27 放宽到 3–30s 八档；2026-11-02 收敛为
 * 5 档 30s 封顶，并**统一快慢窗口**：旧实现给快窗口（code 8 / 429003 / *RPM*）
 * 一个 15s 静态 floor，理由是「覆盖 14s 桶补充周期」——但该理由建立在「宿主等待
 * 是唯一恢复窗口」的旧形态上；4 轮方案落地后插件内序列本身已 20-40s，远超一个
 * 桶周期，15s 静态值失去依据，统一走梯子更简单（前几档短→瞬时抖动快恢复，
 * 后几档长→长窗口期降低请求密度）。
 *
 * 封顶 30s 而非上游 freeapi 的 120s：DSH 宿主对 providerRetryAfterMs > 单次延迟
 * 上限（60s）直接放弃重试（见 adapter.ts 的 QUOTA_RETRY_AFTER_CEILING_MS）。
 *
 * 官方文档将 429 统一标注为 quota_exceeded_error 且建议「指数退避重试」，未公开数值；
 * 实测 key A 30k 请求 429001、key B 同刻通过 → per-key 限速差异，短探测 + 换 key 优先。
 */
export const PROBE_BACKOFF_STEPS_MS: readonly number[] = [3_000, 5_000, 10_000, 15_000, 30_000];

/**
 * 按命中计数取本次退避档位（超出末档则保持在末档）。
 */
export function probeFloorFor(hits: number): number {
  const index = Math.min(Math.max(0, Math.floor(hits)), PROBE_BACKOFF_STEPS_MS.length - 1);
  return PROBE_BACKOFF_STEPS_MS[index] ?? PROBE_BACKOFF_STEPS_MS[PROBE_BACKOFF_STEPS_MS.length - 1]!;
}

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

/** 429 分类（rate 细分五档含 rate-soft，unknown 兜底归 rate）。pool 保留为管线
 * kind：2026-11-03 起请求侧无生产者（特征串判定已废），池格由 console 通道与
 * tpm 持续判据（另行落地）驱动。 */
export type RateLimitKind = "rate-rps" | "rate-tpm" | "rate-endpoint" | "rate-account" | "rate-soft" | "pool" | "unknown";

/**
 * 限流窗口维 —— **唯一参与处置决策的维度**（2026-11-02）。
 *
 * 桶类型由平台写在 code 里（`…TPMExceeded` / `…RPMExceeded`），实测窗口差一个
 * 量级（code 8 约 15s 自愈 vs EndpointTPM 十分钟以上不恢复）。作用域
 * （Endpoint/Account）**不参与决策**，只留作 kind 日志标签——全仓无分支消费
 * 两族的区别。
 */
export type RateBucket = "tpm" | "rpm";

/**
 * 该桶是否计入「连续 3 次踢出」阈值——**单一判据**，adapter 与 vision
 * 回调都从这里取，不各自维护软硬名单。
 *
 * 只有 TPM 桶（分钟级以上）计数：持续命中才说明这把 key 值得关禁闭。RPM 桶
 * （code 8 / 429003 / *RPM* 族，14s 级自愈）贴线限流时计入只会把健康 key 踢出
 * 池、缩小轮换面（2026-10-31 他拍板先 429003 后 code 8；2026-11-02 退避值统一
 * 后，踢出判据仍是这条按桶的正判据，不随退避策略变化）。pool / unknown 另有
 * 口径（格子 / 只换不记）。
 */
export function bucketCountsStrike(bucket: RateBucket | undefined): boolean {
  return bucket === "tpm";
}

/**
 * 从 code 文本读桶类型（只认命名里的 RPM/TPM，**不读 message**——`inference
 * exceeds tpm/rpm limit` 同时含两者，上游 2026-09-24 就栽在这）。无桶标记时
 * 按 TPM 兜底：作用域族的已知成员都是 TPM 形态，未知新成员落到「计数踢出」
 * 侧才符合闸门语义（兜底往宽松侧等于闸门不存在）。
 */
function bucketOfCode(code: string): RateBucket {
  if (/rpm/i.test(code)) return "rpm";
  return "tpm";
}

/** provider 形状的 429 分类结果（quota:true 即速率/TPM/端点/账号类）。 */
export interface RateLimit429Classification {
  quota: boolean;
  retryFloorMs: number | undefined;
  /**
   * 配额子类（**仅日志标签**，不参与处置决策）：'rate'（code 8 速率桶）、
   * 'tpm'（code 429001 推理 token 限速）、'endpoint'
   * （`RateLimitExceeded.Endpoint*Exceeded`）、'account'
   * （`ModelAccount*RateLimitExceeded`）、'rate-soft'（429003，观测多呈 rpm）。
   *
   * 后两者是 2026-10-31 实测新增：同一时刻 A/C 200、B 429，证明它们到不了
   * 「端点共享」——换 key 能绕开（B 换模型仍 429，说明是这把 key 自己的窗口）。
   * 旧结论「端点共享、换 key 无用」没有实测支撑，已推翻。**作用域本身零处置
   * 差异**，2026-11-02 起处置只看 `bucket`（踢出）与统一梯子（退避）。
   */
  kind: "rate" | "tpm" | "endpoint" | "account" | "rate-soft" | undefined;
  /** 桶类型（**踢出判据**）；非配额类为 undefined。退避值不再按桶分。 */
  bucket: RateBucket | undefined;
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
  const none: RateLimit429Classification = { quota: false, retryFloorMs: undefined, kind: undefined, bucket: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return none;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return none;
  const code = parsed.error.code;
  // 退避值统一：所有配额类都给梯子第 0 档，实际档位由 adapter 的入口快照决定。
  const floor = probeFloorFor(0);
  if (typeof code !== "number" && typeof code !== "string") {
    // Anthropic 线（/v1/messages）的限流用 error.type 表达、无数字 code（2026-11-05
    // 真机样本：type=rate_limit_error + message "inference exceeds tpm/rpm limit"，
    // 用户口径实测 rpm 形态）——与 chat 线 insufficient_quota（同一条 message，批 A
    // 拍板 rpm 不计踢）同桶同待遇：换 key、不记 strike。协议结构化字段，非 message
    // 子串匹配（POOL_EXHAUSTED_MARKERS 的教训）。type 不是 rate_limit_error 的 an
    // 线形状 → unknown 兜底轮池（有样本再收编）。数字 code 优先于此分支：万一
    // 未来带 code 的体也带同 type，code 的桶判定（如 429001=tpm）不被劫持。
    if (parsed.error.type === "rate_limit_error") return { quota: true, retryFloorMs: floor, kind: "rate-soft", bucket: "rpm" };
    return none;
  }
  if (code === 8 || code === "8") return { quota: true, retryFloorMs: floor, kind: "rate", bucket: "rpm" };
  // 429003 → rate-soft（2026-10-31 他拍板）：样本 message 与 429001 全同、type 与
  // Endpoint 族全同（内容上区分不了），归速率桶是观测推断；后续实测它多呈 rpm 形态
  // 快速自愈——计入踢出阈值会把贴线限流的健康 key 踢出池，故轮换但不记 strike。
  if (code === 429003 || code === "429003") return { quota: true, retryFloorMs: floor, kind: "rate-soft", bucket: "rpm" };
  if (code === 429001 || code === "429001") return { quota: true, retryFloorMs: floor, kind: "tpm", bucket: "tpm" };
  if (typeof code === "string") {
    // insufficient_quota：freeapi 实测 message 同为 tpm/rpm 限流措辞，命名误导、
    // 实为速率限流（曾按名字误归池类，2026-10-31 订正）；2026-11-03 用户真机样本
    // （message "inference exceeds tpm/rpm limit"）实测 rpm 形态快速自愈——按 rpm
    // 桶换 key 不计踢（与 429003 同待遇；漏踢真 tpm 由梯子+宿主重试兜底）。
    if (code === "insufficient_quota") return { quota: true, retryFloorMs: floor, kind: "rate-soft", bucket: "rpm" };
    // Throttling.AllocationQuota：Workspace 分配配额节流（2026-11-03 用户真机样本
    // "Workspace allocated quota exceeded, please increase your quota limit." 实测
    // 为 rpm 限流：14s~1min 自愈、4 账号同秒各自撞各自的模型级分配配额窗）——
    // code 里的 quota/Allocation 是配额维措辞，不是积分池耗尽；旧实现以 message
    // 子串 "allocated quota exceeded" 把它误归池类（POOL_EXHAUSTED_MARKERS，已废）。
    if (code === "Throttling.AllocationQuota") return { quota: true, retryFloorMs: floor, kind: "rate-soft", bucket: "rpm" };
    // 作用域族：桶类型写在 code 里（…TPMExceeded / …RPMExceeded），只决定**踢出
    // 判据**（RPM 不计、TPM 计）；退避值统一走梯子，不再按桶分两套。
    if (ENDPOINT_RATE_CODE.test(code)) return { quota: true, retryFloorMs: floor, kind: "endpoint", bucket: bucketOfCode(code) };
    if (ACCOUNT_RATE_CODE.test(code)) return { quota: true, retryFloorMs: floor, kind: "account", bucket: bucketOfCode(code) };
  }
  return none;
}

/**
 * 分类层的完整分类：响应体文本 → kind 标签 + 桶类型 + 退避下限。
 *
 * - code 8 → rate-rps / rpm 桶（不计数踢出）
 * - code 429003 → rate-soft / rpm 桶（2026-10-31 他拍板：观测多呈 rpm）
 * - code 429001 → rate-tpm / tpm 桶
 * - `RateLimitExceeded.Endpoint*Exceeded` → rate-endpoint，桶按 code 里的 TPM/RPM 定
 * - `ModelAccount*RateLimitExceeded` → rate-account（同上，按 TPM/RPM 定桶）
 * - `insufficient_quota` / `Throttling.AllocationQuota` → rate-soft / rpm 桶（2026-11-03
 *   真机样本实测均为 rpm 限流，见 classify429Body 内注）
 * - 其余未知形态 → unknown / 无桶（兜底按 rate 处理：轮转+可重试；宿主 maxRetries
 *   封顶；不计数——形状不明时判死一把 key 太武断）
 * - 旧「池类特征串」message 子串判定已废（2026-11-03：两个词条实测全为限流误标，
 *   见模块头注）；kind:"pool" 暂无请求侧生产者，池格由 console 通道与 tpm 持续
 *   判据（另行落地）驱动。
 */
export function classify429Full(bodyText: string): { kind: RateLimitKind; bucket: RateBucket | undefined; retryFloorMs: number | undefined } {
  const byCode = classify429Body(bodyText);
  if (byCode.kind === "rate") return { kind: "rate-rps", bucket: byCode.bucket, retryFloorMs: byCode.retryFloorMs };
  if (byCode.kind === "rate-soft") return { kind: "rate-soft", bucket: byCode.bucket, retryFloorMs: byCode.retryFloorMs };
  if (byCode.kind === "tpm") return { kind: "rate-tpm", bucket: byCode.bucket, retryFloorMs: byCode.retryFloorMs };
  if (byCode.kind === "endpoint") return { kind: "rate-endpoint", bucket: byCode.bucket, retryFloorMs: byCode.retryFloorMs };
  if (byCode.kind === "account") return { kind: "rate-account", bucket: byCode.bucket, retryFloorMs: byCode.retryFloorMs };
  return { kind: "unknown", bucket: undefined, retryFloorMs: undefined };
}

/**
 * 429 响应体的一句话摘要（诊断行用，2026-11-03 批 C）：结构化 body 提取
 * code/type/message（message 截 120 字），非 JSON 原文截断。动机：pool 类
 * 误分类破案（2026-11-02 真机事故）全程被「429 行不打 body」卡住——积分池
 * 耗尽的 body 形状至今零样本，摘要落日志后下次真撞即可识别。
 */
export function summarize429Body(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const rawCode = parsed.error.code;
      const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : "-";
      const type = typeof parsed.error.type === "string" ? parsed.error.type : "-";
      const message = typeof parsed.error.message === "string" ? parsed.error.message.slice(0, 120) : "-";
      return `code=${code} type=${type} msg="${message}"`;
    }
  } catch {
    // 非 JSON：原文截断落日志（网关 HTML/代理错误页也是形状证据）。
  }
  return `raw="${bodyText.slice(0, 120)}"`;
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

/** 提交给 provider 重试层的延迟上限（毫秒）：本地退避与非配额 429 的 Retry-After 均受
 * 此约束，同时作为重试策略退避单次上限；池类下限与此一致（provider 实测定值）。
 * fix-sensenova-429-quota-retry（2026-09-04 实测）：原 3000ms 与配额窗口量级不符——
 * TPM 为 60 秒窗口，提升到 60000ms（spec 允许区间 60–120s 的下沿）。
 * 唯一定义点（2026-11-03 U4 审计 D2：adapter 本地副本已删，消费方统一经 import 引用）。 */
export const PROVIDER_RETRY_AFTER_CAP_MS = 60_000;
