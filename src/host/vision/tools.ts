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
import { defineTool } from "@deepseek-ai/dsh-tools";
import { describe as runDescribe, type DescribeArgs, type VisionFeedback, type VisionOptions } from "./run.ts";
import { buildImageTools, type ImageToolDeps, type ImageToolOptions } from "../image-tools.ts";

/** 信封对象 schema（成功/失败共用一个宽松对象根）。 */
const envelopeSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    ok: { type: "boolean" as const },
    task_type: { type: "string" as const },
    tool_used: { type: "string" as const },
    confidence: { type: "string" as const },
    result: { type: "string" as const },
    error: { type: "string" as const },
    image_count: { type: "integer" as const },
    metadata: { type: "object" as const, additionalProperties: true },
  },
};

/** render：把信封对象序列化为文本块（与 MCP 版返回的 JSON 文本一致）。 */
function renderEnvelope(_args: unknown, value: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(value) }];
}

/** 三工具 + 两工具共用的装配依赖。 */
export interface ToolsetDeps {
  /** 每次执行取最新视觉配置（单模型，用户选择）。 */
  visionOptions: () => VisionOptions;
  /** 视觉 key 解析（池）。 */
  resolveVisionKey: () => Promise<string>;
  /** 视觉调用结局回池（429/401/成功）。 */
  visionFeedback: () => VisionFeedback;
  /** 出图工具配置（按工具解析；两工具各自一份）。 */
  imageOptions: (tool: "text2img" | "img2img") => ImageToolOptions;
  /** 工具开关（面板「多模态」为主设置；注册侧过滤用）。 */
  toolEnabled: (tool: "text2img" | "img2img") => boolean;
  /** 出图 key 解析（池，按模型分组）。 */
  resolveImageKey: (model: string) => Promise<string>;
  /** 出图成功上报（池 onSuccess）。 */
  reportImageSuccess: (key: string) => void;
  /** 宽松 ctx（fetch 注入载体）。 */
  ctx: { get?: (service: string) => unknown };
}

/** 构建视觉两工具（sn_describe_image / sn_describe_images）。 */
export function buildVisionTools(deps: ToolsetDeps) {
  const describeTool = (name: "sn_describe_image" | "sn_describe_images", multi: boolean) => defineTool({
    name,
    description: (multi
      ? "批量描述/理解多张图片(调用商汤 SenseNova 视觉模型,按 sensenova-6.8-flash-lite → deepseek-flash → kimi-k3 故障转移,首个成功即返回)。images 为图片数组(本地绝对路径、http(s) URL 或 base64);返回 JSON 文本(metadata.attempts 记录每轮尝试)。"
      : "描述/理解一张图片(调用商汤 SenseNova 视觉模型,按 sensenova-6.8-flash-lite → deepseek-flash → kimi-k3 故障转移,首个成功即返回)。image 为本地图片绝对路径、http(s) URL 或 base64;返回 JSON 文本(ok/task_type/tool_used/confidence/result/metadata.attempts);多图用 describe_images。")
      + "api key 由套件的 key 池解析(与 LLM 通道共用账号池)。",
    parameters: multi
      ? {
          images: { type: "array", required: true, items: { type: "string" }, description: "图片数组(本地绝对路径 / http(s) URL / data: URL / 裸 base64)。" },
          prompt: { type: "string", description: "识别提示,默认 \"Describe these images in detail.\"。" },
          model: { type: "string", description: "模型链(逗号分隔),默认用配置;可传 \"kimi-k3\" 强制单模型。" },
          base_url: { type: "string", description: "chat-completions base URL,默认用配置。" },
          image_mode: { type: "string", description: "图片传输模式,image_url(默认)或 image_base64(遗留)。" },
        }
      : {
          image: { type: "string", required: true, description: "本地图片绝对路径 / http(s) URL / data: URL / 裸 base64 字符串。" },
          prompt: { type: "string", description: "识别提示,默认 \"Describe this image in detail.\"。" },
          model: { type: "string", description: "模型链(逗号分隔),默认用配置;可传 \"kimi-k3\" 强制单模型。" },
          base_url: { type: "string", description: "chat-completions base URL,默认用配置。" },
          image_mode: { type: "string", description: "图片传输模式,image_url(默认)或 image_base64(遗留)。" },
        },
    output: { schema: envelopeSchema, render: renderEnvelope },
    isConcurrencySafe: () => false,
    async execute(args: DescribeArgs) {
      const envelope = await runDescribe(deps.ctx, args, deps.visionOptions(), deps.resolveVisionKey, deps.visionFeedback(), multi ? "image_reasoning_multi" : "image_reasoning");
      return JSON.parse(envelope) as Record<string, unknown>;
    },
  });

  return [describeTool("sn_describe_image", false), describeTool("sn_describe_images", true)];
}

/** 构建全部四工具（视觉两 + 出图两）。 */
export function buildToolset(deps: ToolsetDeps) {
  const imageDeps: ImageToolDeps = {
    options: deps.imageOptions,
    resolveKey: deps.resolveImageKey,
    reportSuccess: deps.reportImageSuccess
  };
  return [...buildVisionTools(deps), ...buildImageTools(imageDeps)];
}
