//#region src/host/vision/direct.ts
/**
* 直连路径：用 `fetch` 调用商汤 OpenAI 兼容 `chat/completions`。
*
* `redirect: 'error'`（凭据请求拒重定向）；超时用 `AbortSignal.timeout`。
* 单模型（用户选择）；HTTP 失败抛出的错误带 `status` 与 `body`，供上层把
* 429/401 按套件教义回池（run.ts 的 VisionFeedback）。
*
* 纯函数 + 可注入 `fetchImpl`。
*
* @module dsh-sensenova-suite/vision/direct
*/
/** chat-completions base URL 幂等追加。 */
function chatUrl(baseUrl) {
	const base = baseUrl.replace(/\/+$/, "");
	if (base.endsWith("/chat/completions") || base.endsWith("/llm/chat-completions")) return base;
	return `${base}/chat/completions`;
}
/** 构造一个图片内容部件。 */
function imagePart(imageRef, mode) {
	if (mode === "image_base64") {
		let raw = imageRef;
		if (raw.startsWith("data:") && raw.includes(";base64,")) raw = raw.slice(raw.indexOf(";base64,") + 8);
		if (raw.startsWith("http://") || raw.startsWith("https://")) throw new Error("image_base64 mode needs base64 bytes or a local file path, not an http URL");
		return {
			type: "image_base64",
			image_base64: raw
		};
	}
	return {
		type: "image_url",
		image_url: { url: imageRef }
	};
}
/** 从响应 JSON 提取文本。 */
function extractText(data) {
	const choices = data["choices"];
	if (Array.isArray(choices) && choices.length > 0) {
		const first = choices[0];
		if (typeof first === "object" && first !== null) {
			const message = first["message"];
			if (typeof message === "object" && message !== null) {
				const content = message["content"];
				if (typeof content === "string") return content;
			}
		}
	}
	throw new Error(`SenseNova API response had no choices[0].message.content; raw response: ${JSON.stringify(data).slice(0, 800)}`);
}
/**
* 一次 POST（server.py `_post_chat` 的 fetch 版）。HTTP 错误带状态码与响应体摘要；
* 网络/超时错误带原因。**凭据请求拒重定向**（`redirect: 'error'`）。
*/
async function postChat(options) {
	const url = chatUrl(options.apiBase);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`SenseNova request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${options.apiKey}`
			},
			body: JSON.stringify({
				model: options.model,
				messages: [{
					role: "user",
					content: options.content
				}]
			}),
			redirect: "error",
			signal: controller.signal
		});
		if (!response.ok) {
			const body = (await response.text()).slice(0, 800);
			const error = /* @__PURE__ */ new Error(`SenseNova API returned HTTP ${response.status} for ${url}: ${body}`);
			error.status = response.status;
			error.body = body;
			throw error;
		}
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}
/** 失败信封（MCP 兼容）。 */
function envelopeFail(taskType, error) {
	return {
		ok: false,
		task_type: taskType,
		error
	};
}

//#endregion
//#region src/host/rate-classify.ts
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
* rate-rps/rate-tpm → 计数踢出 + 换 key；pool → 记 (key, 组) 格子 + 换 key；
* auth(401) → 永久禁用。`retryFloorMs` 为 provider 实测退避下限（15s 覆盖速率桶
* ≈1 个/14s 的完整补充周期）。
*
* @module dsh-sensenova-suite/rate-classify
*/
/** 配额类（速率桶）429 退避下限（毫秒）。2026-09-04 实测：速率桶补充 ≈1 个/14s，
* 15s 覆盖一个完整补充周期。 */
const QUOTA_RATE_RETRY_FLOOR_MS = 15e3;
/**
* 429001 分级探测退避档位（毫秒）——2026-09-04 定稿：不设长固定下限（60s/180s 均会把
* 用户干锁在死等里），而是每次宿主重试各自重新探测，等待随连续 429001 次数递增
* 3s → 5s → 10s → 15s 后封顶（每轮重置、不继承：任一成功即清零）。
* 官方文档将 429 统一标注为 quota_exceeded_error 且建议「指数退避重试」，未公开数值；
* 实测 key A 30k 请求 429001、key B 同刻通过 → per-key 限速差异，短探测 + 换 key 优先。
*/
const TPM_PROBE_BACKOFF_STEPS_MS = [
	3e3,
	5e3,
	1e4,
	15e3
];
/** 池类 429 的响应体特征（Allocated quota exceeded，provider-config docs 实测形态）。 */
const POOL_EXHAUSTED_MARKERS = [
	"allocated quota exceeded",
	"quota exceeded for the current window",
	"insufficient_quota"
];
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* 解析 429 响应体并按 error.code 二分类（design D1，2026-09-04 实测）。
* 其余（含无 code、非 JSON 体、解析失败）归非配额类，维持现行短退避语义。
*/
function classify429Body(bodyText) {
	let parsed;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return {
			quota: false,
			retryFloorMs: void 0,
			kind: void 0
		};
	}
	if (!isRecord(parsed) || !isRecord(parsed.error)) return {
		quota: false,
		retryFloorMs: void 0,
		kind: void 0
	};
	const code = parsed.error.code;
	if (typeof code !== "number" && typeof code !== "string") return {
		quota: false,
		retryFloorMs: void 0,
		kind: void 0
	};
	if (code === 8 || code === "8") return {
		quota: true,
		retryFloorMs: QUOTA_RATE_RETRY_FLOOR_MS,
		kind: "rate"
	};
	if (code === 429001 || code === "429001") return {
		quota: true,
		retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0],
		kind: "tpm"
	};
	return {
		quota: false,
		retryFloorMs: void 0,
		kind: void 0
	};
}
/**
* 分类层的完整分类：响应体文本 → 四类 + 退避下限。
*
* - code 8 → rate-rps（15s 下限）
* - code 429001 → rate-tpm（3s 起分级）
* - 池类特征串（大小写不敏感）→ pool（15s 下限：池窗口分钟级自愈，硬重试无意义，
*   15s 只是「换完一圈 key 再回来看」的节奏）
* - 其余未知形态 → unknown（兜底按 rate 处理：轮转+可重试；宿主 maxRetries 封顶）
*/
function classify429Full(bodyText) {
	const byCode = classify429Body(bodyText);
	if (byCode.kind === "rate") return {
		kind: "rate-rps",
		retryFloorMs: byCode.retryFloorMs
	};
	if (byCode.kind === "tpm") return {
		kind: "rate-tpm",
		retryFloorMs: byCode.retryFloorMs
	};
	const lower = bodyText.toLowerCase();
	if (POOL_EXHAUSTED_MARKERS.some((marker) => lower.includes(marker))) return {
		kind: "pool",
		retryFloorMs: QUOTA_RATE_RETRY_FLOOR_MS
	};
	return {
		kind: "unknown",
		retryFloorMs: void 0
	};
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

//#endregion
export { parseRetryAfterMs as a, imagePart as c, classify429Full as i, postChat as l, TPM_PROBE_BACKOFF_STEPS_MS as n, envelopeFail as o, classify429Body as r, extractText as s, QUOTA_RATE_RETRY_FLOOR_MS as t };