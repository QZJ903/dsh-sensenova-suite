/** Responses 请求体构造（make-responses-default-wire-protocol 2.x）。
 *
 * 协议纪律（§5.4，spec 硬约束）：绝不发送 store / background /
 * previous_response_id / truncation / include；不发 stop（决策表命中即降级 Chat）；
 * 多轮历史全部由本地 input 数组携带；tools 只用扁平 function 形态。
 *
 * 「省略优于传无效值」：reasoning.effort 仅在 none 时显式发送（其余档位在
 * Responses 上是空操作——等于默认档不发、偏离默认档由 plan 降级 Chat）。
 * @module dsh-sensenova-suite/wire/body-responses
 */
import type { ContentBlock, GenerateOptions, ToolCallBlock } from '@deepseek-ai/dsh-llm';
import { factsFor } from './facts.ts';
import { translateUserContent, type PreparedImage } from './blocks.ts';
import { canonicalThinkingEffort } from './effort.ts';
import type { FactsCatalogEntry } from './types.ts';

/** Responses 推理摘要配置（reasoning.summary，默认 auto）。 */
export type ReasoningSummary = 'auto' | 'concise' | 'detailed';

/** buildResponsesBody 的配置侧输入。 */
export interface ResponsesBodyConfig {
  reasoningSummary?: ReasoningSummary | undefined;
}

function flattenText(message: { content: readonly ContentBlock[] }): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => block.type === 'text' ? block.text : '')
    .join('');
}

type ResponsesInputItem = Record<string, unknown>;

/**
 * 把宿主消息历史映射为 Responses input 数组（§6.5）：
 * - system 消息与 options.system 合并为顶层 instructions；
 * - user 文本 → {type:'message',role:'user',content:[{type:'input_text',text}]}；
 * - assistant 文本 → {type:'message',role:'assistant',content:[{type:'output_text',text}]}；
 * - assistant tool-call → {type:'function_call',call_id,name,arguments}；
 * - tool-result → {type:'function_call_output',call_id,output}。
 *
 * role 条目恒带 type:'message'（2026-11-04 他拍板方案一）：真机 400 实证——
 * 混入 function 项的数组里 role 条目缺 type 即 "missing input.type"（param=
 * input.type，code=MissingParameter）。文档两套形状并存（基础/多轮/图像示例
 * 不带，工具流示例全带）且对「tools 在场但数组尚无 function 项」的第 1 轮
 * 沉默——无条件补齐消除漏判窗口。
 *
 * 坏历史 tool_call 四防御与 Chat 路径一致（tasks 2.1）：空 name 丢弃（含孤立
 * tool-result）、arguments 空串补 '{}'、id 空串/超长（平台限 1–64，2026-10-31
 * 真机 400 实证）合成 sensenova-sanitized-N、
 * 映射不到 call_id 的 tool-result 丢弃。
 */
export function toResponsesInput(options: GenerateOptions, images?: Map<string, PreparedImage> | undefined): { instructions: string | undefined; input: ResponsesInputItem[] } {
  const systemParts: string[] = [];
  if (options.system !== undefined && options.system !== '') systemParts.push(options.system);
  for (const message of options.messages) {
    if (message.role === 'system') systemParts.push(flattenText(message));
  }
  const instructions = systemParts.filter(Boolean).join('\n\n');

  const input: ResponsesInputItem[] = [];
  const toolCallIdRemap = new Map<string, string>();
  let syntheticToolCallSeq = 0;
  for (const message of options.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant') {
      const text = flattenText(message);
      const toolCalls = message.content.filter((block: ContentBlock): block is ToolCallBlock => block.type === 'tool-call');
      let emitted = false;
      for (const call of toolCalls) {
        if (call.name === '' || call.name === undefined) continue; // 空 name 失败调用丢弃（含其孤立结果）
        syntheticToolCallSeq += 1;
        // 平台约束 call_id 长度 1–64（真机 400 实证：宿主侧超长 id 原样透传被拒
        // "Invalid 'call_id'… between 1 and 64"）。空串/超长一律合成短 id——
        // remap 表保证 function_call 与其 output 用同一 id，关联不断。
        const keptId = call.id !== '' && call.id !== undefined && call.id.length <= 64
          ? call.id
          : `sensenova-sanitized-${syntheticToolCallSeq}`;
        toolCallIdRemap.set(call.id, keptId);
        input.push({
          type: 'function_call',
          call_id: keptId,
          name: call.name,
          arguments: call.arguments !== '' && call.arguments !== undefined ? call.arguments : '{}',
        });
        emitted = true;
      }
      if (text !== '') {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
        emitted = true;
      }
      if (!emitted) continue; // 空壳 assistant 消息
      continue;
    }
    if (message.role === 'tool') {
      // 只保留能映射到已回放 function_call 的结果（孤立 tool-result 丢弃，避免 400）。
      const remappedId = toolCallIdRemap.get(message.toolCallId);
      if (remappedId === undefined) continue;
      input.push({
        type: 'function_call_output',
        call_id: remappedId,
        output: toolResultText(message.content) || '(no output)',
      });
      continue;
    }
    // user 角色：无图像保持纯文本现状；有图像经 blocks.ts 翻译（input_image 扁平形态）。
    const content = translateUserContent(message.content, 'responses', images);
    if (typeof content === 'string') {
      if (content !== '') input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] });
    } else if (content.length > 0) {
      input.push({ type: 'message', role: 'user', content });
    }
  }
  return { instructions: instructions !== '' ? instructions : undefined, input };
}

/**
 * 组装 /responses 请求体。max_output_tokens 按 responsesMaxOutputTokens 钳制
 * （含推理 token；上限缺失回退 Chat 档 outputLimitMax，deepseek-flash 文档未列
 * responses 上限 = null，保守回退待实测）。
 */
export function buildResponsesBody(
  options: GenerateOptions,
  entry: FactsCatalogEntry | undefined,
  config: ResponsesBodyConfig = {},
  images?: Map<string, PreparedImage> | undefined,
): Record<string, unknown> {
  const model = options.model;
  const facts = factsFor(model, entry);
  // responsesMaxOutputTokens（§3.2 范围表）优先；null（如 deepseek-flash）保守回退
  // Chat 档 outputLimitMax（目录 max_output_length 优先于静态值，factsFor 已合并）。
  const outputLimit = facts.responsesMaxOutputTokens ?? facts.outputLimitMax;
  const { instructions, input } = toResponsesInput(options, images);
  const tools = ((options.tools ?? []) as Array<{ name: string; description?: string; parameters?: unknown }>).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  // temperature 仅在用户显式设置时发送（未设时采用 Responses 默认 0.6，与 Chat
  // 默认 1 不同，是能力损失提示之一）；kimi-k3 固定 temperature=1，出站不发。
  const sendTemperature = options.temperature !== undefined && !facts.blockedSampling.includes('temperature');

  // 「关闭」要显式发 reasoning.effort:'none'（官方文档：设为 none 可关闭思考模式）；
  // 档位拼写先归一（off/minimal→none，wire/effort.ts）——旧实现只认 'none'，界面
  // 发的 off 会整个省略 reasoning 字段，关闭静默变成「用模型默认」。非 none 档位
  // 是空操作（文档：low/medium/high/xhigh 传入无效）且偏离默认档已降级 Chat，
  // 此处只会见到 none / 等于默认 / 未选三种。
  const effort = canonicalThinkingEffort(options.reasoningEffort as string | undefined);
  const reasoning = effort === 'none'
    ? { effort: 'none', summary: config.reasoningSummary ?? 'auto' }
    : undefined;

  return {
    model,
    input,
    stream: true,
    ...(instructions !== undefined ? { instructions } : {}),
    ...(sendTemperature ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined && outputLimit !== null
      ? { max_output_tokens: Math.min(options.maxTokens, outputLimit) }
      : options.maxTokens !== undefined
        ? { max_output_tokens: options.maxTokens }
        : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}
