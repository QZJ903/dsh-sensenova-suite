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
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { contentHasImage } from '@deepseek-ai/dsh-llm';
import { canonicalThinkingEffort } from './effort.ts';
import type { ModelFacts, WireKind } from './types.ts';

/** 插件配置的四种 wire 模式（缺省 auto：Anthropic 优先，逐级降级）。 */
export type WireProtocol = 'auto' | 'anthropic' | 'responses' | 'chat-completions';

/** 决策结果附带的原因标识（供日志与测试断言）。 */
export type WireReason =
  | 'anthropic-default'
  | 'responses-default'
  | 'forced-chat'
  | 'forced-anthropic'
  | 'forced-responses'
  | 'downgrade-unsupported-model'
  | 'downgrade-image'
  | 'downgrade-stop'
  | 'downgrade-effort'
  | 'downgrade-runtime-marked';

export interface WirePlan {
  wire: WireKind;
  reason: WireReason;
}

/** resolveWirePlan 的配置侧输入（SensenovaConnection 的 wire 相关字段子集）。 */
export interface WirePlanConfig {
  wireProtocol?: WireProtocol;
}

/** resolveWirePlan 的运行时输入（进程内「某协议不支持某模型」标记集合）。 */
export interface WirePlanRuntime {
  /** §5.3：Responses 对该模型返回 400 invalid_request_error 后记入。 */
  responsesUnsupported?: ReadonlySet<string>;
  /** Anthropic 对该模型返回 400 invalid_request_error 后记入（同 §5.3 机制）。 */
  anthropicUnsupported?: ReadonlySet<string>;
}

/** 模型是否声明支持 Anthropic wire（静态表 supportedWires）。 */
function supportsAnthropic(facts: ModelFacts): boolean {
  return facts.supportedWires.includes('anthropic');
}

/** 模型是否声明支持 Responses wire。 */
function supportsResponses(facts: ModelFacts): boolean {
  return facts.supportedWires.includes('responses');
}

/** 请求是否携带图像（宿主检测，含 offloaded 块）。 */
function hasImages(options: GenerateOptions): boolean {
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
function anthropicDegrade(
  options: GenerateOptions,
  facts: ModelFacts,
  runtime: WirePlanRuntime,
): { wire: WireKind; reason: WireReason } | undefined {
  if (!supportsAnthropic(facts)) {
    // 静态表未声明该模型支持 Anthropic wire（文档只对已知模型给出 Messages 参数）。
    return { wire: supportsResponses(facts) ? 'responses' : 'chat-completions', reason: 'downgrade-unsupported-model' };
  }
  if (hasImages(options) && !facts.anthropicSupportsImages) {
    // Anthropic 图片块按 api-compatibility-params 记录仅 6.8——但 2026-10-27
    // 真机实测 deepseek-flash / kimi-k3 走 anthropic 发图同样成功（档案已翻
    // true，不再进本分支）。Responses 的 input_image 支持按文档成立（base64
    // /URL，png/jpeg/gif/webp）——本分支现仅剩未实测模型，降级目标按文档
    // 回到 Responses。
    return { wire: 'responses', reason: 'downgrade-image' };
  }
  if (runtime.anthropicUnsupported?.has(options.model) === true) {
    return { wire: 'responses', reason: 'downgrade-runtime-marked' };
  }
  return undefined;
}

/**
 * Responses 段的降级判定（未命中为 undefined）。任一命中即放弃 Responses。
 * §5.2 原四条序即优先级；档位偏离一条在 Anthropic 优先后仍是 Responses 的主因。
 */
function responsesDegrade(
  options: GenerateOptions,
  facts: ModelFacts,
  runtime: WirePlanRuntime,
): { wire: WireKind; reason: WireReason } | undefined {
  if (options.stop !== undefined && options.stop.length > 0) {
    return { wire: 'chat-completions', reason: 'downgrade-stop' };
  }
  if (!supportsResponses(facts)) {
    return { wire: 'chat-completions', reason: 'downgrade-unsupported-model' };
  }
  // 档位拼写先归一（off/minimal→none）：界面发的 off 不该被当成「偏离默认档」，
  // 关闭思考在 responses 上是真实支持的（reasoning.effort:'none'），不该降级。
  const effort = canonicalThinkingEffort(options.reasoningEffort as string | undefined);
  if (effort !== undefined && effort !== 'none' && effort !== facts.responsesDefaultEffort) {
    return { wire: 'chat-completions', reason: 'downgrade-effort' };
  }
  if (runtime.responsesUnsupported?.has(options.model) === true) {
    return { wire: 'chat-completions', reason: 'downgrade-runtime-marked' };
  }
  return undefined;
}

/**
 * 决定本次请求使用的 wire。
 *
 * `chat-completions` 强制模式无判定直达；`anthropic` / `responses` 强制模式命中各自
 * 降级条件时抛 LlmError，消息说明如何切换到 auto 或 chat-completions
 * （spec「强制模式报错」场景，沿用上游约定）。
 */
export function resolveWirePlan(
  options: GenerateOptions,
  config: WirePlanConfig,
  facts: ModelFacts,
  runtime: WirePlanRuntime = {},
): WirePlan {
  const protocol: WireProtocol = config.wireProtocol ?? 'auto';
  if (protocol === 'chat-completions') return { wire: 'chat-completions', reason: 'forced-chat' };

  const anthropicHit = anthropicDegrade(options, facts, runtime);
  const responsesHit = responsesDegrade(options, facts, runtime);

  if (protocol === 'anthropic') {
    if (anthropicHit !== undefined) {
      throw new LlmError(
        `llm-sensenova: wireProtocol "anthropic" cannot serve this request (${anthropicHit.reason})；当前请求在强制 Anthropic 模式下无法保真（${anthropicHit.reason}），请在设置中将 wireProtocol 切换为 "auto"（自动降级 Responses / Chat Completions）或 "chat-completions"`,
        'INVALID_REQUEST',
      );
    }
    return { wire: 'anthropic', reason: 'forced-anthropic' };
  }

  if (protocol === 'responses') {
    if (responsesHit !== undefined) {
      throw new LlmError(
        `llm-sensenova: wireProtocol "responses" cannot serve this request (${responsesHit.reason})；当前请求在强制 Responses 模式下无法保真（${responsesHit.reason}），请在设置中将 wireProtocol 切换为 "auto"（自动降级 Chat Completions）或 "chat-completions"`,
        'INVALID_REQUEST',
      );
    }
    return { wire: 'responses', reason: 'forced-responses' };
  }

  // auto：anthropic → responses → chat-completions。
  if (anthropicHit === undefined) return { wire: 'anthropic', reason: 'anthropic-default' };
  if (anthropicHit.reason === 'downgrade-runtime-marked' || anthropicHit.reason === 'downgrade-unsupported-model') {
    // 模型级不支持（协议本身不可用）：继续沿链走 Responses 的判定。
    if (responsesHit === undefined) return { wire: 'responses', reason: 'responses-default' };
    return { wire: 'chat-completions', reason: responsesHit.reason };
  }
  // 请求级降级（图像等）：目标 wire 由 anthropicDegrade 直接给出（Responses 支持图像）。
  return { wire: anthropicHit.wire, reason: anthropicHit.reason };
}
