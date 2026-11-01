/** 三线 usage → 宿主 TokenUsage（make-responses-default-wire-protocol 3.4 +
 * add-anthropic-wire-protocol）。
 *
 * 字段名映射（§6.7）：input_tokens − cached_tokens → inputTokens（未缓存输入）；
 * input_tokens_details.cached_tokens → cacheReadTokens；
 * output_tokens_details.reasoning_tokens → reasoningTokens；total_tokens 直取。
 * Anthropic 线字段无 details 嵌套：cache_read_input_tokens / cache_creation_input_tokens。
 *
 * 口径实测（2026-10-31，glm-5.2 /v1/responses，同一 body 连打三次）：第 1 发
 * cached_tokens=0，第 2/3 发 cached_tokens=4352，而 input_tokens 恒 4572、
 * total_tokens 恒 4636 = input_tokens + output_tokens —— responses 线 input_tokens
 * **已含** cached_tokens（OpenAI 口径），减去缓存读对齐宿主 inputTokens 的
 * 「未缓存输入」语义。
 * **an 线口径相反（2026-11-01 真机探针定论，probe-an-usage.mjs 判定 C）**：
 * /v1/messages 的 input_tokens **就是未缓存口径**（Anthropic 原生规范）——shot 2/3
 * input=118、cache_read=1536，而 118+1536=1654=shot 1 无缓存时的全量输入，即
 * input_tokens 与 cache_read 是**并列**字段。此前把 responses 的减法推广到 an 线
 * 是错的（机械扫 D1「三线同口径」的误推广）：缓存热时 118−1536 为负、被
 * Math.max(0,…) 钳成 0。an 线 inputTokens **直取 input_tokens**；totalTokens =
 * input + cacheRead + cacheWrite + output（含缓存全口径，与 chat/responses 的
 * 平台 total 对齐——cache_write 按 Anthropic 规范与 input 并列）。
 * chat 线（adapter mapUsage）：cached_tokens 在 prompt_tokens_details 里、
 * prompt_tokens 含缓存（OpenAI 口径），减法正确，不受本定论影响。
 *
 * 本模块零运行时依赖（peer-free，contract 套件直测三线映射——U2 审计 T2：
 * 此前三线 usage 零钉，responses/an 两线映射还锁在 peer 门控块可达面之外）。
 * @module dsh-sensenova-suite/wire/usage
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 缺失/非数返回 undefined（anthropic 合并语义需要区分「没带该字段」与「带了 0」）。 */
function numOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 把 Responses 事件携带的 usage 对象映射为宿主 TokenUsage。 */
export function mapResponsesUsage(usage: Record<string, unknown>): TokenUsage {
  const input = toNumber(usage.input_tokens);
  const output = toNumber(usage.output_tokens);
  const total = toNumber(usage.total_tokens);
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  const cacheRead = inputDetails !== undefined ? toNumber(inputDetails.cached_tokens) : 0;
  const reasoning = outputDetails !== undefined ? toNumber(outputDetails.reasoning_tokens) : 0;
  // 实测 input_tokens 已含 cached_tokens（见模块头注），减去缓存读对齐未缓存输入。
  return {
    inputTokens: Math.max(0, input - cacheRead),
    outputTokens: output,
    totalTokens: total > 0 ? total : input + output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** Anthropic usage → 宿主 TokenUsage（字段名与 Responses 不同：无 details 嵌套）。
 * input_tokens 是未缓存口径（2026-11-01 真机探针定论，见模块头注）——直取，
 * **不做** responses 线的减法（缓存热时会打出负数再被钳成 0）。
 * 从 sse-anthropic.ts 挪入（U2 审计 T2：三线 usage 映射集中 peer-free 直测）。 */
export function mapAnthropicUsage(usage: Record<string, unknown>): TokenUsage {
  const input = numOrUndefined(usage.input_tokens) ?? 0;
  const output = numOrUndefined(usage.output_tokens) ?? 0;
  const cacheRead = numOrUndefined(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = numOrUndefined(usage.cache_creation_input_tokens) ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + cacheRead + cacheWrite + output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/** message_start 全量 + message_delta 增量合并（sse-anthropic 消费；纯函数，
 * 导出供 contract 直测回落与 total 口径语义——U2 审计 T3）。四字段一律
 * 「incoming 带了才取新值，否则沿用旧值」；totalTokens 与首帧 mapAnthropicUsage
 * 同口径（含缓存全口径：未缓存 input + cacheRead + cacheWrite + output——
 * input/cache_read 在 an 线是并列字段，2026-11-01 真机定论）。delta 显式带
 * cache_read=0 的边角：字段刷新为无（0 与缺失在展开形状下同义）。
 */
export function mergeUsage(state: TokenUsage | undefined, incoming: Record<string, unknown>): TokenUsage {
  const next = mapAnthropicUsage(incoming);
  if (state === undefined) return next;
  const inputTokens = numOrUndefined(incoming.input_tokens) !== undefined ? next.inputTokens : state.inputTokens;
  const outputTokens = numOrUndefined(incoming.output_tokens) !== undefined ? next.outputTokens : state.outputTokens;
  const cacheReadTokens = numOrUndefined(incoming.cache_read_input_tokens) !== undefined
    ? next.cacheReadTokens
    : state.cacheReadTokens;
  const cacheWriteTokens = numOrUndefined(incoming.cache_creation_input_tokens) !== undefined
    ? next.cacheWriteTokens
    : state.cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}
