/**
 * Fallback ambient for @deepseek-ai/dsh-llm — used ONLY when the real type
 * tree is unavailable (a clean clone: the package ships inside the DSH Host
 * and is not installable from any public registry).
 *
 * Declares every name the suite imports, with the RUNTIME-critical shapes
 * spelled out (LlmAdapter base members the adapter overrides; LlmError's
 * message/code constructor) and the data types as honest `any` aliases —
 * the local deep-check (tsconfig.local.json, gitignored, real type tree)
 * is where those get real scrutiny.
 */
declare module "@deepseek-ai/dsh-llm" {
  /** 适配器基类：五个被 override 的成员按宿主形状声明（其余为 any）。 */
  export class LlmAdapter {
    providerInfo?(...args: unknown[]): unknown;
    providerRetryPolicy?(...args: unknown[]): unknown;
    listModels?(...args: unknown[]): unknown;
    resolveModel?(...args: unknown[]): unknown;
    stream?(...args: unknown[]): unknown;
  }
  export class LlmError extends Error {
    constructor(message: string, code?: string, options?: { cause?: unknown; status?: number; body?: string });
    code?: string;
  }
  /** 归一化思考档位（值函数）；同为类型别名。 */
  export const ReasoningEffortId: ((value: unknown) => any) & { readonly __type: any };
  export type ReasoningEffortId = string;
  export const attributionHeaders: (...args: unknown[]) => Record<string, string>;
  export const errorChain: (error: unknown) => string;
  export const projectImagesForTextModel: (messages: unknown, ...rest: unknown[]) => any;
  export const resolveRetryPolicy: (config: unknown, label: string) => unknown;
  export const contentHasImage: (content: unknown) => boolean;
  export const offloadedImageText: (...args: unknown[]) => string;
  export const textOnlyImageText: (...args: unknown[]) => string;
  export type ToolCallId = string;
  export type HostToolCallId = string;
  export type FinishReason = any;
  export interface GenerateOptions {
    model: string;
    messages: Array<{ role?: string; content: ContentBlock[]; toolCallId: string; [key: string]: unknown }>;
    tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
    sessionId?: string;
    signal?: AbortSignal;
    system?: string;
    stop?: string | string[];
    maxTokens?: number;
    temperature?: number;
    [key: string]: unknown;
  }
  export type LlmModelInfo = any;
  export type LlmModelReasoningInfo = any;
  export type LlmProviderInfo = any;
  export type LlmResolvedModelInfo = any;
  export type ModelModality = any;
  export type ResolvedRetryPolicy = any;
  export type StreamChunk = any;
  export type TokenUsage = any;
  export type ContentBlock = any;
  export type ImageBlock = any;
  export type ToolCallBlock = any;
}
