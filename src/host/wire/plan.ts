/** wire 协议决策（per-model-protocol-chain：全量降级链，2026-10-30 用户拍板）。
 *
 * 每个模型恒有一条降级链（有序子集，≤3），生效链按层合成：
 *
 * ```
 * 面板覆盖（pool.json modelProtocols[model]）
 *   ?? wireProtocol 配置（强制值映射为单线链；auto = 档案默认）
 *   ?? 档案默认链（facts.defaultChain：全模型统一 re>an>chat，2026-10-31）
 * ```
 *
 * 决策 = 沿生效链走查：第一条「模型声明支持（supportedWires 求交）且未命中
 * 该线降级条件」的线服务。链上所有线都覆盖不了该请求时，落**全局兜底链**
 * `["chat-completions"]`——chat 是三线中表达最全的参考方言（上游 §二原表），
 * 无降级条件，常态下不再出现「链耗尽报错」；真报错的只剩 chat 自身失败。
 *
 * 旧「强制模式报错」语义（forced 命中降级条件抛错）随本模型退役：单线链
 * 命中降级条件同样落 chat 兜底——用户已拍板「不至于一直报错」。
 *
 * 各线降级条件（未变，链走查逐线调用）：
 * - Anthropic：模型不支持（supportedWires）/ 带图且档案不支持 / 关闭拼写在 an
 *   线无表达（forbidThinkingDisabled 模型勾 off——2026-11-01 拍板「用户选择
 *   大于协议」，显式跳过而非静默失效）/ 运行时 400 标记（anthropicUnsupported）。
 *   `stop` 不是 Anthropic 的降级条件
 *   （#api-compatibility-params 明确支持 stop_sequences）。
 * - Responses：stop 非空 / 模型不支持 / effort 偏离 Responses 默认档（非 none，
 *   off/minimal 归一为 none）/ 运行时 400 标记（responsesUnsupported）。
 * - Chat：无降级条件（参考方言）。
 * @module dsh-sensenova-suite/wire/plan
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { contentHasImage } from '@deepseek-ai/dsh-llm';
import { canonicalThinkingEffort } from './effort.ts';
import { effectiveChain, GLOBAL_FALLBACK_CHAIN } from './chain.ts';
import type { ModelFacts, WireKind } from './types.ts';

/** 插件配置的四种 wire 模式（auto = 档案默认链；三个强制值 = 单线链）。 */
export type WireProtocol = 'auto' | 'anthropic' | 'responses' | 'chat-completions';

/** 决策结果附带的原因标识（供日志与测试断言）。 */
export type WireReason =
  | 'anthropic-default'
  | 'responses-default'
  | 'chat-default'
  | 'chain-fallback'
  | 'downgrade-unsupported-model'
  | 'downgrade-image'
  | 'downgrade-effort-unsupported'
  | 'downgrade-stop'
  | 'downgrade-effort'
  | 'downgrade-runtime-marked';

export interface WirePlan {
  wire: WireKind;
  reason: WireReason;
  /** 本次决策实际走查的生效链（面板 400 下一跳沿它取）。 */
  chain: readonly WireKind[];
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
 * 链走查只消费命中/未命中——返回里的终点 wire 是旧自动链的遗形，不再被读。
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
  // 用户拍板（2026-11-01「用户选择大于协议」）：禁 disabled 的模型（glm-5.2——
  // 文档明写 thinking.type=disabled 传入即失败，output_config.effort 词表无 none，
  // an 线没有可用的关闭表达）勾 off 时不留在 an 静默失效，显式跳过落下一线
  // （responses/chat 都有合法关闭表达）。与 downgrade-image 同形状：线表达不了的
  // 请求特征换线；钉链的语义本就是「优先且允许降级」。off 唯一触发——其余档位
  // 在 an 词表内原样发。未选档位（undefined）归一后非 none，不跳。
  if (facts.forbidThinkingDisabled && canonicalThinkingEffort(options.reasoningEffort as string | undefined) === 'none') {
    return { wire: supportsResponses(facts) ? 'responses' : 'chat-completions', reason: 'downgrade-effort-unsupported' };
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

/** 链上服务线的原因词（同一形状服务面板链与档案默认链）。 */
function servedReason(wire: WireKind): WireReason {
  if (wire === 'anthropic') return 'anthropic-default';
  if (wire === 'responses') return 'responses-default';
  return 'chat-default';
}

/**
 * 沿生效链走查：第一条「模型声明支持且未命中该线降级条件」的线服务；
 * 全链覆盖不了该请求 → 全局兜底 chat（用户拍板「不至于一直报错」）；
 * 连 chat 都不在模型能力面（理论上不存在，档案全含 chat）才真正抛错。
 */
function walkChain(
  options: GenerateOptions,
  facts: ModelFacts,
  runtime: WirePlanRuntime,
  chain: readonly WireKind[],
): WirePlan {
  for (let index = 0; index < chain.length; index += 1) {
    const wire = chain[index]!;
    if (!facts.supportedWires.includes(wire)) continue;
    const hit = wire === 'anthropic'
      ? anthropicDegrade(options, facts, runtime)
      : wire === 'responses'
        ? responsesDegrade(options, facts, runtime)
        : undefined; // chat：参考方言，无降级条件
    // 走查只消费 hit 的命中/未命中：hit 里的 reason 词（downgrade-*）不入返回——
    // 服务 reason 恒为 servedReason(wire)（chain-fallback 除外，兜底分支显式覆盖）。
    // 生产消费面只有 plan.wire 与 plan.chain（adapter），WireReason 的降级词目前
    // 只活在类型与测试钉里（U2 审计顺带 5，2026-11-01 扩记）。
    if (hit !== undefined) continue;
    return { wire, reason: servedReason(wire), chain };
  }
  if (!facts.supportedWires.includes('chat-completions')) {
    throw new LlmError(
      `llm-sensenova: wire chain [${chain.join(' > ')}] cannot serve model "${options.model}" (exhausted, chat not in supportedWires)；模型降级链耗尽且能力面不含 chat，无法服务`,
      'INVALID_REQUEST',
    );
  }
  // 链耗尽 → 全局兜底链（单 chat，无降级条件，恒可服务）。reason 单列为
  // chain-fallback：它告诉读者「该模型自己的链覆盖不了这个请求」。chain 一并
  // 覆盖为兜底链——adapter 的 400 下一跳按 plan.chain.indexOf(wire) 寻址，
  // 兜底链使 chat 命中 0、无下一跳，不会同线重试（U2 审计已核对 4）。
  const fallback = walkChain(options, facts, runtime, GLOBAL_FALLBACK_CHAIN);
  return { ...fallback, reason: 'chain-fallback' };
}

/**
 * 决定本次请求使用的 wire。
 *
 * @param modelChain - 面板对该模型的链覆盖（pool.json modelProtocols[model]，
 *   有序子集；undefined/空/非法 = 无覆盖，按配置与档案默认合成）。
 */
export function resolveWirePlan(
  options: GenerateOptions,
  config: WirePlanConfig,
  facts: ModelFacts,
  runtime: WirePlanRuntime = {},
  modelChain?: readonly unknown[],
): WirePlan {
  return walkChain(options, facts, runtime, effectiveChain(config, facts, modelChain));
}
