import { c as classify429Full, i as postChat, n as extractText, p as traceLog, r as imagePart, t as envelopeFail } from "./direct.js";
import { dirname, extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/host/vision/image-input.ts
/**
* 图片输入归一化：本地路径 / http(s) URL / data: URL / 裸 base64 → 字节 + MIME；
* 以及经附件服务保存为 `ImageAttachmentRef`（子 agent 路径的图片投递）。
*
* 与 MCP server.py 的 `_image_ref` 语义一致：`image_url` 模式本地文件内联为
* `data:<mime>;base64,`（三个模型均支持）；http(s) 直传；`image_base64` 为遗留
* 模式（token.sensenova.cn 实测 400，仅保留兼容）。
*
* @module dsh-sensenova-suite/vision/image-input
*/
/** 扩展名 → MIME（显式表，避免 Windows 注册表查不到返回 null；bmp 仅直连路径用）。 */
const MIME_BY_EXT = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp"
};
/** 判断字符串是否为本地文件路径之外的直传形式。 */
function isUrlLike(value) {
	return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:");
}
/**
* 解析裸 base64 的 MIME 前缀（`data:<mime>;base64,` 形式）；无前缀时按字节内容
* 猜测：PNG/JPEG/GIF/WebP 魔数，无法识别回落 image/png（与 server.py `_mime_for`
* 的宽容策略一致）。返回字符串（bmp 保留原值；附件保存时再收敛到 ImageMediaType）。
*/
function guessMimeFromDataUrl(value) {
	const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,/i.exec(value);
	if (match !== null && match[1] !== void 0) {
		const declared = match[1].toLowerCase();
		if (declared.startsWith("image/")) return declared;
		return "image/png";
	}
	const body = value.indexOf(",") >= 0 ? value.slice(value.indexOf(",") + 1) : value;
	const sample = Buffer.from(body, "base64").subarray(0, 12);
	if (sample.length >= 8 && sample[0] === 137 && sample[1] === 80 && sample[2] === 78 && sample[3] === 71 && sample[4] === 13 && sample[5] === 10 && sample[6] === 26 && sample[7] === 10) return "image/png";
	if (sample.length >= 3 && sample[0] === 255 && sample[1] === 216 && sample[2] === 255) return "image/jpeg";
	if (sample.length >= 6 && sample[0] === 71 && sample[1] === 73 && sample[2] === 70 && sample[3] === 56 && (sample[4] === 55 || sample[4] === 57) && sample[5] === 97) return "image/gif";
	if (sample.length >= 12 && sample[0] === 82 && sample[1] === 73 && sample[2] === 70 && sample[3] === 70 && sample[8] === 87 && sample[9] === 69 && sample[10] === 66 && sample[11] === 80) return "image/webp";
	return "image/png";
}
/**
* 归一化一个图片输入（本地路径 / http(s) URL / data: URL / 裸 base64）。
* http(s) URL 不取回字节（直连路径按 URL 直传；附件服务不支持 URL 字节内联），
* 因此 `source === 'http'` 时 `bytes` 为空、`mime` 为 image/png 占位。
*/
async function normalizeImageInput(raw) {
	const value = raw.trim();
	if (value === "") throw new Error("image input must be a non-empty string");
	if (value.startsWith("http://") || value.startsWith("https://")) return {
		mime: "image/png",
		bytes: /* @__PURE__ */ new Uint8Array(0),
		source: "http"
	};
	if (value.startsWith("data:")) {
		const semicolon = value.indexOf(";base64,");
		const comma = value.indexOf(",");
		if (semicolon < 0 || comma < 0) throw new Error("invalid data: URL (missing ;base64,)");
		const body = value.slice(semicolon + 8);
		const mime = guessMimeFromDataUrl(value);
		const bytes = Buffer.from(body, "base64");
		if (bytes.length === 0) throw new Error("empty image bytes in data: URL");
		return {
			mime,
			bytes: new Uint8Array(bytes),
			source: "data"
		};
	}
	if (!isUrlLike(value) && /^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 32) try {
		const bytes = Buffer.from(value.replace(/\s+/g, ""), "base64");
		if (bytes.length > 0) return {
			mime: guessMimeFromDataUrl(`data:;base64,${value}`),
			bytes: new Uint8Array(bytes),
			source: "base64"
		};
	} catch {}
	let bytes;
	try {
		bytes = new Uint8Array(await readFile(value));
	} catch {
		throw new Error(`image file not found: ${value}`);
	}
	const ext = extname(value).toLowerCase();
	const mime = MIME_BY_EXT[ext] ?? "image/png";
	const leaf = value.split(/[\\/]/).pop() ?? "";
	return {
		mime,
		bytes,
		source: "path",
		...leaf !== "" ? { name: leaf } : {}
	};
}
/** 直连路径用：把归一化图片内联为 `data:<mime>;base64,`（http 源直传原 URL）。 */
function toDataUrl(input, raw) {
	if (input.source === "http") return raw.trim();
	return `data:${input.mime};base64,${Buffer.from(input.bytes).toString("base64")}`;
}

//#endregion
//#region src/host/vision/run.ts
/**
* 视觉调度层。
*
* 凭据走池：每次调用经注入的 `resolveKey()`（index.ts 接 KeyOrchestrator——按
* 视觉模型的积分组选 key）。**失败回池**：HTTP 429 按套件统一教义分类后经
* `feedback` 回报（rate 计数 / pool 记格 / 401 移除），成功清零——视觉调用与
* 主对话通道共用同一套池纪律。单模型（用户选择），无链式故障转移。
*
* 纯模块：ctx 仅作可选 fetch 注入的载体（宽松形状，不 import cordis）。
*
* @module dsh-sensenova-suite/vision/run
*/
function fetchImplOf(ctx) {
	const candidate = ctx.get?.("fetch");
	return typeof candidate === "function" ? candidate : void 0;
}
/** 从工具参数提取并归一化图片数组（describe_image 单图包装为数组）。 */
async function normalizeImagesOf(args) {
	const raws = args.images ?? (args.image !== void 0 ? [args.image] : []);
	if (raws.length === 0) throw new Error("at least one image is required");
	const normalized = [];
	for (const raw of raws) {
		if (typeof raw !== "string" || raw.trim() === "") throw new Error(`each image must be a non-empty string, got ${JSON.stringify(raw)}`);
		normalized.push(await normalizeImageInput(raw));
	}
	return normalized;
}
/** 解析用户覆盖：空串/未传用配置值。 */
function resolveOverrides(args, options) {
	return {
		apiBase: args.base_url !== void 0 && args.base_url.trim() !== "" ? args.base_url.trim().replace(/\/+$/, "") : options.apiBase,
		imageMode: args.image_mode === "image_base64" ? "image_base64" : options.imageMode
	};
}
/**
* 一次视觉调用（单模型）：成功回 envelope 所需的 text/model，失败抛错前先按
* 套件教义把 429/401 回报池层。`postChat` 的错误带 `status`/`body`（direct.ts
* 附加），分类用完整响应体。
*/
async function callOnce(options) {
	const { feedback, apiKey } = options;
	try {
		const data = await postChat({
			apiBase: options.apiBase,
			model: options.model,
			content: options.content,
			apiKey,
			timeoutMs: options.timeoutMs,
			...options.fetchImpl === void 0 ? {} : { fetchImpl: options.fetchImpl }
		});
		feedback.onSuccess(apiKey);
		return extractText(data);
	} catch (error) {
		const err = error;
		const status = typeof err.status === "number" ? err.status : void 0;
		const body = typeof err.body === "string" ? err.body : "";
		if (status === 429) {
			const classified = classify429Full(body);
			feedback.on429(apiKey, classified.kind, classified.bucket);
		} else if (status === 401) feedback.on401(apiKey);
		throw error;
	}
}
/** describe_image / describe_images 共用实现（返回 JSON 信封字符串，与 MCP 版一致）。 */
async function describe(ctx, args, options, resolveKey, feedback, taskType) {
	const started = Date.now();
	const prompt = args.prompt ?? (taskType === "image_reasoning_multi" ? "Describe these images in detail." : "Describe this image in detail.");
	const overrides = resolveOverrides(args, options);
	let images;
	let raws;
	try {
		images = await normalizeImagesOf(args);
		raws = args.images ?? (args.image !== void 0 ? [args.image] : []);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return JSON.stringify(envelopeFail(taskType, message));
	}
	try {
		const apiKey = await resolveKey();
		const content = [];
		for (let index = 0; index < images.length; index += 1) {
			const image = images[index];
			const raw = raws[index];
			if (image === void 0 || raw === void 0) continue;
			content.push(imagePart(toDataUrl(image, raw), overrides.imageMode));
		}
		if (prompt !== "") content.push({
			type: "text",
			text: prompt
		});
		const fetchImpl = fetchImplOf(ctx);
		const result = await callOnce({
			apiBase: overrides.apiBase,
			model: options.model,
			content,
			apiKey,
			timeoutMs: options.timeoutMs,
			fetchImpl,
			feedback
		});
		return JSON.stringify({
			ok: true,
			task_type: taskType,
			tool_used: `sensenova:${options.model}`,
			confidence: "high",
			...taskType === "image_reasoning_multi" ? { image_count: images.length } : {},
			result,
			metadata: {
				model: options.model,
				base_url: overrides.apiBase,
				image_mode: overrides.imageMode,
				total_ms: Date.now() - started,
				attempts: [{
					model: options.model,
					status: "ok",
					latency_ms: Date.now() - started
				}]
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return JSON.stringify(envelopeFail(taskType, message));
	}
}

//#endregion
//#region src/host/image-tools.ts
/**
* 出图两工具：文生图（/images/generations）
* + 图片编辑（/images/edits）。suite 化改动：
*
*   1. **key 按调用经池解析**（resolveKey(model)——按模型的积分组选 key，
*      u1.5 系归商汤组走会话亲和；替换源插件的三级 key 解析链）；
*   2. **失败 30s 冷却**（冷却期内出图工具
*      直接拒绝，避免 agent 对着故障连环重试）；
*   3. **面板参数强制覆盖**（2026-10-27）：模型/尺寸/输出格式/水印/prompt
*      润色以面板保存值为唯一真源，调用时强制生效——旧逻辑 args 优先、配置只补缺，
*      模型带 `watermark: true` 就把面板的「关闭水印」压掉（水印关不掉的根因）。
*      同名参数已从 schema 移除（schema 广告被静默忽略的参数 = 对模型的假承诺）。
*   4. **只回 URL（2026-10-27）**：response_format 固定 url，base64 不进工具
*      返回值（一张 2K 图 ≈ 7MB 文本，回传即灌爆模型上下文）；落盘走「保存目录」
*      ——插件拉取 URL 字节存文件，失败不吞结果（诊断日志）。
*
* 纯逻辑模块（fetch 全局；peer 由 vision/tools.ts 的 defineTool 包裹），
* 可离线单测。
*
* @module dsh-sensenova-suite/image-tools
*/
/** 失败后的冷却期：30s 内出图工具直接拒绝。 */
const IMAGE_COOLDOWN_MS = 3e4;
function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
async function postImage(path, apiKey, body, timeoutMs, fetchImpl) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(path, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
		const text = await response.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`API 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`);
		}
		if (!response.ok) {
			const parsed = asRecord(json);
			const err = asRecord(parsed.error);
			const msg = typeof err.message === "string" ? err.message : typeof parsed.error === "string" ? parsed.error : text;
			throw new Error(`SenseNova API 错误（HTTP ${response.status}）：${msg}`);
		}
		return asRecord(json);
	} finally {
		clearTimeout(timer);
	}
}
/** Save image bytes to disk; returns absolute path. */
function saveImage(bytes, targetPath, format) {
	const ext = (format === "jpeg" ? "jpg" : format) || "png";
	let filePath = resolve(process.cwd(), targetPath);
	if (![
		".png",
		".jpg",
		".jpeg",
		".webp"
	].includes(extname(filePath).toLowerCase())) {
		if (!existsSync(filePath)) mkdirSync(filePath, { recursive: true });
		filePath = resolve(filePath, `sensenova-${Date.now()}.${ext}`);
	} else if (!existsSync(dirname(filePath))) mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, bytes);
	return filePath;
}
/** 拉取出图 URL 的字节（落盘用）；失败抛错，由调用方决定兜底（URL 已在手）。 */
async function downloadImage(url, fetchImpl, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return Buffer.from(await response.arrayBuffer());
	} finally {
		clearTimeout(timer);
	}
}
function buildValue(result, model) {
	const usage = asRecord(result.usage);
	return {
		ok: true,
		model,
		...typeof result.size === "string" ? { size: result.size } : {},
		...typeof result.output_format === "string" ? { output_format: result.output_format } : {},
		...usage.input_tokens !== void 0 || usage.output_tokens !== void 0 || usage.total_tokens !== void 0 || usage.images_count !== void 0 ? { usage: {
			input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : void 0,
			output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : void 0,
			total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : void 0,
			images_count: typeof usage.images_count === "number" ? usage.images_count : void 0
		} } : {}
	};
}
/** render：把结果值转成文本块（与源插件一致）。 */
function renderImageResult(_args, value) {
	const v = asRecord(value);
	if (v.ok !== true) return [{
		type: "text",
		text: `❌ ${v.error || "未知错误"}`
	}];
	const lines = [`✅ SenseNova ${v.model} 生成完成${v.size ? `（${v.size}）` : ""}`];
	if (v.imagePath !== void 0) lines.push(`已保存：${v.imagePath}`);
	if (v.imageUrl !== void 0) lines.push(`图片 URL（24h 有效）：${v.imageUrl}`);
	if (v.usage) lines.push(`Token：input ${v.usage.input_tokens ?? "?"} / output ${v.usage.output_tokens ?? "?"} / total ${v.usage.total_tokens ?? "?"}`);
	return [{
		type: "text",
		text: lines.join("\n")
	}];
}
/** 结果 schema（宽松对象根）。 */
const imageResultSchema = {
	type: "object",
	properties: {
		ok: { type: "boolean" },
		model: { type: "string" },
		size: { type: "string" },
		output_format: { type: "string" },
		imageUrl: { type: "string" },
		imagePath: { type: "string" },
		usage: {
			type: "object",
			additionalProperties: true
		},
		error: { type: "string" }
	},
	additionalProperties: true
};
/** 文生图参数 schema。模型/尺寸/格式/水印/润色/落盘路径都不在参数里——
* 面板配置强制生效（见模块头注释 3），schema 广告被忽略的参数 = 对模型的假承诺。 */
const text2imgParams = {
	type: "object",
	properties: { prompt: {
		type: "string",
		description: "图像生成描述（中文或英文）"
	} },
	required: ["prompt"],
	additionalProperties: false
};
/** 图片编辑参数 schema（同 text2img：面板参数强制，schema 只留调用侧真参数）。 */
const img2imgParams = {
	type: "object",
	properties: {
		prompt: {
			type: "string",
			description: "编辑指令（描述期望的最终画面）"
		},
		images: {
			type: "array",
			description: "图片输入数组，每项包含 { image_url }。第 1 张为主编辑图，最多 5 张。",
			items: {
				type: "object",
				properties: { image_url: {
					type: "string",
					description: "公网 URL 或 Base64 Data URL"
				} },
				required: ["image_url"],
				additionalProperties: false
			}
		}
	},
	required: ["prompt", "images"],
	additionalProperties: false
};
/**
* 出图执行核心（两工具共用）。暴露给测试与 vision/tools.ts 的 defineTool 包装。
* 冷却：一次失败后 30s 内直接返回失败值（不发起请求）。
*/
async function callImageApi(deps, rawArgs, tool, endpoint) {
	const args = asRecord(rawArgs);
	if (typeof args.prompt !== "string" || args.prompt.trim() === "") throw new Error("prompt 不能为空");
	const config = deps.options(tool);
	const now = deps.now ?? Date.now;
	const fetchImpl = deps.fetchImpl ?? fetch;
	if (cooldownUntil > now()) return {
		ok: false,
		error: `出图刚失败过，${Math.ceil((cooldownUntil - now()) / 1e3)}s 后冷却结束再试`
	};
	const model = config.defaultModel;
	const body = {
		model,
		prompt: args.prompt.trim(),
		n: 1,
		watermark: config.watermark
	};
	if (config.defaultSize !== "") body.size = config.defaultSize;
	body.output_format = config.outputFormat;
	body.response_format = "url";
	body.prompt_extend = config.promptExtend;
	if (endpoint === "/images/edits") {
		if (!Array.isArray(args.images) || args.images.length === 0) throw new Error("images 不能为空（至少 1 张参考图）");
		body.images = args.images.map((img) => {
			const record = asRecord(img);
			if (typeof record.image_url !== "string" || record.image_url.trim() === "") throw new Error("images[] 每项必须包含非空 image_url");
			return { image_url: record.image_url };
		});
	}
	let key;
	try {
		key = await deps.resolveKey(model);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
	const url = `${config.apiBase.replace(/\/+$/, "")}${endpoint}`;
	let result;
	try {
		result = await postImage(url, key, body, config.timeoutMs, fetchImpl);
	} catch (error) {
		cooldownUntil = now() + IMAGE_COOLDOWN_MS;
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
	deps.reportSuccess(key);
	const data = asRecord(Array.isArray(result.data) ? asRecord(result.data[0]) : {});
	const value = buildValue(result, model);
	const format = typeof result.output_format === "string" ? result.output_format : config.outputFormat !== "" ? config.outputFormat : "png";
	const imageUrl = typeof data.url === "string" ? data.url : void 0;
	if (imageUrl !== void 0) {
		value.imageUrl = imageUrl;
		const target = config.outputDir;
		if (typeof target === "string" && target.trim() !== "") try {
			value.imagePath = saveImage(await downloadImage(imageUrl, fetchImpl, config.timeoutMs), target.trim(), format);
		} catch (error) {
			traceLog(`[dsh-sensenova-suite] 出图落盘失败（URL 已返回）：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return value;
}
/** 进程内冷却截止时刻（epoch ms）；0 = 无冷却。模块级——两个工具共享一个冷却。 */
let cooldownUntil = 0;
/**
* 构建出图两工具的**形状描述**（name/description/parameters/output schema/render/
* execute）。真正的 defineTool 包装在 vision/tools.ts（peer 半区）；本函数返回
* 纯数据 + execute 闭包，离线测试可直接驱动。
*/
function buildImageTools(deps) {
	return [{
		name: "sn_text2img",
		description: "调用商汤 U 系列模型生成图片。将文字描述生成图片，返回 Base64 图片数据或 24 小时有效 URL；面板配置了保存目录时自动保存本地文件。模型、尺寸、输出/返回格式、水印、prompt 润色由插件面板配置强制生效，调用时不接受这些参数",
		parameters: text2imgParams,
		output: {
			schema: imageResultSchema,
			render: renderImageResult
		},
		execute: (args) => callImageApi(deps, args, "text2img", "/images/generations")
	}, {
		name: "sn_img2img",
		description: "通过商汤 U 系列模型编辑图片。根据1-5 张参考图以及编辑指令，生成修改后的图片。参考图接受公网 URL 或完整的 Base64 Data URL（格式为 data:image/{format};base64,{base64_data}）。模型、尺寸、输出/返回格式、水印、prompt 润色由插件面板配置强制生效，调用时不接受这些参数",
		parameters: img2imgParams,
		output: {
			schema: imageResultSchema,
			render: renderImageResult
		},
		execute: (args) => callImageApi(deps, args, "img2img", "/images/edits")
	}];
}

//#endregion
//#region src/host/vision/tools.ts
/**
* 视觉三工具 + 出图两工具的注册面。
*
* 视觉两工具（sn_describe_image / sn_describe_images）与出图两工具
* （sn_text2img / sn_img2img）的 key 都是**按调用经池解析**
* （KeyOrchestrator 按模型积分组选 key，参与轮转/亲和/429 上报）。
*
* 本模块是 peer 依赖半区（import @deepseek-ai/dsh-tools），由 index.ts 懒加载，
* 离线测试用假工具服务替代。
*
* @module dsh-sensenova-suite/vision/tools
*/
/** 信封对象 schema（成功/失败共用一个宽松对象根）。 */
const envelopeSchema = {
	type: "object",
	additionalProperties: true,
	properties: {
		ok: { type: "boolean" },
		task_type: { type: "string" },
		tool_used: { type: "string" },
		confidence: { type: "string" },
		result: { type: "string" },
		error: { type: "string" },
		image_count: { type: "integer" },
		metadata: {
			type: "object",
			additionalProperties: true
		}
	}
};
/** render：把信封对象序列化为文本块（与 MCP 版返回的 JSON 文本一致）。 */
function renderEnvelope(_args, value) {
	return [{
		type: "text",
		text: JSON.stringify(value)
	}];
}
/** 构建视觉两工具（sn_describe_image / sn_describe_images）。 */
function buildVisionTools(deps) {
	const describeTool = (name, multi) => defineTool({
		name,
		description: (multi ? "批量描述/理解多张图片(调用商汤 SenseNova 视觉模型,模型由配置 visionModel 决定,默认 sensenova-6.8-flash-lite;支持通过 model 参数指定其他模型)。images 为图片数组(本地绝对路径、http(s) URL 或 base64);返回 JSON 文本(metadata.attempts 记录每轮尝试)。" : "描述/理解一张图片(调用商汤 SenseNova 视觉模型,模型由配置 visionModel 决定,默认 sensenova-6.8-flash-lite;支持通过 model 参数指定其他模型)。image 为本地图片绝对路径、http(s) URL 或 base64;返回 JSON 文本(ok/task_type/tool_used/confidence/result/metadata.attempts);多图用 describe_images。") + "api key 由套件的 key 池解析(与 LLM 通道共用账号池)。",
		parameters: multi ? {
			images: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "图片数组(本地绝对路径 / http(s) URL / data: URL / 裸 base64)。"
			},
			prompt: {
				type: "string",
				description: "识别提示,默认 \"Describe these images in detail.\"。"
			},
			model: {
				type: "string",
				description: "视觉模型 id,默认用配置 visionModel(默认 sensenova-6.8-flash-lite)。"
			},
			base_url: {
				type: "string",
				description: "chat-completions base URL,默认用配置。"
			},
			image_mode: {
				type: "string",
				description: "图片传输模式,image_url(默认)或 image_base64(遗留)。"
			}
		} : {
			image: {
				type: "string",
				required: true,
				description: "本地图片绝对路径 / http(s) URL / data: URL / 裸 base64 字符串。"
			},
			prompt: {
				type: "string",
				description: "识别提示,默认 \"Describe this image in detail.\"。"
			},
			model: {
				type: "string",
				description: "视觉模型 id,默认用配置 visionModel(默认 sensenova-6.8-flash-lite)。"
			},
			base_url: {
				type: "string",
				description: "chat-completions base URL,默认用配置。"
			},
			image_mode: {
				type: "string",
				description: "图片传输模式,image_url(默认)或 image_base64(遗留)。"
			}
		},
		output: {
			schema: envelopeSchema,
			render: renderEnvelope
		},
		isConcurrencySafe: () => false,
		async execute(args) {
			const envelope = await describe(deps.ctx, args, deps.visionOptions(), deps.resolveVisionKey, deps.visionFeedback(), multi ? "image_reasoning_multi" : "image_reasoning");
			return JSON.parse(envelope);
		}
	});
	return [describeTool("sn_describe_image", false), describeTool("sn_describe_images", true)];
}
/** 构建全部四工具（视觉两 + 出图两）。 */
function buildToolset(deps) {
	const imageDeps = {
		options: deps.imageOptions,
		resolveKey: deps.resolveImageKey,
		reportSuccess: deps.reportImageSuccess
	};
	return [...buildVisionTools(deps), ...buildImageTools(imageDeps)];
}

//#endregion
export { buildToolset };