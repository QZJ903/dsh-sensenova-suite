import { r as traceLog } from "./trace-log.js";
import { dirname, extname, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

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
* 纯逻辑模块（fetch 可注入），可离线单测；工具对象由 vision/tools.ts 裸转发、
* index.ts 直接注册 ctx.tools——无 defineTool 包装（上游 lib/index.js 同为裸对象
* 注册，defineTool 从未存在过；U9 台账 D5）。
*
* @module dsh-sensenova-suite/image-tools
*/
/** 出图「上次成功的 key」（model → key，模块级跨调用）：下一次请求优先用它，
* 失败的 key 不留案底——上次失败的这次照常参与轮询（2026-11-04 他裁定）。
* 条目数 ≤ 出图模型数，无界风险无。 */
const lastGoodImageKey = /* @__PURE__ */ new Map();
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
			redirect: "error",
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
			const error = /* @__PURE__ */ new Error(`SenseNova API 错误（HTTP ${response.status}）：${msg}`);
			error.status = response.status;
			throw error;
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
			maxItems: 5,
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
* 出图执行核心（两工具共用）。暴露给测试与 vision/tools.ts 的注册面。
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
	const preferred = lastGoodImageKey.get(model);
	try {
		key = preferred ?? await deps.resolveKey(model);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
	const url = `${config.apiBase.replace(/\/+$/, "")}${endpoint}`;
	let result;
	const tried = /* @__PURE__ */ new Set();
	for (;;) {
		tried.add(key);
		try {
			result = await postImage(url, key, body, config.timeoutMs, fetchImpl);
			break;
		} catch (error) {
			const status = error.status;
			if (status !== 429) {
				if (status === 401) lastGoodImageKey.delete(model);
				cooldownUntil = now() + IMAGE_COOLDOWN_MS;
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
			let next;
			try {
				next = await deps.rotateOnQuota(key, model, tried);
			} catch {
				next = void 0;
			}
			if (next === void 0 || next === "" || tried.has(next)) {
				cooldownUntil = now() + IMAGE_COOLDOWN_MS;
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
			key = next;
		}
	}
	lastGoodImageKey.set(model, key);
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
* execute）。工具对象由 vision/tools.ts 裸转发、index.ts 直接注册 ctx.tools
* （无 defineTool 包装，与上游同形）；本函数返回纯数据 + execute 闭包，离线
* 测试可直接驱动。
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
* 出图两工具的注册面。
*
* 出图两工具（sn_text2img / sn_img2img）的 key 都是**按调用经池解析**
* （KeyOrchestrator 按模型积分组选 key，参与轮转/亲和/额度耗尽换 key）。
*
* 识图工具（sn_describe_image / sn_describe_images）已下线（2026-11-04 他裁定）：
* 「能看图的直接看了，不能的还有桥」——勾选「可看图」的模型图原样进请求，
* 未勾选的走读图桥（bridge.ts）转述，describe 工具是冗余的第三条路。
*
* 本模块是纯转发（buildToolset → buildImageTools 裸工具对象）：index.ts 懒加载
* 后把对象直接注册进 ctx.tools——无 defineTool 包装（defineTool 在上游也不存在，
* 上游 lib/index.js:313 同为裸对象注册），离线测试直接驱动 buildImageTools。
*
* @module dsh-sensenova-suite/vision/tools
*/
/** 构建全部出图工具。 */
function buildToolset(deps) {
	const imageDeps = {
		options: deps.imageOptions,
		resolveKey: deps.resolveImageKey,
		reportSuccess: deps.reportImageSuccess,
		rotateOnQuota: deps.rotateImageKey
	};
	return [...buildImageTools(imageDeps)];
}

//#endregion
export { buildToolset };