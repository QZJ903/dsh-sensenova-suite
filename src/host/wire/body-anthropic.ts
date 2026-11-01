/** Anthropic Messages 请求体构造（add-anthropic-wire-protocol；
 * 商汤官方文档 #api-compatibility / #api-compatibility-thinking / #api-compatibility-params）。
 *
 * 与另两条 wire 的形状差异（全部以官方文档为准）：
 * - `system` 是**顶层字段**（字符串或内容块数组），不是 messages 里的一条；
 * - `max_tokens` 走 Anthropic 原生名（不按模型分派 max_completion_tokens）；
 * - 思考档位用 `output_config.effort`（low/medium/high/xhigh/max，默认 high）；
 *   关闭思考用 `thinking: {type:"disabled"}`；
 * - 工具是扁平 `{name, description, input_schema}`，无 type 层；
 * - 图片是 `{type:'image', source:{type:'base64',media_type,data}}` 或
 *   `source:{type:'url', url}`；
 * - 停止序列叫 `stop_sequences`；
 * - 多轮只回传 content，**不回传思维链**（文档「参数推荐」）。
 *
 * 注意：本网关的 `/v1/messages` 用 `Authorization: Bearer` 鉴权（与 OpenAI 兼容
 * 接口共用 key），**不是** Anthropic 原生的 `x-api-key`——鉴权由 adapter 统一处理。
 * @module dsh-sensenova-suite/wire/body-anthropic
 */
import type { ContentBlock, GenerateOptions, ToolCallBlock } from '@deepseek-ai/dsh-llm';
import { factsFor } from './facts.ts';
import { translateUserContent, type PreparedImage } from './blocks.ts';
import { anthropicEffortOut } from './effort.ts';
import type { FactsCatalogEntry } from './types.ts';

/** 目录条目的 Anthropic 侧输入（adapter CatalogEntry 的结构子集，避免循环依赖）。 */
export interface AnthropicCatalogEntry {
  reasoning?: { efforts: readonly { id: string }[] };
  supportedSamplingParameters?: readonly string[];
}

function flattenText(message: { content: readonly ContentBlock[] }): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => block.type === 'text' ? block.text : '')
    .join('');
}

/** tool-call 的 arguments 字符串 → Anthropic 的 input 对象（解析失败给 {}）。 */
function argumentsOf(value: string): Record<string, unknown> {
  if (value === '' || value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

type AnthropicContentItem = Record<string, unknown>;

/** content 是否为「全 tool_result 块」的数组（并行工具结果消息的唯一形状）。 */
function isToolResultContent(content: unknown): content is Array<Record<string, unknown>> {
  return Array.isArray(content) && content.length > 0
    && content.every((item) => typeof item === 'object' && item !== null
      && (item as Record<string, unknown>).type === 'tool_result');
}

/**
 * Anthropic 要求 user/assistant 严格交替，且同一轮的多个 tool_result 应载于
 * 同一条 user 消息（Anthropic 公开规范；商汤文档无 /v1/messages 工具章节，
 * 兼容层宽松度未知——U2 审计疑似 1）。宿主并行工具循环逐条发 role:'tool'，
 * 直译产出连续多条 user：一条内容里两个 tool_use、两条 user 各载一个
 * tool_result——严格执行交替的平台会拒收。此处把相邻的全 tool_result user
 * 消息合并成一条（多块 tool_result 并列），消除「平台必须宽松」这一前提；
 * 普通 user 文本/图消息不含 tool_result 块，不受影响（U2 拍板落地轮，
 * 2026-11-01）。
 */
function mergeAdjacentToolResults(messages: Array<{ role: string; content: unknown }>): void {
  const merged: Array<{ role: string; content: unknown }> = [];
  for (const message of messages) {
    const prev = merged[merged.length - 1];
    if (message.role === 'user' && isToolResultContent(message.content)
        && prev !== undefined && prev.role === 'user' && isToolResultContent(prev.content)) {
      (prev.content as Array<Record<string, unknown>>).push(...(message.content as Array<Record<string, unknown>>));
      continue;
    }
    merged.push(message);
  }
  messages.length = 0;
  messages.push(...merged);
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
function toAnthropicMessages(
  options: GenerateOptions,
  images: Map<string, PreparedImage> | undefined,
): { system: string | undefined; messages: Array<{ role: string; content: unknown }> } {
  const systemParts: string[] = [];
  if (options.system !== undefined && options.system !== '') systemParts.push(options.system);
  for (const message of options.messages) {
    if (message.role === 'system') systemParts.push(flattenText(message));
  }
  const system = systemParts.filter(Boolean).join('\n\n');

  const messages: Array<{ role: string; content: unknown }> = [];
  const toolCallIdRemap = new Map<string, string>();
  let syntheticToolCallSeq = 0;
  for (const message of options.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant') {
      const text = flattenText(message);
      const toolCalls = (message.content as ContentBlock[]).filter((block): block is ToolCallBlock => block.type === 'tool-call');
      const content: AnthropicContentItem[] = [];
      for (const call of toolCalls) {
        if (call.name === '' || call.name === undefined) continue; // 空 name 失败调用丢弃（含其孤立结果）
        syntheticToolCallSeq += 1;
        const keptId = call.id !== '' && call.id !== undefined ? call.id : `sensenova-sanitized-${syntheticToolCallSeq}`;
        toolCallIdRemap.set(call.id, keptId);
        content.push({
          type: 'tool_use',
          id: keptId,
          name: call.name,
          input: argumentsOf(call.arguments),
        });
      }
      if (text !== '') content.push({ type: 'text', text });
      if (content.length === 0) continue; // 空壳 assistant 消息
      messages.push({ role: 'assistant', content });
      continue;
    }
    if (message.role === 'tool') {
      const remappedId = toolCallIdRemap.get(message.toolCallId);
      if (remappedId === undefined) continue; // 孤立 tool-result 丢弃
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: remappedId,
          content: toolResultText(message.content) || '(no output)',
        }],
      });
      continue;
    }
    const content = translateUserContent(message.content, 'anthropic', images);
    if (typeof content === 'string') {
      if (content !== '') messages.push({ role: 'user', content });
    } else if (content.length > 0) {
      messages.push({ role: 'user', content });
    }
  }
  mergeAdjacentToolResults(messages);
  return { system: system !== '' ? system : undefined, messages };
}

/**
 * 组装 /messages 请求体。
 *
 * effort 出站策略（2026-10-27 按平台词表收紧，判定在 wire/effort.ts）：
 * - 「关闭思考」的任何方言拼写（面板 off / chat 方言 none / 静态表 minimal）→
 *   `thinking: {type:'disabled'}`，不发 effort（文档：关闭思考的两种表达之一）；
 *   档案 forbidThinkingDisabled 的模型除外（glm-5.2——文档 GLM-5.2 段明写
 *   「thinking.type 不支持 disabled，传入该值将导致请求失败」）：an 线没有可用的
 *   关闭表达（output_config.effort 词表无 none，真机 400 原文），不发任何思考
 *   字段 = 保持平台默认开思考；
 * - 其余档位 → `output_config: {effort}`，仅接受平台枚举的五个值，词表外
 *   一律不发（不发未知值，绝不上桌让平台打 400）；
 * - 未选档位 → 两者都不发（网关默认 enabled + effort=high，即「用模型默认」）。
 */
export function buildAnthropicBody(
  options: GenerateOptions,
  entry: AnthropicCatalogEntry | undefined,
  images?: Map<string, PreparedImage> | undefined,
): Record<string, unknown> {
  const model = options.model;
  const facts = factsFor(model, entry as FactsCatalogEntry | undefined);
  const { system, messages } = toAnthropicMessages(options, images);
  const tools = ((options.tools ?? []) as Array<{ name: string; description?: string; parameters?: unknown }>).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));

  const { thinkingDisabled, effortWire } = anthropicEffortOut(options.reasoningEffort as string | undefined);
  // 禁 disabled 的模型（glm-5.2）：不发 thinking、也不发 effort（none 拼写下
  // effortWire 本就 undefined）——此前无条件发 disabled，glm 勾 off 走 an 线必 400
  // 并被误标 anthropicUnsupported（U2 审计 D1，2026-11-01）。2026-11-01 拍板后
  // plan 走查已在该组合下显式跳过 an（downgrade-effort-unsupported），本判定退为
  // 第二道防线（含未来新档案模型），两层语义一致：不发任何思考字段。
  const sendThinkingDisabled = thinkingDisabled && !facts.forbidThinkingDisabled;

  // temperature：显式设置才发；kimi-k3 固定 1，出站不发（与 Chat 路径同一纪律）。
  const sendTemperature = options.temperature !== undefined && !facts.blockedSampling.includes('temperature');

  return {
    model,
    messages,
    stream: true,
    // max_tokens 非必填（官方文档 /messages 请求参数表：必填列「—」、无默认值）。
    // 宿主未给时不发而非填兜底值——填值会把输出悄悄掐在兜底数上（模型默认 64K），
    // 省略 = 用平台/模型默认。2026-10-27 旧实现在「必填」的错误前提下常驻 4096。
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(system !== undefined ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(sendTemperature ? { temperature: options.temperature } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: options.stop } : {}),
    ...(sendThinkingDisabled ? { thinking: { type: 'disabled' } } : {}),
    ...(effortWire !== undefined ? { output_config: { effort: effortWire } } : {}),
  };
}
