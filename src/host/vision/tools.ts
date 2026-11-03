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
 * 本模块是 peer 依赖半区（import @deepseek-ai/dsh-tools），由 index.ts 懒加载，
 * 离线测试用假工具服务替代。
 *
 * @module dsh-sensenova-suite/vision/tools
 */
import { buildImageTools, type ImageToolDeps, type ImageToolOptions } from "../image-tools.ts";

/** 出图工具的装配依赖。 */
export interface ToolsetDeps {
  /** 出图工具配置（按工具解析；两工具各自一份）。 */
  imageOptions: (tool: "text2img" | "img2img") => ImageToolOptions;
  /** 工具开关（面板「多模态」为主设置；注册侧过滤用）。 */
  toolEnabled: (tool: "text2img" | "img2img") => boolean;
  /** 出图 key 解析（池，按模型分组）。 */
  resolveImageKey: (model: string) => Promise<string>;
  /** 出图成功上报（池 onSuccess）。 */
  reportImageSuccess: (key: string) => void;
  /** 额度耗尽换 key（exclude = 本轮已试 key 全集；池 pickNext 返回未试过的一把；
   * 不打格——与对话链账本无关）。 */
  rotateImageKey: (key: string, model: string, exclude: ReadonlySet<string>) => Promise<string | undefined>;
  /** 宽松 ctx（fetch 注入载体）。 */
  ctx: { get?: (service: string) => unknown };
}

/** 构建全部出图工具。 */
export function buildToolset(deps: ToolsetDeps) {
  const imageDeps: ImageToolDeps = {
    options: deps.imageOptions,
    resolveKey: deps.resolveImageKey,
    reportSuccess: deps.reportImageSuccess,
    rotateOnQuota: deps.rotateImageKey
  };
  return [...buildImageTools(imageDeps)];
}
