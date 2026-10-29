import { S as staticFacts, T as maskKey, _ as contentHasImage$1, b as factsFor, d as inputModalitiesFor, i as LLM_PROVIDER_ID, n as KNOWN_UNROUTABLE_MODELS, u as IMAGE_INPUT_MODALITIES } from "./llm-models.js";
import { a as TPM_PROBE_BACKOFF_STEPS_MS, c as parseRetryAfterMs, i as QUOTA_RATE_RETRY_FLOOR_MS, o as classify429Body, r as traceLog, s as classify429Full } from "./trace-log.js";
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
//#region src/host/llm-retry.ts
/**
* The directly-registered SenseNova provider's 429 retry policy — the peer-FREE
* half of the 429 self-healing work.
*
* The *decision* (which failure classes this shared-pool provider retries, and
* how gently) is pure, so it lives here — importable on a clean checkout where
* the `@deepseek-ai/dsh-llm` peer is not resolvable — and is handed to the peer's
* `resolveRetryPolicy` from `llm-adapter.ts`. `test/retry.test.mjs` pins its
* shape without importing that peer.
*
* The peer classifies a SenseNova 429 into two codes (`isQuotaExceededError` →
* `rate.?limit` inside `classifyPiAiError`, pinned against the real source by
* `test/peer-contract.test.mjs`):
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
* The failure classes this provider retries, in peer-canonical order.
*
* Excludes both quota codes on purpose: a depleted pool cannot be retried into
* health, and retrying it against a shared credit pool only prolongs the
* cool-down. `RATE_LIMIT` stays — transient throttles self-clear.
* @returns {string[]} the retryable code list (no duplicates, non-empty).
*/
function retryableCodes() {
	return [
		QUOTA_CODES.emptyResponse,
		QUOTA_CODES.rateLimit,
		QUOTA_CODES.server,
		QUOTA_CODES.timeout,
		QUOTA_CODES.transport
	];
}

//#endregion
//#region src/host/concurrency.ts
/** 排队超时默认值（毫秒）。2026-09-04 实测：与 TPM 60s 窗口对齐（design D4/D6）。 */
const DEFAULT_QUEUE_TIMEOUT_MS = 6e4;
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
* （非法值回退默认 60s）则以可重试 TimeoutError reject，同样不占额度、从队列
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
*   「URL 总量 200MB」需要服务端字节信息，客户端无从测量，注记待实测（TODO）。
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
		effortDomain: catalogEfforts ?? staticDomain,
		noneMapsToThinkingDisabled: facts.noneMapsToThinkingDisabled
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
	let thinkingDisabled = false;
	if (options.reasoningEffort !== void 0) {
		const effort = canonicalThinkingEffort(options.reasoningEffort);
		if (plan.noneMapsToThinkingDisabled && effort === "none") thinkingDisabled = true;
		else if (effort !== void 0) {
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
		...reasoningEffortWire !== void 0 ? { reasoning_effort: reasoningEffortWire } : {},
		...thinkingDisabled ? { thinking: "disabled" } : {}
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
* - user 文本 → {role:'user',content:[{type:'input_text',text}]}；
* - assistant 文本 → {role:'assistant',content:[{type:'output_text',text}]}；
* - assistant tool-call → {type:'function_call',call_id,name,arguments}；
* - tool-result → {type:'function_call_output',call_id,output}。
*
* 坏历史 tool_call 四防御与 Chat 路径一致（tasks 2.1）：空 name 丢弃（含孤立
* tool-result）、arguments 空串补 '{}'、id 空串合成 sensenova-sanitized-N、
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
				const keptId = call.id !== "" && call.id !== void 0 ? call.id : `sensenova-sanitized-${syntheticToolCallSeq}`;
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
				role: "user",
				content: [{
					type: "input_text",
					text: content
				}]
			});
		} else if (content.length > 0) input.push({
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
		...thinkingDisabled ? { thinking: { type: "disabled" } } : {},
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
		inputTokens: input,
		outputTokens: output,
		totalTokens: total > 0 ? total : input + output,
		...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning > 0 ? { reasoningTokens: reasoning } : {}
	};
}

//#endregion
//#region src/host/wire/sse-responses.ts
/** Responses SSE → 宿主 StreamChunk 翻译（make-responses-default-wire-protocol 3.x；
* docs/sensenova-upgrade-plan.md §6.6）。
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
/** Anthropic usage → 宿主 TokenUsage（字段名与 Responses 不同：无 details 嵌套）。 */
function mapAnthropicUsage(usage) {
	const input = toNumber$1(usage.input_tokens) ?? 0;
	const output = toNumber$1(usage.output_tokens) ?? 0;
	const cacheRead = toNumber$1(usage.cache_read_input_tokens) ?? 0;
	const cacheWrite = toNumber$1(usage.cache_creation_input_tokens) ?? 0;
	return {
		inputTokens: Math.max(0, input - cacheRead),
		outputTokens: output,
		totalTokens: input + output,
		...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
		...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}
	};
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
/** 合并 usage（message_start 给全量，message_delta 给增量；后者覆盖前者同名字段）。 */
function mergeUsage(state, incoming) {
	const next = mapAnthropicUsage(incoming);
	if (state.usage === void 0) {
		state.usage = next;
		return;
	}
	const inputTokens = toNumber$1(incoming.input_tokens) !== void 0 ? next.inputTokens : state.usage.inputTokens;
	const outputTokens = toNumber$1(incoming.output_tokens) !== void 0 ? next.outputTokens : state.usage.outputTokens;
	state.usage = {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
		...next.cacheReadTokens !== void 0 ? { cacheReadTokens: next.cacheReadTokens } : {},
		...next.cacheWriteTokens !== void 0 ? { cacheWriteTokens: next.cacheWriteTokens } : {}
	};
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
			const serialized = input !== void 0 && JSON.stringify(input) !== "{}" ? JSON.stringify(input) : "";
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
		if (usage !== void 0) mergeUsage(state, usage);
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
			if (!state.messageStopped) throw new LlmError("llm-sensenova: SenseNova Anthropic stream ended before message_stop；SenseNova 流式响应在 message_stop 之前中断，重试通常可恢复", "TRANSPORT");
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
/** wire 协议决策（make-responses-default-wire-protocol §五 + add-anthropic-wire-protocol 降级链）。
*
* auto 模式的降级链（用户拍板）：
*
* ```
* anthropic → responses → chat-completions
* ```
*
* 即 Anthropic 优先；Anthropic 表达不了降 Responses；Responses 也表达不了降 Chat。
* 降级理由与终点的对应关系见 degradeReason 的返回注释。
*
* §5.2 原有四条降级 + 「省略优于传无效值」在 Responses 段保持不变：
* - stop 非空 / 模型不支持 Responses / effort 偏离 Responses 默认档（非 none）/
*   运行时 400 标记（§5.3 responsesUnsupported）→ 降级。
* - effort === none → Responses 显式发 reasoning:{effort:"none"}（真关闭）。
* - effort === responsesDefaultEffort 或未选 → Responses 不发 reasoning（默认即所需）。
*
* Anthropic 段的降级判据（文档 #api-compatibility / #api-compatibility-thinking）：
* - 模型不在 Anthropic 支持集（文档仅列 sensenova-6.8-flash-lite 走图片块，其余模型
*   路由存在但能力未声明）→ 降 Responses。
* - 带图像但模型在 Anthropic 协议下不支持图像（文档：仅 6.8 支持 image 块）→ 降 Responses。
* - effort 偏离 Anthropic 默认档且非 none：Anthropic 有 output_config.effort 且值域
*   完整（low/medium/high/xhigh/max），**不降级**——档位可原样兑现，这正是它优先的原因。
* - 运行时 400 标记（anthropicUnsupported）→ 降 Responses。
*
* 强制模式沿用上游约定：`responses` / `anthropic` 命中各自无法表达的场景直接抛错并
* 说明切换方法，不静默回退；`chat-completions` 仍是零回归逃生舱。
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
/** 请求是否携带图像（宿主检测，含 offloaded 块）。 */
function hasImages(options) {
	return options.messages.some((message) => contentHasImage(message.content));
}
/**
* Anthropic 段的降级判定（未命中为 undefined）。任一命中即放弃 Anthropic。
* 返回值即降级后的终点（responses 或 chat-completions）与理由。
*/
/**
* Anthropic 段的降级判定（未命中为 undefined）。任一命中即放弃 Anthropic。
*
* 注意：`stop` **不是** Anthropic 的降级条件——文档 #api-compatibility-params 明确
* 支持 `stop_sequences`。stop 只是 Responses 的降级条件（§5.2 原第一条），在
* Anthropic 优先后仅当 Anthropic 已被排除时才成为判据。
*/
function anthropicDegrade(options, facts, runtime) {
	if (!supportsAnthropic(facts)) return {
		wire: supportsResponses(facts) ? "responses" : "chat-completions",
		reason: "downgrade-unsupported-model"
	};
	if (hasImages(options) && !facts.anthropicSupportsImages) return {
		wire: "responses",
		reason: "downgrade-image"
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
/**
* 决定本次请求使用的 wire。
*
* `chat-completions` 强制模式无判定直达；`anthropic` / `responses` 强制模式命中各自
* 降级条件时抛 LlmError，消息说明如何切换到 auto 或 chat-completions
* （spec「强制模式报错」场景，沿用上游约定）。
*/
function resolveWirePlan(options, config, facts, runtime = {}) {
	const protocol = config.wireProtocol ?? "auto";
	if (protocol === "chat-completions") return {
		wire: "chat-completions",
		reason: "forced-chat"
	};
	const anthropicHit = anthropicDegrade(options, facts, runtime);
	const responsesHit = responsesDegrade(options, facts, runtime);
	if (protocol === "anthropic") {
		if (anthropicHit !== void 0) throw new LlmError(`llm-sensenova: wireProtocol "anthropic" cannot serve this request (${anthropicHit.reason})；当前请求在强制 Anthropic 模式下无法保真（${anthropicHit.reason}），请在设置中将 wireProtocol 切换为 "auto"（自动降级 Responses / Chat Completions）或 "chat-completions"`, "INVALID_REQUEST");
		return {
			wire: "anthropic",
			reason: "forced-anthropic"
		};
	}
	if (protocol === "responses") {
		if (responsesHit !== void 0) throw new LlmError(`llm-sensenova: wireProtocol "responses" cannot serve this request (${responsesHit.reason})；当前请求在强制 Responses 模式下无法保真（${responsesHit.reason}），请在设置中将 wireProtocol 切换为 "auto"（自动降级 Chat Completions）或 "chat-completions"`, "INVALID_REQUEST");
		return {
			wire: "responses",
			reason: "forced-responses"
		};
	}
	if (anthropicHit === void 0) return {
		wire: "anthropic",
		reason: "anthropic-default"
	};
	if (anthropicHit.reason === "downgrade-runtime-marked" || anthropicHit.reason === "downgrade-unsupported-model") {
		if (responsesHit === void 0) return {
			wire: "responses",
			reason: "responses-default"
		};
		return {
			wire: "chat-completions",
			reason: responsesHit.reason
		};
	}
	return {
		wire: anthropicHit.wire,
		reason: anthropicHit.reason
	};
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
* SenseNova 目录通常不披露上下文字段，这里用 131072 作为合理默认
* （DeepSeek 系列与 SenseNova 常见模型窗口）；目录有字段时优先采用。
*/
const DEFAULT_CONTEXT_WINDOW = 131072;
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
* 提交给 provider 重试层的延迟上限（毫秒）：本地退避与非配额 429 的
* Retry-After 均受此约束，同时作为重试策略退避单次上限。
* fix-sensenova-429-quota-retry（2026-09-04 实测）：原 3000ms 与配额窗口量级
* 不符——TPM 为 60 秒窗口，提升到 60000ms（spec 允许区间 60–120s 的下沿）。
*/
const PROVIDER_RETRY_AFTER_CAP_MS = 6e4;
/** 配额类 429 退避指导（providerRetryAfterMs）的绝对上限（毫秒）：与
* PROVIDER_RETRY_AFTER_CAP_MS（即重试策略单次延迟上限）一致。宿主 dsh-llm-retry
* （normal 模式）在 providerRetryAfterMs 超过单次延迟上限时会直接放弃重试，封顶
* 对齐后保证任何采用值都会被宿主按指导延迟重试；不影响 TPM 分级档（3–30s）与
* code 8 固定档（15s）的正常取值。 */
const QUOTA_RETRY_AFTER_CEILING_MS = 6e4;
/** 配额类 429（code 8，rps/rpm exhausted）退避下限（毫秒）。2026-09-04 实测：速率桶补充 ≈1 个/14s，15s 覆盖一个完整补充周期。 */
/** 生成请求连接/首字节超时（毫秒）。2026-09-04 实测：传输挂起 ≈1/5 且无 RST，45s 覆盖大 prompt 建连+首包（design D4/D6）。 */
const CONNECT_TIMEOUT_MS = 45e3;
/** SSE 流空闲看门狗（毫秒）：距上一事件 ≥ 该值无任何 chunk/事件即按停摆结束。2026-09-04 实测：思考期渠道有空事件/心跳自然重置计时（design D4/D6）。 */
const STREAM_IDLE_TIMEOUT_MS = 6e4;
/** 明确的模型不可用错误码（不在默认可重试集合内，故不触发 provider 重试）。 */
const MODEL_NOT_FOUND_CODE = "MODEL_NOT_FOUND";
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
	return firstPositiveNumber(raw, [
		"context_length",
		"context_window",
		"max_context_length",
		"contextLength"
	]);
}
function firstMaxOutputField(raw) {
	return firstPositiveNumber(raw, [
		"max_output_length",
		"max_tokens",
		"max_output_tokens",
		"max_completion_tokens",
		"maxTokens",
		"maxOutputTokens",
		"maxCompletionTokens"
	]);
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
	if (!isRecord(value) || !Array.isArray(value.data)) throw new LlmError("llm-sensenova: unexpected models response shape", "PROVIDER_PROTOCOL_ERROR");
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
			if (!state.sawContent) throw new LlmError("llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复", "EMPTY_RESPONSE");
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
			throw new LlmError(`llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`, "TIMEOUT", { cause: error });
		}
		if (signal?.aborted) throw error;
		if (error instanceof LlmError) {
			traceLog(`[dsh-sensenova-suite] chat-completions 流失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${error.message}`);
			throw error;
		}
		traceLog(`[dsh-sensenova-suite] chat-completions 流中途失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${errorChain(error)} → TRANSPORT`);
		throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, "TRANSPORT", { cause: error });
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
* dynamicFloorMs：stream 层算好的配额类动态退避下限（429001 分级探测），
* 覆盖 classify429Body 返回的静态 floor；undefined 时用静态 floor。
* wire：当前请求走的协议；Anthropic 协议的错误体用 type 字符串而非数字 code，
* 需单独识别 overloaded / rate_limit，否则会被当成普通 HTTP 5xx/4xx 漏判。 */
function httpError(status, errText, retryAfterMs, dynamicFloorMs, wire) {
	const anthropicType = wire === "anthropic" ? anthropicErrorType(errText) : void 0;
	if (status === 401) return new LlmError("llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效", "INVALID_CREDENTIAL", { status: 401 });
	if (status === 404 && isModelNotFoundText(errText)) return new LlmError("llm-sensenova: SenseNova model is not routable — the model id is no longer served；SenseNova 模型不可路由：该模型 id 已下线", MODEL_NOT_FOUND_CODE, { status: 404 });
	if (status === 429) {
		const classified = classify429Body(errText);
		const classifiedWithAnthropic = anthropicType === ANTHROPIC_RATE_LIMIT && !classified.quota ? {
			quota: true,
			retryFloorMs: QUOTA_RATE_RETRY_FLOOR_MS,
			kind: "rate"
		} : classified;
		const floorMs = dynamicFloorMs ?? classifiedWithAnthropic.retryFloorMs;
		let providerRetryAfterMs;
		if (floorMs !== void 0) providerRetryAfterMs = Math.min(Math.max(floorMs, retryAfterMs !== void 0 && retryAfterMs > 0 ? retryAfterMs : 0), QUOTA_RETRY_AFTER_CEILING_MS);
		else providerRetryAfterMs = retryAfterMs !== void 0 && retryAfterMs > 0 && retryAfterMs <= PROVIDER_RETRY_AFTER_CAP_MS ? retryAfterMs : void 0;
		return new LlmError("llm-sensenova: SenseNova API error 429 — rate limited；SenseNova API 返回 429：请求被限流", "RATE_LIMIT", {
			status: 429,
			...providerRetryAfterMs !== void 0 ? { providerRetryAfterMs } : {}
		});
	}
	if (anthropicType === ANTHROPIC_OVERLOADED) return new LlmError(`llm-sensenova: SenseNova API error 529 overloaded；SenseNova 返回 overloaded_error：服务端过载，重试通常可恢复`, "PROVIDER_HTTP_ERROR", { status });
	if (anthropicType !== void 0 && ANTHROPIC_AUTH.has(anthropicType)) return new LlmError("llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效", "INVALID_CREDENTIAL", { status });
	return new LlmError(`llm-sensenova: SenseNova API error ${status}: ${errText.slice(0, 500)}`, "PROVIDER_HTTP_ERROR", { status });
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
	quotaStickyKeys = /* @__PURE__ */ new Map();
	/**
	* 429001 连续命中计数（per-session，分级探测用）：命中 +1、成功/换 key 清零，
	* 决定下次探测档位 TPM_PROBE_BACKOFF_STEPS_MS[count]。仅内存，随适配器生命周期。
	*/
	tpmHitCounts = /* @__PURE__ */ new Map();
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
		const credentialChanged = this.catalogCredential !== void 0 && this.catalogCredential !== apiKey;
		const apiBaseChanged = this.catalogApiBase !== void 0 && this.catalogApiBase !== connection.apiBase;
		if (this.catalogFetchedAt === 0 && catalogSeed !== void 0 && catalogSeed.credential === apiKey && catalogSeed.apiBase === connection.apiBase) {
			this.catalog = catalogSeed.entries;
			this.catalogCredential = catalogSeed.credential;
			this.catalogApiBase = catalogSeed.apiBase;
			this.catalogFetchedAt = catalogSeed.fetchedAt;
		}
		if (!credentialChanged && !apiBaseChanged && this.catalogFetchedAt > 0 && now - this.catalogFetchedAt < CATALOG_TTL_MS) return this.catalog;
		if (this.catalogNextRetryAt > now) return this.catalog;
		if (this.catalogInflight !== void 0) return this.catalogInflight;
		const inflight = this.fetchCatalogUncached(connection, apiKey, credentialChanged || apiBaseChanged);
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
		if (response.status === 401) throw new LlmError("llm-sensenova: SenseNova API rejected the API key (401)", "INVALID_CREDENTIAL", { status: 401 });
		if (!response.ok) throw new LlmError(`llm-sensenova: models endpoint returned HTTP ${response.status}`, "PROVIDER_HTTP_ERROR", { status: response.status });
		const parsed = await response.json();
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
		const contextWindow = entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const checked = this.deps.visionModelIds?.().includes(model) === true;
		return {
			provider,
			id: model,
			name: entry?.name ?? displayNameFor(model),
			...checked ? { inputModalities: IMAGE_INPUT_MODALITIES } : {},
			context: { contextWindow },
			...entry?.maxOutputTokens !== void 0 ? { defaultMaxTokens: entry.maxOutputTokens } : {},
			...entry?.reasoning !== void 0 ? { reasoning: entry.reasoning } : {}
		};
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
		let wire = resolveWirePlan(options, connection, facts, {
			responsesUnsupported: this.responsesUnsupported,
			anthropicUnsupported: this.anthropicUnsupported
		}).wire;
		const override = this.deps.protocolOverrides?.()[options.model];
		if (override === "anthropic" || override === "responses" || override === "chat-completions") wire = override;
		let bridgedMessages = options.messages;
		if (this.deps.imageSwapper !== void 0 && Array.isArray(bridgedMessages)) {
			bridgedMessages = await this.deps.imageSwapper(bridgedMessages, { model: options.model });
			if (contentHasImage$1(bridgedMessages)) traceLog(`[dsh-sensenova-suite] 图片桥: 换图后消息仍携带图片块（勾选模型走原生，属预期）`);
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
		try {
			for (let rotations = 0;;) {
				tried.add(apiKey);
				try {
					release = await this.gate.acquire(apiKey, limit, options.signal, queueMs);
				} catch (error) {
					if (!isTimeoutReason(error)) throw error;
					throw new LlmError(`llm-sensenova: request queued behind the per-key concurrency limit for over ${queueMs ?? 6e4}ms；SenseNova 请求排队超时（未占用并发额度），交宿主重试层退避后重试`, "TIMEOUT", { cause: error });
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
					if (isTimeoutReason(error)) throw new LlmError(`llm-sensenova: request to ${connection.apiBase} timed out after ${connectMs}ms；SenseNova 请求建连或首包超时（已释放并发额度），交宿主重试层处理`, "TIMEOUT", { cause: error });
					throw new LlmError(`llm-sensenova: request to ${connection.apiBase} failed: ${errorChain(error)}；连接 SenseNova API 失败，通常是网络或代理问题`, "TRANSPORT", { cause: error });
				}
				if (attempt.ok) {
					response = attempt;
					if (this.tpmHitCounts.get(options.sessionId) !== void 0) traceLog(`[dsh-sensenova-suite] 429 恢复 sid=${options.sessionId ?? "-"} model=${options.model} key=${maskKey(apiKey)} 连续限流结束，探测档归零`);
					this.tpmHitCounts.delete(options.sessionId);
					this.deps.reportOutcome?.(apiKey, "success");
					break;
				}
				const errText = await attempt.text().catch(() => "");
				const retryAfterMs = parseRetryAfterMs(attempt.headers.get("retry-after"));
				if (attempt.status === 400) traceLog(`[dsh-sensenova-suite] ${wire} wire 400 sid=${options.sessionId ?? "-"} model "${options.model}" body: ${errText.slice(0, 400)}`);
				if (attempt.status === 400 && wire !== "chat-completions" && !responsesFallbackUsed && isInvalidRequestError(errText)) {
					const nextWire = wire === "anthropic" ? "responses" : "chat-completions";
					if (wire === "anthropic") this.anthropicUnsupported.add(options.model);
					else this.responsesUnsupported.add(options.model);
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
				const quota429 = attempt.status === 429 && classified.quota;
				const pool429 = attempt.status === 429 && !classified.quota && classify429Full(errText).kind === "pool";
				let dynamicFloorMs;
				if (classified.kind === "tpm") {
					const hits = this.tpmHitCounts.get(options.sessionId) ?? 0;
					dynamicFloorMs = TPM_PROBE_BACKOFF_STEPS_MS[Math.min(hits, TPM_PROBE_BACKOFF_STEPS_MS.length - 1)];
					this.tpmHitCounts.set(options.sessionId, hits + 1);
				}
				traceLog(`[dsh-sensenova-suite] 429 sid=${options.sessionId ?? "-"} model=${options.model} key=${maskKey(apiKey)} kind=${pool429 ? "pool" : classified.quota ? classified.kind : "rate"} 退避=${dynamicFloorMs !== void 0 ? `${Math.round(dynamicFloorMs / 1e3)}s` : retryAfterMs !== void 0 ? `${Math.round(retryAfterMs / 1e3)}s(retry-after)` : "宿主默认"}`);
				const quotaRotate = (quota429 || pool429) && quotaRotation;
				if ((attempt.status === 401 || quotaRotate) && options.signal?.aborted !== true && rotations < connection.accountCount) {
					const next = await this.deps.rotateApiKey(apiKey, attempt.status === 401 ? "invalid-credential" : pool429 ? "pool-exhausted" : "quota-exhausted");
					if (next !== void 0 && !tried.has(next)) {
						release();
						release = void 0;
						apiKey = next;
						rotations += 1;
						traceLog(`[dsh-sensenova-suite] 429 换 key sid=${options.sessionId ?? "-"} model=${options.model} → 新 key（粘性已更新，已轮换 ${rotations}/${connection.accountCount}）`);
						if (quotaRotate) {
							this.quotaStickyKeys.set(options.sessionId, next);
							this.tpmHitCounts.delete(options.sessionId);
						}
						continue;
					}
				}
				if (attempt.status === 429) traceLog(`[dsh-sensenova-suite] 429 换无可换 sid=${options.sessionId ?? "-"} model=${options.model} 已试 ${rotations}/${connection.accountCount} 把，交宿主重试层（预算内自动重试）`);
				release();
				release = void 0;
				throw httpError(attempt.status, errText, retryAfterMs, dynamicFloorMs, wire);
			}
			if (response === void 0) throw new LlmError("llm-sensenova: SenseNova API returned no response", "PROVIDER_PROTOCOL_ERROR");
			if (response.body === null) throw new LlmError("llm-sensenova: SenseNova API returned no response body", "PROVIDER_PROTOCOL_ERROR");
			yield* wire === "anthropic" ? parseAnthropicSse(response.body, options.signal, streamIdleMs, options.model, options.sessionId) : wire === "responses" ? parseResponsesSse(response.body, options.signal, streamIdleMs, options.model, options.sessionId) : parseOpenAiSse(response.body, options.signal, streamIdleMs, options.model, options.sessionId);
		} finally {
			for (const cleanup of connectCleanups) cleanup();
			release?.();
			releaseSlot?.();
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
* The publish chain hands `{ entries, enabledIds, baseUrl, resolveApiKey, get,
* unavailableModelIds, maxTokensOverrides }`; with the wire adapter the
* catalog is the adapter's own (`fetchCatalog` → GET {apiBase}/models), so
* `entries` is unused and the allow-list / quota-mark semantics ride the
* `catalogFilter` seam instead. `resolveApiKey` (the panel's single-key
* resolver) is superseded by the pool — the panel key is the pool's FIRST
* slot, configured by `index.ts`, not passed through here.
*
* @param {PoolFacade} pool - the orchestrator facade from `index.ts`.
* @returns {(args: object) => Promise<{adapter: unknown, providerIds: string[]}>}
*   the async factory matching the publish chain's await-and-shape-check.
*/
function createAdapterFactory(pool) {
	const { orchestrator } = pool;
	return async function createSensenovaAdapter({ baseUrl, enabledIds, unavailableModelIds }) {
		const apiBase = typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : "https://token.sensenova.cn/v1";
		const enabled = Array.isArray(enabledIds) ? enabledIds.filter((id) => typeof id === "string") : [];
		const unavailable = Array.isArray(unavailableModelIds) ? unavailableModelIds.filter((id) => typeof id === "string") : [];
		const snapshot = orchestrator.snapshot();
		Math.max(1, snapshot.running.length + snapshot.blocked.length);
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
				requestSlot: async (signal) => orchestrator.acquireSlot(signal),
				rotateApiKey: async (rejectedKey, rejection) => {
					const exclude = /* @__PURE__ */ new Set([rejectedKey]);
					if (rejection === "invalid-credential") {
						orchestrator.reportAuthRejected(rejectedKey);
						return orchestrator.pickNext(exclude, "general");
					}
					if (rejection === "pool-exhausted") {
						orchestrator.reportPoolExhausted(rejectedKey, "general");
						return orchestrator.pickNext(exclude, "general");
					}
					orchestrator.reportRateLimited(rejectedKey);
					return orchestrator.pickNext(exclude, "general");
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
				thinkingOverrides: () => pool.thinkingOverrides()
			}),
			providerIds: [LLM_PROVIDER_ID]
		};
	};
}

//#endregion
export { createAdapterFactory };