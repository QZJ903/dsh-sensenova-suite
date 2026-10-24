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
  return { system: system !== '' ? system : undefined, messages };
}

/**
 * 组装 /messages 请求体。
 *
 * effort 出站策略（与 Chat 路径同一套域判定）：
 * - `none` → `thinking: {type:'disabled'}`，不发 effort（文档明确二者为关闭思考的两种表达）；
 * - 其余档位 → `output_config: {effort}`，仅当值落在该模型 effort 词表内；
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

  // 档位词表：目录 reasoning.efforts 优先，静态表兜底；两者皆空 = 未知，不发（不发未知值）。
  const catalogEfforts = entry?.reasoning?.efforts.map((effort) => effort.id as string);
  const effortDomain = catalogEfforts ?? (facts.efforts.length > 0 ? facts.efforts : undefined);
  const effort = options.reasoningEffort as string | undefined;
  const thinkingDisabled = effort === 'none';
  const effortWire = !thinkingDisabled
    && effort !== undefined
    && (effortDomain === undefined || effortDomain.includes(effort))
    ? effort
    : undefined;

  // temperature：显式设置才发；kimi-k3 固定 1，出站不发（与 Chat 路径同一纪律）。
  const sendTemperature = options.temperature !== undefined && !facts.blockedSampling.includes('temperature');

  return {
    model,
    messages,
    stream: true,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(system !== undefined ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(sendTemperature ? { temperature: options.temperature } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: options.stop } : {}),
    ...(thinkingDisabled ? { thinking: { type: 'disabled' } } : {}),
    ...(effortWire !== undefined ? { output_config: { effort: effortWire } } : {}),
  };
}

/** max_tokens 缺省值：Anthropic 协议必填，宿主未显式设置时给一个安全默认。 */
export const DEFAULT_MAX_TOKENS = 4096;
