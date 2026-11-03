import { N as maskKey, T as inputModalitiesFor, _ as contextWindowForId, a as effectiveChain, d as CONTEXT_WINDOW_FIELDS, g as MAX_OUTPUT_FIELDS, h as LLM_PROVIDER_ID, i as GLOBAL_FALLBACK_CHAIN, l as staticFacts, p as KNOWN_UNROUTABLE_MODELS, s as factsFor, t as contentHasImage$1, w as IMAGE_INPUT_MODALITIES, x as maxTokensForId } from "./bridge.js";
import { r as traceLog } from "./trace-log.js";
import { readFile } from "node:fs/promises";
import { LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders, contentHasImage, errorChain, offloadedImageText, projectImagesForTextModel, resolveRetryPolicy, textOnlyImageText } from "@deepseek-ai/dsh-llm";

//#region src/host/brand.ts
/**
* Brand a string as a {@link ToolCallId}.
* @param id - the provider-issued or synthesized call id.
* @returns the same string with the compile-time tool-call-id brand.
*/
function ToolCallId(id) {
	return id;
}

//#endregion
//#region src/host/rate-classify.ts
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
const PROBE_BACKOFF_STEPS_MS = [
	3e3,
	5e3,
	1e4,
	15e3,
	3e4
];
/**
* 按命中计数取本次退避档位（超出末档则保持在末档）。
*/
function probeFloorFor(hits) {
	const index = Math.min(Math.max(0, Math.floor(hits)), PROBE_BACKOFF_STEPS_MS.length - 1);
	return PROBE_BACKOFF_STEPS_MS[index] ?? PROBE_BACKOFF_STEPS_MS[PROBE_BACKOFF_STEPS_MS.length - 1];
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
function bucketCountsStrike(bucket) {
	return bucket === "tpm";
}
/**
* 从 code 文本读桶类型（只认命名里的 RPM/TPM，**不读 message**——`inference
* exceeds tpm/rpm limit` 同时含两者，上游 2026-09-24 就栽在这）。无桶标记时
* 按 TPM 兜底：作用域族的已知成员都是 TPM 形态，未知新成员落到「计数踢出」
* 侧才符合闸门语义（兜底往宽松侧等于闸门不存在）。
*/
function bucketOfCode(code) {
	if (/rpm/i.test(code)) return "rpm";
	return "tpm";
}
function isRecord$4(value) {
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
function classify429Body(bodyText) {
	const none = {
		quota: false,
		retryFloorMs: void 0,
		kind: void 0,
		bucket: void 0
	};
	let parsed;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return none;
	}
	if (!isRecord$4(parsed) || !isRecord$4(parsed.error)) return none;
	const code = parsed.error.code;
	if (typeof code !== "number" && typeof code !== "string") return none;
	const floor = probeFloorFor(0);
	if (code === 8 || code === "8") return {
		quota: true,
		retryFloorMs: floor,
		kind: "rate",
		bucket: "rpm"
	};
	if (code === 429003 || code === "429003") return {
		quota: true,
		retryFloorMs: floor,
		kind: "rate-soft",
		bucket: "rpm"
	};
	if (code === 429001 || code === "429001") return {
		quota: true,
		retryFloorMs: floor,
		kind: "tpm",
		bucket: "tpm"
	};
	if (typeof code === "string") {
		if (code === "insufficient_quota") return {
			quota: true,
			retryFloorMs: floor,
			kind: "rate-soft",
			bucket: "rpm"
		};
		if (code === "Throttling.AllocationQuota") return {
			quota: true,
			retryFloorMs: floor,
			kind: "rate-soft",
			bucket: "rpm"
		};
		if (ENDPOINT_RATE_CODE.test(code)) return {
			quota: true,
			retryFloorMs: floor,
			kind: "endpoint",
			bucket: bucketOfCode(code)
		};
		if (ACCOUNT_RATE_CODE.test(code)) return {
			quota: true,
			retryFloorMs: floor,
			kind: "account",
			bucket: bucketOfCode(code)
		};
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
function classify429Full(bodyText) {
	const byCode = classify429Body(bodyText);
	if (byCode.kind === "rate") return {
		kind: "rate-rps",
		bucket: byCode.bucket,
		retryFloorMs: byCode.retryFloorMs
	};
	if (byCode.kind === "rate-soft") return {
		kind: "rate-soft",
		bucket: byCode.bucket,
		retryFloorMs: byCode.retryFloorMs
	};
	if (byCode.kind === "tpm") return {
		kind: "rate-tpm",
		bucket: byCode.bucket,
		retryFloorMs: byCode.retryFloorMs
	};
	if (byCode.kind === "endpoint") return {
		kind: "rate-endpoint",
		bucket: byCode.bucket,
		retryFloorMs: byCode.retryFloorMs
	};
	if (byCode.kind === "account") return {
		kind: "rate-account",
		bucket: byCode.bucket,
		retryFloorMs: byCode.retryFloorMs
	};
	return {
		kind: "unknown",
		bucket: void 0,
		retryFloorMs: void 0
	};
}
/**
* 429 响应体的一句话摘要（诊断行用，2026-11-03 批 C）：结构化 body 提取
* code/type/message（message 截 120 字），非 JSON 原文截断。动机：pool 类
* 误分类破案（2026-11-02 真机事故）全程被「429 行不打 body」卡住——积分池
* 耗尽的 body 形状至今零样本，摘要落日志后下次真撞即可识别。
*/
function summarize429Body(bodyText) {
	try {
		const parsed = JSON.parse(bodyText);
		if (isRecord$4(parsed) && isRecord$4(parsed.error)) {
			const rawCode = parsed.error.code;
			return `code=${typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : "-"} type=${typeof parsed.error.type === "string" ? parsed.error.type : "-"} msg="${typeof parsed.error.message === "string" ? parsed.error.message.slice(0, 120) : "-"}"`;
		}
	} catch {}
	return `raw="${bodyText.slice(0, 120)}"`;
}
/**
* Retry-After / RetryAfter 头解析。
* 支持 HTTP 日期与秒数两种形态；结果交上层封顶（PROVIDER_RETRY_AFTER_CAP_MS）。
*/
function parseRetryAfterMs(value, now = Date.now()) {
	if (typeof value !== "string" || value === "") return void 0;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		return seconds > 0 ? seconds * 1e3 : void 0;
	}
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return void 0;
	const delta = date - now;
	return delta > 0 ? delta : void 0;
}
/** 提交给 provider 重试层的延迟上限（毫秒）：本地退避与非配额 429 的 Retry-After 均受
* 此约束，同时作为重试策略退避单次上限；池类下限与此一致（provider 实测定值）。
* fix-sensenova-429-quota-retry（2026-09-04 实测）：原 3000ms 与配额窗口量级不符——
* TPM 为 60 秒窗口，提升到 60000ms（spec 允许区间 60–120s 的下沿）。
* 唯一定义点（2026-11-03 U4 审计 D2：adapter 本地副本已删，消费方统一经 import 引用）。 */
const PROVIDER_RETRY_AFTER_CAP_MS = 6e4;

//#endregion
//#region src/host/key-health.ts
/**
* 「这次失败该不该换一把 key」的判定 —— 适配器失败出口的兜底（纯逻辑、无 peer）。
*
* 适配器只对「认识的理由」换 key：401、配额类 429（code 8 / 429001 / Endpoint 族 /
* ModelAccount 族）、池类 429。平台换一种拒绝形态时，剩下的失败一律原地重试：
*
* - **分类器不认识的 429**：注释一直写着「unknown 兜底按 rate 处理（轮转+可重试）」，
*   但旧实现只轮换 quota/pool 两类，unknown 落到不轮换。宿主会把同一把 key 重试到
*   预算耗尽（10 次）才报错——`EndpointTPMExceeded` 在补分类前就是这种形态。
* - **402/403**：账号态拒绝（欠费 / 禁用 / 无权限）。这两类不在宿主可重试清单里，
*   不轮换就直接上屏，而另一把 key 很可能能用。
*
* 判据刻意很窄：400/404/413/422 是请求或路由的问题，换 key 不会变好；5xx、超时、
* 传输错误是平台或网络的问题，换 key 也不变好。宁可漏判，不做全场误判。
*
* @module dsh-sensenova-suite/key-health
*/
/**
* 这次失败是否应当触发一次「换一把 key 试」。
*
* @param status - HTTP 状态码。
* @param alreadyRotating - 本次失败是否已由 401 / 配额 429 / 池 429 路径参与轮换
*   （那三条路径自己会换，不重复触发）。
* @returns 是否应当走兜底轮换。
*/
function shouldRotateUnclassified(status, alreadyRotating) {
	if (alreadyRotating) return false;
	return status === 429 || status === 402 || status === 403;
}

//#endregion
//#region src/host/llm-retry.ts
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
const QUOTA_CODES = Object.freeze({
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
const LLM_CODES = Object.freeze({
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
	modelNotFound: "MODEL_NOT_FOUND"
});
/**
* Anthropic 线流断尾专用码（2026-10-31）：平台 anthropic 线时好时坏，流在
* message_stop 之前中断。自造码而不借用 TRANSPORT，是为了让「这个形态可重试」
* 成为重试策略里的显式决策（而不是搭 TRANSPORT 的便车）——peer 的
* `resolveRetryPolicy` 对 retryableCodes 只验非空字符串、不锁枚举（真机 asar
* 实证），重试判定即 `retryableCodes.includes(failure.code)`。适配器还按它做
* 内存级换线降级（adapter.ts 命中即 anthropicUnsupported.add）。
*/
const ANTHROPIC_TRUNCATED_CODE = "ANTHROPIC_TRUNCATED";
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
function retryableCodes() {
	return [
		QUOTA_CODES.emptyResponse,
		QUOTA_CODES.rateLimit,
		QUOTA_CODES.server,
		QUOTA_CODES.timeout,
		QUOTA_CODES.transport,
		ANTHROPIC_TRUNCATED_CODE
	];
}

//#endregion
//#region src/host/catalog-gate.ts
/**
* 目录抓取的门槛判定（纯函数、无 peer）——fetchCatalog 的「发不发、发之前能
* 回什么」一个判据源。
*
* 背景（2026-10-31）：失败退避（60s）期内旧实现无条件回现有缓存——实例从未
* 成功过时那是空数组，DSH 侧表现为「错误横幅消失但模型列表空白干等一分钟」。
* 现给退避期内的空缓存两条降级路，防循环的初衷不变：
*
*   1. **种子回落**：模块级跨实例种子（同凭据同端点且非空）可服务——同进程里
*      兄弟实例成功过时，本实例失败期仍有目录可显（种子过期与否由认领方的 TTL
*      判定兜住，本模块只看「能不能用」）；
*   2. **补发一次**：进程冷启动后首次失败（通常无种子，且 10s 瞬时超时高发）
*      每段退避期补发一枪；补发再失败继续安静到退避到期——`emptyRetryUsed`
*      保证每段退避只补一次，不会退化成秒级重试循环（退避存在的理由）。
*
* 正常路径（退避到期后的实发）会重置 `emptyRetryUsed`——新的失败段又有一次
* 补发额度。标记的存取都在调用方（adapter 实例字段），本模块只读输入。
*
* @module dsh-sensenova-suite/catalog-gate
*/
/** 目录抓取超时（毫秒）。商汤 /v1/models 秒级；10s 覆盖慢抖动，超过按失败退避。 */
const MODELS_TIMEOUT_MS = 1e4;
/**
* 目录缓存 TTL（毫秒）：宿主（模型选择器/策略 UI）会以秒级周期反复调用
* listModels()（2026-10-10 Loon 实测 ~5s 一次），而模型目录变化极慢。
* 缓存命中期间从内存应答，不发 HTTP；用户明确「一天一次够用」。
*/
const CATALOG_TTL_MS = 864e5;
/** 目录刷新失败后的退避（毫秒）：防止故障时退化为秒级重试循环。 */
const CATALOG_FAILURE_RETRY_MS = 6e4;
/**
* 目录抓取门槛：TTL 命中 → 缓存；退避期内按「有缓存 / 有种子 / 补发额度」
* 三级降级；否则实发（凭据或端点变化时让 fetchCatalogUncached 清 404 失败缓存）。
*/
function planCatalogFetch(state, input) {
	const credentialChanged = input.cacheCredential !== void 0 && input.cacheCredential !== input.credential;
	const apiBaseChanged = input.cacheApiBase !== void 0 && input.cacheApiBase !== input.apiBase;
	const invalidateFailedModels = apiBaseChanged;
	if (!credentialChanged && !apiBaseChanged && state.fetchedAt > 0 && input.now - state.fetchedAt < 864e5) return { action: "serve-cache" };
	if (state.nextRetryAt > input.now) {
		if (state.cachedEntries > 0) return { action: "serve-cache" };
		if (input.seed !== void 0 && input.seed.credential === input.credential && input.seed.apiBase === input.apiBase && input.seed.entries.length > 0) return { action: "serve-seed" };
		return state.emptyRetryUsed ? { action: "serve-empty" } : {
			action: "send-forced",
			invalidateFailedModels
		};
	}
	return {
		action: "send",
		invalidateFailedModels
	};
}

//#endregion
//#region src/host/concurrency.ts
/**
* 排队超时默认值（毫秒）。
*
* 2026-09-04 定 60s（与 TPM 60s 窗口对齐，design D4/D6）；2026-11-02 提到 90s：
* 4 轮轮询把「等待」搬进了插件内，一次全 429 的 stream() 全程占全局槽约
* 30-50s（16 次 RTT + 10s 抖动等待）。globalConcurrency=2 时两个会话同时
* 全 429，第 3 个排队者的等待会逼近 60s；90s 留出余量，避免排队者因别人的
* 限流重试而超时失败。
*/
const DEFAULT_QUEUE_TIMEOUT_MS = 9e4;
/** 把配置的并发上限归一化为正整数：非整数、负数或无法解析一律回退 1。 */
function normalizeConcurrencyLimit(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}
/** 排队/等待期间中止时抛出的取消错误（不占额度）。 */
function concurrencyAbortError() {
	return new DOMException("The operation was aborted.", "AbortError");
}
/** 排队超时抛出的超时错误（不占额度；adapter 层映射为可重试 LlmError 'TIMEOUT'）。 */
function concurrencyQueueTimeoutError() {
	return new DOMException("The operation was timed out.", "TimeoutError");
}
/**
* 按 key 隔离的并发闸：`acquire(key, limit, signal?, queueTimeoutMs?)` 在额度
* 允许时立即返回 `release()`；达到上限时按 FIFO 排队，前序释放后唤起队首。
* 排队期间 signal 中止则 reject 取消错误且不占额度；排队超过 `queueTimeoutMs`
* （非法值回退默认 90s，2026-11-02 定版）则以可重试 TimeoutError reject，同样不占额度、从队列
* 移除并清 abort listener。release 幂等，排空后惰性删除 key 条目。
*/
var KeyedConcurrencyGate = class {
	states = /* @__PURE__ */ new Map();
	acquire(key, limit, signal, queueTimeoutMs) {
		const capacity = normalizeConcurrencyLimit(limit);
		const timeoutMs = typeof queueTimeoutMs === "number" && Number.isFinite(queueTimeoutMs) && queueTimeoutMs > 0 ? queueTimeoutMs : DEFAULT_QUEUE_TIMEOUT_MS;
		if (signal?.aborted) return Promise.reject(concurrencyAbortError());
		let state = this.states.get(key);
		if (state === void 0) {
			state = {
				inFlight: 0,
				queue: []
			};
			this.states.set(key, state);
		}
		if (state.inFlight < capacity) {
			state.inFlight += 1;
			return Promise.resolve(this.releaseOf(key, state));
		}
		return new Promise((resolve, reject) => {
			let timer;
			const entry = {
				signal,
				resolve: () => {
					if (timer !== void 0) clearTimeout(timer);
					if (entry.signal !== void 0) entry.signal.removeEventListener("abort", entry.onAbort);
					state.inFlight += 1;
					resolve(this.releaseOf(key, state));
				},
				reject: (error) => {
					if (timer !== void 0) clearTimeout(timer);
					if (entry.signal !== void 0) entry.signal.removeEventListener("abort", entry.onAbort);
					reject(error);
				},
				onAbort: () => {
					if (timer !== void 0) clearTimeout(timer);
					const index = state.queue.indexOf(entry);
					if (index >= 0) state.queue.splice(index, 1);
					reject(concurrencyAbortError());
				}
			};
			const onTimeout = () => {
				const index = state.queue.indexOf(entry);
				if (index >= 0) state.queue.splice(index, 1);
				if (entry.signal !== void 0) entry.signal.removeEventListener("abort", entry.onAbort);
				reject(concurrencyQueueTimeoutError());
			};
			state.queue.push(entry);
			timer = setTimeout(onTimeout, timeoutMs);
			if (signal !== void 0) {
				if (signal.aborted) entry.onAbort();
				else signal.addEventListener("abort", entry.onAbort, { once: true });
			}
		});
	}
	releaseOf(key, state) {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			state.inFlight -= 1;
			const next = state.queue.shift();
			if (next !== void 0) next.resolve();
			else if (state.inFlight === 0) this.states.delete(key);
		};
	}
};

//#endregion
//#region src/host/wire/blocks.ts
/** 内容块 → wire 出站项翻译（add-multimodal-input 1.x；规划 §6.3、design 决策 1/2/5）。
*
* 双分支形态（硬约束，测试断言形状）：
* - chat：`{type:'image_url', image_url:{url}}`（嵌套）+ `{type:'text', text}`；
* - responses：`{type:'input_image', image_url}`（**扁平字段**）+ `{type:'input_text', text}`。
*
* 图像数据流（design 前提假设，0.1.7-rc.2 类型面）：ImageBlock 只携带
* `attachment: ImageAttachmentRef`（attachmentId/name/width/height/mediaType，无内联
* 字节或 URL）。宿主 `resolveImageAttachmentAccess` 需要 AttachmentStore + 宿主路径
* 映射，二者均为宿主内部服务、不向 adapter 暴露——因此本模块把「ref → 图像来源」
* 定义为可注入的 `ImageAccessResolver`（生产侧由装配层桥接 resolveImageAttachmentAccess
* 的结果；缺省 undefined → 图像按宿主 textOnlyImageText 占位，绝不静默丢弃后发空请求）。
* 检测/投影一律复用宿主 re-export：contentHasImage / projectImagesForTextModel /
* offloadedImageText / textOnlyImageText（tasks 1.4 grep 自查：无自造等价物；
* 注：宿主 0.1.7-rc.2 无 `offloadRequestImagesWithPolicy` 导出，卸载决策由宿主
* 路由层负责，本插件只消费已带 `offloaded:true` 标记的块）。
* @module dsh-sensenova-suite/wire/blocks
*/
/** Responses input_image 协议格式集（文档 §Responses :3210 段，spec「图像限制校验」）。 */
const RESPONSES_IMAGE_FORMATS = /* @__PURE__ */ new Set([
	"png",
	"jpeg",
	"gif",
	"webp"
]);
/** deepseek-flash 图像限制（文档 :1468-1500；design 前提假设按 1024 进制）。 */
const DEEPSEEK_FLASH_IMAGE_LIMITS = {
	singleBytes: 52428800,
	totalBytes: 67108864,
	maxCount: 200
};
/** mediaType → 规范扩展名（jpg 与 jpeg 归一为 jpeg；白名单两侧同样归一）。 */
function formatOf(mediaType) {
	switch (mediaType) {
		case "image/png": return "png";
		case "image/jpg":
		case "image/jpeg": return "jpeg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		case "image/bmp": return "bmp";
		case "image/heic": return "heic";
		case "image/heif": return "heif";
		default: return;
	}
}
function refKey(ref) {
	return String(ref.attachmentId);
}
/**
* data URL → Anthropic base64 source（`{type:'base64',media_type,data}`）。
* data URL 形如 `data:image/png;base64,AAAA`，拆出 media_type 与纯 base64 数据
* （Anthropic 协议不收带前缀的 data URL，文档 #api-compatibility-images）。
*/
function parseBase64Source(dataUrl) {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
	if (match === null) return {
		type: "base64",
		media_type: "image/png",
		data: dataUrl
	};
	return {
		type: "base64",
		media_type: match[1] ?? "image/png",
		data: match[2] ?? ""
	};
}
/** 是否为需要出站的图像块（offloaded 块由 builders 直接投影占位文本，不进本路径）。 */
function isLiveImage(block) {
	return block.type === "image" && block.offloaded !== true;
}
/**
* 出站前预解析全部图像块（唯一的异步步骤；builders 同步消费结果）：
* - 格式校验：mediaType → 扩展名后对照模型 imageFormats（Responses wire 再与
*   png/jpeg/gif/webp 求交）；不支持 → 报错（文案含支持列表，spec「格式不支持」）。
* - 限制校验：deepseek-flash 单图 50MB / 总 64MB / 200 张（spec「大小与数量超限」）；
*   「URL 总量 200MB」是文档侧约束，客户端无从测量字节、不预校验——超限/不可达由
*   平台侧报错（2026-10-31 实测：URL 抓取失败为 code 3「image download failed」，
*   302 跳转源与签名过期同样落到它；平台抓外国源仅 15–25KB/s，200MB 是否真拒
*   未测——需国内快速源方能触到该分界）。
* - 编码：本地只读路径 → base64 data URL；URL 来源原样保留（kimi-k3 仅 base64：
*   URL 图像不进载荷表，builders 会以占位文本顶替并在此打日志，design 决策 3）。
* - 解析不到来源的图像同样不进载荷表（builders 投影 textOnlyImageText 占位）。
*
* @returns attachmentId → 载荷； builders 用 has() 区分「占位」与「直传」。
*/
async function prepareImages(options, entry, wire, resolveImageAccess) {
	const facts = factsFor(options.model, entry);
	const whitelist = new Set(facts.imageFormats.map((format) => format === "jpg" ? "jpeg" : format));
	if (wire === "responses") {
		for (const format of whitelist) if (!RESPONSES_IMAGE_FORMATS.has(format)) whitelist.delete(format);
	}
	const limits = options.model === "deepseek-flash" ? DEEPSEEK_FLASH_IMAGE_LIMITS : void 0;
	const checkImageLimits = (byteLength) => {
		if (limits === void 0) return;
		if (byteLength > limits.singleBytes) throw new LlmError(`llm-sensenova: deepseek-flash 单张图片不超过 50 MB（${(byteLength / 1024 / 1024).toFixed(1)} MB）；请压缩图片`, "INVALID_REQUEST");
		totalBytes += byteLength;
		if (totalBytes > limits.totalBytes) throw new LlmError("llm-sensenova: deepseek-flash 请求图片总量不超过 64 MB；请减少或压缩图片", "INVALID_REQUEST");
	};
	const prepared = /* @__PURE__ */ new Map();
	let count = 0;
	let totalBytes = 0;
	const seen = /* @__PURE__ */ new Set();
	for (const message of options.messages) for (const block of message.content) {
		if (!isLiveImage(block)) continue;
		count += 1;
		if (limits !== void 0 && count > limits.maxCount) throw new LlmError(`llm-sensenova: deepseek-flash 单请求最多 ${limits.maxCount} 张图片，当前 ${count} 张；请减少图片数量或换用其他模型`, "INVALID_REQUEST");
		const ref = block.attachment;
		const key = refKey(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		const format = formatOf(ref.mediaType);
		if (format === void 0 || !whitelist.has(format)) throw new LlmError(`llm-sensenova: 模型 ${options.model} 不支持图片格式 ${ref.mediaType ?? "(未知)"}${wire === "responses" ? "（Responses 协议）" : ""}；支持的格式：${[...whitelist].join(", ")}`, "INVALID_REQUEST");
		const access = resolveImageAccess !== void 0 ? await resolveImageAccess(ref) : void 0;
		if (access === void 0) {
			traceLog(`[dsh-sensenova-suite] 图片出站解析失败（无 resolver 或读取失败）→ 占位文本，模型看不到这张图`);
			continue;
		}
		if ("url" in access) {
			if (facts.imageRequiresBase64) {
				traceLog(`[dsh-sensenova-suite] model ${options.model} accepts base64 images only; public-URL image ${JSON.stringify(ref.name ?? String(ref.attachmentId))} was replaced with a text placeholder`);
				continue;
			}
			prepared.set(key, {
				url: access.url,
				fromUrlSource: true
			});
			continue;
		}
		if ("base64" in access) {
			checkImageLimits(Math.floor(access.base64.length * 3 / 4));
			prepared.set(key, {
				url: `data:${access.mediaType};base64,${access.base64}`,
				fromUrlSource: false
			});
			continue;
		}
		const bytes = await readFile(access.readonlyPath);
		checkImageLimits(access.byteLength ?? bytes.byteLength);
		prepared.set(key, {
			url: `data:${ref.mediaType};base64,${bytes.toString("base64")}`,
			fromUrlSource: false
		});
	}
	return prepared;
}
/**
* 翻译一条 user 消息的 content（add-multimodal-input 1.2/1.3；
* add-anthropic-wire-protocol 增加第三种形状）：
* 无图像块 → 纯文本字符串（与迁移前出站完全一致，零回归）；
* 有图像块 → 按 wire 输出对象数组（kimi「content 必须是对象数组」同时满足）。
*
* 三种 wire 的文本/图像块形状（硬约束，测试断言形状）：
* - responses：`{type:'input_text',text}` + `{type:'input_image',image_url}`（扁平）；
* - anthropic：`{type:'text',text}` + `{type:'image',source:{type,media_type?,data?}}`；
* - chat：`{type:'text',text}` + `{type:'image_url',image_url:{url}}`（嵌套）。
*
* offloaded 图像用宿主 offloadedImageText 投影；解析不到来源的图像用宿主
* textOnlyImageText 占位——三条路径都不再「静默丢弃」（P0-2）。
*/
function translateUserContent(content, wire, images) {
	if (!contentHasImage(content)) return content.filter((block) => block.type === "text").map((block) => block.text).join("");
	const textType = wire === "responses" ? "input_text" : "text";
	const items = [];
	for (const block of content) {
		if (block.type === "text") {
			items.push({
				type: textType,
				text: block.text
			});
			continue;
		}
		if (block.type !== "image") continue;
		const ref = block.attachment;
		if (block.offloaded === true) {
			items.push({
				type: textType,
				text: offloadedImageText(ref)
			});
			continue;
		}
		const prepared = images?.get(refKey(ref));
		if (prepared === void 0) {
			items.push({
				type: textType,
				text: textOnlyImageText(ref)
			});
			continue;
		}
		if (wire === "anthropic") {
			items.push(prepared.fromUrlSource ? {
				type: "image",
				source: {
					type: "url",
					url: prepared.url
				}
			} : {
				type: "image",
				source: parseBase64Source(prepared.url)
			});
			continue;
		}
		if (wire === "responses") items.push({
			type: "input_image",
			image_url: prepared.url
		});
		else items.push({
			type: "image_url",
			image_url: { url: prepared.url }
		});
	}
	return items;
}

//#endregion
//#region src/host/wire/effort.ts
/**
* Anthropic wire 的 effort 出站判定——纯函数，零导入（contract 套件 peer-free
* 闸直接驱动本模块，运行时与钉子共用同一份代码）。
*
* 词表不是目录/静态表的 chat 方言（那里含 off/none/minimal），而是平台 400
* 原文枚举的 anthropic 方言（2026-10-27 真机：
* `output_config.effort must be one of: low, medium, high, xhigh, max; got "off"`——
* 用户勾选集里的 off 经目录 reasoning.efforts 混进了出站，方言混用即根因）。
*
* @module dsh-sensenova-suite/wire/effort
*/
/** Anthropic wire 接受的 effort 值（平台枚举，词表外一律不出站）。 */
const ANTHROPIC_EFFORTS = /* @__PURE__ */ new Set([
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
]);
/** 「关闭思考」在各方言里的拼写：面板 off、chat 方言 none、静态表 minimal。 */
const THINKING_OFF_SPELLINGS = /* @__PURE__ */ new Set([
	"off",
	"none",
	"minimal"
]);
/**
* 档位拼写归一：面板 off / 静态表 minimal → chat·responses 方言的 none。
* 对话界面的可选档位 = 用户勾选集（含 off），而 chat/responses 两线的关闭
* 判据历来只认 'none'——不归一，off 会绕过 kimi 的 thinking:disabled 特判、
* 在 responses 上整个省略 reasoning 字段（关闭静默变成「用默认」，2026-10-27）。
*/
function canonicalThinkingEffort(effort) {
	if (effort === void 0) return void 0;
	return THINKING_OFF_SPELLINGS.has(effort) ? "none" : effort;
}
/**
* 档位 → anthropic 出站字段。关闭思考的任何拼写都落
* `thinking:{type:'disabled'}`；其余仅词表内值进 `output_config.effort`，
* 词表外/未选一律双字段皆不发（不发未知值，不上桌让平台打 400）。
*/
function anthropicEffortOut(effort) {
	const none = canonicalThinkingEffort(effort) === "none" && effort !== void 0;
	return {
		thinkingDisabled: none,
		effortWire: effort !== void 0 && !none && ANTHROPIC_EFFORTS.has(effort) ? effort : void 0
	};
}

//#endregion
//#region src/host/wire/body-chat.ts
/** 展平工具结果内容块为纯文本（0.1.7 类型面：tool 结果为独立 role:'tool' 消息）。 */
function toolResultText$2(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : "").join("");
}
/** 拼出某条消息的可见文本（接受 RequestMessage：含无持久 id 的 RequestUserInput）。 */
function flattenText$2(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** 把 OpenAI 消息历史翻译为 OpenAI 请求体消息数组。
* replayReasoning（deepseek 系且本轮带 tools）：把宿主历史 assistant 消息里的
* reasoning 増量重建为 assistant 项的 reasoning_content 回传（文档 :1411-1412、
* :1790-1791：deepseek 系带 tools 必须回传全部历史思维链；不带 tools 或其余模型
* 不携带——6.8/glm 多轮不回传，kimi 仅要求原样回传 content+tool_calls）。 */
function toOpenAiMessages(options, replayReasoning, images) {
	const systemParts = [];
	if (options.system !== void 0 && options.system !== "") systemParts.push(options.system);
	for (const message of options.messages) if (message.role === "system") systemParts.push(flattenText$2(message));
	const systemText = systemParts.filter(Boolean).join("\n\n");
	const messages = [];
	if (systemText !== "") messages.push({
		role: "system",
		content: systemText
	});
	const toolCallIdRemap = /* @__PURE__ */ new Map();
	let syntheticToolCallSeq = 0;
	for (const message of options.messages) {
		if (message.role === "system") continue;
		if (message.role === "assistant") {
			const text = flattenText$2(message);
			const reasoningText = replayReasoning ? message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("") : "";
			const toolCalls = message.content.filter((block) => block.type === "tool-call");
			const sanitizedCalls = [];
			for (const call of toolCalls) {
				if (call.name === "" || call.name === void 0) continue;
				syntheticToolCallSeq += 1;
				const keptId = call.id !== "" && call.id !== void 0 ? call.id : `sensenova-sanitized-${syntheticToolCallSeq}`;
				toolCallIdRemap.set(call.id, keptId);
				sanitizedCalls.push({
					id: keptId,
					type: "function",
					function: {
						name: call.name,
						arguments: call.arguments !== "" && call.arguments !== void 0 ? call.arguments : "{}"
					}
				});
			}
			if (text === "" && sanitizedCalls.length === 0) continue;
			const entry = {
				role: "assistant",
				content: text !== "" ? text : null
			};
			if (reasoningText !== "") entry.reasoning_content = reasoningText;
			if (sanitizedCalls.length > 0) entry.tool_calls = sanitizedCalls;
			messages.push(entry);
			continue;
		}
		if (message.role === "tool") {
			const remappedId = toolCallIdRemap.get(message.toolCallId);
			if (remappedId === void 0) continue;
			messages.push({
				role: "tool",
				tool_call_id: remappedId,
				content: toolResultText$2(message.content) || "(no output)"
			});
			continue;
		}
		const content = translateUserContent(message.content, "chat-completions", images);
		if (typeof content === "string") {
			if (content !== "") messages.push({
				role: "user",
				content
			});
		} else if (content.length > 0) messages.push({
			role: "user",
			content
		});
	}
	return messages;
}
/** 计算模型的 Chat 字段分派计划（add-model-facts 2.2：数据驱动自 wire/facts，
* 出站行为与迁移前逐字段一致；未知模型沿用「保守不发/原样 effort」语义）。 */
function chatFieldPlan(model, entry) {
	const facts = factsFor(model, entry);
	const catalogEfforts = entry?.reasoning?.efforts.map((effort) => effort.id);
	const staticDomain = facts.efforts.length > 0 ? facts.efforts : void 0;
	return {
		maxTokensField: facts.outputLimitField,
		streamOptionsUsage: facts.supportsStreamOptions,
		replayReasoningWithTools: facts.requiresReasoningReplay,
		blockedSampling: new Set(facts.blockedSampling),
		effortCompat: facts.effortCompat,
		effortDomain: catalogEfforts ?? staticDomain
	};
}
/** 组装 OpenAI /chat/completions 请求体（按 ChatFieldPlan 分派字段）。
* images：blocks.ts 预解析的图像载荷（add-multimodal-input）；缺省 undefined 时
* user 内容保持纯文本现状（零回归）。 */
function buildChatBody(options, entry, images) {
	const model = options.model;
	const plan = chatFieldPlan(model, entry);
	const tools = (options.tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	const messages = toOpenAiMessages(options, plan.replayReasoningWithTools && tools.length > 0, images);
	const samplingWhitelist = entry?.supportedSamplingParameters ?? staticFacts(model)?.samplingParameters;
	const samplingAllowed = (field, blocked) => {
		if (blocked) return false;
		if (samplingWhitelist === void 0) return true;
		return samplingWhitelist.includes(field);
	};
	let reasoningEffortWire;
	if (options.reasoningEffort !== void 0) {
		const effort = canonicalThinkingEffort(options.reasoningEffort);
		if (effort !== void 0) {
			const mapped = plan.effortCompat?.[effort];
			const inDomain = plan.effortDomain?.includes(effort) ?? true;
			reasoningEffortWire = mapped !== void 0 ? mapped : inDomain ? effort : void 0;
		}
	}
	return {
		model,
		messages,
		stream: true,
		...options.temperature !== void 0 && samplingAllowed("temperature", plan.blockedSampling.has("temperature")) ? { temperature: options.temperature } : {},
		...options.maxTokens !== void 0 ? { [plan.maxTokensField]: options.maxTokens } : {},
		...options.stop !== void 0 && options.stop.length > 0 ? { stop: options.stop } : {},
		...tools.length > 0 ? { tools } : {},
		...plan.streamOptionsUsage ? { stream_options: { include_usage: true } } : {},
		...reasoningEffortWire !== void 0 ? { reasoning_effort: reasoningEffortWire } : {}
	};
}

//#endregion
//#region src/host/wire/body-responses.ts
function flattenText$1(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function toolResultText$1(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : "").join("");
}
/**
* 把宿主消息历史映射为 Responses input 数组（§6.5）：
* - system 消息与 options.system 合并为顶层 instructions；
* - user 文本 → {type:'message',role:'user',content:[{type:'input_text',text}]}；
* - assistant 文本 → {type:'message',role:'assistant',content:[{type:'output_text',text}]}；
* - assistant tool-call → {type:'function_call',call_id,name,arguments}；
* - tool-result → {type:'function_call_output',call_id,output}。
*
* role 条目恒带 type:'message'（2026-11-04 他拍板方案一）：真机 400 实证——
* 混入 function 项的数组里 role 条目缺 type 即 "missing input.type"（param=
* input.type，code=MissingParameter）。文档两套形状并存（基础/多轮/图像示例
* 不带，工具流示例全带）且对「tools 在场但数组尚无 function 项」的第 1 轮
* 沉默——无条件补齐消除漏判窗口。
*
* 坏历史 tool_call 四防御与 Chat 路径一致（tasks 2.1）：空 name 丢弃（含孤立
* tool-result）、arguments 空串补 '{}'、id 空串/超长（平台限 1–64，2026-10-31
* 真机 400 实证）合成 sensenova-sanitized-N、
* 映射不到 call_id 的 tool-result 丢弃。
*/
function toResponsesInput(options, images) {
	const systemParts = [];
	if (options.system !== void 0 && options.system !== "") systemParts.push(options.system);
	for (const message of options.messages) if (message.role === "system") systemParts.push(flattenText$1(message));
	const instructions = systemParts.filter(Boolean).join("\n\n");
	const input = [];
	const toolCallIdRemap = /* @__PURE__ */ new Map();
	let syntheticToolCallSeq = 0;
	for (const message of options.messages) {
		if (message.role === "system") continue;
		if (message.role === "assistant") {
			const text = flattenText$1(message);
			const toolCalls = message.content.filter((block) => block.type === "tool-call");
			let emitted = false;
			for (const call of toolCalls) {
				if (call.name === "" || call.name === void 0) continue;
				syntheticToolCallSeq += 1;
				const keptId = call.id !== "" && call.id !== void 0 && call.id.length <= 64 ? call.id : `sensenova-sanitized-${syntheticToolCallSeq}`;
				toolCallIdRemap.set(call.id, keptId);
				input.push({
					type: "function_call",
					call_id: keptId,
					name: call.name,
					arguments: call.arguments !== "" && call.arguments !== void 0 ? call.arguments : "{}"
				});
				emitted = true;
			}
			if (text !== "") {
				input.push({
					type: "message",
					role: "assistant",
					content: [{
						type: "output_text",
						text
					}]
				});
				emitted = true;
			}
			if (!emitted) continue;
			continue;
		}
		if (message.role === "tool") {
			const remappedId = toolCallIdRemap.get(message.toolCallId);
			if (remappedId === void 0) continue;
			input.push({
				type: "function_call_output",
				call_id: remappedId,
				output: toolResultText$1(message.content) || "(no output)"
			});
			continue;
		}
		const content = translateUserContent(message.content, "responses", images);
		if (typeof content === "string") {
			if (content !== "") input.push({
				type: "message",
				role: "user",
				content: [{
					type: "input_text",
					text: content
				}]
			});
		} else if (content.length > 0) input.push({
			type: "message",
			role: "user",
			content
		});
	}
	return {
		instructions: instructions !== "" ? instructions : void 0,
		input
	};
}
/**
* 组装 /responses 请求体。max_output_tokens 按 responsesMaxOutputTokens 钳制
* （含推理 token；上限缺失回退 Chat 档 outputLimitMax，deepseek-flash 文档未列
* responses 上限 = null，保守回退待实测）。
*/
function buildResponsesBody(options, entry, config = {}, images) {
	const model = options.model;
	const facts = factsFor(model, entry);
	const outputLimit = facts.responsesMaxOutputTokens ?? facts.outputLimitMax;
	const { instructions, input } = toResponsesInput(options, images);
	const tools = (options.tools ?? []).map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	const sendTemperature = options.temperature !== void 0 && !facts.blockedSampling.includes("temperature");
	const reasoning = canonicalThinkingEffort(options.reasoningEffort) === "none" ? {
		effort: "none",
		summary: config.reasoningSummary ?? "auto"
	} : void 0;
	return {
		model,
		input,
		stream: true,
		...instructions !== void 0 ? { instructions } : {},
		...sendTemperature ? { temperature: options.temperature } : {},
		...options.maxTokens !== void 0 && outputLimit !== null ? { max_output_tokens: Math.min(options.maxTokens, outputLimit) } : options.maxTokens !== void 0 ? { max_output_tokens: options.maxTokens } : {},
		...tools.length > 0 ? { tools } : {},
		...reasoning !== void 0 ? { reasoning } : {}
	};
}

//#endregion
//#region src/host/wire/body-anthropic.ts
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function toolResultText(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : "").join("");
}
/** tool-call 的 arguments 字符串 → Anthropic 的 input 对象（解析失败给 {}）。 */
function argumentsOf(value) {
	if (value === "" || value === void 0) return {};
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
/** content 是否为「全 tool_result 块」的数组（并行工具结果消息的唯一形状）。 */
function isToolResultContent(content) {
	return Array.isArray(content) && content.length > 0 && content.every((item) => typeof item === "object" && item !== null && item.type === "tool_result");
}
/**
* Anthropic 要求 user/assistant 严格交替，且同一轮的多个 tool_result 应载于
* 同一条 user 消息（Anthropic 公开规范；商汤文档无 /v1/messages 工具章节，
* 兼容层宽松度未知——U2 审计疑似 1）。宿主并行工具循环逐条发 role:'tool'，
* 直译产出连续多条 user：一条内容里两个 tool_use、两条 user 各载一个
* tool_result——严格执行交替的平台会拒收。此处把相邻的全 tool_result user
* 消息合并成一条（多块 tool_result 并列），消除「平台必须宽松」这一前提；
* 普通 user 文本/图消息不含 tool_result 块，不受影响（U2 拍板落地轮，
* 2026-11-01）。
*/
function mergeAdjacentToolResults(messages) {
	const merged = [];
	for (const message of messages) {
		const prev = merged[merged.length - 1];
		if (message.role === "user" && isToolResultContent(message.content) && prev !== void 0 && prev.role === "user" && isToolResultContent(prev.content)) {
			prev.content.push(...message.content);
			continue;
		}
		merged.push(message);
	}
	messages.length = 0;
	messages.push(...merged);
}
/**
* 把宿主消息历史映射为 Anthropic messages 数组：
* - system/developer 消息与 options.system 合并为**顶层** system 字符串；
* - assistant tool-call → `{type:'tool_use', id, name, input}`（input 是对象）；
* - tool 结果 → `{role:'user', content:[{type:'tool_result', tool_use_id, content}]}`；
* - user 文本/图像 → content 字符串或内容块数组（图像经 blocks.ts 翻译）。
*
* 坏历史 tool_call 四防御与另两条 wire 一致：空 name 丢弃（含孤立 tool-result）、
* arguments 空串补 {}、id 空串合成稳定 id、映射不到 tool_use_id 的结果丢弃。
*/
function toAnthropicMessages(options, images) {
	const systemParts = [];
	if (options.system !== void 0 && options.system !== "") systemParts.push(options.system);
	for (const message of options.messages) if (message.role === "system") systemParts.push(flattenText(message));
	const system = systemParts.filter(Boolean).join("\n\n");
	const messages = [];
	const toolCallIdRemap = /* @__PURE__ */ new Map();
	let syntheticToolCallSeq = 0;
	for (const message of options.messages) {
		if (message.role === "system") continue;
		if (message.role === "assistant") {
			const text = flattenText(message);
			const toolCalls = message.content.filter((block) => block.type === "tool-call");
			const content = [];
			for (const call of toolCalls) {
				if (call.name === "" || call.name === void 0) continue;
				syntheticToolCallSeq += 1;
				const keptId = call.id !== "" && call.id !== void 0 ? call.id : `sensenova-sanitized-${syntheticToolCallSeq}`;
				toolCallIdRemap.set(call.id, keptId);
				content.push({
					type: "tool_use",
					id: keptId,
					name: call.name,
					input: argumentsOf(call.arguments)
				});
			}
			if (text !== "") content.push({
				type: "text",
				text
			});
			if (content.length === 0) continue;
			messages.push({
				role: "assistant",
				content
			});
			continue;
		}
		if (message.role === "tool") {
			const remappedId = toolCallIdRemap.get(message.toolCallId);
			if (remappedId === void 0) continue;
			messages.push({
				role: "user",
				content: [{
					type: "tool_result",
					tool_use_id: remappedId,
					content: toolResultText(message.content) || "(no output)"
				}]
			});
			continue;
		}
		const content = translateUserContent(message.content, "anthropic", images);
		if (typeof content === "string") {
			if (content !== "") messages.push({
				role: "user",
				content
			});
		} else if (content.length > 0) messages.push({
			role: "user",
			content
		});
	}
	mergeAdjacentToolResults(messages);
	return {
		system: system !== "" ? system : void 0,
		messages
	};
}
/**
* 组装 /messages 请求体。
*
* effort 出站策略（2026-10-27 按平台词表收紧，判定在 wire/effort.ts）：
* - 「关闭思考」的任何方言拼写（面板 off / chat 方言 none / 静态表 minimal）→
*   `thinking: {type:'disabled'}`，不发 effort（文档：关闭思考的两种表达之一）；
*   档案 forbidThinkingDisabled 的模型除外（现唯一载体 6.8-flash——thinking.type
*   仅 enabled，平台行为）：不发任何思考字段 = 保持平台默认开思考。glm-5.2 曾
*   按文档列此，2026-11-04 他真机 curl 推翻文档判据（disabled 打 /messages 得
*   200），档案翻 false——11-01 时代记录的真机 400（U2 D1）真因已不可对质；
* - 其余档位 → `output_config: {effort}`，仅接受平台枚举的五个值，词表外
*   一律不发（不发未知值，绝不上桌让平台打 400）；
* - 未选档位 → 两者都不发（网关默认 enabled + effort=high，即「用模型默认」）。
*/
function buildAnthropicBody(options, entry, images) {
	const model = options.model;
	const facts = factsFor(model, entry);
	const { system, messages } = toAnthropicMessages(options, images);
	const tools = (options.tools ?? []).map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters
	}));
	const { thinkingDisabled, effortWire } = anthropicEffortOut(options.reasoningEffort);
	const sendThinkingDisabled = thinkingDisabled && !facts.forbidThinkingDisabled;
	const sendTemperature = options.temperature !== void 0 && !facts.blockedSampling.includes("temperature");
	return {
		model,
		messages,
		stream: true,
		...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {},
		...system !== void 0 ? { system } : {},
		...tools.length > 0 ? { tools } : {},
		...sendTemperature ? { temperature: options.temperature } : {},
		...options.stop !== void 0 && options.stop.length > 0 ? { stop_sequences: options.stop } : {},
		...sendThinkingDisabled ? { thinking: { type: "disabled" } } : {},
		...effortWire !== void 0 ? { output_config: { effort: effortWire } } : {}
	};
}

//#endregion
//#region src/host/wire/usage.ts
function isRecord$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toNumber$2(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/** 缺失/非数返回 undefined（anthropic 合并语义需要区分「没带该字段」与「带了 0」）。 */
function numOrUndefined(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** 把 Responses 事件携带的 usage 对象映射为宿主 TokenUsage。 */
function mapResponsesUsage(usage) {
	const input = toNumber$2(usage.input_tokens);
	const output = toNumber$2(usage.output_tokens);
	const total = toNumber$2(usage.total_tokens);
	const inputDetails = isRecord$3(usage.input_tokens_details) ? usage.input_tokens_details : void 0;
	const outputDetails = isRecord$3(usage.output_tokens_details) ? usage.output_tokens_details : void 0;
	const cacheRead = inputDetails !== void 0 ? toNumber$2(inputDetails.cached_tokens) : 0;
	const reasoning = outputDetails !== void 0 ? toNumber$2(outputDetails.reasoning_tokens) : 0;
	return {
		inputTokens: Math.max(0, input - cacheRead),
		outputTokens: output,
		totalTokens: total > 0 ? total : input + output,
		...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning > 0 ? { reasoningTokens: reasoning } : {}
	};
}
/** Anthropic usage → 宿主 TokenUsage（字段名与 Responses 不同：无 details 嵌套）。
* input_tokens 是未缓存口径（2026-11-01 真机探针定论，见模块头注）——直取，
* **不做** responses 线的减法（缓存热时会打出负数再被钳成 0）。
* 从 sse-anthropic.ts 挪入（U2 审计 T2：三线 usage 映射集中 peer-free 直测）。 */
function mapAnthropicUsage(usage) {
	const input = numOrUndefined(usage.input_tokens) ?? 0;
	const output = numOrUndefined(usage.output_tokens) ?? 0;
	const cacheRead = numOrUndefined(usage.cache_read_input_tokens) ?? 0;
	const cacheWrite = numOrUndefined(usage.cache_creation_input_tokens) ?? 0;
	return {
		inputTokens: input,
		outputTokens: output,
		totalTokens: input + cacheRead + cacheWrite + output,
		...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
		...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}
	};
}
/** message_start 全量 + message_delta 增量合并（sse-anthropic 消费；纯函数，
* 导出供 contract 直测回落与 total 口径语义——U2 审计 T3）。四字段一律
* 「incoming 带了才取新值，否则沿用旧值」；totalTokens 与首帧 mapAnthropicUsage
* 同口径（含缓存全口径：未缓存 input + cacheRead + cacheWrite + output——
* input/cache_read 在 an 线是并列字段，2026-11-01 真机定论）。delta 显式带
* cache_read=0 的边角：字段刷新为无（0 与缺失在展开形状下同义）。
*/
function mergeUsage(state, incoming) {
	const next = mapAnthropicUsage(incoming);
	if (state === void 0) return next;
	const inputTokens = numOrUndefined(incoming.input_tokens) !== void 0 ? next.inputTokens : state.inputTokens;
	const outputTokens = numOrUndefined(incoming.output_tokens) !== void 0 ? next.outputTokens : state.outputTokens;
	const cacheReadTokens = numOrUndefined(incoming.cache_read_input_tokens) !== void 0 ? next.cacheReadTokens : state.cacheReadTokens;
	const cacheWriteTokens = numOrUndefined(incoming.cache_creation_input_tokens) !== void 0 ? next.cacheWriteTokens : state.cacheWriteTokens;
	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + outputTokens,
		...cacheReadTokens !== void 0 ? { cacheReadTokens } : {},
		...cacheWriteTokens !== void 0 ? { cacheWriteTokens } : {}
	};
}

//#endregion
//#region src/host/wire/sse-responses.ts
/** Responses SSE → 宿主 StreamChunk 翻译（make-responses-default-wire-protocol 3.x）。
*
* 事件映射：output_item.added → block-start（output_index 即 block index；
* item.type reasoning/message/function_call → 推理/文本/工具块）；
* reasoning_summary_text.delta → reasoning-delta；output_text.delta → text-delta；
* function_call_arguments.delta → tool-call-delta（call_id 即 ToolCallId）；
* output_item.done → block-end；response.completed / incomplete / failed 收尾
* （不等待也不识别 [DONE]）。并行 function_call 按 output_index 分桶拼接。
* 不依赖 sequence_number（design §八·14 假设 6）。
* @module dsh-sensenova-suite/wire/sse-responses
*/
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toString$2(value) {
	return typeof value === "string" ? value : void 0;
}
/** 解析一行 SSE；返回 [事件类型, 事件对象]；[DONE]/空行/注释行/无 type 返回 undefined。 */
function parseResponsesLine(line) {
	let trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":")) return void 0;
	if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
	if (!trimmed || trimmed === "[DONE]") return void 0;
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (!isRecord$2(parsed)) return void 0;
	const type = toString$2(parsed.type);
	if (type === void 0) return void 0;
	return {
		type,
		event: parsed
	};
}
/** output_item.added 的 item.type → 宿主块类型。 */
function blockTypeForItem(itemType) {
	if (itemType === "message") return "text";
	if (itemType === "reasoning") return "reasoning";
	if (itemType === "function_call") return "tool-call";
}
function closeItem(index, item) {
	if (item === void 0) return [];
	if (item.blockType === "tool-call") {
		const name = item.name ?? "";
		if (name === "") return [];
		return [{
			type: "block-end",
			index,
			block: {
				type: "tool-call",
				id: ToolCallId(item.callId ?? `sensenova-tool-${index}`),
				name,
				arguments: item.content !== "" ? item.content : "{}"
			}
		}];
	}
	return [{
		type: "block-end",
		index,
		block: item.blockType === "text" ? {
			type: "text",
			text: item.content
		} : {
			type: "reasoning",
			text: item.content
		}
	}];
}
function closeAllOpen$1(state) {
	const chunks = [];
	for (const [index, item] of [...state.open.entries()]) chunks.push(...closeItem(index, item));
	state.open.clear();
	state.indexByItemId.clear();
	return chunks;
}
/** 处理一个 Responses 事件，返回宿主 StreamChunk 序列（无终止语义）。 */
function processResponsesEvent(parsed, state) {
	const { type, event } = parsed;
	const chunks = [];
	if (type === "response.output_item.added") {
		const item = isRecord$2(event.item) ? event.item : void 0;
		const blockType = blockTypeForItem(toString$2(item?.type) ?? "");
		if (blockType !== void 0 && typeof event.output_index === "number") {
			const index = event.output_index;
			state.open.set(index, {
				blockType,
				content: "",
				callId: toString$2(item?.call_id),
				name: toString$2(item?.name)
			});
			const itemId = toString$2(event.item_id);
			if (itemId !== void 0) state.indexByItemId.set(itemId, index);
			if (blockType === "tool-call") state.sawContent = true;
			chunks.push({
				type: "block-start",
				index,
				blockType
			});
		}
		return chunks;
	}
	const resolveIndex = (ev) => {
		if (typeof ev.output_index === "number" && state.open.has(ev.output_index)) return ev.output_index;
		const itemId = toString$2(ev.item_id);
		const mapped = itemId !== void 0 ? state.indexByItemId.get(itemId) : void 0;
		if (mapped !== void 0 && state.open.has(mapped)) return mapped;
	};
	const deltaText = (ev) => toString$2(ev.delta) ?? "";
	if (type === "response.output_text.delta") {
		const index = resolveIndex(event);
		if (index === void 0) return chunks;
		const item = state.open.get(index);
		if (item !== void 0 && item.blockType === "text") {
			const delta = deltaText(event);
			item.content += delta;
			state.sawContent = true;
			chunks.push({
				type: "text-delta",
				index,
				text: delta
			});
		}
		return chunks;
	}
	if (type === "response.reasoning_summary_text.delta") {
		const index = resolveIndex(event);
		if (index === void 0) return chunks;
		const item = state.open.get(index);
		if (item !== void 0 && item.blockType === "reasoning") {
			const delta = deltaText(event);
			item.content += delta;
			state.sawContent = true;
			chunks.push({
				type: "reasoning-delta",
				index,
				text: delta
			});
		}
		return chunks;
	}
	if (type === "response.function_call_arguments.delta") {
		const index = resolveIndex(event);
		if (index === void 0) return chunks;
		const item = state.open.get(index);
		if (item !== void 0 && item.blockType === "tool-call") {
			const delta = deltaText(event);
			item.content += delta;
			chunks.push({
				type: "tool-call-delta",
				index,
				id: ToolCallId(item.callId ?? `sensenova-tool-${index}`),
				...item.name !== void 0 && item.name !== "" ? { name: item.name } : {},
				argumentsDelta: delta
			});
		}
		return chunks;
	}
	if (type === "response.output_item.done") {
		const index = typeof event.output_index === "number" ? event.output_index : void 0;
		const item = index !== void 0 ? state.open.get(index) : void 0;
		if (index !== void 0 && item !== void 0) {
			const doneItem = isRecord$2(event.item) ? event.item : void 0;
			if (item.callId === void 0) item.callId = toString$2(doneItem?.call_id);
			if (item.name === void 0 || item.name === "") item.name = toString$2(doneItem?.name);
			state.open.delete(index);
			const itemId = toString$2(event.item_id);
			if (itemId !== void 0) state.indexByItemId.delete(itemId);
			chunks.push(...closeItem(index, item));
		}
		return chunks;
	}
	return chunks;
}
/** 终止族事件 → 收尾 chunk 序列（close + usage + finish）。 */
function finishFromTerminalEvent(parsed, state) {
	const { type, event } = parsed;
	const chunks = closeAllOpen$1(state);
	const response = isRecord$2(event.response) ? event.response : void 0;
	const usageRec = isRecord$2(response?.usage) ? response?.usage : void 0;
	if (usageRec !== void 0) chunks.push({
		type: "usage",
		usage: mapResponsesUsage(usageRec)
	});
	let reason;
	if (type === "response.completed") reason = (Array.isArray(response?.output) ? response.output : []).some((item) => isRecord$2(item) && toString$2(item.type) === "function_call") ? { kind: "tool-calls" } : { kind: "stop" };
	else if (type === "response.incomplete") {
		const incompleteReason = toString$2((isRecord$2(response?.incomplete_details) ? response?.incomplete_details : void 0)?.reason);
		if (incompleteReason === "max_output_tokens") reason = { kind: "max-tokens" };
		else reason = {
			kind: "error",
			failure: {
				message: `SenseNova response incomplete: ${incompleteReason ?? "unknown reason"}`,
				code: "PROVIDER_PROTOCOL_ERROR"
			}
		};
	} else reason = {
		kind: "error",
		failure: {
			message: toString$2((isRecord$2(event.error) ? event.error : isRecord$2(response?.error) ? response?.error : void 0)?.message) ?? "SenseNova response failed",
			code: "PROVIDER_PROTOCOL_ERROR"
		}
	};
	chunks.push({
		type: "finish",
		reason
	});
	return chunks;
}
function isTerminalType(type) {
	return type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "error";
}
/** 判断错误是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason$2(value) {
	return value instanceof Error && value.name === "TimeoutError";
}
/** 把 Responses SSE 响应体翻译为宿主 StreamChunk 序列（结构与 parseOpenAiSse 对齐：
* 空闲看门狗、断尾收口、错误映射）。 */
async function* parseResponsesSse(body, signal, idleTimeoutMs, model, sessionId) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	const state = {
		open: /* @__PURE__ */ new Map(),
		indexByItemId: /* @__PURE__ */ new Map(),
		sawContent: false,
		finished: false
	};
	let buffer = "";
	let finished = false;
	let watchdogReject;
	let watchdogTimer;
	const armWatchdog = () => {
		if (watchdogTimer !== void 0) clearTimeout(watchdogTimer);
		watchdogTimer = setTimeout(() => {
			watchdogReject?.(new DOMException(`SenseNova stream idle for ${idleTimeoutMs}ms`, "TimeoutError"));
		}, idleTimeoutMs);
	};
	const disarmWatchdog = () => {
		if (watchdogTimer !== void 0) {
			clearTimeout(watchdogTimer);
			watchdogTimer = void 0;
		}
	};
	try {
		for (;;) {
			const read = await new Promise((resolve, reject) => {
				watchdogReject = reject;
				reader.read().then(resolve, reject);
				armWatchdog();
			});
			disarmWatchdog();
			const { done, value } = read;
			if (done) break;
			bytes += value.byteLength;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const parsed = parseResponsesLine(line);
				if (parsed === void 0) continue;
				if (finished) continue;
				if (isTerminalType(parsed.type)) {
					for (const chunk of finishFromTerminalEvent(parsed, state)) {
						yield chunk;
						if (chunk.type === "finish") finished = true;
					}
					continue;
				}
				for (const chunk of processResponsesEvent(parsed, state)) yield chunk;
			}
		}
		if (buffer.trim() !== "") {
			const parsed = parseResponsesLine(buffer);
			if (parsed !== void 0 && !finished) {
				if (isTerminalType(parsed.type)) for (const chunk of finishFromTerminalEvent(parsed, state)) {
					yield chunk;
					if (chunk.type === "finish") finished = true;
				}
				else for (const chunk of processResponsesEvent(parsed, state)) yield chunk;
			}
		}
		if (!finished) {
			traceLog(`[dsh-sensenova-suite] responses 流断尾 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B 未见终止事件，按 stop 收口`);
			for (const chunk of closeAllOpen$1(state)) yield chunk;
			if (!state.sawContent) throw new LlmError("llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复", "EMPTY_RESPONSE");
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		}
	} catch (error) {
		if (signal?.aborted && isTimeoutReason$2(signal.reason) || isTimeoutReason$2(error)) {
			traceLog(`[dsh-sensenova-suite] responses 流停摆/超时 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B → TIMEOUT`);
			throw new LlmError(`llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`, "TIMEOUT", { cause: error });
		}
		if (signal?.aborted) throw error;
		if (error instanceof LlmError) {
			traceLog(`[dsh-sensenova-suite] responses 流失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${error.message}`);
			throw error;
		}
		traceLog(`[dsh-sensenova-suite] responses 流中途失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${errorChain(error)} → TRANSPORT`);
		throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, "TRANSPORT", { cause: error });
	} finally {
		disarmWatchdog();
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}

//#endregion
//#region src/host/wire/sse-anthropic.ts
/** Anthropic Messages SSE → 宿主 StreamChunk 翻译（add-anthropic-wire-protocol）。
*
* 事件序列（Anthropic 公开规范，商汤文档未单列但实现遵循）：
* `message_start`（usage）→ `content_block_start` → `content_block_delta`×N →
* `content_block_stop` → `message_delta`（stop_reason + 增量 usage）→ `message_stop`。
* 另有 `ping` 心跳与 `error` 事件。
*
* 与另两条 wire 的翻译差异：
* - 块号直接用事件 `index`（无需 output_index/item_id 兜底那套）；
* - 思考内容走 `thinking` 块（`thinking_delta` 增量），不是摘要；
* - 工具参数走 `input_json_delta` 的 `partial_json` 增量；
* - `stop_reason` 是 `end_turn`/`max_tokens`/`stop_sequence`/`tool_use`。
*
* 硬约束（参照 Responses 翻译器的既有纪律）：
* - 没收到 `message_stop` 视为传输中断（不等 `[DONE]`，也不依赖它）；
* - 一个块都没开 = 空响应。
* @module dsh-sensenova-suite/wire/sse-anthropic
*/
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toString$1(value) {
	return typeof value === "string" ? value : void 0;
}
function toNumber$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** 解析一行 SSE；返回事件对象；空行/注释行/`[DONE]`/非 JSON/无 type 返回 undefined。 */
function parseAnthropicLine(line) {
	let trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":")) return void 0;
	if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
	if (!trimmed || trimmed === "[DONE]") return void 0;
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (!isRecord$1(parsed)) return void 0;
	return toString$1(parsed.type) === void 0 ? void 0 : parsed;
}
/** stop_reason → 宿主 FinishReason（有工具调用时优先 tool-calls）。 */
function finishOf(stopReason, hasToolCall) {
	if (hasToolCall || stopReason === "tool_use") return { kind: "tool-calls" };
	if (stopReason === "max_tokens") return { kind: "max-tokens" };
	return { kind: "stop" };
}
/** content_block 的 type → 宿主块类型。 */
function blockTypeOf(wireType) {
	if (wireType === "text") return "text";
	if (wireType === "thinking") return "reasoning";
	if (wireType === "tool_use") return "tool-call";
}
function closeBlock(index, block) {
	if (block === void 0) return [];
	if (block.blockType === "tool-call") {
		const name = block.name ?? "";
		if (name === "") return [];
		return [{
			type: "block-end",
			index,
			block: {
				type: "tool-call",
				id: ToolCallId(block.id ?? `sensenova-tool-${index}`),
				name,
				arguments: block.content !== "" ? block.content : "{}"
			}
		}];
	}
	return [{
		type: "block-end",
		index,
		block: block.blockType === "text" ? {
			type: "text",
			text: block.content
		} : {
			type: "reasoning",
			text: block.content
		}
	}];
}
function closeAllOpen(state) {
	const chunks = [];
	for (const [index, block] of [...state.open.entries()]) chunks.push(...closeBlock(index, block));
	state.open.clear();
	return chunks;
}
/** 处理一个 Anthropic 事件，返回宿主 StreamChunk 序列。 */
function processAnthropicEvent(event, state) {
	const type = toString$1(event.type) ?? "";
	const chunks = [];
	if (type === "error") {
		const message = toString$1((isRecord$1(event.error) ? event.error : void 0)?.message) ?? "SenseNova returned a stream error";
		throw new LlmError(`llm-sensenova: SenseNova Anthropic stream reported an error: ${message}；SenseNova 流式响应报告错误：${message}`, "PROVIDER_PROTOCOL_ERROR");
	}
	if (type === "message_start") {
		const message = isRecord$1(event.message) ? event.message : void 0;
		const usage = isRecord$1(message?.usage) ? message.usage : void 0;
		if (usage !== void 0) state.usage = mapAnthropicUsage(usage);
		return chunks;
	}
	if (type === "content_block_start") {
		const wire = isRecord$1(event.content_block) ? event.content_block : void 0;
		const blockType = blockTypeOf(toString$1(wire?.type) ?? "");
		const index = toNumber$1(event.index);
		if (blockType === void 0 || index === void 0) return chunks;
		const initialText = blockType === "reasoning" ? toString$1(wire?.thinking) ?? "" : blockType === "text" ? toString$1(wire?.text) ?? "" : "";
		const block = {
			blockType,
			content: initialText,
			id: toString$1(wire?.id),
			name: toString$1(wire?.name)
		};
		state.open.set(index, block);
		state.sawContent = true;
		if (blockType === "tool-call") state.sawToolCall = true;
		chunks.push({
			type: "block-start",
			index,
			blockType
		});
		if (initialText !== "") chunks.push(blockType === "reasoning" ? {
			type: "reasoning-delta",
			index,
			text: initialText
		} : {
			type: "text-delta",
			index,
			text: initialText
		});
		if (blockType === "tool-call") {
			const input = wire?.input;
			const serialized = input !== void 0 && isRecord$1(input) && JSON.stringify(input) !== "{}" ? JSON.stringify(input) : "";
			if (serialized !== "") {
				block.content = serialized;
				chunks.push({
					type: "tool-call-delta",
					index,
					id: ToolCallId(block.id ?? `sensenova-tool-${index}`),
					...block.name !== void 0 && block.name !== "" ? { name: block.name } : {},
					argumentsDelta: serialized
				});
			}
		}
		return chunks;
	}
	if (type === "content_block_delta") {
		const index = toNumber$1(event.index);
		const block = index !== void 0 ? state.open.get(index) : void 0;
		if (index === void 0 || block === void 0) return chunks;
		const delta = isRecord$1(event.delta) ? event.delta : void 0;
		const value = delta !== void 0 ? delta.type === "thinking_delta" ? toString$1(delta.thinking) : delta.type === "input_json_delta" ? toString$1(delta.partial_json) : delta.type === "text_delta" ? toString$1(delta.text) : void 0 : void 0;
		if (value === void 0 || value === "") return chunks;
		block.content += value;
		if (block.blockType === "tool-call") chunks.push({
			type: "tool-call-delta",
			index,
			id: ToolCallId(block.id ?? `sensenova-tool-${index}`),
			...block.name !== void 0 && block.name !== "" ? { name: block.name } : {},
			argumentsDelta: value
		});
		else if (block.blockType === "reasoning") chunks.push({
			type: "reasoning-delta",
			index,
			text: value
		});
		else chunks.push({
			type: "text-delta",
			index,
			text: value
		});
		return chunks;
	}
	if (type === "content_block_stop") {
		const index = toNumber$1(event.index);
		if (index === void 0) return chunks;
		const block = state.open.get(index);
		if (block === void 0) return chunks;
		state.open.delete(index);
		chunks.push(...closeBlock(index, block));
		return chunks;
	}
	if (type === "message_delta") {
		state.stopReason = toString$1((isRecord$1(event.delta) ? event.delta : {}).stop_reason) ?? state.stopReason;
		const usage = isRecord$1(event.usage) ? event.usage : void 0;
		if (usage !== void 0) state.usage = mergeUsage(state.usage, usage);
		return chunks;
	}
	if (type === "message_stop") {
		state.messageStopped = true;
		return chunks;
	}
	return chunks;
}
/** 判断错误是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason$1(value) {
	return value instanceof Error && value.name === "TimeoutError";
}
/** 把 Anthropic SSE 响应体翻译为宿主 StreamChunk 序列（结构与另两条 wire 对齐：
* 空闲看门狗、断尾收口、错误映射）。 */
async function* parseAnthropicSse(body, signal, idleTimeoutMs, model, sessionId) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	const state = {
		open: /* @__PURE__ */ new Map(),
		usage: void 0,
		stopReason: void 0,
		sawContent: false,
		sawToolCall: false,
		finished: false,
		messageStopped: false
	};
	let buffer = "";
	let watchdogReject;
	let watchdogTimer;
	const armWatchdog = () => {
		if (watchdogTimer !== void 0) clearTimeout(watchdogTimer);
		watchdogTimer = setTimeout(() => {
			watchdogReject?.(new DOMException(`SenseNova stream idle for ${idleTimeoutMs}ms`, "TimeoutError"));
		}, idleTimeoutMs);
	};
	const disarmWatchdog = () => {
		if (watchdogTimer !== void 0) {
			clearTimeout(watchdogTimer);
			watchdogTimer = void 0;
		}
	};
	try {
		for (;;) {
			const read = await new Promise((resolve, reject) => {
				watchdogReject = reject;
				reader.read().then(resolve, reject);
				armWatchdog();
			});
			disarmWatchdog();
			const { done, value } = read;
			if (done) break;
			bytes += value.byteLength;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const event = parseAnthropicLine(line);
				if (event === void 0) continue;
				if (state.finished) continue;
				for (const chunk of processAnthropicEvent(event, state)) {
					yield chunk;
					if (chunk.type === "finish") state.finished = true;
				}
			}
		}
		if (buffer.trim() !== "") {
			const event = parseAnthropicLine(buffer);
			if (event !== void 0 && !state.finished) for (const chunk of processAnthropicEvent(event, state)) {
				yield chunk;
				if (chunk.type === "finish") state.finished = true;
			}
		}
		if (!state.finished) {
			if (!state.messageStopped) throw new LlmError("llm-sensenova: SenseNova Anthropic stream ended before message_stop；SenseNova 流式响应在 message_stop 之前中断，重试通常可恢复", ANTHROPIC_TRUNCATED_CODE);
			for (const chunk of closeAllOpen(state)) yield chunk;
			if (!state.sawContent) throw new LlmError("llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复", "EMPTY_RESPONSE");
			if (state.usage !== void 0) yield {
				type: "usage",
				usage: state.usage
			};
			yield {
				type: "finish",
				reason: finishOf(state.stopReason, state.sawToolCall)
			};
		}
	} catch (error) {
		if (signal?.aborted && isTimeoutReason$1(signal.reason) || isTimeoutReason$1(error)) {
			traceLog(`[dsh-sensenova-suite] anthropic 流停摆/超时 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B → TIMEOUT`);
			throw new LlmError(`llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`, "TIMEOUT", { cause: error });
		}
		if (signal?.aborted) throw error;
		if (error instanceof LlmError) {
			traceLog(`[dsh-sensenova-suite] anthropic 流失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${error.message}`);
			throw error;
		}
		traceLog(`[dsh-sensenova-suite] anthropic 流中途失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${errorChain(error)} → TRANSPORT`);
		throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, "TRANSPORT", { cause: error });
	} finally {
		disarmWatchdog();
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}

//#endregion
//#region src/host/wire/plan.ts
/** wire 协议决策（per-model-protocol-chain：全量降级链，2026-10-30 用户拍板）。
*
* 每个模型恒有一条降级链（有序子集，≤3），生效链按层合成：
*
* ```
* 面板覆盖（pool.json modelProtocols[model]）
*   ?? wireProtocol 配置（强制值映射为单线链；auto = 档案默认）
*   ?? 档案默认链（facts.defaultChain：全模型统一 an>re>chat，2026-11-04 倒序；
*      2026-10-31 曾定 re>an>chat）
* ```
*
* 决策 = 沿生效链走查：第一条「模型声明支持（supportedWires 求交）且未命中
* 该线降级条件」的线服务。链上所有线都覆盖不了该请求时，落**全局兜底链**
* `["chat-completions"]`——chat 是三线中表达最全的参考方言（上游 §二原表），
* 无降级条件，常态下不再出现「链耗尽报错」；真报错的只剩 chat 自身失败。
*
* 旧「强制模式报错」语义（forced 命中降级条件抛错）随本模型退役：单线链
* 命中降级条件同样落 chat 兜底——用户已拍板「不至于一直报错」。
*
* 各线降级条件（未变，链走查逐线调用）：
* - Anthropic：模型不支持（supportedWires）/ 关闭拼写在 an 线无表达
*   （forbidThinkingDisabled 模型勾 off——2026-11-01 拍板「用户选择大于协议」，
*   显式跳过而非静默失效）/ 运行时 400 标记（anthropicUnsupported）。
*   带图与 `stop` 都不是 Anthropic 的降级条件：stop 由文档背书
*   （#api-compatibility-params 明确支持 stop_sequences）；带图的静态预拦
*   （anthropicSupportsImages）2026-11-04 撤档——an 线收不收图由用户「可看图」
*   勾选（换图器边界）与运行时 400 探测决定，见 anthropicDegrade 注。
* - Responses：stop 非空 / 模型不支持 / effort 偏离 Responses 默认档（非 none，
*   off/minimal 归一为 none）/ 运行时 400 标记（responsesUnsupported）。
* - Chat：无降级条件（参考方言）。
* @module dsh-sensenova-suite/wire/plan
*/
/** 模型是否声明支持 Anthropic wire（静态表 supportedWires）。 */
function supportsAnthropic(facts) {
	return facts.supportedWires.includes("anthropic");
}
/** 模型是否声明支持 Responses wire。 */
function supportsResponses(facts) {
	return facts.supportedWires.includes("responses");
}
/**
* Anthropic 段的降级判定（未命中为 undefined）。任一命中即放弃 Anthropic。
* 链走查只消费命中/未命中——返回里的终点 wire 是旧自动链的遗形，不再被读。
*
* 注意：`stop` **不是** Anthropic 的降级条件——文档 #api-compatibility-params 明确
* 支持 `stop_sequences`。stop 只是 Responses 的降级条件（§5.2 原第一条），在
* Anthropic 优先后仅当 Anthropic 已被排除时才成为判据。
*
* 带图不再静态预拦（2026-11-04 他拍板「anthropicSupportsImages 撤档，由用户
* 手动配置和探测决定」）：该字段的历史就是文档口径被真机逐个推翻史——文档写
* 「仅 6.8-lite 支持图片块」，deepseek-flash/kimi-k3（10-27）与 6.8-flash
* （11-03）真机发图先后成功，档案三次被迫翻 true。撤档后 an 线收不收图由
* 「可看图」勾选（未勾模型在换图器边界就被转述/拦下，wire 层看不到图）与
* 运行时 400 探测（§5.3 invalid_request_error → anthropicUnsupported 标记换线）
* 决定；文档沉默不预填「不支持」。
*/
function anthropicDegrade(options, facts, runtime) {
	if (!supportsAnthropic(facts)) return {
		wire: supportsResponses(facts) ? "responses" : "chat-completions",
		reason: "downgrade-unsupported-model"
	};
	if (facts.forbidThinkingDisabled && canonicalThinkingEffort(options.reasoningEffort) === "none") return {
		wire: supportsResponses(facts) ? "responses" : "chat-completions",
		reason: "downgrade-effort-unsupported"
	};
	if (runtime.anthropicUnsupported?.has(options.model) === true) return {
		wire: "responses",
		reason: "downgrade-runtime-marked"
	};
}
/**
* Responses 段的降级判定（未命中为 undefined）。任一命中即放弃 Responses。
* §5.2 原四条序即优先级；档位偏离一条在 Anthropic 优先后仍是 Responses 的主因。
*/
function responsesDegrade(options, facts, runtime) {
	if (options.stop !== void 0 && options.stop.length > 0) return {
		wire: "chat-completions",
		reason: "downgrade-stop"
	};
	if (!supportsResponses(facts)) return {
		wire: "chat-completions",
		reason: "downgrade-unsupported-model"
	};
	const effort = canonicalThinkingEffort(options.reasoningEffort);
	if (effort !== void 0 && effort !== "none" && effort !== facts.responsesDefaultEffort) return {
		wire: "chat-completions",
		reason: "downgrade-effort"
	};
	if (runtime.responsesUnsupported?.has(options.model) === true) return {
		wire: "chat-completions",
		reason: "downgrade-runtime-marked"
	};
}
/** 链上服务线的原因词（同一形状服务面板链与档案默认链）。 */
function servedReason(wire) {
	if (wire === "anthropic") return "anthropic-default";
	if (wire === "responses") return "responses-default";
	return "chat-default";
}
/**
* 沿生效链走查：第一条「模型声明支持且未命中该线降级条件」的线服务；
* 全链覆盖不了该请求 → 全局兜底 chat（用户拍板「不至于一直报错」）；
* 连 chat 都不在模型能力面（理论上不存在，档案全含 chat）才真正抛错。
*/
function walkChain(options, facts, runtime, chain) {
	for (let index = 0; index < chain.length; index += 1) {
		const wire = chain[index];
		if (!facts.supportedWires.includes(wire)) continue;
		if ((wire === "anthropic" ? anthropicDegrade(options, facts, runtime) : wire === "responses" ? responsesDegrade(options, facts, runtime) : void 0) !== void 0) continue;
		return {
			wire,
			reason: servedReason(wire),
			chain
		};
	}
	if (!facts.supportedWires.includes("chat-completions")) throw new LlmError(`llm-sensenova: wire chain [${chain.join(" > ")}] cannot serve model "${options.model}" (exhausted, chat not in supportedWires)；模型降级链耗尽且能力面不含 chat，无法服务`, "INVALID_REQUEST");
	return {
		...walkChain(options, facts, runtime, GLOBAL_FALLBACK_CHAIN),
		reason: "chain-fallback"
	};
}
/**
* 决定本次请求使用的 wire。
*
* @param modelChain - 面板对该模型的链覆盖（pool.json modelProtocols[model]，
*   有序子集；undefined/空/非法 = 无覆盖，按配置与档案默认合成）。
*/
function resolveWirePlan(options, config, facts, runtime = {}, modelChain) {
	return walkChain(options, facts, runtime, effectiveChain(config, facts, modelChain));
}

//#endregion
//#region src/host/adapter.ts
/**
* SenseNova（OpenAI 兼容）provider 适配器（host 侧）。
*
* 复用参考插件 @mars-sea/dsh-commandcode-provider 的适配器结构，但只保留
* OpenAI 兼容的目录拉取与 SSE 流式翻译，外加「流开始前的 401 账号轮换」
* （429 不轮换：一个会话固定一个 key，保护服务端按 key 命中的 prompt 缓存，
* 429 交由宿主重试层退避后原 key 重试）。
* 与 pi-ai 的 `toStreamChunks` 不同，这里直接消费 OpenAI SSE（`data:` 行、
* `[DONE]`、`choices[].delta`、`finish_reason`、`usage`），不引入第三方流库。
*
* 适配器刻意不依赖 cordis/schemastery：每请求的连接事实与 key 解析/轮换
* 全部通过构造注入，node 测试可直接驱动。
*
* @module dsh-sensenova-suite/adapter
*/
/** 官方文档声明的模型族事实已迁入 src/wire/facts.ts（add-model-facts 2.2）；
* adapter 仅消费 factsFor/staticFacts，不复制第二份。 */
/** Chat 请求体构造已迁出至 wire/body-chat.ts（make-responses-default-wire-protocol 4.1，行为不变）。 */
/**
* 目录缺上下文字段时的兜底窗（131072）移到 llm-models.FALLBACK_CONTEXT_WINDOW：
* 面板 badge 与 resolveModel 引用同一常量（D1——两处各写一个数字曾分叉
* 128k/131072），本文件经 import 使用。
*/
/**
* 配额类 429 退避指导（providerRetryAfterMs）的绝对上限（毫秒）：与
* PROVIDER_RETRY_AFTER_CAP_MS（即重试策略单次延迟上限）一致。宿主 dsh-llm-retry
* （normal 模式）在 providerRetryAfterMs 超过单次延迟上限时会直接放弃重试，封顶
* 对齐后保证任何采用值都会被宿主按指导延迟重试；不影响统一退避梯（3–30s）
* 各档的正常取值。 */
const QUOTA_RETRY_AFTER_CEILING_MS = PROVIDER_RETRY_AFTER_CAP_MS;
/** 轮间抖动等待窗口（毫秒）：3 轮全 429 之后、第 4 轮之前等一次，每请求独立算。
* 目的是避免多个并发请求同时结束等待、造成第二波请求洪峰（2026-11-02 他拍板）。 */
const JITTER_WAIT_MIN_MS = 5e3;
/** quotaStickyKeys 的容量上限（U4 审计顺带②）：条目=会话→粘住的 key，此前只增
* 不删无上界。超上限删最早插入者（Map 迭代序=插入序，与 key-orchestrator 亲和表
* 同款取舍——严格 LRU 需读时重排，不值得）。512 与亲和表 affinityMax 同量级。 */
const QUOTA_STICKY_KEYS_MAX = 512;
/** 可中断 sleep（毫秒）：signal abort 时立即醒来。轮间等待用。 */
function abortableSleep(ms, signal) {
	return new Promise((resolve) => {
		if (ms <= 0 || signal?.aborted === true) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/** 生成请求连接/首字节超时（毫秒）。2026-09-04 实测：传输挂起 ≈1/5 且无 RST，45s 覆盖大 prompt 建连+首包（design D4/D6）。 */
const CONNECT_TIMEOUT_MS = 45e3;
/** SSE 流空闲看门狗（毫秒）：距上一事件 ≥ 该值无任何 chunk/事件即按停摆结束。2026-09-04 实测：思考期渠道有空事件/心跳自然重置计时（design D4/D6）。 */
const STREAM_IDLE_TIMEOUT_MS = 6e4;
/** 明确的模型不可用错误码（不在默认可重试集合内，故不触发 provider 重试）。 */
const MODEL_NOT_FOUND_CODE = LLM_CODES.modelNotFound;
/** 模型 id → 标准显示名的显式品牌映射。 */
const DISPLAY_NAME_OVERRIDES = /* @__PURE__ */ new Map([["sensenova-6.7-flash-lite", "Sensenova 6.7 Flash Lite"]]);
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toString(value) {
	return typeof value === "string" ? value : void 0;
}
function toNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/** wire → 端点路径（三条协议共享同一 apiBase，路径各不同）。 */
function endpointOf(wire) {
	if (wire === "anthropic") return "/messages";
	if (wire === "responses") return "/responses";
	return "/chat/completions";
}
/** 把模型 id 标准化为可读显示名：显式映射优先，否则按品牌前缀回退。 */
function displayNameFor(id) {
	const override = DISPLAY_NAME_OVERRIDES.get(id);
	if (override !== void 0) return override;
	const normalized = id.trim();
	const words = normalized.split(/[-_]+/).filter((part) => part !== "").flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/));
	if (words.length === 0) return normalized;
	return words.map((word) => word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word).join(" ").replace(/\s+/g, " ").trim();
}
/** 从目录条目读取一个正数能力字段（按优先级），缺失/非法返回 undefined。 */
function firstPositiveNumber(raw, keys) {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
}
function firstContextField(raw) {
	return firstPositiveNumber(raw, CONTEXT_WINDOW_FIELDS);
}
function firstMaxOutputField(raw) {
	return firstPositiveNumber(raw, MAX_OUTPUT_FIELDS);
}
/** 读取目录中的 effort 词表字段；返回字符串数组或 undefined（无明确词表）。 */
function effortListField(raw) {
	for (const key of ["reasoning_efforts", "reasoning_levels"]) {
		const value = raw[key];
		if (Array.isArray(value)) {
			const efforts = value.filter((item) => typeof item === "string" && item !== "");
			if (efforts.length > 0) return efforts;
		}
	}
}
/** 读取嵌套 reasoning.efforts / thinking.efforts 词表；返回字符串数组或 undefined。 */
function nestedEffortListField(raw) {
	for (const key of ["reasoning", "thinking"]) {
		const holder = raw[key];
		if (!isRecord(holder)) continue;
		const efforts = holder.efforts;
		if (Array.isArray(efforts)) {
			const list = efforts.filter((item) => typeof item === "string" && item !== "");
			if (list.length > 0) return list;
		}
	}
}
/** 读取目录中的默认 effort 字段；返回字符串或 undefined。 */
function defaultEffortField(raw) {
	const direct = raw.default_reasoning_effort;
	if (typeof direct === "string" && direct !== "") return direct;
	for (const key of ["reasoning", "thinking"]) {
		const holder = raw[key];
		if (isRecord(holder)) {
			const value = holder.defaultEffort ?? holder.default_effort;
			if (typeof value === "string" && value !== "") return value;
		}
	}
}
/** 目录是否声明支持 reasoning；仅用于静态已知模型族的档位补全。 */
function hasReasoningSupport(raw) {
	const features = raw.supported_features;
	if (Array.isArray(features) && features.includes("reasoning")) return true;
	if (raw.reasoning_effort !== void 0) return true;
	const thinking = raw.thinking;
	return thinking === true || isRecord(thinking);
}
/** 读取目录 supported_sampling_parameters 白名单；缺失返回 undefined。 */
function samplingListField(raw) {
	const value = raw.supported_sampling_parameters;
	if (!Array.isArray(value)) return void 0;
	const list = value.filter((item) => typeof item === "string" && item !== "");
	return list.length > 0 ? list : void 0;
}
/** 目录未返回 supported_sampling_parameters 时的静态兜底已迁入 src/wire/facts.ts
* （静态档案 samplingParameters 字段；kimi-k3 依文档 :2455-2457 补 seed/parallel_tool_calls）。 */
/** 思考档位规范升序：对话界面下拉「从上到下递增」的唯一依据（2026-10-27 用户拍板）。
* off（用户勾选集拼法，pool.json thinking）与 none（平台目录拼法）同处最低档；
* minimal 在 low 之下、xhigh 在 high 之上（glm 原生词表）。表外档位排末尾、保持
* 相对顺序（稳定排序），不猜强度。 */
const EFFORT_RANK = {
	off: 0,
	none: 1,
	minimal: 2,
	low: 3,
	medium: 4,
	high: 5,
	xhigh: 6,
	max: 7
};
/** 把档位 id 列表排成升序并转成 reasoning.efforts 的行。reasoningInfoFrom（目录
* 词表/静态表）与 parseCatalog（用户勾选覆盖）两条路共用——平台目录按强度降序
* 罗列、勾选集按保存顺序，都不再原样透传到对话下拉。 */
function effortsAscending(efforts) {
	return efforts.map((effort, index) => ({
		effort,
		index,
		rank: EFFORT_RANK[effort] ?? Number.MAX_SAFE_INTEGER
	})).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ effort }) => ({
		id: ReasoningEffortId(effort),
		name: effort
	}));
}
/** 解析目录条目的 reasoning 词表；目录词表优先，静态表仅补全已知且有支持标记的模型。
* defaultEffort：目录声明的默认档优先；目录未带（或命中静态表）时回退静态表默认档
* （align-request-fields-with-docs 1.2：命中静态表即声明 defaultEffort）。
* 词表一律排成升序（effortsAscending）——对话下拉从上到下递增，不透传目录原序。 */
function reasoningInfoFrom(raw, modelId) {
	const efforts = effortListField(raw) ?? nestedEffortListField(raw);
	const knownFacts = staticFacts(modelId);
	const selectedEfforts = efforts ?? (knownFacts !== void 0 && hasReasoningSupport(raw) ? knownFacts.efforts : void 0);
	if (selectedEfforts === void 0 || selectedEfforts.length === 0) return void 0;
	const infos = effortsAscending(selectedEfforts);
	const declaredDefault = efforts !== void 0 ? defaultEffortField(raw) : void 0;
	const fallbackDefault = knownFacts?.defaultEffort ?? void 0;
	const defaultEffort = declaredDefault ?? fallbackDefault;
	const defaultId = defaultEffort !== void 0 && selectedEfforts.includes(defaultEffort) ? ReasoningEffortId(defaultEffort) : void 0;
	return {
		efforts: infos,
		...defaultId !== void 0 ? { defaultEffort: defaultId } : {}
	};
}
/** 用户思考档位覆盖（pool.json `thinking` 分区）的现算投影：有勾选集时该模型
* reasoning.efforts 改为「用户勾选集」（DSH 对话界面的可选思考档位 = 用户勾选集），
* defaultEffort 维持目录解析结果（不在新集内也保留——不影响可选集，只影响默认档）。
* 在 listModels/resolveModel/stream 三个读取边界调用，不写回目录缓存（热更新）。 */
function withUserThinking(entry, model, overrides) {
	if (entry === void 0) return entry;
	const userList = overrides?.[model];
	if (!Array.isArray(userList) || userList.length === 0) return entry;
	const efforts = effortsAscending(userList);
	return {
		...entry,
		reasoning: entry.reasoning !== void 0 ? {
			...entry.reasoning,
			efforts
		} : { efforts }
	};
}
/** 解析 OpenAI 模型目录为目录条目；应用自动过滤与失败缓存。
* 只投影平台数据——用户配置（思考档位/可看图）一律在读取边界现算
* （withUserThinking / visionModelIds），绝不烘焙进 24h 目录缓存：缓存内容
* 若掺了用户配置，改配置不会失效缓存（2026-10-27「思考档位要重启才生效」根因）。 */
function parseCatalog(value, failedModels) {
	if (!isRecord(value) || !Array.isArray(value.data)) throw new LlmError("llm-sensenova: unexpected models response shape", LLM_CODES.providerProtocolError);
	const out = [];
	for (const raw of value.data) {
		if (!isRecord(raw)) continue;
		const id = toString(raw.id);
		if (id === void 0 || id === "") continue;
		const output = raw.output_modalities;
		if (!(Array.isArray(output) ? output.some((item) => toString(item) === "text") : false)) continue;
		if (KNOWN_UNROUTABLE_MODELS.has(id)) continue;
		if (failedModels.has(id)) continue;
		const contextWindow = firstContextField(raw);
		const maxOutputTokens = firstMaxOutputField(raw);
		const reasoning = reasoningInfoFrom(raw, id);
		const supportedSamplingParameters = samplingListField(raw);
		const inputModalities = inputModalitiesFor(raw);
		out.push({
			id,
			name: displayNameFor(id),
			...inputModalities !== void 0 ? { inputModalities } : {},
			...contextWindow !== void 0 ? { contextWindow } : {},
			...maxOutputTokens !== void 0 ? { maxOutputTokens } : {},
			...reasoning !== void 0 ? { reasoning } : {},
			...supportedSamplingParameters !== void 0 ? { supportedSamplingParameters } : {}
		});
	}
	return out;
}
/** OpenAI usage → 宿主 TokenUsage（inputTokens 为未缓存输入，缓存读单独计）。 */
function mapUsage(usage) {
	const prompt = toNumber(usage.prompt_tokens);
	const completion = toNumber(usage.completion_tokens);
	const total = toNumber(usage.total_tokens);
	const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : void 0;
	const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : void 0;
	const cacheRead = promptDetails !== void 0 ? toNumber(promptDetails.cached_tokens) : 0;
	const reasoning = completionDetails !== void 0 ? toNumber(completionDetails.reasoning_tokens) : 0;
	return {
		inputTokens: Math.max(0, prompt - cacheRead),
		outputTokens: completion,
		totalTokens: total > 0 ? total : prompt + completion,
		...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning > 0 ? { reasoningTokens: reasoning } : {}
	};
}
/** OpenAI finish_reason → 宿主 FinishReason。 */
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls":
		case "function_call": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: "SenseNova stream aborted",
				code: "ABORTED"
			}
		};
		default: return { kind: "stop" };
	}
}
/** 解析一行 SSE；返回解析后的数据对象，`[DONE]` 或空行/注释行返回 undefined。 */
function parseSseDataLine(line) {
	let trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":")) return void 0;
	if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
	if (!trimmed || trimmed === "[DONE]") return void 0;
	try {
		return JSON.parse(trimmed);
	} catch {
		return;
	}
}
function createSseState() {
	return {
		nextIndex: 0,
		textIndex: -1,
		textContent: "",
		reasoningIndex: -1,
		reasoningContent: "",
		toolIndexById: /* @__PURE__ */ new Map(),
		toolIndexByProtocolIndex: /* @__PURE__ */ new Map(),
		toolIndexByAnonymousName: /* @__PURE__ */ new Map(),
		lastAnonymousIndex: -1,
		toolIdByIndex: /* @__PURE__ */ new Map(),
		toolNameByIndex: /* @__PURE__ */ new Map(),
		toolArgsByIndex: /* @__PURE__ */ new Map(),
		sawContent: false,
		pendingUsage: void 0,
		usageEmitted: false,
		finished: false
	};
}
function closeText(state) {
	if (state.textIndex < 0) return [];
	const chunk = {
		type: "block-end",
		index: state.textIndex,
		block: {
			type: "text",
			text: state.textContent
		}
	};
	state.textIndex = -1;
	state.textContent = "";
	return [chunk];
}
function closeReasoning(state) {
	if (state.reasoningIndex < 0) return [];
	const chunk = {
		type: "block-end",
		index: state.reasoningIndex,
		block: {
			type: "reasoning",
			text: state.reasoningContent
		}
	};
	state.reasoningIndex = -1;
	state.reasoningContent = "";
	return [chunk];
}
function closeToolCalls(state) {
	const chunks = [];
	for (const [index, args] of [...state.toolArgsByIndex.entries()]) {
		const name = state.toolNameByIndex.get(index) ?? "";
		if (name === "") continue;
		const id = state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`;
		chunks.push({
			type: "block-end",
			index,
			block: {
				type: "tool-call",
				id: ToolCallId(id),
				name,
				arguments: args !== "" ? args : "{}"
			}
		});
	}
	state.toolArgsByIndex.clear();
	state.toolIdByIndex.clear();
	state.toolNameByIndex.clear();
	state.toolIndexById.clear();
	state.toolIndexByProtocolIndex.clear();
	state.toolIndexByAnonymousName.clear();
	state.lastAnonymousIndex = -1;
	return chunks;
}
/** 将事件中的 usage 转成单次 usage chunk，避免 finish/trailing 重复发出。 */
function usageChunksFrom(event, state) {
	if (state.usageEmitted || !isRecord(event)) return [];
	const usageRec = isRecord(event.usage) ? event.usage : void 0;
	if (state.pendingUsage === void 0 && usageRec === void 0) return [];
	const usage = state.pendingUsage ?? mapUsage(usageRec);
	state.pendingUsage = void 0;
	state.usageEmitted = true;
	return [{
		type: "usage",
		usage
	}];
}
/** 处理一个 OpenAI SSE 数据对象，返回对应的宿主 StreamChunk 序列。 */
function processChunkEvent(event, state) {
	if (!isRecord(event)) return [];
	const choices = event.choices;
	if (!Array.isArray(choices)) return usageChunksFrom(event, state);
	const chunks = [];
	for (const rawChoice of choices) {
		if (state.finished) break;
		if (!isRecord(rawChoice)) continue;
		const delta = isRecord(rawChoice.delta) ? rawChoice.delta : void 0;
		const finishReasonRaw = rawChoice.finish_reason;
		const finishReason = typeof finishReasonRaw === "string" && finishReasonRaw !== "" && finishReasonRaw !== "null" ? finishReasonRaw : void 0;
		if (delta !== void 0) {
			const content = toString(delta.content) ?? "";
			const reasoning = toString(delta.reasoning_content) ?? toString(delta.reasoning) ?? "";
			const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : [];
			if (reasoning !== "") {
				chunks.push(...closeText(state));
				if (state.reasoningIndex < 0) {
					state.reasoningIndex = state.nextIndex;
					state.nextIndex += 1;
					chunks.push({
						type: "block-start",
						index: state.reasoningIndex,
						blockType: "reasoning"
					});
				}
				state.reasoningContent += reasoning;
				chunks.push({
					type: "reasoning-delta",
					index: state.reasoningIndex,
					text: reasoning
				});
			}
			if (content !== "") {
				chunks.push(...closeReasoning(state));
				if (state.textIndex < 0) {
					state.textIndex = state.nextIndex;
					state.nextIndex += 1;
					chunks.push({
						type: "block-start",
						index: state.textIndex,
						blockType: "text"
					});
				}
				state.textContent += content;
				state.sawContent = true;
				chunks.push({
					type: "text-delta",
					index: state.textIndex,
					text: content
				});
			}
			for (const tc of toolCalls) {
				const id = toString(tc.id) ?? "";
				const protocolIndex = typeof tc.index === "number" && Number.isInteger(tc.index) ? tc.index : void 0;
				const fn = isRecord(tc.function) ? tc.function : void 0;
				const name = fn !== void 0 ? toString(fn.name) ?? "" : "";
				const argsDelta = fn !== void 0 ? toString(fn.arguments) ?? "" : "";
				let index;
				if (protocolIndex !== void 0) index = state.toolIndexByProtocolIndex.get(protocolIndex);
				else if (id !== "") index = state.toolIndexById.get(id);
				else if (name !== "") index = state.toolIndexByAnonymousName.get(name);
				else index = state.lastAnonymousIndex >= 0 ? state.lastAnonymousIndex : void 0;
				if (index === void 0) {
					chunks.push(...closeText(state), ...closeReasoning(state));
					index = state.nextIndex;
					state.nextIndex += 1;
					if (protocolIndex !== void 0) state.toolIndexByProtocolIndex.set(protocolIndex, index);
					if (id !== "") state.toolIndexById.set(id, index);
					if (name !== "" && protocolIndex === void 0 && id === "") {
						state.toolIndexByAnonymousName.set(name, index);
						state.lastAnonymousIndex = index;
					}
					state.toolIdByIndex.set(index, id);
					state.toolNameByIndex.set(index, name);
					state.toolArgsByIndex.set(index, "");
					chunks.push({
						type: "block-start",
						index,
						blockType: "tool-call"
					});
					state.sawContent = true;
				}
				if (id !== "") {
					state.toolIdByIndex.set(index, id);
					state.toolIndexById.set(id, index);
				}
				if (name !== "") state.toolNameByIndex.set(index, name);
				if (protocolIndex === void 0 && id === "" && name !== "") {
					state.toolIndexByAnonymousName.set(name, index);
					state.lastAnonymousIndex = index;
				}
				const accumulated = (state.toolArgsByIndex.get(index) ?? "") + argsDelta;
				state.toolArgsByIndex.set(index, accumulated);
				const effectiveName = state.toolNameByIndex.get(index) ?? "";
				chunks.push({
					type: "tool-call-delta",
					index,
					id: ToolCallId(state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`),
					...effectiveName !== "" ? { name: effectiveName } : {},
					argumentsDelta: argsDelta
				});
			}
		}
		if (finishReason !== void 0) {
			state.finished = true;
			chunks.push(...closeText(state), ...closeReasoning(state), ...closeToolCalls(state));
			chunks.push(...usageChunksFrom(event, state));
			chunks.push({
				type: "finish",
				reason: mapFinishReason(finishReason)
			});
			continue;
		}
		const usageRec = isRecord(event.usage) ? event.usage : void 0;
		if (usageRec !== void 0 && state.pendingUsage === void 0) state.pendingUsage = mapUsage(usageRec);
	}
	return chunks;
}
/** 把 OpenAI SSE 响应体翻译为宿主 StreamChunk 序列。 */
async function* parseOpenAiSse(body, signal, idleTimeoutMs, model, sessionId) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state = createSseState();
	let buffer = "";
	let finished = false;
	let bytes = 0;
	let watchdogReject;
	let watchdogTimer;
	const armWatchdog = () => {
		if (watchdogTimer !== void 0) clearTimeout(watchdogTimer);
		watchdogTimer = setTimeout(() => {
			watchdogReject?.(new DOMException(`SenseNova stream idle for ${idleTimeoutMs}ms`, "TimeoutError"));
		}, idleTimeoutMs);
	};
	const disarmWatchdog = () => {
		if (watchdogTimer !== void 0) {
			clearTimeout(watchdogTimer);
			watchdogTimer = void 0;
		}
	};
	try {
		for (;;) {
			const read = await new Promise((resolve, reject) => {
				watchdogReject = reject;
				reader.read().then(resolve, reject);
				armWatchdog();
			});
			disarmWatchdog();
			const { done, value } = read;
			if (done) break;
			bytes += value.byteLength;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const event = parseSseDataLine(line);
				if (event === void 0) continue;
				if (finished) {
					for (const chunk of usageChunksFrom(event, state)) yield chunk;
					continue;
				}
				for (const chunk of processChunkEvent(event, state)) {
					yield chunk;
					if (chunk.type === "finish") finished = true;
				}
			}
		}
		if (buffer.trim() !== "") {
			const event = parseSseDataLine(buffer);
			if (event !== void 0) {
				if (finished) for (const chunk of usageChunksFrom(event, state)) yield chunk;
				else for (const chunk of processChunkEvent(event, state)) {
					yield chunk;
					if (chunk.type === "finish") finished = true;
				}
			}
		}
		if (!finished) {
			traceLog(`[dsh-sensenova-suite] chat-completions 流断尾 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B 未见终止事件，按 stop 收口`);
			const trailing = [
				...closeText(state),
				...closeReasoning(state),
				...closeToolCalls(state)
			];
			for (const chunk of trailing) yield chunk;
			if (!state.sawContent) throw new LlmError("llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复", LLM_CODES.emptyResponse);
			if (state.pendingUsage !== void 0) yield {
				type: "usage",
				usage: state.pendingUsage
			};
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		}
	} catch (error) {
		if (signal?.aborted && isTimeoutReason(signal.reason) || isTimeoutReason(error)) {
			traceLog(`[dsh-sensenova-suite] chat-completions 流停摆/超时 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B → TIMEOUT`);
			throw new LlmError(`llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`, LLM_CODES.timeout, { cause: error });
		}
		if (signal?.aborted) throw error;
		if (error instanceof LlmError) {
			traceLog(`[dsh-sensenova-suite] chat-completions 流失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${error.message}`);
			throw error;
		}
		traceLog(`[dsh-sensenova-suite] chat-completions 流中途失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${errorChain(error)} → TRANSPORT`);
		throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, LLM_CODES.transport, { cause: error });
	} finally {
		disarmWatchdog();
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}
/** 判断错误文本是否为「模型不可路由」的 404 措辞。 */
function isModelNotFoundText(errText) {
	const lower = errText.toLowerCase();
	return lower.includes("model route not found") || lower.includes("model is not found");
}
/** §5.3：400 响应体是否为 error.type === 'invalid_request_error'（Responses 运行时不符信号）。 */
function isInvalidRequestError(errText) {
	try {
		const parsed = JSON.parse(errText);
		return isRecord(parsed) && isRecord(parsed.error) && parsed.error.type === "invalid_request_error";
	} catch {
		return false;
	}
}
/** 是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason(value) {
	return value instanceof Error && value.name === "TimeoutError";
}
/** Anthropic 协议的错误 type 词表（公开规范；商汤 /v1/messages 遵循）。 */
const ANTHROPIC_OVERLOADED = "overloaded_error";
const ANTHROPIC_RATE_LIMIT = "rate_limit_error";
const ANTHROPIC_AUTH = /* @__PURE__ */ new Set(["authentication_error", "permission_error"]);
/** 从错误体取 Anthropic 形状的 error.type（非该形状返回 undefined）。 */
function anthropicErrorType(errText) {
	try {
		const parsed = JSON.parse(errText);
		if (!isRecord(parsed) || !isRecord(parsed.error)) return void 0;
		const type = parsed.error.type;
		return typeof type === "string" ? type : void 0;
	} catch {
		return;
	}
}
/** 把预流 HTTP 失败映射为稳定 LlmError。
* dynamicFloorMs：stream 层算好的配额类动态退避下限（分级探测档），
* 覆盖 classify429Body 返回的静态 floor；undefined 时用静态 floor。
* wire：当前请求走的协议；Anthropic 协议的错误体用 type 字符串而非数字 code，
* 需单独识别 overloaded / rate_limit，否则会被当成普通 HTTP 5xx/4xx 漏判。
* poolExhausted：该组积分池已全标（4 轮轮询的唯一「不等就终止」路径）——
* 抛 ACCOUNT_QUOTA（不在宿主可重试清单里，直接上屏）而不是 RATE_LIMIT。 */
function httpError(status, errText, retryAfterMs, dynamicFloorMs, wire, poolExhausted = false) {
	const anthropicType = wire === "anthropic" ? anthropicErrorType(errText) : void 0;
	if (status === 401) return new LlmError("llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效", LLM_CODES.invalidCredential, { status: 401 });
	if (status === 404 && isModelNotFoundText(errText)) return new LlmError("llm-sensenova: SenseNova model is not routable — the model id is no longer served；SenseNova 模型不可路由：该模型 id 已下线", MODEL_NOT_FOUND_CODE, { status: 404 });
	if (status === 429) {
		if (poolExhausted) return new LlmError("llm-sensenova: SenseNova model group persistently rate-limited；SenseNova 该模型组全部 key 持续限流不可用（连续超阈升级），已停止重试，稍后自动恢复或更换账号", QUOTA_CODES.accountQuota, { status: 429 });
		const classified = classify429Body(errText);
		const classifiedWithAnthropic = anthropicType === ANTHROPIC_RATE_LIMIT && !classified.quota ? {
			quota: true,
			retryFloorMs: probeFloorFor(0),
			kind: "rate",
			bucket: "tpm"
		} : classified;
		const floorMs = dynamicFloorMs ?? classifiedWithAnthropic.retryFloorMs;
		let providerRetryAfterMs;
		if (floorMs !== void 0) providerRetryAfterMs = Math.min(Math.max(floorMs, retryAfterMs !== void 0 && retryAfterMs > 0 ? retryAfterMs : 0), QUOTA_RETRY_AFTER_CEILING_MS);
		else providerRetryAfterMs = retryAfterMs !== void 0 && retryAfterMs > 0 && retryAfterMs <= 6e4 ? retryAfterMs : void 0;
		return new LlmError("llm-sensenova: SenseNova API error 429 — rate limited；SenseNova API 返回 429：请求被限流", LLM_CODES.rateLimit, {
			status: 429,
			...providerRetryAfterMs !== void 0 ? { providerRetryAfterMs } : {}
		});
	}
	if (anthropicType === ANTHROPIC_OVERLOADED) return new LlmError(`llm-sensenova: SenseNova API error 529 overloaded；SenseNova 返回 overloaded_error：服务端过载，重试通常可恢复`, QUOTA_CODES.server, { status });
	if (anthropicType !== void 0 && ANTHROPIC_AUTH.has(anthropicType)) return new LlmError("llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效", LLM_CODES.invalidCredential, { status });
	if (status >= 500) return new LlmError(`llm-sensenova: SenseNova API error ${status}: ${errText.slice(0, 500)}`, QUOTA_CODES.server, { status });
	return new LlmError(`llm-sensenova: SenseNova API error ${status}: ${errText.slice(0, 500)}`, LLM_CODES.providerHttpError, { status });
}
/**
* 跨实例目录种子（模块级，2026-10-27）：重注册（思考/勾选保存触发的签名重建）
* 会新建适配器实例，实例级缓存从零开始——不播种则每次重建后的首个 listModels
* 必打 /v1/models（HTTP 秒级），DSH 目录重建窗口拉长到会话超时（真机：
* `session/model-unavailable: The operation was aborted due to timeout`）。
* 成功拉取的最新目录落在这里；新实例冷启动时同凭据同端点且未过期即认领，
* 重建零网络、零窗口。只作种子：TTL/失败退避判定仍在实例内照常走。
*/
let catalogSeed;
/** SenseNova（OpenAI 兼容）适配器。 */
var SensenovaAdapter = class extends LlmAdapter {
	deps;
	fetchImpl;
	gate;
	catalog = [];
	/** 进程内失败缓存：运行时返回 MODEL_NOT_FOUND 的模型 id。 */
	failedModels = /* @__PURE__ */ new Set();
	/** §5.3 运行时不符兜底：Responses 400 invalid_request_error 的模型 id（进程内，
	* 不持久化；命中后 resolveWirePlan 第 4 条判定直接降级 Chat）。 */
	responsesUnsupported = /* @__PURE__ */ new Set();
	/** 同上机制用于 Anthropic wire：400 invalid_request_error 后该模型降级 Responses。 */
	anthropicUnsupported = /* @__PURE__ */ new Set();
	/** 上一次成功目录请求使用的 key/base；变化时旧失败缓存不再可信。 */
	catalogCredential;
	catalogApiBase;
	/** 目录缓存时间戳（毫秒 epoch）；与 TTL 共同决定下次调用是否实发 HTTP。 */
	catalogFetchedAt = 0;
	/** 目录刷新失败后的下次重试时间（毫秒 epoch）；仅失败时写入。 */
	catalogNextRetryAt = 0;
	/** 本段失败退避期内「空缓存补发一次」是否已用掉（语义见 catalog-gate.ts）。 */
	catalogEmptyRetryUsed = false;
	/** 目录单飞去重：并发的 listModels 共享同一 in-flight Promise。 */
	catalogInflight;
	/**
	* 配额类 429 粘住 key（design D5，仅 quotaRotation 开启时读写）：
	* 有 sessionId 的请求按会话分桶（同一会话后续请求粘住切换后的 key）；
	* 无 sessionId 的请求共享进程级桶（undefined 键）——宿主 GenerateOptions
	* 仅提供 sessionId 这一会话标识，粘性粒度即「会话（无标识时为进程）」，
	* 与 spec「同一会话后续请求继续使用新 key」对齐。条目仅存内存，随适配器
	* 生命周期结束。
	*/
	/** 会话→quota 轮换粘住的 key（design D5）。生命周期：轮换时 set、**成功时 delete**
	* （拐杖只为扛过 429 期；成功后下一请求回池层选 key，商汤组由亲和表保持粘性——
	* 2026-11-03 U4 顺带②B 拍板）、有界 QUOTA_STICKY_KEYS_MAX。 */
	quotaStickyKeys = /* @__PURE__ */ new Map();
	/**
	* 配额类 429 连续命中计数（per-session，分级退避用）：每次 stream() 调用至多 +1
	* （入口快照、finally 推进），成功清零，决定下次退避档位
	* PROBE_BACKOFF_STEPS_MS[count]（3/5/10/15/30s）。仅内存，随适配器生命周期。
	*/
	probeHitCounts = /* @__PURE__ */ new Map();
	/**
	* 429 轨迹账本（per-session，纯诊断）：同一逻辑请求跨宿主重试吃过的 key
	* （原文，打印时 maskKey）。每次 429 追加当前 key（去重），成功即清。
	* 「已试 N/M 把」从此按跨重试的实况计——单跳的 key= 字段只看得到当次。
	* 仅内存，随适配器生命周期；容量天然有界（≤ 会话数 × 池大小）。
	*/
	session429Trail = /* @__PURE__ */ new Map();
	constructor(deps) {
		super();
		this.deps = deps;
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.gate = deps.concurrencyGate ?? new KeyedConcurrencyGate();
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "SenseNova"
		};
	}
	providerRetryPolicy(_provider) {
		return resolveRetryPolicy({
			mode: "normal",
			maxRetries: 10,
			retryableCodes: retryableCodes(),
			backoff: { maxDelayMs: PROVIDER_RETRY_AFTER_CAP_MS }
		}, "dsh-sensenova-suite.retryPolicy");
	}
	async listModels(provider) {
		const models = await this.fetchCatalog();
		const filter = this.deps.catalogFilter?.();
		const allowed = (set) => (m) => set.size === 0 || set.has(m.id);
		const keep = (m) => {
			if (this.failedModels.has(m.id)) return false;
			if (filter === void 0) return true;
			return allowed(new Set(filter.enabledIds))(m) && !filter.unavailableIds.includes(m.id);
		};
		const checked = new Set(this.deps.visionModelIds?.() ?? []);
		return models.filter(keep).map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			...checked.has(model.id) ? { inputModalities: IMAGE_INPUT_MODALITIES } : {}
		}));
	}
	/**
	* 目录获取入口（listModels 专用）：TTL 内从缓存应答，过期后单飞实发 HTTP。
	* 成功刷新 TTL=CATALOG_TTL_MS（24h）；失败退避 CATALOG_FAILURE_RETRY_MS（60s）
	* 并维持旧缓存可读，避免宿主秒级问询在故障时退化为秒级重试循环。
	* 凭据或 apiBase 变化立即失效（换 key/换端点后旧目录不再可信）。
	*/
	async fetchCatalog() {
		const connection = this.deps.options();
		let apiKey;
		try {
			apiKey = await this.deps.resolveApiKey(connection);
		} catch (error) {
			if (error instanceof LlmError && error.code === "MISSING_CREDENTIAL") return [];
			throw error;
		}
		const now = Date.now();
		if (this.catalogFetchedAt === 0 && catalogSeed !== void 0 && catalogSeed.credential === apiKey && catalogSeed.apiBase === connection.apiBase) {
			this.catalog = catalogSeed.entries;
			this.catalogCredential = catalogSeed.credential;
			this.catalogApiBase = catalogSeed.apiBase;
			this.catalogFetchedAt = catalogSeed.fetchedAt;
		}
		const seed = catalogSeed;
		const gate = planCatalogFetch({
			cachedEntries: this.catalog.length,
			fetchedAt: this.catalogFetchedAt,
			nextRetryAt: this.catalogNextRetryAt,
			emptyRetryUsed: this.catalogEmptyRetryUsed
		}, {
			now,
			credential: apiKey,
			apiBase: connection.apiBase,
			cacheCredential: this.catalogCredential,
			cacheApiBase: this.catalogApiBase,
			seed
		});
		if (gate.action === "serve-cache") return this.catalog;
		if (gate.action === "serve-seed") {
			if (seed !== void 0) {
				this.catalog = seed.entries;
				this.catalogCredential = apiKey;
				this.catalogApiBase = connection.apiBase;
				this.catalogFetchedAt = seed.fetchedAt;
			}
			return this.catalog;
		}
		if (gate.action === "serve-empty") return this.catalog;
		this.catalogEmptyRetryUsed = gate.action === "send-forced";
		if (this.catalogInflight !== void 0) return this.catalogInflight;
		const inflight = this.fetchCatalogUncached(connection, apiKey, gate.invalidateFailedModels);
		this.catalogInflight = inflight;
		inflight.then(() => {
			this.catalogInflight = void 0;
		}, () => {
			this.catalogInflight = void 0;
			this.catalogNextRetryAt = Date.now() + CATALOG_FAILURE_RETRY_MS;
		});
		return inflight;
	}
	/** 实际发起 HTTP 目录请求并更新缓存（仅 fetchCatalog 调用）。 */
	async fetchCatalogUncached(connection, apiKey, invalidateFailedModels) {
		const response = await this.fetchImpl(`${connection.apiBase}/models`, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${apiKey}`,
				...attributionHeaders()
			},
			signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
		});
		if (response.status === 401) throw new LlmError("llm-sensenova: SenseNova API rejected the API key (401)", LLM_CODES.invalidCredential, { status: 401 });
		if (!response.ok) throw new LlmError(`llm-sensenova: models endpoint returned HTTP ${response.status}`, LLM_CODES.providerHttpError, { status: response.status });
		let parsed;
		try {
			parsed = await response.json();
		} catch (error) {
			throw new LlmError(`llm-sensenova: models endpoint returned non-JSON body（代理错误页/网关 HTML？）；SenseNova 目录响应不是合法 JSON`, LLM_CODES.providerProtocolError, { cause: error });
		}
		if (invalidateFailedModels) this.failedModels.clear();
		const models = parseCatalog(parsed, this.failedModels);
		this.catalogCredential = apiKey;
		this.catalogApiBase = connection.apiBase;
		this.catalogFetchedAt = Date.now();
		this.catalog = models;
		catalogSeed = {
			credential: apiKey,
			apiBase: connection.apiBase,
			fetchedAt: this.catalogFetchedAt,
			entries: models
		};
		return models;
	}
	async resolveModel(provider, model, _signal) {
		const entry = withUserThinking(this.catalog.find((m) => m.id === model), model, this.deps.thinkingOverrides?.());
		const contextWindow = contextWindowForId(model, entry?.contextWindow, this.deps.contextWindowOverrides?.());
		const maxTokens = maxTokensForId(model, entry?.maxOutputTokens, this.deps.maxTokensOverrides?.());
		const checked = this.deps.visionModelIds?.().includes(model) === true;
		return {
			provider,
			id: model,
			name: entry?.name ?? displayNameFor(model),
			...checked ? { inputModalities: IMAGE_INPUT_MODALITIES } : {},
			context: { contextWindow },
			...maxTokens !== void 0 ? { defaultMaxTokens: maxTokens } : {},
			...entry?.reasoning !== void 0 ? { reasoning: entry.reasoning } : {}
		};
	}
	/**
	* 4 轮轮询的「新一轮起点」：走池层 pickStart（商汤组亲和 key 恒第一、
	* 通用组游标推进）。返回 undefined = 池里没有可用 key（池空或该组全标）。
	* 缺省缝未接时退回 undefined（调用方按「无可用 key」收尾）。
	*/
	async pickRoundStart(options, excludeStart) {
		if (this.deps.pickStartKeyForRequest === void 0) return void 0;
		try {
			return await this.deps.pickStartKeyForRequest({
				sessionId: options.sessionId,
				model: options.model,
				...excludeStart !== void 0 ? { excludeStart } : {}
			});
		} catch {
			return;
		}
	}
	async *stream(options) {
		const connection = this.deps.options();
		const releaseSlot = this.deps.requestSlot !== void 0 ? await this.deps.requestSlot(options.signal) : void 0;
		const catalogEntry = this.catalog.find((m) => m.id === options.model);
		const entry = withUserThinking(this.deps.visionModelIds?.().includes(options.model) === true ? catalogEntry ?? {
			id: options.model,
			name: displayNameFor(options.model),
			inputModalities: IMAGE_INPUT_MODALITIES
		} : catalogEntry, options.model, this.deps.thinkingOverrides?.());
		const facts = factsFor(options.model, entry);
		const plan = resolveWirePlan(options, connection, facts, {
			responsesUnsupported: this.responsesUnsupported,
			anthropicUnsupported: this.anthropicUnsupported
		}, this.deps.protocolOverrides?.()[options.model]);
		let wire = plan.wire;
		let bridgedMessages = options.messages;
		if (this.deps.imageSwapper !== void 0 && Array.isArray(bridgedMessages)) {
			bridgedMessages = await this.deps.imageSwapper(bridgedMessages, { model: options.model });
			if (bridgedMessages.some((message) => contentHasImage$1(message.content))) traceLog(`[dsh-sensenova-suite] 图片桥: 换图后消息仍携带图片块（勾选=预期原生；未勾选=转述关闭或块无附件引用）`);
		}
		const projectedMessages = facts.supportsImages ? bridgedMessages : projectImagesForTextModel(bridgedMessages);
		const request = {
			...options,
			messages: [...projectedMessages]
		};
		const imagePayloads = /* @__PURE__ */ new Map();
		const payloadsFor = async (w) => {
			let payloads = imagePayloads.get(w);
			if (payloads === void 0) {
				payloads = await prepareImages(request, entry, w, this.deps.resolveImageAccess);
				imagePayloads.set(w, payloads);
			}
			return payloads;
		};
		const buildBody = async (w) => JSON.stringify(w === "anthropic" ? buildAnthropicBody(request, entry, await payloadsFor(w)) : w === "responses" ? buildResponsesBody(request, entry, { reasoningSummary: connection.reasoningSummary }, await payloadsFor(w)) : buildChatBody(request, entry, await payloadsFor(w)));
		let body = await buildBody(wire);
		let responsesFallbackUsed = false;
		let unclassifiedFallbackUsed = false;
		const tried = /* @__PURE__ */ new Set();
		const limit = connection.concurrency;
		const connectMs = this.deps.timeouts?.connectMs ?? 45e3;
		const streamIdleMs = this.deps.timeouts?.streamIdleMs ?? 6e4;
		const queueMs = this.deps.timeouts?.queueMs;
		const quotaRotation = connection.quotaRotation === true;
		let apiKey = (quotaRotation ? this.quotaStickyKeys.get(options.sessionId) : void 0) ?? (this.deps.resolveApiKeyForRequest !== void 0 ? await this.deps.resolveApiKeyForRequest({
			sessionId: options.sessionId,
			model: options.model
		}) : await this.deps.resolveApiKey(connection));
		let response;
		let release;
		const connectCleanups = [];
		const entryProbeHits = this.probeHitCounts.get(options.sessionId) ?? 0;
		const entryProbeFloorMs = probeFloorFor(entryProbeHits);
		let probeHitThisCall = false;
		let probeResetBySuccess = false;
		let round = 1;
		const MAX_POLL_ROUNDS = 3;
		/** 第 4 轮（等待之后的那一轮）——不再有任何等待。 */
		const FINAL_ROUND = 4;
		/** 累计上游尝试次数（日志与收尾行用）。 */
		let totalAttempts = 1;
		let roundStartKey = apiKey;
		try {
			for (;;) {
				tried.add(apiKey);
				try {
					release = await this.gate.acquire(apiKey, limit, options.signal, queueMs);
				} catch (error) {
					if (!isTimeoutReason(error)) throw error;
					traceLog(`[dsh-sensenova-suite] 并发闸排队超时 model=${options.model} key=${maskKey(apiKey)} 等=${Math.round((queueMs ?? 9e4) / 1e3)}s——交宿主重试层退避后重试`);
					throw new LlmError(`llm-sensenova: request queued behind the per-key concurrency limit for over ${queueMs ?? 9e4}ms；SenseNova 请求排队超时（未占用并发额度），交宿主重试层退避后重试`, LLM_CODES.timeout, { cause: error });
				}
				let attempt;
				try {
					const connectController = new AbortController();
					const connectTimer = setTimeout(() => {
						connectController.abort(new DOMException("connect timed out", "TimeoutError"));
					}, connectMs);
					const onHostAbort = () => connectController.abort(options.signal?.reason);
					if (options.signal !== void 0) {
						if (options.signal.aborted) connectController.abort(options.signal.reason);
						else options.signal.addEventListener("abort", onHostAbort, { once: true });
					}
					connectCleanups.push(() => {
						clearTimeout(connectTimer);
						options.signal?.removeEventListener("abort", onHostAbort);
					});
					attempt = await this.fetchImpl(`${connection.apiBase}${endpointOf(wire)}`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${apiKey}`,
							...attributionHeaders()
						},
						body,
						signal: connectController.signal
					});
					clearTimeout(connectTimer);
				} catch (error) {
					release();
					release = void 0;
					if (options.signal?.aborted) throw error;
					if (isTimeoutReason(error)) throw new LlmError(`llm-sensenova: request to ${connection.apiBase} timed out after ${connectMs}ms；SenseNova 请求建连或首包超时（已释放并发额度），交宿主重试层处理`, LLM_CODES.timeout, { cause: error });
					throw new LlmError(`llm-sensenova: request to ${connection.apiBase} failed: ${errorChain(error)}；连接 SenseNova API 失败，通常是网络或代理问题`, LLM_CODES.transport, { cause: error });
				}
				if (attempt.ok) {
					response = attempt;
					const priorHits = this.probeHitCounts.get(options.sessionId);
					const trailLen = this.session429Trail.get(options.sessionId)?.length ?? 0;
					if (priorHits !== void 0 || trailLen > 0) traceLog(`[dsh-sensenova-suite] 429 恢复 model=${options.model} key=${maskKey(apiKey)} ` + (priorHits !== void 0 ? "连续限流结束，探测档归零" : `连续 ${trailLen} 次限流后成功`));
					this.probeHitCounts.delete(options.sessionId);
					this.session429Trail.delete(options.sessionId);
					this.quotaStickyKeys.delete(options.sessionId);
					probeResetBySuccess = true;
					this.deps.reportOutcome?.(apiKey, "success");
					break;
				}
				const errText = await attempt.text().catch(() => "");
				const retryAfterMs = parseRetryAfterMs(attempt.headers.get("retry-after"));
				if (attempt.status === 400) traceLog(`[dsh-sensenova-suite] ${wire} wire 400 sid=${options.sessionId ?? "-"} model "${options.model}" body: ${errText.slice(0, 400)}`);
				const hopIndex = plan.chain.indexOf(wire);
				const nextWire = (hopIndex >= 0 && hopIndex + 1 < plan.chain.length ? plan.chain[hopIndex + 1] : void 0) ?? (wire === "chat-completions" ? void 0 : "chat-completions");
				if (attempt.status === 400 && nextWire !== void 0 && !responsesFallbackUsed && isInvalidRequestError(errText)) {
					if (wire === "anthropic") this.anthropicUnsupported.add(options.model);
					else if (wire === "responses") this.responsesUnsupported.add(options.model);
					traceLog(`[dsh-sensenova-suite] ${wire} wire rejected model "${options.model}" with 400 invalid_request_error; falling back to ${nextWire} for this and subsequent requests in this process`);
					wire = nextWire;
					body = await buildBody(wire);
					responsesFallbackUsed = true;
					release();
					release = void 0;
					continue;
				}
				if (attempt.status === 404 && isModelNotFoundText(errText)) {
					release();
					release = void 0;
					this.failedModels.add(options.model);
					this.catalogFetchedAt = 0;
					throw httpError(attempt.status, errText, retryAfterMs, void 0, wire);
				}
				const classified = classify429Body(errText);
				const full = classify429Full(errText);
				const quota429 = attempt.status === 429 && classified.quota;
				const pool429 = attempt.status === 429 && !classified.quota && full.kind === "pool";
				let dynamicFloorMs;
				if (classified.quota) {
					dynamicFloorMs = entryProbeFloorMs;
					probeHitThisCall = true;
				}
				const trail429 = this.session429Trail.get(options.sessionId) ?? [];
				if (!trail429.includes(apiKey)) trail429.push(apiKey);
				this.session429Trail.set(options.sessionId, trail429);
				traceLog(`[dsh-sensenova-suite] 429 model=${options.model} key=${maskKey(apiKey)} kind=${pool429 ? "pool" : classified.quota ? classified.kind : "unknown"} bucket=${full.bucket ?? "-"} round=${round}/${FINAL_ROUND} 退避=${dynamicFloorMs !== void 0 ? `${Math.round(dynamicFloorMs / 1e3)}s` : retryAfterMs !== void 0 ? `${Math.round(retryAfterMs / 1e3)}s(retry-after)` : "宿主默认"} body=${summarize429Body(errText)}`);
				const quotaRotate = (quota429 || pool429) && quotaRotation;
				if ((attempt.status === 401 || quotaRotate) && options.signal?.aborted !== true) {
					const next = await this.deps.rotateApiKey(apiKey, attempt.status === 401 ? "invalid-credential" : pool429 ? "pool-exhausted" : bucketCountsStrike(full.bucket) ? "quota-exhausted" : "rate-soft", options.model, tried);
					if (next !== void 0 && !tried.has(next)) {
						release();
						release = void 0;
						const previousKey = apiKey;
						apiKey = next;
						totalAttempts += 1;
						traceLog(`[dsh-sensenova-suite] 429 换 key model=${options.model} ${maskKey(previousKey)} → ${maskKey(next)}（轮 ${round}/${FINAL_ROUND}，本轮已试 ${tried.size} 把，累计 ${totalAttempts} 次）`);
						if (quotaRotate) {
							if (!this.quotaStickyKeys.has(options.sessionId) && this.quotaStickyKeys.size >= QUOTA_STICKY_KEYS_MAX) {
								const oldest = this.quotaStickyKeys.keys().next().value;
								if (oldest !== void 0) this.quotaStickyKeys.delete(oldest);
							}
							this.quotaStickyKeys.set(options.sessionId, next);
						}
						continue;
					}
				}
				if (shouldRotateUnclassified(attempt.status, quota429 || pool429) && options.signal?.aborted !== true && (attempt.status === 429 || !unclassifiedFallbackUsed)) {
					const next = await this.deps.rotateApiKey(apiKey, "rate-unclassified", options.model, tried);
					if (next !== void 0 && !tried.has(next)) {
						release();
						release = void 0;
						const previousKey = apiKey;
						apiKey = next;
						totalAttempts += 1;
						if (attempt.status !== 429) unclassifiedFallbackUsed = true;
						traceLog(`[dsh-sensenova-suite] 未分类失败换 key model=${options.model} status=${attempt.status} ${maskKey(previousKey)} → ${maskKey(next)}（${attempt.status === 429 ? "本请求内轮满池" : "仅兜底一次"}，轮 ${round}/${FINAL_ROUND}，累计 ${totalAttempts} 次）`);
						continue;
					}
				}
				const allPoolMarked = attempt.status === 429 && this.deps.poolFullyMarked?.(options.model) === true;
				if (attempt.status === 429 && !allPoolMarked && round < FINAL_ROUND) {
					if (round === MAX_POLL_ROUNDS) {
						const waitMs = JITTER_WAIT_MIN_MS + Math.floor(Math.random() * 5e3);
						traceLog(`[dsh-sensenova-suite] 429 轮间等待 model=${options.model} ${Math.round(waitMs / 100) / 10}s（${MAX_POLL_ROUNDS} 轮全 429，抖动等待后进第 ${FINAL_ROUND} 轮）`);
						release?.();
						release = void 0;
						await abortableSleep(waitMs, options.signal);
						if (options.signal?.aborted === true) throw options.signal.reason;
					}
					round += 1;
					tried.clear();
					release?.();
					release = void 0;
					const nextStart = await this.pickRoundStart(options, roundStartKey);
					if (nextStart === void 0) {
						traceLog(`[dsh-sensenova-suite] 429 轮 ${round} 无可用 key model=${options.model}（池空或该组全标）`);
						throw httpError(attempt.status, errText, retryAfterMs, dynamicFloorMs, wire, allPoolMarked);
					}
					apiKey = nextStart;
					roundStartKey = nextStart;
					tried.add(apiKey);
					traceLog(`[dsh-sensenova-suite] 429 进入第 ${round}/${FINAL_ROUND} 轮 model=${options.model} 起点 key=${maskKey(apiKey)}`);
					continue;
				}
				if (attempt.status === 429) {
					const label = allPoolMarked ? `429 该组全池耗尽（${round} 轮终止）` : quota429 || pool429 ? quotaRotation ? `429 ${round} 轮换无可换` : "429 未轮换（quotaRotation 未开）" : totalAttempts > 1 ? `429 未识别形状，已换 ${totalAttempts - 1} 次 key` : "429 未识别形状，无可轮换";
					traceLog(`[dsh-sensenova-suite] ${label} model=${options.model} 已试 ${trail429.map((key) => maskKey(key)).join("/")} 共 ${trail429.length} 把、${totalAttempts} 次，${allPoolMarked ? "抛 QUOTA（宿主不重试）" : "交宿主重试层（预算内自动重试）"}`);
				}
				release();
				release = void 0;
				throw httpError(attempt.status, errText, retryAfterMs, dynamicFloorMs, wire, allPoolMarked);
			}
			if (response === void 0) throw new LlmError("llm-sensenova: SenseNova API returned no response", LLM_CODES.providerProtocolError);
			if (response.body === null) throw new LlmError("llm-sensenova: SenseNova API returned no response body", LLM_CODES.providerProtocolError);
			if (wire === "anthropic") try {
				yield* parseAnthropicSse(response.body, options.signal, streamIdleMs, options.model, options.sessionId);
			} catch (error) {
				if (error instanceof LlmError && error.code === "ANTHROPIC_TRUNCATED" && !this.anthropicUnsupported.has(options.model)) {
					this.anthropicUnsupported.add(options.model);
					traceLog(`[dsh-sensenova-suite] anthropic 流断尾（无 message_stop）model="${options.model}" stop=${options.stop?.length ?? 0}——本进程内标记该模型 anthropic 线不支持，后续请求走生效链下一跳（重启清除）`);
				}
				throw error;
			}
			else if (wire === "responses") yield* parseResponsesSse(response.body, options.signal, streamIdleMs, options.model, options.sessionId);
			else yield* parseOpenAiSse(response.body, options.signal, streamIdleMs, options.model, options.sessionId);
		} finally {
			for (const cleanup of connectCleanups) cleanup();
			release?.();
			releaseSlot?.();
			if (probeHitThisCall && !probeResetBySuccess) this.probeHitCounts.set(options.sessionId, entryProbeHits + 1);
		}
	}
};

//#endregion
//#region src/host/llm-adapter.ts
/**
* The peer-dependent half of the suite's LLM provider — the WIRE adapter
* factory.
*
* Replaces the former pi-ai assembly module (retired with step 3): the
* registered adapter is the ported `SensenovaAdapter` from
* the wire implementation, speaking anthropic / responses / chat-completions
* directly against the SenseNova gateway with the symmetric downgrade chain.
* Everything pool-related (multi-account rotation, session affinity by credit
* group, the (key, group) pool-429 grid, the global in-flight cap, probe
* recovery) lives in `key-orchestrator.ts` and is handed in here as one
* object; this module only wires the two together into the
* `{ adapter, providerIds }` shape the publish chain registers.
*
* Peer-dependent by design (like its predecessor): it imports
* `@deepseek-ai/dsh-llm` statically, so the offline suites substitute a fake
* factory through `deps.loadAdapterModule` and never load this file.
*
* @module dsh-sensenova-suite/llm-adapter
*/
/**
* Build the factory the publish chain calls (`createSensenovaAdapter`).
*
* The publish chain hands `{ entries, enabledIds, baseUrl,
* unavailableModelIds, maxTokensOverrides }`; with the wire adapter the
* catalog is the adapter's own (`fetchCatalog` → GET {apiBase}/models), so
* `entries` is unused and the allow-list / quota-mark semantics ride the
* `catalogFilter` seam instead. The old `resolveApiKey`/`get` build args are
* GONE (2026-10-31 cleanup): the key is resolved per request by the pool and
* services come from the Host, so the args had no reader. `maxTokensOverrides`
* IS live: it rides the adapter deps and resolveModel resolves the request
* ceiling from it (`maxTokensForId`, override > catalogue figure — the same
* order the panel roster quotes).
*
* @param {PoolFacade} pool - the orchestrator facade from `index.ts`.
* @returns {(args: object) => Promise<{adapter: unknown, providerIds: string[]}>}
*   the async factory matching the publish chain's await-and-shape-check.
*/
function createAdapterFactory(pool) {
	const { orchestrator } = pool;
	return async function createSensenovaAdapter({ baseUrl, enabledIds, unavailableModelIds, maxTokensOverrides, contextWindowOverrides }) {
		const apiBase = typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : "https://token.sensenova.cn/v1";
		const enabled = Array.isArray(enabledIds) ? enabledIds.filter((id) => typeof id === "string") : [];
		const unavailable = Array.isArray(unavailableModelIds) ? unavailableModelIds.filter((id) => typeof id === "string") : [];
		return {
			adapter: new SensenovaAdapter({
				options: () => ({
					apiBase,
					accountCount: (() => {
						const live = orchestrator.snapshot();
						return Math.max(1, live.running.length + live.blocked.length);
					})(),
					concurrency: 1,
					quotaRotation: true,
					wireProtocol: "auto",
					reasoningSummary: "auto"
				}),
				resolveApiKey: async () => {
					try {
						return (await orchestrator.pickStart({ model: "" })).key;
					} catch {
						throw new LlmError("dsh-sensenova-suite: no usable SenseNova API key (pool empty)", "MISSING_CREDENTIAL");
					}
				},
				resolveApiKeyForRequest: async (request) => {
					try {
						return (await orchestrator.pickStart(request)).key;
					} catch {
						throw new LlmError("dsh-sensenova-suite: no usable SenseNova API key (pool empty)", "MISSING_CREDENTIAL");
					}
				},
				pickStartKeyForRequest: async (request) => {
					try {
						return (await orchestrator.pickStart(request)).key;
					} catch {
						return;
					}
				},
				poolFullyMarked: (model) => orchestrator.groupFullyPoolMarked(orchestrator.groupOf(model)),
				requestSlot: async (signal) => orchestrator.acquireSlot(signal),
				rotateApiKey: async (rejectedKey, rejection, model, roundExclude) => {
					const group = orchestrator.groupOf(model);
					const exclude = roundExclude !== void 0 ? /* @__PURE__ */ new Set([...roundExclude, rejectedKey]) : /* @__PURE__ */ new Set([rejectedKey]);
					if (rejection === "invalid-credential") {
						orchestrator.reportAuthRejected(rejectedKey);
						return orchestrator.pickNext(exclude, group, { borrow: false });
					}
					orchestrator.noteLimited(rejectedKey, group);
					if (orchestrator.sustainedLimited(rejectedKey)) {
						orchestrator.reportPoolExhausted(rejectedKey, group);
						if (orchestrator.groupFullyPoolMarked(group)) return void 0;
						return orchestrator.pickNext(exclude, group, { borrow: false });
					}
					if (rejection === "pool-exhausted") {
						orchestrator.reportPoolExhausted(rejectedKey, group);
						if (orchestrator.groupFullyPoolMarked(group)) return void 0;
						return orchestrator.pickNext(exclude, group, { borrow: false });
					}
					if (rejection !== "rate-unclassified" && rejection !== "rate-soft") orchestrator.reportRateLimited(rejectedKey);
					return orchestrator.pickNext(exclude, group, { borrow: false });
				},
				reportOutcome: (key) => orchestrator.reportSuccess(key),
				catalogFilter: () => ({
					enabledIds: enabled,
					unavailableIds: unavailable
				}),
				...pool.visionSwapper !== void 0 ? { imageSwapper: pool.visionSwapper } : {},
				...pool.resolveImageAccess !== void 0 ? { resolveImageAccess: pool.resolveImageAccess } : {},
				...pool.visionModelIds !== void 0 ? { visionModelIds: pool.visionModelIds } : {},
				protocolOverrides: () => pool.protocolOverrides(),
				thinkingOverrides: () => pool.thinkingOverrides(),
				maxTokensOverrides: () => maxTokensOverrides ?? null,
				contextWindowOverrides: () => contextWindowOverrides ?? null
			}),
			providerIds: [LLM_PROVIDER_ID]
		};
	};
}

//#endregion
export { createAdapterFactory };