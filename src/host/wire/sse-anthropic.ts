/** Anthropic Messages SSE → 宿主 StreamChunk 翻译（add-anthropic-wire-protocol）。
 *
 * 事件序列（Anthropic 公开规范，商汤文档未单列但实现遵循）：
 * `message_start`（usage）→ `content_block_start` → `content_block_delta`×N →
 * `content_block_stop` → `message_delta`（stop_reason + 增量 usage）→ `message_stop`。
 * 另有 `ping` 心跳与 `error` 事件。
 *
 * 与另两条 wire 的翻译差异：
 * - 块号直接用事件 `index`（无需 output_index/item_id 兜底那套）；
 * - 思考内容走 `thinking` 块（`thinking_delta` 增量），不是摘要；
 * - 工具参数走 `input_json_delta` 的 `partial_json` 增量；
 * - `stop_reason` 是 `end_turn`/`max_tokens`/`stop_sequence`/`tool_use`。
 *
 * 硬约束（参照 Responses 翻译器的既有纪律）：
 * - 没收到 `message_stop` 视为传输中断（不等 `[DONE]`，也不依赖它）；
 * - 一个块都没开 = 空响应。
 * @module dsh-sensenova-suite/wire/sse-anthropic
 */
import { LlmError, errorChain } from '@deepseek-ai/dsh-llm';
import { ANTHROPIC_TRUNCATED_CODE } from '../llm-retry.ts';
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '../brand.ts';
import { traceLog } from '../trace-log.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 解析一行 SSE；返回事件对象；空行/注释行/`[DONE]`/非 JSON/无 type 返回 undefined。 */
function parseAnthropicLine(line: string): Record<string, unknown> | undefined {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === '[DONE]') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  return toString(parsed.type) === undefined ? undefined : parsed;
}

/** Anthropic usage → 宿主 TokenUsage（字段名与 Responses 不同：无 details 嵌套）。 */
export function mapAnthropicUsage(usage: Record<string, unknown>): TokenUsage {
  const input = toNumber(usage.input_tokens) ?? 0;
  const output = toNumber(usage.output_tokens) ?? 0;
  const cacheRead = toNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = toNumber(usage.cache_creation_input_tokens) ?? 0;
  return {
    inputTokens: Math.max(0, input - cacheRead),
    outputTokens: output,
    totalTokens: input + output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/** stop_reason → 宿主 FinishReason（有工具调用时优先 tool-calls）。 */
function finishOf(stopReason: string | undefined, hasToolCall: boolean): FinishReason {
  if (hasToolCall || stopReason === 'tool_use') return { kind: 'tool-calls' };
  if (stopReason === 'max_tokens') return { kind: 'max-tokens' };
  return { kind: 'stop' };
}

/** content_block 的 type → 宿主块类型。 */
function blockTypeOf(wireType: string): 'text' | 'reasoning' | 'tool-call' | undefined {
  if (wireType === 'text') return 'text';
  if (wireType === 'thinking') return 'reasoning';
  if (wireType === 'tool_use') return 'tool-call';
  return undefined;
}

/** 每个未闭合 content block 的累积状态。 */
interface OpenBlock {
  blockType: 'text' | 'reasoning' | 'tool-call';
  content: string;
  id: string | undefined;
  name: string | undefined;
}

interface AnthropicSseState {
  open: Map<number, OpenBlock>;
  usage: TokenUsage | undefined;
  stopReason: string | undefined;
  sawContent: boolean;
  /** 是否见过 tool_use 块（finish 判 tool-calls 用；块可能已闭合，不能只看 open）。 */
  sawToolCall: boolean;
  finished: boolean;
  messageStopped: boolean;
}

function closeBlock(index: number, block: OpenBlock | undefined): StreamChunk[] {
  if (block === undefined) return [];
  if (block.blockType === 'tool-call') {
    const name = block.name ?? '';
    if (name === '') return []; // name 始终未到达的残缺调用不产出 tool-call block
    return [{
      type: 'block-end',
      index,
      block: {
        type: 'tool-call',
        id: ToolCallId(block.id ?? `sensenova-tool-${index}`),
        name,
        arguments: block.content !== '' ? block.content : '{}',
      },
    }];
  }
  return [{
    type: 'block-end',
    index,
    block: block.blockType === 'text'
      ? { type: 'text', text: block.content }
      : { type: 'reasoning', text: block.content },
  }];
}

function closeAllOpen(state: AnthropicSseState): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [index, block] of [...state.open.entries()]) {
    chunks.push(...closeBlock(index, block));
  }
  state.open.clear();
  return chunks;
}

/** 合并 usage（message_start 给全量，message_delta 给增量；后者覆盖前者同名字段）。 */
function mergeUsage(state: AnthropicSseState, incoming: Record<string, unknown>): void {
  const next = mapAnthropicUsage(incoming);
  if (state.usage === undefined) {
    state.usage = next;
    return;
  }
  // 逐字段取新值（缺字段回落旧值）；totalTokens 由合并后的输入/输出重算，恒有定义。
  const inputTokens = toNumber(incoming.input_tokens) !== undefined ? next.inputTokens : state.usage.inputTokens;
  const outputTokens = toNumber(incoming.output_tokens) !== undefined ? next.outputTokens : state.usage.outputTokens;
  state.usage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(next.cacheReadTokens !== undefined ? { cacheReadTokens: next.cacheReadTokens } : {}),
    ...(next.cacheWriteTokens !== undefined ? { cacheWriteTokens: next.cacheWriteTokens } : {}),
  };
}

/** 处理一个 Anthropic 事件，返回宿主 StreamChunk 序列。 */
function processAnthropicEvent(event: Record<string, unknown>, state: AnthropicSseState): StreamChunk[] {
  const type = toString(event.type) ?? '';
  const chunks: StreamChunk[] = [];

  if (type === 'error') {
    const errorRec = isRecord(event.error) ? event.error : undefined;
    const message = toString(errorRec?.message) ?? 'SenseNova returned a stream error';
    throw new LlmError(
      `llm-sensenova: SenseNova Anthropic stream reported an error: ${message}；SenseNova 流式响应报告错误：${message}`,
      'PROVIDER_PROTOCOL_ERROR',
    );
  }

  if (type === 'message_start') {
    const message = isRecord(event.message) ? event.message : undefined;
    const usage = isRecord(message?.usage) ? message.usage : undefined;
    if (usage !== undefined) state.usage = mapAnthropicUsage(usage);
    return chunks;
  }

  if (type === 'content_block_start') {
    const wire = isRecord(event.content_block) ? event.content_block : undefined;
    const blockType = blockTypeOf(toString(wire?.type) ?? '');
    const index = toNumber(event.index);
    if (blockType === undefined || index === undefined) return chunks; // 未知块类型/无 index：忽略
    const initialText = blockType === 'reasoning'
      ? toString(wire?.thinking) ?? ''
      : blockType === 'text'
        ? toString(wire?.text) ?? ''
        : '';
    const block: OpenBlock = {
      blockType,
      content: initialText,
      id: toString(wire?.id),
      name: toString(wire?.name),
    };
    state.open.set(index, block);
    state.sawContent = true;
    if (blockType === 'tool-call') state.sawToolCall = true;
    chunks.push({ type: 'block-start', index, blockType });
    if (initialText !== '') {
      chunks.push(blockType === 'reasoning'
        ? { type: 'reasoning-delta', index, text: initialText }
        : { type: 'text-delta', index, text: initialText });
    }
    // content_block_start 可能直接携带完整 input（罕见但规范允许）。
    if (blockType === 'tool-call') {
      const input = wire?.input;
      const serialized = input !== undefined && JSON.stringify(input) !== '{}' ? JSON.stringify(input) : '';
      if (serialized !== '') {
        block.content = serialized;
        chunks.push({
          type: 'tool-call-delta',
          index,
          id: ToolCallId(block.id ?? `sensenova-tool-${index}`),
          ...(block.name !== undefined && block.name !== '' ? { name: block.name } : {}),
          argumentsDelta: serialized,
        });
      }
    }
    return chunks;
  }

  if (type === 'content_block_delta') {
    const index = toNumber(event.index);
    const block = index !== undefined ? state.open.get(index) : undefined;
    if (index === undefined || block === undefined) return chunks; // 未开块的增量：防御性丢弃
    const delta = isRecord(event.delta) ? event.delta : undefined;
    const value = delta !== undefined
      ? (delta.type === 'thinking_delta' ? toString(delta.thinking)
        : delta.type === 'input_json_delta' ? toString(delta.partial_json)
          : delta.type === 'text_delta' ? toString(delta.text)
            : undefined)
      : undefined;
    if (value === undefined || value === '') return chunks;
    block.content += value;
    if (block.blockType === 'tool-call') {
      chunks.push({
        type: 'tool-call-delta',
        index,
        id: ToolCallId(block.id ?? `sensenova-tool-${index}`),
        ...(block.name !== undefined && block.name !== '' ? { name: block.name } : {}),
        argumentsDelta: value,
      });
    } else if (block.blockType === 'reasoning') {
      chunks.push({ type: 'reasoning-delta', index, text: value });
    } else {
      chunks.push({ type: 'text-delta', index, text: value });
    }
    return chunks;
  }

  if (type === 'content_block_stop') {
    const index = toNumber(event.index);
    if (index === undefined) return chunks;
    const block = state.open.get(index);
    if (block === undefined) return chunks;
    state.open.delete(index);
    chunks.push(...closeBlock(index, block));
    return chunks;
  }

  if (type === 'message_delta') {
    const delta = isRecord(event.delta) ? event.delta : {};
    state.stopReason = toString(delta.stop_reason) ?? state.stopReason;
    const usage = isRecord(event.usage) ? event.usage : undefined;
    if (usage !== undefined) mergeUsage(state, usage);
    return chunks;
  }

  if (type === 'message_stop') {
    state.messageStopped = true;
    return chunks;
  }

  // ping 等其余事件：忽略（心跳由空闲看门狗统一处理）。
  return chunks;
}

/** 判断错误是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason(value: unknown): value is Error {
  return value instanceof Error && value.name === 'TimeoutError';
}

/** 把 Anthropic SSE 响应体翻译为宿主 StreamChunk 序列（结构与另两条 wire 对齐：
 * 空闲看门狗、断尾收口、错误映射）。 */
export async function* parseAnthropicSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
  model?: string,
  sessionId?: string,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  const state: AnthropicSseState = {
    open: new Map(),
    usage: undefined,
    stopReason: undefined,
    sawContent: false,
    sawToolCall: false,
    finished: false,
    messageStopped: false,
  };
  let buffer = '';
  let watchdogReject: ((error: unknown) => void) | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogReject?.(new DOMException(`SenseNova stream idle for ${idleTimeoutMs}ms`, 'TimeoutError'));
    }, idleTimeoutMs);
  };
  const disarmWatchdog = () => {
    if (watchdogTimer !== undefined) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  };

  try {
    for (;;) {
      const read: ReadableStreamReadResult<Uint8Array> = await new Promise((resolve, reject) => {
        watchdogReject = reject;
        reader.read().then(resolve, reject);
        armWatchdog();
      });
      disarmWatchdog();
      const { done, value } = read;
      if (done) break;
      bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseAnthropicLine(line);
        if (event === undefined) continue; // 含 [DONE]：不识别也不等待
        if (state.finished) continue;
        for (const chunk of processAnthropicEvent(event, state)) {
          yield chunk;
          if (chunk.type === 'finish') state.finished = true;
        }
      }
    }
    if (buffer.trim() !== '') {
      const event = parseAnthropicLine(buffer);
      if (event !== undefined && !state.finished) {
        for (const chunk of processAnthropicEvent(event, state)) {
          yield chunk;
          if (chunk.type === 'finish') state.finished = true;
        }
      }
    }
    if (!state.finished) {
      if (!state.messageStopped) {
        // 流断尾（无 message_stop）：Anthropic 客户端严格依赖该终止事件，
        // 缺失即视为传输中断，而非静默收口。专用码 ANTHROPIC_TRUNCATED（在
        // llm-retry 的 retryableCodes 里显式可重试）供两层消费：宿主重试层重试，
        // 适配器按码做内存级换线降级（anthropicUnsupported，见 adapter.ts）。
        throw new LlmError(
          'llm-sensenova: SenseNova Anthropic stream ended before message_stop；SenseNova 流式响应在 message_stop 之前中断，重试通常可恢复',
          ANTHROPIC_TRUNCATED_CODE,
        );
      }
      for (const chunk of closeAllOpen(state)) yield chunk;
      if (!state.sawContent) {
        throw new LlmError('llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复', 'EMPTY_RESPONSE');
      }
      if (state.usage !== undefined) yield { type: 'usage', usage: state.usage };
      yield {
        type: 'finish',
        reason: finishOf(state.stopReason, state.sawToolCall),
      };
    }
  } catch (error) {
    // 流级失败每个落一行（trace-log 是桌面端唯一排障出口：宿主 stdout 被主进程
    // 接管，聊天里看到的断尾/停摆/平台 error 事件必须在诊断文件里有对应行）。
    // 超壳 abort（用户离开、重试层换请求）是我们自己的取消，不落。
    if ((signal?.aborted && isTimeoutReason(signal.reason)) || isTimeoutReason(error)) {
      traceLog(`[dsh-sensenova-suite] anthropic 流停摆/超时 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B → TIMEOUT`);
      throw new LlmError(
        `llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`,
        'TIMEOUT',
        { cause: error },
      );
    }
    if (signal?.aborted) throw error;
    if (error instanceof LlmError) {
      // 平台 error 事件 / 断尾 / 空响应都从这里过，完整消息原样落盘。
      traceLog(`[dsh-sensenova-suite] anthropic 流失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${error.message}`);
      throw error;
    }
    traceLog(`[dsh-sensenova-suite] anthropic 流中途失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${errorChain(error)} → TRANSPORT`);
    throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, 'TRANSPORT', { cause: error });
  } finally {
    disarmWatchdog();
    await reader.cancel().catch(() => void 0);
    reader.releaseLock();
  }
}
