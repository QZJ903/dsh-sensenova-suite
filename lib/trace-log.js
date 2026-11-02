import { dirname } from "node:path";
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";

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
* 池类 429 的响应体特征（Allocated quota exceeded，provider-config docs 实测形态）。
*
* `insufficient_quota` 曾按名字列在这里，2026-10-31 依上游 freeapi 订正移出：它
* 命名像「配额耗尽」、实为 tpm/rpm 速率限流（freeapi adapter.ts 明写「命名误导：
* message 同为 tpm/rpm 限流」），归池类会把速率窗误记成 (key,组) 积分格——组内
* 全中招时还会错误触发「换无可换」快速失败，而实测换 key 能绕开。现按 code 归
* tpm 档（classify429Body 的 string-code 分支）。
*/
const POOL_EXHAUSTED_MARKERS = ["allocated quota exceeded", "quota exceeded for the current window"];
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
function isRecord(value) {
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
	if (!isRecord(parsed) || !isRecord(parsed.error)) return none;
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
			kind: "tpm",
			bucket: "tpm"
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
* - 池类特征串（大小写不敏感）→ pool / 无桶（记格子，走独立的 QUOTA 出口）
* - 其余未知形态 → unknown / 无桶（兜底按 rate 处理：轮转+可重试；宿主 maxRetries
*   封顶；不计数——形状不明时判死一把 key 太武断）
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
	const lower = bodyText.toLowerCase();
	if (POOL_EXHAUSTED_MARKERS.some((marker) => lower.includes(marker))) return {
		kind: "pool",
		bucket: void 0,
		retryFloorMs: probeFloorFor(0)
	};
	return {
		kind: "unknown",
		bucket: void 0,
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
//#region src/host/trace-log.ts
/**
* Host-side diagnostic lines → a real file (companion exit of console.warn).
*
* 桌面主进程把宿主半区（插件所在进程）的 stdout/stderr 管道接管，只在崩溃时
* 落一份 crash-host.log——终端里永远看不到插件的 `[dsh-sensenova-suite]` 诊断行
* （2026-10-27 图片链路排查实测：终端启动也只有主进程自己的行）。本模块让所有
* 诊断行在保留 console 出口的同时同步追加进 `<状态目录>/dsh-sensenova-suite.log`
* （与 pool.json 同目录），`Get-Content -Wait` 它即可排障。
*
* 设计约束：
* - 日志永不抛错：sink 挂了/磁盘满/目录缺失静默丢弃（打开失败退化为纯 console）
*   ——诊断失败不能反过来打断请求路径；
* - 无配置字段：路径由状态目录派生，无开关（配置字段要少）；
* - 时间戳只加在文件行上，console 行逐字保持原样（不扰动既有消费者）；
* - 轮转只在打开时做一次（>2MB 改名 .old）：行量是诊断级的，运行中不轮转。
*
* @module dsh-sensenova-suite/trace-log
*/
/** 单文件上限：超过则启动时轮转为 .old（保留上一份供回看）。 */
const TRACE_MAX_BYTES = 2097152;
/** UTF-8 BOM 字节序列：无 BOM 的 UTF-8 会被 PowerShell 5.1 按 ANSI（GBK）解码。 */
const UTF8_BOM_BYTES = Buffer.from([
	239,
	187,
	191
]);
/** 文件首写的 BOM 字符（文本形态，与 UTF8_BOM_BYTES 同值）。 */
const UTF8_BOM = "﻿";
let sink;
/** 接线点（index.ts 启动时调用一次）；传 undefined 恢复纯 console。 */
function setTraceSink(next) {
	sink = next;
}
/**
* 诊断行唯一出口：console.warn 原样 + 文件追加（带 ISO 时间戳，永不抛）。
* 插件内一切 `[dsh-sensenova-suite]` 行都走这里，别再直接调 console。
*/
function traceLog(line) {
	console.warn(line);
	try {
		sink?.(`${(/* @__PURE__ */ new Date()).toISOString()} ${line}\n`);
	} catch {}
}
/**
* 打开日志文件（追加语义；超限先轮转 .old，不存在 = 全新文件）。返回追加器。
*
* 状态目录可能还不存在（全新安装 / 新 profile 首挂 / 用户清过 state 目录），
* 而下面的 BOM 首写没有父目录会 ENOENT——这里抛出去，`index.ts` 的 apply()
* 就在挂载中途崩掉、整插件下线，且 store 写点全在挂载之后，目录永远没人建，
* 每次启动同崩（2026-10-31 审计 U7-D1）。所以：先建目录；打开路径的任何一环
* 仍失败（只读 Home、磁盘满）都退化为 no-op sink——诊断文件缺席是可接受的
* 降级，不能反过来挡挂载。
*/
function openTraceFile(file) {
	try {
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		try {
			if (statSync(file).size > 2097152) renameSync(file, `${file}.old`);
		} catch {}
		let fresh = true;
		try {
			const head = Buffer.alloc(3);
			const fd = openSync(file, "r");
			try {
				readSync(fd, head, 0, 3, 0);
				fresh = !head.equals(UTF8_BOM_BYTES);
			} finally {
				closeSync(fd);
			}
			if (fresh) renameSync(file, `${file}.old`);
		} catch {
			fresh = true;
		}
		if (fresh) appendFileSync(file, UTF8_BOM);
	} catch {
		return () => {};
	}
	return (line) => {
		appendFileSync(file, line);
	};
}

//#endregion
export { extractText as a, bucketCountsStrike as c, parseRetryAfterMs as d, probeFloorFor as f, envelopeFail as i, classify429Body as l, setTraceSink as n, imagePart as o, traceLog as r, postChat as s, openTraceFile as t, classify429Full as u };