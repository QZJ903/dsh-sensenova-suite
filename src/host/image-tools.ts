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
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
import { traceLog } from "./trace-log.ts";


/** 出图单工具的生效配置（面板保存值 → 配置默认 → 代码默认，index.ts 归一）。 */
export interface ImageToolOptions {
  apiBase: string;
  defaultModel: string;
  watermark: boolean;
  defaultSize: string;
  outputFormat: string;
  promptExtend: boolean;
  outputDir: string;
  timeoutMs: number;
}

/** 依赖注入：每工具配置解析（sn_text2img / sn_img2img 各自一份）、key 解析（池）、
 * 成功上报与额度耗尽换 key（2026-11-04 批 H：429 遍历全池——失败一直换到所有
 * key 试过，不打池格不记账，与对话链的耗尽账本无关）。
 * rotateOnQuota 的 exclude = 本轮已试过的 key 全集（含失败 key），池层返回
 * 未试过的一把；全池试完返回 undefined（调用方冷却+报错收场）。 */
export interface ImageToolDeps {
  options: (tool: "text2img" | "img2img") => ImageToolOptions;
  resolveKey: (model: string) => Promise<string>;
  reportSuccess: (key: string) => void;
  /** 额度耗尽换 key：从池里挑一把不在 exclude 的；全试过返回 undefined。 */
  rotateOnQuota: (key: string, model: string, exclude: ReadonlySet<string>) => Promise<string | undefined>;
  /** 可注入时钟/请求（测试用）。 */
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/** 出图「上次成功的 key」（model → key，模块级跨调用）：下一次请求优先用它，
 * 失败的 key 不留案底——上次失败的这次照常参与轮询（2026-11-04 他裁定）。
 * 条目数 ≤ 出图模型数，无界风险无。 */
const lastGoodImageKey = new Map<string, string>();

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
      const error = new Error(`SenseNova API 错误（HTTP ${response.status}）：${msg}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return asRecord(json);
  } finally {
    clearTimeout(timer);
  }
}

/** Save image bytes to disk; returns absolute path. */
function saveImage(bytes: Buffer, targetPath: string, format: string): string {
  const ext = (format === "jpeg" ? "jpg" : format) || "png";
  let filePath = resolve(process.cwd(), targetPath);
  const hasImgExt = [".png", ".jpg", ".jpeg", ".webp"].includes(extname(filePath).toLowerCase());
  if (!hasImgExt) {
    if (!existsSync(filePath)) mkdirSync(filePath, { recursive: true });
    filePath = resolve(filePath, `sensenova-${Date.now()}.${ext}`);
  } else if (!existsSync(dirname(filePath))) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  writeFileSync(filePath, bytes);
  return filePath;
}

/** 拉取出图 URL 的字节（落盘用）；失败抛错，由调用方决定兜底（URL 已在手）。 */
async function downloadImage(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Buffer> {
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
    imageUrl: { type: "string" },
    imagePath: { type: "string" },
    usage: { type: "object", additionalProperties: true },
    error: { type: "string" },
  },
  additionalProperties: true,
} as const;

/** 文生图参数 schema。模型/尺寸/格式/水印/润色/落盘路径都不在参数里——
 * 面板配置强制生效（见模块头注释 3），schema 广告被忽略的参数 = 对模型的假承诺。 */
export const text2imgParams = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "图像生成描述（中文或英文）" },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

/** 图片编辑参数 schema（同 text2img：面板参数强制，schema 只留调用侧真参数）。 */
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

  // 参数强制覆盖（2026-10-27）：面板配置是唯一真源，args 不参与这些旋钮——
  // schema 已不广告它们；这里也不再读，防止 schema 漂移后旧客户端参数复活。
  const model = config.defaultModel;
  const body: Record<string, unknown> = {
    model,
    prompt: args.prompt.trim(),
    n: 1,
    watermark: config.watermark,
  };
  // 面板「尺寸」留空 = 不发 size（平台默认）。
  if (config.defaultSize !== "") body.size = config.defaultSize;
  body.output_format = config.outputFormat;
  // response_format 固定 url：base64 回传会灌爆模型上下文（一张 2K 图 ≈ 7MB
  // 文本），模型侧只需要可引用的链接（24h 有效）；本地留存走「保存目录」落盘。
  body.response_format = "url";
  body.prompt_extend = config.promptExtend;

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

  // 起始 key：上次成功的优先（2026-11-04 他裁定「记住成功的 key，下一次还用他」），
  // 没有或解析失败回池层 resolveKey。
  let key: string;
  const preferred = lastGoodImageKey.get(model);
  try {
    key = preferred ?? (await deps.resolveKey(model));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const url = `${config.apiBase.replace(/\/+$/, "")}${endpoint}`;
  let result: Record<string, unknown>;
  // 额度耗尽遍历（2026-11-04 批 H，他裁定）：429 ⇒ 排除已试 key 换下一把，
  // **一直换到所有 key 都试过**（每把一次），全试完 ⇒ 冷却+报错收场。
  // 失败的 key 不留案底——上一轮失败的这一轮照常参与轮询；成功 key 记入
  // lastGoodImageKey 作下一次起点。不打池格不记账（与对话链账本无关）。
  const tried = new Set<string>();
  for (;;) {
    tried.add(key);
    try {
      result = await postImage(url, key, body, config.timeoutMs, fetchImpl);
      break;
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (status !== 429) {
        // 401（key 已失效，常见于面板删 key 后 lastGood 残留）⇒ 清记忆，
        // 下一次回池层 resolveKey 重新选——否则永久卡死在死 key 上。
        if (status === 401) lastGoodImageKey.delete(model);
        cooldownUntil = now() + IMAGE_COOLDOWN_MS;
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      let next: string | undefined;
      try {
        next = await deps.rotateOnQuota(key, model, tried);
      } catch {
        next = undefined;
      }
      if (next === undefined || next === "" || tried.has(next)) {
        cooldownUntil = now() + IMAGE_COOLDOWN_MS;
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      key = next;
    }
  }
  lastGoodImageKey.set(model, key);
  deps.reportSuccess(key);

  const data = asRecord(Array.isArray(result.data) ? asRecord(result.data[0]) : {});
  const value = buildValue(result, model);
  const format = typeof result.output_format === "string" ? result.output_format
    : (config.outputFormat !== "" ? config.outputFormat : "png");

  // 只回 URL（2026-10-27）：base64 不再进工具返回值。落盘位置只由面板「输出
  // 目录」决定（savePath 参数已移除——模型不该决定文件落在哪）；留空 = 不落盘。
  const imageUrl = typeof data.url === "string" ? data.url : undefined;
  if (imageUrl !== undefined) {
    value.imageUrl = imageUrl;
    const target = config.outputDir;
    if (typeof target === "string" && target.trim() !== "") {
      try {
        const bytes = await downloadImage(imageUrl, fetchImpl, config.timeoutMs);
        value.imagePath = saveImage(bytes, target.trim(), format);
      } catch (error) {
        // 落盘失败不吞结果：URL 已在手，模型仍可引用；原因走诊断日志。
        traceLog(`[dsh-sensenova-suite] 出图落盘失败（URL 已返回）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
      description: "调用商汤 U 系列模型生成图片。将文字描述生成图片，返回 Base64 图片数据或 24 小时有效 URL；面板配置了保存目录时自动保存本地文件。模型、尺寸、输出/返回格式、水印、prompt 润色由插件面板配置强制生效，调用时不接受这些参数",
      parameters: text2imgParams,
      output: { schema: imageResultSchema, render: renderImageResult },
      execute: (args) => callImageApi(deps, args, "text2img", "/images/generations"),
    },
    {
      name: "sn_img2img",
      description: "通过商汤 U 系列模型编辑图片。根据1-5 张参考图以及编辑指令，生成修改后的图片。参考图接受公网 URL 或完整的 Base64 Data URL（格式为 data:image/{format};base64,{base64_data}）。模型、尺寸、输出/返回格式、水印、prompt 润色由插件面板配置强制生效，调用时不接受这些参数",
      parameters: img2imgParams,
      output: { schema: imageResultSchema, render: renderImageResult },
      execute: (args) => callImageApi(deps, args, "img2img", "/images/edits"),
    },
  ];
}
