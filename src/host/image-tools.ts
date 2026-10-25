/**
 * 出图两工具：文生图（/images/generations）
 * + 图片编辑（/images/edits）。参数、结果信封、savePath/Base64/24h URL 行为与
 * 源插件一致；三处 suite 化改动：
 *
 *   1. **key 按调用经池解析**（resolveKey(model)——按模型的积分组选 key，
 *      u1.5 系归商汤组走会话亲和；替换源插件的三级 key 解析链）；
 *   2. **失败 30s 冷却**（冷却期内出图工具
 *      直接拒绝，避免 agent 对着故障连环重试）；
 *   3. **model 参数不写死枚举**（catalog
 *      有新图模即出现；这里参数收自由字符串，缺省用配置 defaultModel）。
 *
 * 纯逻辑模块（fetch 全局；peer 由 vision/tools.ts 的 defineTool 包裹），
 * 可离线单测。
 *
 * @module dsh-sensenova-suite/image-tools
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";

/** 出图单工具的生效配置（面板保存值 → 配置默认 → 代码默认，index.ts 归一）。 */
export interface ImageToolOptions {
  apiBase: string;
  defaultModel: string;
  watermark: boolean;
  defaultSize: string;
  outputFormat: string;
  responseFormat: string;
  promptExtend: boolean;
  outputDir: string;
  timeoutMs: number;
}

/** 依赖注入：每工具配置解析（sn_text2img / sn_img2img 各自一份）、key 解析（池）与成功上报。 */
export interface ImageToolDeps {
  options: (tool: "text2img" | "img2img") => ImageToolOptions;
  resolveKey: (model: string) => Promise<string>;
  reportSuccess: (key: string) => void;
  /** 可注入时钟/请求（测试用）。 */
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" };

/** 失败后的冷却期：30s 内出图工具直接拒绝。 */
export const IMAGE_COOLDOWN_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 一次出图请求的结果（工具 execute 的返回值）。 */
export interface ImageToolValue {
  ok: boolean;
  model?: string;
  size?: string;
  output_format?: string;
  imageDataUrl?: string;
  imageUrl?: string;
  imagePath?: string;
  /** exactOptionalPropertyTypes：usage 子字段可为 undefined（上游 JSON 缺项如实透传）。 */
  usage?: { input_tokens?: number | undefined; output_tokens?: number | undefined; total_tokens?: number | undefined; images_count?: number | undefined };
  error?: string;
}

async function postImage(path: string, apiKey: string, body: Record<string, unknown>, timeoutMs: number, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch {
      throw new Error(`API 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`);
    }
    if (!response.ok) {
      const parsed = asRecord(json);
      const err = asRecord(parsed.error);
      const msg = typeof err.message === "string" ? err.message : (typeof parsed.error === "string" ? parsed.error : text);
      throw new Error(`SenseNova API 错误（HTTP ${response.status}）：${msg}`);
    }
    return asRecord(json);
  } finally {
    clearTimeout(timer);
  }
}

/** Save base64 image to disk; returns absolute path. */
function saveImage(b64: string, targetPath: string, format: string): string {
  const ext = (format === "jpeg" ? "jpg" : format) || "png";
  let filePath = resolve(process.cwd(), targetPath);
  const hasImgExt = [".png", ".jpg", ".jpeg", ".webp"].includes(extname(filePath).toLowerCase());
  if (!hasImgExt) {
    if (!existsSync(filePath)) mkdirSync(filePath, { recursive: true });
    filePath = resolve(filePath, `sensenova-${Date.now()}.${ext}`);
  } else if (!existsSync(dirname(filePath))) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  writeFileSync(filePath, Buffer.from(b64, "base64"));
  return filePath;
}

function buildValue(result: Record<string, unknown>, model: string): ImageToolValue {
  const usage = asRecord(result.usage);
  return {
    ok: true,
    model,
    ...(typeof result.size === "string" ? { size: result.size } : {}),
    ...(typeof result.output_format === "string" ? { output_format: result.output_format } : {}),
    ...(usage.input_tokens !== undefined || usage.output_tokens !== undefined || usage.total_tokens !== undefined || usage.images_count !== undefined ? {
      usage: {
        input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
        output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
        total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
        images_count: typeof usage.images_count === "number" ? usage.images_count : undefined,
      },
    } : {}),
  };
}

/** render：把结果值转成文本块（与源插件一致）。 */
export function renderImageResult(_args: unknown, value: unknown): Array<{ type: "text"; text: string }> {
  const v = asRecord(value) as Partial<ImageToolValue>;
  if (v.ok !== true) {
    return [{ type: "text", text: `❌ ${v.error || "未知错误"}` }];
  }
  const lines = [`✅ SenseNova ${v.model} 生成完成${v.size ? `（${v.size}）` : ""}`];
  if (v.imagePath !== undefined) lines.push(`已保存：${v.imagePath}`);
  if (v.imageUrl !== undefined) lines.push(`图片 URL（24h 有效）：${v.imageUrl}`);
  if (v.imageDataUrl !== undefined) lines.push(`Base64 图片数据已返回（${Math.round(v.imageDataUrl.length / 1024)} KB）。如需保存到文件，请用 savePath 参数重新生成。`);
  if (v.usage) lines.push(`Token：input ${v.usage.input_tokens ?? "?"} / output ${v.usage.output_tokens ?? "?"} / total ${v.usage.total_tokens ?? "?"}`);
  return [{ type: "text", text: lines.join("\n") }];
}

/** 结果 schema（宽松对象根）。 */
export const imageResultSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    model: { type: "string" },
    size: { type: "string" },
    output_format: { type: "string" },
    imageDataUrl: { type: "string" },
    imageUrl: { type: "string" },
    imagePath: { type: "string" },
    usage: { type: "object", additionalProperties: true },
    error: { type: "string" },
  },
  additionalProperties: true,
} as const;

/** 文生图参数 schema。 */
export const text2imgParams = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "图像生成描述（中文或英文）" },
    model: { type: "string", description: "图片模型 id（如 sensenova-u1.5-lite 质量优先 / sensenova-u1.5-fast 速度优先；catalog 新增图模可直接用）。默认用插件配置" },
    size: { type: "string", description: "尺寸：auto 或 WIDTHxHEIGHT（32 的倍数，512-4096，比例 ≤3:1）。官方建议：2048x2048（1:1/2K）、2720x1536（16:9/2K）、1536x2720（9:16/2K）、1664x2496（2:3/2K）、2496x1664（3:2/2K）、4096x4096（1:1/4K）" },
    output_format: { type: "string", enum: ["png", "jpeg", "webp"], description: "输出格式，默认 png" },
    response_format: { type: "string", enum: ["b64_json", "url"], description: "b64_json 返回 Base64；url 返回 24h 临时链接。默认 b64_json" },
    watermark: { type: "boolean", description: "是否添加官方水印（默认 true；面板的「关闭水印」开关会反转此值——面板开=去水印=false）" },
    prompt_extend: { type: "boolean", description: "自动润色扩写 prompt，默认 true" },
    savePath: { type: "string", description: "可选：将 Base64 结果保存为本地文件（完整文件路径或目录）" },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

/** 图片编辑参数 schema。 */
export const img2imgParams = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "编辑指令（描述期望的最终画面）" },
    images: {
      type: "array",
      description: "图片输入数组，每项包含 { image_url }。第 1 张为主编辑图，最多 5 张。",
      items: {
        type: "object",
        properties: { image_url: { type: "string", description: "公网 URL 或 Base64 Data URL" } },
        required: ["image_url"],
        additionalProperties: false,
      },
    },
    model: { type: "string", description: "图片模型 id，默认用插件配置" },
    size: { type: "string", description: "尺寸：auto 或 WIDTHxHEIGHT（32 的倍数，512-4096，比例 ≤3:1）。官方建议：2048x2048（1:1/2K）、2720x1536（16:9/2K）、1536x2720（9:16/2K）、1664x2496（2:3/2K）、2496x1664（3:2/2K）、4096x4096（1:1/4K）" },
    output_format: { type: "string", enum: ["png", "jpeg", "webp"], description: "默认 png" },
    response_format: { type: "string", enum: ["b64_json", "url"], description: "默认 b64_json" },
    watermark: { type: "boolean", description: "默认取插件配置" },
    prompt_extend: { type: "boolean", description: "默认 true" },
    savePath: { type: "string", description: "可选：保存路径（完整文件路径或目录）" },
  },
  required: ["prompt", "images"],
  additionalProperties: false,
} as const;

/**
 * 出图执行核心（两工具共用）。暴露给测试与 vision/tools.ts 的 defineTool 包装。
 * 冷却：一次失败后 30s 内直接返回失败值（不发起请求）。
 */
export async function callImageApi(
  deps: ImageToolDeps,
  rawArgs: unknown,
  tool: "text2img" | "img2img",
  endpoint: "/images/generations" | "/images/edits",
): Promise<ImageToolValue> {
  const args = asRecord(rawArgs);
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw new Error("prompt 不能为空");
  }
  const config = deps.options(tool);
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;

  // 冷却检查（进程内；重启即清）。
  if (cooldownUntil > now()) {
    return { ok: false, error: `出图刚失败过，${Math.ceil((cooldownUntil - now()) / 1000)}s 后冷却结束再试` };
  }

  const model = typeof args.model === "string" && args.model.trim() !== "" ? args.model.trim() : config.defaultModel;
  const body: Record<string, unknown> = {
    model,
    prompt: args.prompt.trim(),
    n: 1,
    watermark: args.watermark !== undefined ? args.watermark === true : config.watermark,
  };
  const size = typeof args.size === "string" && args.size.trim() !== "" ? args.size.trim() : config.defaultSize;
  if (size !== "") body.size = size;
  body.output_format = typeof args.output_format === "string" ? args.output_format : config.outputFormat;
  body.response_format = typeof args.response_format === "string" ? args.response_format : config.responseFormat;
  body.prompt_extend = args.prompt_extend !== undefined ? args.prompt_extend === true : config.promptExtend;

  if (endpoint === "/images/edits") {
    if (!Array.isArray(args.images) || args.images.length === 0) {
      throw new Error("images 不能为空（至少 1 张参考图）");
    }
    body.images = args.images.map((img) => {
      const record = asRecord(img);
      if (typeof record.image_url !== "string" || record.image_url.trim() === "") {
        throw new Error("images[] 每项必须包含非空 image_url");
      }
      return { image_url: record.image_url };
    });
  }

  let key: string;
  try {
    key = await deps.resolveKey(model);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const url = `${config.apiBase.replace(/\/+$/, "")}${endpoint}`;
  let result: Record<string, unknown>;
  try {
    result = await postImage(url, key, body, config.timeoutMs, fetchImpl);
  } catch (error) {
    cooldownUntil = now() + IMAGE_COOLDOWN_MS;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  deps.reportSuccess(key);

  const data = asRecord(Array.isArray(result.data) ? asRecord(result.data[0]) : {});
  const value = buildValue(result, model);
  const format = typeof result.output_format === "string" ? result.output_format
    : typeof args.output_format === "string" ? args.output_format : "png";

  const b64 = data.b64_json;
  if (typeof b64 === "string" && b64 !== "") {
    value.imageDataUrl = `data:${MIME[format] ?? "image/png"};base64,${b64}`;
    const target = args.savePath !== undefined ? args.savePath : config.outputDir;
    if (typeof target === "string" && target.trim() !== "") {
      value.imagePath = saveImage(b64, target.trim(), format);
    }
  } else if (typeof data.url === "string") {
    value.imageUrl = data.url;
  }
  return value;
}

/** 进程内冷却截止时刻（epoch ms）；0 = 无冷却。模块级——两个工具共享一个冷却。 */
let cooldownUntil = 0;

/** 测试口：重置冷却。 */
export function resetImageCooldown(): void {
  cooldownUntil = 0;
}

/**
 * 构建出图两工具的**形状描述**（name/description/parameters/output schema/render/
 * execute）。真正的 defineTool 包装在 vision/tools.ts（peer 半区）；本函数返回
 * 纯数据 + execute 闭包，离线测试可直接驱动。
 */
export function buildImageTools(deps: ImageToolDeps): Array<{
  name: string;
  description: string;
  parameters: typeof text2imgParams | typeof img2imgParams;
  output: { schema: typeof imageResultSchema; render: typeof renderImageResult };
  execute: (args: unknown) => Promise<ImageToolValue>;
}> {
  return [
    {
      name: "sn_text2img",
      description: "调用商汤 U 系列模型生成图片。将文字描述生成图片，返回 Base64 图片数据或 24 小时有效 URL，可选择是否保存到本地；可指定尺寸、格式、输出方式，水印默认关闭",
      parameters: text2imgParams,
      output: { schema: imageResultSchema, render: renderImageResult },
      execute: (args) => callImageApi(deps, args, "text2img", "/images/generations"),
    },
    {
      name: "sn_img2img",
      description: "通过商汤 U 系列模型编辑图片。根据1-5 张参考图以及编辑指令，生成修改后的图片。参考图接受公网 URL 或完整的 Base64 Data URL（格式为 data:image/{format};base64,{base64_data}）",
      parameters: img2imgParams,
      output: { schema: imageResultSchema, render: renderImageResult },
      execute: (args) => callImageApi(deps, args, "img2img", "/images/edits"),
    },
  ];
}
