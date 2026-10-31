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

import { normalizeImageInput, toDataUrl, type NormalizedImage } from "./image-input.ts";
import { envelopeFail, imagePart, postChat, extractText } from "./direct.ts";
import { classify429Full } from "../rate-classify.ts";

/** 视觉运行配置（host-config 解析后的形状）：单模型，由用户选择。 */
export interface VisionOptions {
  apiBase: string;
  model: string;
  imageMode: "image_url" | "image_base64";
  timeoutMs: number;
}

/** 池侧 key 解析（无可用 key 时抛错，信封负责转成失败 JSON）。 */
export type ResolveKey = () => Promise<string>;

/**
 * 结局反馈（可选）：视觉调用的结局按套件统一教义回池——429 分类后记数/记格、
 * 401 永久移除、成功清零。index.ts 注入；纯函数模块不 import 池。
 */
export interface VisionFeedback {
  on429: (key: string, kind: import("../rate-classify.ts").RateLimitKind) => void;
  on401: (key: string) => void;
  onSuccess: (key: string) => void;
}

/** 一次 `describe_*` 的输入参数（与 MCP 工具签名一致）。 */
export interface DescribeArgs {
  image?: string;
  images?: string[];
  prompt?: string;
  base_url?: string;
  image_mode?: string;
}

/** 可选注入的 fetch（宿主无 'fetch' 服务时回落全局 fetch）。 */
type FetchCarrier = { get?: (service: string) => unknown };

function fetchImplOf(ctx: FetchCarrier): typeof fetch | undefined {
  const candidate = ctx.get?.("fetch") as typeof fetch | undefined;
  return typeof candidate === "function" ? candidate : undefined;
}

/** 从工具参数提取并归一化图片数组（describe_image 单图包装为数组）。 */
export async function normalizeImagesOf(args: DescribeArgs): Promise<NormalizedImage[]> {
  const raws = args.images ?? (args.image !== undefined ? [args.image] : []);
  if (raws.length === 0) throw new Error("at least one image is required");
  const normalized: NormalizedImage[] = [];
  for (const raw of raws) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`each image must be a non-empty string, got ${JSON.stringify(raw)}`);
    }
    normalized.push(await normalizeImageInput(raw));
  }
  return normalized;
}

/** 解析用户覆盖：空串/未传用配置值。 */
function resolveOverrides(args: { base_url?: string; image_mode?: string }, options: VisionOptions): {
  apiBase: string;
  imageMode: "image_url" | "image_base64";
} {
  return {
    apiBase: args.base_url !== undefined && args.base_url.trim() !== ""
      ? args.base_url.trim().replace(/\/+$/, "")
      : options.apiBase,
    imageMode: args.image_mode === "image_base64" ? "image_base64" : options.imageMode,
  };
}

/**
 * 一次视觉调用（单模型）：成功回 envelope 所需的 text/model，失败抛错前先按
 * 套件教义把 429/401 回报池层。`postChat` 的错误带 `status`/`body`（direct.ts
 * 附加），分类用完整响应体。
 */
async function callOnce(options: {
  apiBase: string;
  model: string;
  content: Array<Record<string, unknown>>;
  apiKey: string;
  timeoutMs: number;
  fetchImpl: typeof fetch | undefined;
  feedback: VisionFeedback;
}): Promise<string> {
  const { feedback, apiKey } = options;
  try {
    const data = await postChat({
      apiBase: options.apiBase,
      model: options.model,
      content: options.content,
      apiKey,
      timeoutMs: options.timeoutMs,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });
    feedback.onSuccess(apiKey);
    return extractText(data);
  } catch (error: unknown) {
    const err = error as { status?: unknown; body?: unknown };
    const status = typeof err.status === "number" ? err.status : undefined;
    const body = typeof err.body === "string" ? err.body : "";
    if (status === 429) feedback.on429(apiKey, classify429Full(body).kind);
    else if (status === 401) feedback.on401(apiKey);
    throw error;
  }
}

/** describe_image / describe_images 共用实现（返回 JSON 信封字符串，与 MCP 版一致）。 */
export async function describe(
  ctx: FetchCarrier,
  args: DescribeArgs,
  options: VisionOptions,
  resolveKey: ResolveKey,
  feedback: VisionFeedback,
  taskType: "image_reasoning" | "image_reasoning_multi",
): Promise<string> {
  const started = Date.now();
  const prompt = args.prompt ?? (taskType === "image_reasoning_multi"
    ? "Describe these images in detail."
    : "Describe this image in detail.");
  const overrides = resolveOverrides(args, options);

  let images: NormalizedImage[];
  let raws: string[];
  try {
    images = await normalizeImagesOf(args);
    raws = args.images ?? (args.image !== undefined ? [args.image] : []);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify(envelopeFail(taskType, message));
  }

  try {
    const apiKey = await resolveKey();
    const content: Array<Record<string, unknown>> = [];
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const raw = raws[index];
      if (image === undefined || raw === undefined) continue;
      content.push(imagePart(toDataUrl(image, raw), overrides.imageMode));
    }
    if (prompt !== "") content.push({ type: "text", text: prompt });

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
      ...(taskType === "image_reasoning_multi" ? { image_count: images.length } : {}),
      result,
      metadata: {
        model: options.model,
        base_url: overrides.apiBase,
        image_mode: overrides.imageMode,
        total_ms: Date.now() - started,
        attempts: [{ model: options.model, status: "ok", latency_ms: Date.now() - started }]
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify(envelopeFail(taskType, message));
  }
}
