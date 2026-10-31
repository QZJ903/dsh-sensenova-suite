/** Responses usage → 宿主 TokenUsage（make-responses-default-wire-protocol 3.4）。
 *
 * 字段名映射（§6.7）：input_tokens − cached_tokens → inputTokens（未缓存输入）；
 * input_tokens_details.cached_tokens → cacheReadTokens；
 * output_tokens_details.reasoning_tokens → reasoningTokens；total_tokens 直取。
 *
 * 口径实测（2026-10-31，glm-5.2 /v1/responses，同一 body 连打三次）：第 1 发
 * cached_tokens=0，第 2/3 发 cached_tokens=4352，而 input_tokens 恒 4572、
 * total_tokens 恒 4636 = input_tokens + output_tokens —— input_tokens **已含**
 * cached_tokens（若为未缓存口径 total 应为 8988）。初版「直取」会把缓存命中
 * 部分多报进未缓存输入（缓存热时 ≈20 倍），现减去缓存读对齐宿主 inputTokens
 * 的「未缓存输入」语义，与 adapter.ts mapUsage（chat 线）、sse-anthropic.ts
 * mapAnthropicUsage（anthropic 线）三线同口径。
 * @module dsh-sensenova-suite/wire/usage
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
