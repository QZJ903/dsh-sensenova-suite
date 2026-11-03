/**
 * SenseNova（OpenAI 兼容）provider 适配器（host 侧）。
 *
 * 复用参考插件 @mars-sea/dsh-commandcode-provider 的适配器结构，但只保留
 * OpenAI 兼容的目录拉取与 SSE 流式翻译，外加「流开始前的 401 账号轮换」
 * （429 不轮换：一个会话固定一个 key，保护服务端按 key 命中的 prompt 缓存，
 * 429 交由宿主重试层退避后原 key 重试）。
 * 与 pi-ai 的 `toStreamChunks` 不同，这里直接消费 OpenAI SSE（`data:` 行、
 * `[DONE]`、`choices[].delta`、`finish_reason`、`usage`），不引入第三方流库。
 *
 * 适配器刻意不依赖 cordis/schemastery：每请求的连接事实与 key 解析/轮换
 * 全部通过构造注入，node 测试可直接驱动。
 *
 * @module dsh-sensenova-suite/adapter
 */
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  attributionHeaders,
  errorChain,
  projectImagesForTextModel,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm';
import { ToolCallId } from './brand.ts';
import type {
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm';
import { parseRetryAfterMs, classify429Body, classify429Full, bucketCountsStrike, probeFloorFor, summarize429Body, PROVIDER_RETRY_AFTER_CAP_MS } from './rate-classify.ts';
import { shouldRotateUnclassified } from './key-health.ts';
import { retryableCodes, ANTHROPIC_TRUNCATED_CODE, QUOTA_CODES, LLM_CODES } from './llm-retry.ts';
import { MODELS_TIMEOUT_MS, CATALOG_FAILURE_RETRY_MS, planCatalogFetch } from './catalog-gate.ts';
import { DEFAULT_QUEUE_TIMEOUT_MS, KeyedConcurrencyGate, type Release } from './concurrency.ts';
import { KNOWN_UNROUTABLE_MODELS, CONTEXT_WINDOW_FIELDS, MAX_OUTPUT_FIELDS, maxTokensForId, contextWindowForId } from './llm-models.ts';
import { IMAGE_INPUT_MODALITIES, inputModalitiesFor } from './modality.ts';
import { traceLog } from './trace-log.ts';
import { maskKey } from './util.ts';

/**
 * 目录缺上下文字段时的兜底窗（131072）移到 llm-models.FALLBACK_CONTEXT_WINDOW：
 * 面板 badge 与 resolveModel 引用同一常量（D1——两处各写一个数字曾分叉
 * 128k/131072），本文件经 import 使用。
 */
/**
 * 配额类 429 退避指导（providerRetryAfterMs）的绝对上限（毫秒）：与
 * PROVIDER_RETRY_AFTER_CAP_MS（即重试策略单次延迟上限）一致。宿主 dsh-llm-retry
 * （normal 模式）在 providerRetryAfterMs 超过单次延迟上限时会直接放弃重试，封顶
 * 对齐后保证任何采用值都会被宿主按指导延迟重试；不影响统一退避梯（3–30s）
 * 各档的正常取值。 */
export const QUOTA_RETRY_AFTER_CEILING_MS = PROVIDER_RETRY_AFTER_CAP_MS;
/** 轮间抖动等待窗口（毫秒）：3 轮全 429 之后、第 4 轮之前等一次，每请求独立算。
 * 目的是避免多个并发请求同时结束等待、造成第二波请求洪峰（2026-11-02 他拍板）。 */
const JITTER_WAIT_MIN_MS = 5_000;
const JITTER_WAIT_MAX_MS = 10_000;
/** quotaStickyKeys 的容量上限（U4 审计顺带②）：条目=会话→粘住的 key，此前只增
 * 不删无上界。超上限删最早插入者（Map 迭代序=插入序，与 key-orchestrator 亲和表
 * 同款取舍——严格 LRU 需读时重排，不值得）。512 与亲和表 affinityMax 同量级。 */
const QUOTA_STICKY_KEYS_MAX = 512;

/** 可中断 sleep（毫秒）：signal abort 时立即醒来。轮间等待用。 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
/** 生成请求连接/首字节超时（毫秒）。2026-09-04 实测：传输挂起 ≈1/5 且无 RST，45s 覆盖大 prompt 建连+首包（design D4/D6）。 */
export const CONNECT_TIMEOUT_MS = 45_000;
/** SSE 流空闲看门狗（毫秒）：距上一事件 ≥ 该值无任何 chunk/事件即按停摆结束。2026-09-04 实测：思考期渠道有空事件/心跳自然重置计时（design D4/D6）。 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;
/** 明确的模型不可用错误码（不在默认可重试集合内，故不触发 provider 重试）。 */
const MODEL_NOT_FOUND_CODE = LLM_CODES.modelNotFound;
/** 模型 id → 标准显示名的显式品牌映射。 */
const DISPLAY_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ['sensenova-6.7-flash-lite', 'Sensenova 6.7 Flash Lite'],
]);
/** 官方文档声明的模型族事实已迁入 src/wire/facts.ts（add-model-facts 2.2）；
 * adapter 仅消费 factsFor/staticFacts，不复制第二份。 */
import { factsFor, staticFacts } from './wire/facts.ts';
/** Chat 请求体构造已迁出至 wire/body-chat.ts（make-responses-default-wire-protocol 4.1，行为不变）。 */
import { buildChatBody } from './wire/body-chat.ts';
import { buildResponsesBody, type ReasoningSummary } from './wire/body-responses.ts';
import { buildAnthropicBody } from './wire/body-anthropic.ts';
import { parseResponsesSse } from './wire/sse-responses.ts';
import { parseAnthropicSse } from './wire/sse-anthropic.ts';
import { resolveWirePlan, type WireProtocol } from './wire/plan.ts';
import { prepareImages, type ImageAccessResolver, type PreparedImage } from './wire/blocks.ts';
import { contentHasImage } from './vision/bridge.ts';
import type { WireKind } from './wire/types.ts';

export interface SensenovaConnection {
  apiBase: string;
  /** 已配置账户槽位总数，用于轮换上限（tried.size < accountCount）。 */
  accountCount: number;
  /** 每 key 并发生成请求上限（正整数）；非法值在并发闸内回退 1。 */
  concurrency?: number;
  /** 配额类 429 粘性换 key 开关（默认关；开启后仅配额类 429 触发切换，design D5）。 */
  quotaRotation?: boolean;
  /** wire 协议模式（make-responses-default-wire-protocol §5.1；缺省 auto：优先 Anthropic
   * （2026-11-04 标准链倒序，re 的推理档位传入无效），语义会丢失时按决策表降级 Chat）。 */
  wireProtocol?: WireProtocol;
  /** Responses 推理摘要（reasoning.summary；缺省 auto）。 */
  reasoningSummary?: ReasoningSummary;
}

/** 生成请求三段超时注入（毫秒，测试用）；缺省用模块级常量/并发闸默认。 */
export interface SensenovaTimeouts {
  /** 连接/首字节超时；缺省 CONNECT_TIMEOUT_MS。 */
  connectMs?: number;
  /** SSE 流空闲看门狗；缺省 STREAM_IDLE_TIMEOUT_MS。 */
  streamIdleMs?: number;
  /** 并发闸排队超时；缺省 concurrency.DEFAULT_QUEUE_TIMEOUT_MS。 */
  queueMs?: number;
}

export interface SensenovaAdapterDeps {
  /** 每请求的连接事实（apiBase、账户数、并发上限、配额轮换开关）。 */
  options: () => SensenovaConnection;
  /** 解析一个可用 key（无可解析 key 时抛 MISSING_CREDENTIAL）。 */
  resolveApiKey: (connection: SensenovaConnection) => Promise<string>;
  /**
   * 轮换到下一个 key：401（'invalid-credential'）永久禁用被拒账号；
   * 速率/TPM 类 429（'quota-exhausted'）与积分池类 429（'pool-exhausted'，
   * dsh-sensenova-suite 扩展）不写任何账号状态，仅用于换 key。
   * 第三参 model：本次请求的模型 id——拒绝类型不带组信息，池格的组由实现侧
   * groupOf(model) 现算（2026-10-31 起，写读同组；此前硬编码 general 是错位源）。
   * 返回 undefined 表示无更多 key（含全池格子标记的快速失败）。
   * roundExclude：本请求已试 key 全集（tried），池侧选择条件——轮内恒遍历未试
   * 运行态 key、不借阻塞（2026-11-04 他拍板；池空保底借用仍走 pickStart）。
   */
  rotateApiKey: (
    rejectedKey: string,
    rejection: 'invalid-credential' | 'quota-exhausted' | 'pool-exhausted' | 'rate-unclassified' | 'rate-soft',
    model: string | undefined,
    roundExclude?: ReadonlySet<string>,
  ) => Promise<string | undefined>;
  /**
   * 该模型所属积分组是否「每把 key（含阻塞态）都被池格标记」——4 轮轮询里
   * 唯一「不等就终止」的判据（全组积分耗尽 → 抛 ACCOUNT_QUOTA，宿主不重试）。
   * 缺省 undefined = 不判（行为退化为普通轮尽）。
   */
  poolFullyMarked?: (model: string | undefined) => boolean;
  /**
   * 请求结局上报（dsh-sensenova-suite 扩展，可选）：2xx 时回调 'success'，
   * 池层据此清连续限流计数并救回被借用的阻塞 key。缺省 undefined 不影响原行为。
   */
  reportOutcome?: (key: string, outcome: 'success') => void;
  /**
   * 目录过滤（dsh-sensenova-suite 扩展，可选）：listModels 的输出按
   * { enabledIds（空 = 全量）, unavailableIds } 过滤——面板的允许清单与
   * 额度标记语义在 wire 适配器上的落点。缺省 undefined = 不过滤。
   */
  catalogFilter?: () => { enabledIds: string[]; unavailableIds: string[] };
  /**
   * 每模型降级链覆盖（dsh-sensenova-suite 扩展，可选）：面板"协议"三槽链，
   * pool.json modelProtocols[model]（有序子集，≤3）。经 resolveWirePlan 生效链
   * 合成（面板 ?? 配置单线 ?? 档案默认）参与走查与 chat 兜底。
   * 缺省 undefined = 全部走档案默认链。
   */
  protocolOverrides?: () => Record<string, string[]>;
  /**
   * 每模型可用思考档位（dsh-sensenova-suite 扩展点，可选）：从 pool.json
   * `thinking` 分区读取（{ modelId → ["off","low",...] }）。在读取边界
   * （listModels/resolveModel/stream）经 withUserThinking 现算覆盖
   * reasoning.efforts——DSH 对话界面的思考档位可选集 = 用户勾选集，改勾选
   * 即生效（不烘焙进目录缓存，无需重启）。缺省 undefined = 目录词表。
   */
  thinkingOverrides?: () => Record<string, string[]>;
  /**
   * 每模型最大输出天花板覆盖（dsh-sensenova-suite 扩展点，可选）：settings 行
   * `maxTokensOverrides`（{ modelId → ceiling }，文档天花板覆盖滞后的目录）。
   * 在 resolveModel 经 llm-models.maxTokensForId 以「override > 目录申报值」
   * 现算 defaultMaxTokens——与面板「最大输出」同一判据同一份，读到的数字即
   * 请求携带的上限。缺省 undefined = 目录申报值（未申报则不申报）。
   */
  maxTokensOverrides?: () => Record<string, number> | null | undefined;
  /**
   * 每模型上下文窗口覆盖（dsh-sensenova-suite 扩展点，可选）：settings 行
   * `contextWindowOverrides`（{ modelId → tokens }）。在 resolveModel 经
   * llm-models.contextWindowForId 以「override > 目录申报值 > 131072 兜底」
   * 现算 context.contextWindow——与面板「上下文」徽章同一判据同一份。目录会
   * 低报新模型（sensenova-6.8-flash 探测 262144，官方文档 1M）。
   */
  contextWindowOverrides?: () => Record<string, number> | null | undefined;
  fetchImpl?: typeof fetch;
  /**
   * 按请求解析 key（dsh-sensenova-suite 扩展点，可选）：与 resolveApiKey 不同，
   * 这里拿到会话标识与模型 id，供池层做「按积分组的粘性/轮转」分派。
   * 缺省 undefined 时回落 resolveApiKey（行为与原 provider 插件一致）。
   */
  resolveApiKeyForRequest?: (request: { sessionId: string | undefined; model: string }) => Promise<string>;
  /**
   * 每轮重新解析起点 key（4 轮轮询用，可选）：与首轮同源（池层 pickStart），
   * 商汤组返回亲和 key（恒第一）、通用组推进游标（起点轮换）。返回 undefined =
   * 池里没有可用 key（池空或该组全标）。缺省 undefined 时用首轮 key 继续。
   * `excludeStart` = 上一轮起点：裸轮转组据此把起点推进一位（每轮起始账户
   * 轮换，避免总是固定账户优先）；亲和组忽略它。
   */
  pickStartKeyForRequest?: (request: { sessionId: string | undefined; model: string; excludeStart?: string }) => Promise<string | undefined>;
  /**
   * 全局在途槽（dsh-sensenova-suite 扩展点，可选）：一次 stream() 请求全程持有，
   * 结束（含异常）释放；缺省 undefined 时不限全局并发（仅每 key 闸）。
   */
  requestSlot?: (signal?: AbortSignal) => Promise<() => void>;
  /** 每 key 并发闸；缺省为进程内实例（可注入以利测试）。 */
  concurrencyGate?: KeyedConcurrencyGate;
  /** 三段超时注入（测试用）；缺省为生产常量。 */
  timeouts?: SensenovaTimeouts;
  /**
   * 图像来源解析器（add-multimodal-input）：宿主 ImageBlock 只带 attachment 引用，
   * 字节须经 resolveImageAttachmentAccess 桥接的本地只读路径（或现成 URL）取得。
   * 缺省 undefined → 图像按宿主 textOnlyImageText 占位出站（不静默丢弃）。
   */
  /**
   * 图片桥换图器（suite 扩展，vision/bridge.ts createImageSwapper 的产物）：
   * 目标模型在「可看图」勾选集（pool.json vision.visionModels）里时图片原样
   * 进请求，不在时换成转述观察文本——换图发生在请求边界，session 与用户侧
   * 界面保持原图原文。缺省 = 不换（零回归）。
   */
  imageSwapper?: (messages: unknown, context: { model: string }) => Promise<unknown>;
  resolveImageAccess?: ImageAccessResolver;
  /** 用户「可看图」勾选集（pool.json vision.visionModels）实时读；图像能力唯一真源。
   * 两个读者：目录申报边界（listModels/resolveModel）与请求期 entry 注记（stream）。 */
  visionModelIds?: () => readonly string[];
}

/** 目录条目：宿主所需的能力元数据快照（listModels 后缓存，resolveModel 消费）。
 * inputModalities 可缺省：申报「纯文本」会让宿主把图片剥成占位文本（见
 * modality.inputModalitiesFor），不含 image 的结论一律不申报。 */
interface CatalogEntry {
  id: string;
  name: string;
  inputModalities?: readonly ModelModality[];
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: LlmModelReasoningInfo;
  /** 目录 supported_sampling_parameters 白名单（模型支持的采样参数列表，缺失时用静态兜底）。 */
  supportedSamplingParameters?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** wire → 端点路径（三条协议共享同一 apiBase，路径各不同）。 */
function endpointOf(wire: WireKind): string {
  if (wire === 'anthropic') return '/messages';
  if (wire === 'responses') return '/responses';
  return '/chat/completions';
}

/** 把模型 id 标准化为可读显示名：显式映射优先，否则按品牌前缀回退。 */
function displayNameFor(id: string): string {
  const override = DISPLAY_NAME_OVERRIDES.get(id);
  if (override !== undefined) return override;
  const normalized = id.trim();
  // 回退规则：按连字符/下划线切词（点号属于版本号，如 6.8、u1.5，需保留），
  // 再按大写边界切词，首字母大写其余小写。
  const words = normalized
    .split(/[-_]+/)
    .filter((part) => part !== '')
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/));
  if (words.length === 0) return normalized;
  const titled = words.map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word));
  return titled.join(' ').replace(/\s+/g, ' ').trim();
}

/** 从目录条目读取一个正数能力字段（按优先级），缺失/非法返回 undefined。 */
function firstPositiveNumber(raw: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function firstContextField(raw: Record<string, unknown>): number | undefined {
  // 拼写表与面板投影共用一份（llm-models.CONTEXT_WINDOW_FIELDS，同序）——
  // 同一事实一份实现一个优先序（D1）。
  return firstPositiveNumber(raw, CONTEXT_WINDOW_FIELDS);
}

function firstMaxOutputField(raw: Record<string, unknown>): number | undefined {
  // max_output_length 是 SenseNova /models 目录的实际字段名，置首优先；
  // OpenAI 风格字段保留兜底。拼写表与面板投影共用（llm-models.MAX_OUTPUT_FIELDS）。
  return firstPositiveNumber(raw, MAX_OUTPUT_FIELDS);
}

/** 读取目录中的 effort 词表字段；返回字符串数组或 undefined（无明确词表）。 */
function effortListField(raw: Record<string, unknown>): readonly string[] | undefined {
  for (const key of ['reasoning_efforts', 'reasoning_levels']) {
    const value = raw[key];
    if (Array.isArray(value)) {
      const efforts = value.filter((item): item is string => typeof item === 'string' && item !== '');
      if (efforts.length > 0) return efforts;
    }
  }
  return undefined;
}

/** 读取嵌套 reasoning.efforts / thinking.efforts 词表；返回字符串数组或 undefined。 */
function nestedEffortListField(raw: Record<string, unknown>): readonly string[] | undefined {
  for (const key of ['reasoning', 'thinking']) {
    const holder = raw[key];
    if (!isRecord(holder)) continue;
    const efforts = holder.efforts;
    if (Array.isArray(efforts)) {
      const list = efforts.filter((item): item is string => typeof item === 'string' && item !== '');
      if (list.length > 0) return list;
    }
  }
  return undefined;
}

/** 读取目录中的默认 effort 字段；返回字符串或 undefined。 */
function defaultEffortField(raw: Record<string, unknown>): string | undefined {
  const direct = raw.default_reasoning_effort;
  if (typeof direct === 'string' && direct !== '') return direct;
  for (const key of ['reasoning', 'thinking']) {
    const holder = raw[key];
    if (isRecord(holder)) {
      const value = holder.defaultEffort ?? holder.default_effort;
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return undefined;
}

/** 目录是否声明支持 reasoning；仅用于静态已知模型族的档位补全。 */
function hasReasoningSupport(raw: Record<string, unknown>): boolean {
  const features = raw.supported_features;
  if (Array.isArray(features) && features.includes('reasoning')) return true;
  // 兼容旧目录的宽松支持标记，但不把任意模型 id 当作已知模型。
  if (raw.reasoning_effort !== undefined) return true;
  const thinking = raw.thinking;
  return thinking === true || isRecord(thinking);
}

/** 读取目录 supported_sampling_parameters 白名单；缺失返回 undefined。 */
function samplingListField(raw: Record<string, unknown>): readonly string[] | undefined {
  const value = raw.supported_sampling_parameters;
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === 'string' && item !== '');
  return list.length > 0 ? list : undefined;
}

/** 目录未返回 supported_sampling_parameters 时的静态兜底已迁入 src/wire/facts.ts
 * （静态档案 samplingParameters 字段；kimi-k3 依文档 :2455-2457 补 seed/parallel_tool_calls）。 */

/** 思考档位规范升序：对话界面下拉「从上到下递增」的唯一依据（2026-10-27 用户拍板）。
 * off（用户勾选集拼法，pool.json thinking）与 none（平台目录拼法）同处最低档；
 * minimal 在 low 之下、xhigh 在 high 之上（glm 原生词表）。表外档位排末尾、保持
 * 相对顺序（稳定排序），不猜强度。 */
const EFFORT_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 1,
  minimal: 2,
  low: 3,
  medium: 4,
  high: 5,
  xhigh: 6,
  max: 7,
};

/** 把档位 id 列表排成升序并转成 reasoning.efforts 的行。reasoningInfoFrom（目录
 * 词表/静态表）与 parseCatalog（用户勾选覆盖）两条路共用——平台目录按强度降序
 * 罗列、勾选集按保存顺序，都不再原样透传到对话下拉。 */
function effortsAscending(efforts: readonly string[]) {
  return efforts
    .map((effort, index) => ({ effort, index, rank: EFFORT_RANK[effort] ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ effort }) => ({ id: ReasoningEffortId(effort), name: effort }));
}

/** 解析目录条目的 reasoning 词表；目录词表优先，静态表仅补全已知且有支持标记的模型。
 * defaultEffort：目录声明的默认档优先；目录未带（或命中静态表）时回退静态表默认档
 * （align-request-fields-with-docs 1.2：命中静态表即声明 defaultEffort）。
 * 词表一律排成升序（effortsAscending）——对话下拉从上到下递增，不透传目录原序。 */
function reasoningInfoFrom(raw: Record<string, unknown>, modelId: string): LlmModelReasoningInfo | undefined {
  const efforts = effortListField(raw) ?? nestedEffortListField(raw);
  const knownFacts = staticFacts(modelId);
  const selectedEfforts = efforts ?? (knownFacts !== undefined && hasReasoningSupport(raw) ? knownFacts.efforts : undefined);
  if (selectedEfforts === undefined || selectedEfforts.length === 0) return undefined;
  const infos = effortsAscending(selectedEfforts);
  const declaredDefault = efforts !== undefined ? defaultEffortField(raw) : undefined;
  const fallbackDefault = knownFacts?.defaultEffort ?? undefined;
  const defaultEffort = declaredDefault ?? fallbackDefault;
  const defaultId = defaultEffort !== undefined && selectedEfforts.includes(defaultEffort)
    ? ReasoningEffortId(defaultEffort)
    : undefined;
  return {
    efforts: infos,
    ...(defaultId !== undefined ? { defaultEffort: defaultId } : {}),
  };
}

/** 用户思考档位覆盖（pool.json `thinking` 分区）的现算投影：有勾选集时该模型
 * reasoning.efforts 改为「用户勾选集」（DSH 对话界面的可选思考档位 = 用户勾选集），
 * defaultEffort 维持目录解析结果（不在新集内也保留——不影响可选集，只影响默认档）。
 * 在 listModels/resolveModel/stream 三个读取边界调用，不写回目录缓存（热更新）。 */
function withUserThinking(
  entry: CatalogEntry | undefined,
  model: string,
  overrides: Record<string, string[]> | undefined,
): CatalogEntry | undefined {
  if (entry === undefined) return entry;
  const userList = overrides?.[model];
  if (!Array.isArray(userList) || userList.length === 0) return entry;
  const efforts = effortsAscending(userList);
  return {
    ...entry,
    reasoning: entry.reasoning !== undefined ? { ...entry.reasoning, efforts } : { efforts },
  };
}

/** 解析 OpenAI 模型目录为目录条目；应用自动过滤与失败缓存。
 * 只投影平台数据——用户配置（思考档位/可看图）一律在读取边界现算
 * （withUserThinking / visionModelIds），绝不烘焙进 24h 目录缓存：缓存内容
 * 若掺了用户配置，改配置不会失效缓存（2026-10-27「思考档位要重启才生效」根因）。 */
function parseCatalog(value: unknown, failedModels: ReadonlySet<string>) {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new LlmError('llm-sensenova: unexpected models response shape', LLM_CODES.providerProtocolError);
  }
  const out: CatalogEntry[] = [];
  for (const raw of value.data) {
    if (!isRecord(raw)) continue;
    const id = toString(raw.id);
    if (id === undefined || id === '') continue;
    // 1) image-only 永远排除：output_modalities 必须含 text，否则不可进入 chat 选择器。
    const output = raw.output_modalities;
    const outputsText = Array.isArray(output) ? output.some((item) => toString(item) === 'text') : false;
    if (!outputsText) continue;
    // 2) 按已知不可路由清单与失败缓存过滤；目录是唯一模型来源。
    if (KNOWN_UNROUTABLE_MODELS.has(id)) continue;
    if (failedModels.has(id)) continue;
    const contextWindow = firstContextField(raw);
    const maxOutputTokens = firstMaxOutputField(raw);
    const reasoning = reasoningInfoFrom(raw, id);
    const supportedSamplingParameters = samplingListField(raw);
    // 条目本义 = 平台申报原样（无 image 不申报）；用户勾选集在申报边界
    // （listModels/resolveModel）与请求期注记（stream）裁决，不进这份 24h 缓存
    // ——缓存键不含用户配置，写回会粘住（见缓存失效教训）。
    const inputModalities = inputModalitiesFor(raw);
    out.push({
      id,
      name: displayNameFor(id),
      ...(inputModalities !== undefined ? { inputModalities } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(supportedSamplingParameters !== undefined ? { supportedSamplingParameters } : {}),
    });
  }
  return out;
}

/** OpenAI usage → 宿主 TokenUsage（inputTokens 为未缓存输入，缓存读单独计）。 */
function mapUsage(usage: Record<string, unknown>): TokenUsage {
  const prompt = toNumber(usage.prompt_tokens);
  const completion = toNumber(usage.completion_tokens);
  const total = toNumber(usage.total_tokens);
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined;
  const cacheRead = promptDetails !== undefined ? toNumber(promptDetails.cached_tokens) : 0;
  const reasoning = completionDetails !== undefined ? toNumber(completionDetails.reasoning_tokens) : 0;
  return {
    inputTokens: Math.max(0, prompt - cacheRead),
    outputTokens: completion,
    totalTokens: total > 0 ? total : prompt + completion,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** OpenAI finish_reason → 宿主 FinishReason。 */
function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' };
    case 'tool_calls':
    case 'function_call': return { kind: 'tool-calls' };
    case 'length': return { kind: 'max-tokens' };
    case 'aborted': return { kind: 'aborted', failure: { message: 'SenseNova stream aborted', code: 'ABORTED' } };
    default: return { kind: 'stop' };
  }
}

/** 解析一行 SSE；返回解析后的数据对象，`[DONE]` 或空行/注释行返回 undefined。 */
function parseSseDataLine(line: string): unknown {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === '[DONE]') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** SSE 翻译期间的增量组装状态。 */
interface SseState {
  nextIndex: number;
  textIndex: number;
  textContent: string;
  reasoningIndex: number;
  reasoningContent: string;
  toolIndexById: Map<string, number>;
  toolIndexByProtocolIndex: Map<number, number>;
  /** 无 index 且无 id 的退化分片：name → 槽位（name 是工具边界）。 */
  toolIndexByAnonymousName: Map<string, number>;
  /** 最近一次无键续片指向的槽（无 name 续片回退目标）。 */
  lastAnonymousIndex: number;
  toolIdByIndex: Map<number, string>;
  toolNameByIndex: Map<number, string>;
  toolArgsByIndex: Map<number, string>;
  sawContent: boolean;
  pendingUsage: TokenUsage | undefined;
  usageEmitted: boolean;
  finished: boolean;
}

function createSseState(): SseState {
  return {
    nextIndex: 0,
    textIndex: -1,
    textContent: '',
    reasoningIndex: -1,
    reasoningContent: '',
    toolIndexById: new Map(),
    toolIndexByProtocolIndex: new Map(),
    toolIndexByAnonymousName: new Map(),
    lastAnonymousIndex: -1,
    toolIdByIndex: new Map(),
    toolNameByIndex: new Map(),
    toolArgsByIndex: new Map(),
    sawContent: false,
    pendingUsage: undefined,
    usageEmitted: false,
    finished: false,
  };
}

function closeText(state: SseState): StreamChunk[] {
  if (state.textIndex < 0) return [];
  const chunk: StreamChunk = {
    type: 'block-end',
    index: state.textIndex,
    block: { type: 'text', text: state.textContent },
  };
  state.textIndex = -1;
  state.textContent = '';
  return [chunk];
}

function closeReasoning(state: SseState): StreamChunk[] {
  if (state.reasoningIndex < 0) return [];
  const chunk: StreamChunk = {
    type: 'block-end',
    index: state.reasoningIndex,
    block: { type: 'reasoning', text: state.reasoningContent },
  };
  state.reasoningIndex = -1;
  state.reasoningContent = '';
  return [chunk];
}

function closeToolCalls(state: SseState): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [index, args] of [...state.toolArgsByIndex.entries()]) {
    const name = state.toolNameByIndex.get(index) ?? '';
    if (name === '') continue; // name 始终未到达的残缺调用不产出 tool-call block，避免污染历史导致后续 400
    const id = state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`;
    chunks.push({
      type: 'block-end',
      index,
      block: {
        type: 'tool-call',
        id: ToolCallId(id),
        name,
        arguments: args !== '' ? args : '{}',
      },
    });
  }
  state.toolArgsByIndex.clear();
  state.toolIdByIndex.clear();
  state.toolNameByIndex.clear();
  state.toolIndexById.clear();
  state.toolIndexByProtocolIndex.clear();
  state.toolIndexByAnonymousName.clear();
  state.lastAnonymousIndex = -1;
  return chunks;
}

/** 将事件中的 usage 转成单次 usage chunk，避免 finish/trailing 重复发出。 */
function usageChunksFrom(event: unknown, state: SseState): StreamChunk[] {
  if (state.usageEmitted || !isRecord(event)) return [];
  const usageRec = isRecord(event.usage) ? event.usage : undefined;
  if (state.pendingUsage === undefined && usageRec === undefined) return [];
  const usage = state.pendingUsage ?? mapUsage(usageRec as Record<string, unknown>);
  state.pendingUsage = undefined;
  state.usageEmitted = true;
  return [{ type: 'usage', usage }];
}

/** 处理一个 OpenAI SSE 数据对象，返回对应的宿主 StreamChunk 序列。 */
function processChunkEvent(event: unknown, state: SseState): StreamChunk[] {
  if (!isRecord(event)) return [];
  const choices = event.choices;
  if (!Array.isArray(choices)) return usageChunksFrom(event, state);
  const chunks: StreamChunk[] = [];
  for (const rawChoice of choices) {
    if (state.finished) break;
    if (!isRecord(rawChoice)) continue;
    const delta = isRecord(rawChoice.delta) ? rawChoice.delta : undefined;
    const finishReasonRaw = rawChoice.finish_reason;
    const finishReason = typeof finishReasonRaw === 'string' && finishReasonRaw !== '' && finishReasonRaw !== 'null' ? finishReasonRaw : undefined;

    if (delta !== undefined) {
      const content = toString(delta.content) ?? '';
      // 6.8 系使用 reasoning，其他模型使用 reasoning_content；同一事件以前者为优先。
      const reasoning = toString(delta.reasoning_content) ?? toString(delta.reasoning) ?? '';
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : [];

      if (reasoning !== '') {
        chunks.push(...closeText(state));
        if (state.reasoningIndex < 0) {
          state.reasoningIndex = state.nextIndex;
          state.nextIndex += 1;
          chunks.push({ type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' });
        }
        state.reasoningContent += reasoning;
        chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text: reasoning });
      }

      if (content !== '') {
        chunks.push(...closeReasoning(state));
        if (state.textIndex < 0) {
          state.textIndex = state.nextIndex;
          state.nextIndex += 1;
          chunks.push({ type: 'block-start', index: state.textIndex, blockType: 'text' });
        }
        state.textContent += content;
        state.sawContent = true;
        chunks.push({ type: 'text-delta', index: state.textIndex, text: content });
      }

      for (const tc of toolCalls) {
        const id = toString(tc.id) ?? '';
        const protocolIndex = typeof tc.index === 'number' && Number.isInteger(tc.index) ? tc.index : undefined;
        const fn = isRecord(tc.function) ? tc.function : undefined;
        const name = fn !== undefined ? (toString(fn.name) ?? '') : '';
        const argsDelta = fn !== undefined ? (toString(fn.arguments) ?? '') : '';
        // OpenAI 规范的 index 优先；非规范响应依次回退到稳定 id、匿名 name。
        let index: number | undefined;
        if (protocolIndex !== undefined) {
          index = state.toolIndexByProtocolIndex.get(protocolIndex);
        } else if (id !== '') {
          index = state.toolIndexById.get(id);
        } else if (name !== '') {
          // name 是匿名分片流的工具边界：同 name 归同槽（可能跨事件续片）。
          index = state.toolIndexByAnonymousName.get(name);
        } else {
          // 纯 arguments 续片：无 name 无法标识工具，续最近匿名槽（防御性，
          // 真实网关不会发既无 index/id 也无 name 的分片流）。
          index = state.lastAnonymousIndex >= 0 ? state.lastAnonymousIndex : undefined;
        }
        if (index === undefined) {
          chunks.push(...closeText(state), ...closeReasoning(state));
          index = state.nextIndex;
          state.nextIndex += 1;
          if (protocolIndex !== undefined) state.toolIndexByProtocolIndex.set(protocolIndex, index);
          if (id !== '') state.toolIndexById.set(id, index);
          if (name !== '' && protocolIndex === undefined && id === '') {
            state.toolIndexByAnonymousName.set(name, index);
            state.lastAnonymousIndex = index;
          }
          state.toolIdByIndex.set(index, id);
          state.toolNameByIndex.set(index, name);
          state.toolArgsByIndex.set(index, '');
          chunks.push({ type: 'block-start', index, blockType: 'tool-call' });
          state.sawContent = true;
        }
        if (id !== '') {
          state.toolIdByIndex.set(index, id);
          state.toolIndexById.set(id, index);
        }
        if (name !== '') state.toolNameByIndex.set(index, name);
        if (protocolIndex === undefined && id === '' && name !== '') {
          state.toolIndexByAnonymousName.set(name, index);
          state.lastAnonymousIndex = index;
        }
        const accumulated = (state.toolArgsByIndex.get(index) ?? '') + argsDelta;
        state.toolArgsByIndex.set(index, accumulated);
        const effectiveName = state.toolNameByIndex.get(index) ?? '';
        chunks.push({
          type: 'tool-call-delta',
          index,
          id: ToolCallId(state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`),
          ...(effectiveName !== '' ? { name: effectiveName } : {}),
          argumentsDelta: argsDelta,
        });
      }
    }

    if (finishReason !== undefined) {
      state.finished = true;
      chunks.push(...closeText(state), ...closeReasoning(state), ...closeToolCalls(state));
      chunks.push(...usageChunksFrom(event, state));
      chunks.push({ type: 'finish', reason: mapFinishReason(finishReason) });
      continue;
    }

    const usageRec = isRecord(event.usage) ? event.usage : undefined;
    if (usageRec !== undefined && state.pendingUsage === undefined) {
      state.pendingUsage = mapUsage(usageRec);
    }
  }
  return chunks;
}

/** 把 OpenAI SSE 响应体翻译为宿主 StreamChunk 序列。 */
async function* parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
  model?: string,
  sessionId?: string,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = createSseState();
  let buffer = '';
  let finished = false;
  let bytes = 0;
  // 流空闲看门狗（design D4，2026-09-04 实测：思考期渠道有空事件/心跳自然重置）：
  // 每次读到事件即重置计时；距上一事件 ≥ idleTimeoutMs 无任何 chunk/事件时以
  // TimeoutError 中断挂起的 read，走 finally 释放额度并在 catch 映射可重试 TIMEOUT。
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
      // read 与看门狗竞争：看门狗先触发则中断挂起的 read（消费侧背压不计入空闲）。
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
        const event = parseSseDataLine(line);
        if (event === undefined) continue;
        if (finished) {
          for (const chunk of usageChunksFrom(event, state)) yield chunk;
          continue;
        }
        for (const chunk of processChunkEvent(event, state)) {
          yield chunk;
          if (chunk.type === 'finish') finished = true;
        }
      }
    }
    if (buffer.trim() !== '') {
      const event = parseSseDataLine(buffer);
      if (event !== undefined) {
        if (finished) {
          for (const chunk of usageChunksFrom(event, state)) yield chunk;
        } else {
          for (const chunk of processChunkEvent(event, state)) {
            yield chunk;
            if (chunk.type === 'finish') finished = true;
          }
        }
      }
    }
    if (!finished) {
      // 流断尾（chat-completions 不强制终止事件）：按 stop 收口，但必须留痕——
      // 否则一次平台掐流在诊断日志里与正常结束无法区分。
      traceLog(`[dsh-sensenova-suite] chat-completions 流断尾 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B 未见终止事件，按 stop 收口`);
      const trailing = [...closeText(state), ...closeReasoning(state), ...closeToolCalls(state)];
      for (const chunk of trailing) yield chunk;
      if (!state.sawContent) {
        throw new LlmError('llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复', LLM_CODES.emptyResponse);
      }
      if (state.pendingUsage !== undefined) yield { type: 'usage', usage: state.pendingUsage };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  } catch (error) {
    // 连接超时 signal（与 fetch 共用）在流阶段触发时，reason 为 TimeoutError：
    // 同样按可重试 TIMEOUT 收口（宿主 signal abort 保持原样透传）。
    // 流级失败每个落一行（trace-log 是桌面端唯一排障出口）；超壳 abort
    // （用户离开、重试层换请求）是我们自己的取消，不落。
    if ((signal?.aborted && isTimeoutReason(signal.reason)) || isTimeoutReason(error)) {
      traceLog(`[dsh-sensenova-suite] chat-completions 流停摆/超时 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B → TIMEOUT`);
      throw new LlmError(
        `llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`,
        LLM_CODES.timeout,
        { cause: error },
      );
    }
    if (signal?.aborted) throw error;
    if (error instanceof LlmError) {
      // 空响应等自带消息的 LlmError：完整消息原样落盘。
      traceLog(`[dsh-sensenova-suite] chat-completions 流失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${error.message}`);
      throw error;
    }
    traceLog(`[dsh-sensenova-suite] chat-completions 流中途失败 sid=${sessionId ?? "-"} model=${model ?? "?"} 已收 ${bytes}B: ${errorChain(error)} → TRANSPORT`);
    throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, LLM_CODES.transport, { cause: error });
  } finally {
    disarmWatchdog();
    await reader.cancel().catch(() => void 0);
    reader.releaseLock();
  }
}

/** 判断错误文本是否为「模型不可路由」的 404 措辞。 */
function isModelNotFoundText(errText: string): boolean {
  const lower = errText.toLowerCase();
  return lower.includes('model route not found') || lower.includes('model is not found');
}

/** §5.3：400 响应体是否为 error.type === 'invalid_request_error'（Responses 运行时不符信号）。 */
function isInvalidRequestError(errText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(errText);
    return isRecord(parsed) && isRecord(parsed.error) && parsed.error.type === 'invalid_request_error';
  } catch {
    return false;
  }
}

/** 是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason(value: unknown): value is Error {
  return value instanceof Error && value.name === 'TimeoutError';
}

/** Anthropic 协议的错误 type 词表（公开规范；商汤 /v1/messages 遵循）。 */
const ANTHROPIC_OVERLOADED = 'overloaded_error';
const ANTHROPIC_RATE_LIMIT = 'rate_limit_error';
const ANTHROPIC_AUTH = new Set(['authentication_error', 'permission_error']);

/** 从错误体取 Anthropic 形状的 error.type（非该形状返回 undefined）。 */
function anthropicErrorType(errText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(errText);
    if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
    const type = parsed.error.type;
    return typeof type === 'string' ? type : undefined;
  } catch {
    return undefined;
  }
}

/** 把预流 HTTP 失败映射为稳定 LlmError。
 * dynamicFloorMs：stream 层算好的配额类动态退避下限（分级探测档），
 * 覆盖 classify429Body 返回的静态 floor；undefined 时用静态 floor。
 * wire：当前请求走的协议；Anthropic 协议的错误体用 type 字符串而非数字 code，
 * 需单独识别 overloaded / rate_limit，否则会被当成普通 HTTP 5xx/4xx 漏判。
 * poolExhausted：该组积分池已全标（4 轮轮询的唯一「不等就终止」路径）——
 * 抛 ACCOUNT_QUOTA（不在宿主可重试清单里，直接上屏）而不是 RATE_LIMIT。 */
function httpError(status: number, errText: string, retryAfterMs: number | undefined, dynamicFloorMs?: number, wire?: WireKind, poolExhausted = false): LlmError {
  const anthropicType = wire === 'anthropic' ? anthropicErrorType(errText) : undefined;
  if (status === 401) {
    return new LlmError(
      'llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效',
      LLM_CODES.invalidCredential,
      { status: 401 },
    );
  }
  if (status === 404 && isModelNotFoundText(errText)) {
    return new LlmError(
      'llm-sensenova: SenseNova model is not routable — the model id is no longer served；SenseNova 模型不可路由：该模型 id 已下线',
      MODEL_NOT_FOUND_CODE,
      { status: 404 },
    );
  }
  if (status === 429) {
    // SenseNova 429 分类（design D1，2026-09-04 实测；2026-11-02 统一退避）：
    // 所有配额类都用 stream 层算好的分级探测档（dynamicFloorMs：3/5/10/15/30s，
    // 成功清零；入口快照、整轮推进一档）。响应 Retry-After 大于下限时优先采用，
    // 但整体封顶（防异常 Retry-After 把退避拖到分钟级外）。非配额类维持现行短退避
    // 语义：Retry-After <= 上限时透传，超长整值不透传（也不截断），由宿主本地
    // 退避策略计算。
    //
    // 该组全标（poolExhausted）走 ACCOUNT_QUOTA：组内全部 key 持续限流不可用
    // （tpm 持续判据升级/console 通道实证），宿主重试毫无意义，快速失败让面板
    // 说出原因才是可处置的形态。（2026-11-03 语义校准：旧文案断言「积分池已耗尽」
    // ——但 pool 类请求侧信号实测全部是限流误标，积分池耗尽的 body 形状至今
    // 零样本；文案改为只陈述观测事实「持续限流不可用」。）
    if (poolExhausted) {
      return new LlmError(
        'llm-sensenova: SenseNova model group persistently rate-limited；SenseNova 该模型组全部 key 持续限流不可用（连续超阈升级），已停止重试，稍后自动恢复或更换账号',
        QUOTA_CODES.accountQuota,
        { status: 429 },
      );
    }
    const classified = classify429Body(errText);
    // Anthropic 协议用 type 字符串表达限流（无数字 code）：同样按配额类处理。
    // 无桶标记 ⇒ 按 TPM 桶兜底（与 bucketOfCode 同口径：闸门往严的一侧兜）。
    const classifiedWithAnthropic = anthropicType === ANTHROPIC_RATE_LIMIT && !classified.quota
      ? { quota: true, retryFloorMs: probeFloorFor(0), kind: 'rate' as const, bucket: 'tpm' as const }
      : classified;
    const floorMs = dynamicFloorMs ?? classifiedWithAnthropic.retryFloorMs;
    let providerRetryAfterMs: number | undefined;
    if (floorMs !== undefined) {
      // 配额类：退避下限生效，Retry-After 更大时优先，整体封顶 60s（对齐单次
      // 延迟上限，防止宿主因采用值超限而放弃重试）。
      providerRetryAfterMs = Math.min(
        Math.max(floorMs, retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : 0),
        QUOTA_RETRY_AFTER_CEILING_MS,
      );
    } else {
      providerRetryAfterMs = retryAfterMs !== undefined && retryAfterMs > 0 && retryAfterMs <= PROVIDER_RETRY_AFTER_CAP_MS
        ? retryAfterMs
        : undefined;
    }
    return new LlmError('llm-sensenova: SenseNova API error 429 — rate limited；SenseNova API 返回 429：请求被限流', LLM_CODES.rateLimit, {
      status: 429,
      ...(providerRetryAfterMs !== undefined ? { providerRetryAfterMs } : {}),
    });
  }
  if (anthropicType === ANTHROPIC_OVERLOADED) {
    return new LlmError(
      `llm-sensenova: SenseNova API error 529 overloaded；SenseNova 返回 overloaded_error：服务端过载，重试通常可恢复`,
      // D2a（2026-11-04 拍板）：过载是瞬态，归 SERVER 档进宿主重试名单——
      // 与 429 同哲学，这句「重试通常可恢复」从此是真话。
      QUOTA_CODES.server,
      { status },
    );
  }
  if (anthropicType !== undefined && ANTHROPIC_AUTH.has(anthropicType)) {
    return new LlmError(
      'llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效',
      LLM_CODES.invalidCredential,
      { status },
    );
  }
  // D2a（2026-11-04 拍板）：5xx 与过载同为瞬态，归 SERVER 档进宿主重试名单；
  // 4xx（400/401/402/403/404）维持 PROVIDER_HTTP_ERROR 不重试。
  if (status >= 500) {
    return new LlmError(`llm-sensenova: SenseNova API error ${status}: ${errText.slice(0, 500)}`, QUOTA_CODES.server, { status });
  }
  return new LlmError(`llm-sensenova: SenseNova API error ${status}: ${errText.slice(0, 500)}`, LLM_CODES.providerHttpError, { status });
}

/**
 * 跨实例目录种子（模块级，2026-10-27）：重注册（思考/勾选保存触发的签名重建）
 * 会新建适配器实例，实例级缓存从零开始——不播种则每次重建后的首个 listModels
 * 必打 /v1/models（HTTP 秒级），DSH 目录重建窗口拉长到会话超时（真机：
 * `session/model-unavailable: The operation was aborted due to timeout`）。
 * 成功拉取的最新目录落在这里；新实例冷启动时同凭据同端点且未过期即认领，
 * 重建零网络、零窗口。只作种子：TTL/失败退避判定仍在实例内照常走。
 */
let catalogSeed: { credential: string; apiBase: string; fetchedAt: number; entries: CatalogEntry[] } | undefined;

/** SenseNova（OpenAI 兼容）适配器。 */
export class SensenovaAdapter extends LlmAdapter {
  private readonly deps: SensenovaAdapterDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly gate: KeyedConcurrencyGate;
  private catalog: CatalogEntry[] = [];
  /** 进程内失败缓存：运行时返回 MODEL_NOT_FOUND 的模型 id。 */
  private readonly failedModels = new Set<string>();
  /** §5.3 运行时不符兜底：Responses 400 invalid_request_error 的模型 id（进程内，
   * 不持久化；命中后 resolveWirePlan 第 4 条判定直接降级 Chat）。 */
  private readonly responsesUnsupported = new Set<string>();
  /** 同上机制用于 Anthropic wire：400 invalid_request_error 后该模型降级 Responses。 */
  private readonly anthropicUnsupported = new Set<string>();
  /** 上一次成功目录请求使用的 key/base；变化时旧失败缓存不再可信。 */
  private catalogCredential: string | undefined;
  private catalogApiBase: string | undefined;
  /** 目录缓存时间戳（毫秒 epoch）；与 TTL 共同决定下次调用是否实发 HTTP。 */
  private catalogFetchedAt = 0;
  /** 目录刷新失败后的下次重试时间（毫秒 epoch）；仅失败时写入。 */
  private catalogNextRetryAt = 0;
  /** 本段失败退避期内「空缓存补发一次」是否已用掉（语义见 catalog-gate.ts）。 */
  private catalogEmptyRetryUsed = false;
  /** 目录单飞去重：并发的 listModels 共享同一 in-flight Promise。 */
  private catalogInflight: Promise<CatalogEntry[]> | undefined;
  /**
   * 配额类 429 粘住 key（design D5，仅 quotaRotation 开启时读写）：
   * 有 sessionId 的请求按会话分桶（同一会话后续请求粘住切换后的 key）；
   * 无 sessionId 的请求共享进程级桶（undefined 键）——宿主 GenerateOptions
   * 仅提供 sessionId 这一会话标识，粘性粒度即「会话（无标识时为进程）」，
   * 与 spec「同一会话后续请求继续使用新 key」对齐。条目仅存内存，随适配器
   * 生命周期结束。
   */
  /** 会话→quota 轮换粘住的 key（design D5）。生命周期：轮换时 set、**成功时 delete**
   * （拐杖只为扛过 429 期；成功后下一请求回池层选 key，商汤组由亲和表保持粘性——
   * 2026-11-03 U4 顺带②B 拍板）、有界 QUOTA_STICKY_KEYS_MAX。 */
  private readonly quotaStickyKeys = new Map<string | undefined, string>();
  /**
   * 配额类 429 连续命中计数（per-session，分级退避用）：每次 stream() 调用至多 +1
   * （入口快照、finally 推进），成功清零，决定下次退避档位
   * PROBE_BACKOFF_STEPS_MS[count]（3/5/10/15/30s）。仅内存，随适配器生命周期。
   */
  private readonly probeHitCounts = new Map<string | undefined, number>();

  /**
   * 429 轨迹账本（per-session，纯诊断）：同一逻辑请求跨宿主重试吃过的 key
   * （原文，打印时 maskKey）。每次 429 追加当前 key（去重），成功即清。
   * 「已试 N/M 把」从此按跨重试的实况计——单跳的 key= 字段只看得到当次。
   * 仅内存，随适配器生命周期；容量天然有界（≤ 会话数 × 池大小）。
   */
  private readonly session429Trail = new Map<string | undefined, string[]>();

  constructor(deps: SensenovaAdapterDeps) {
    super();
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.gate = deps.concurrencyGate ?? new KeyedConcurrencyGate();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'SenseNova' };
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return resolveRetryPolicy(
      {
        mode: 'normal',
        // tune-sensenova-429-retry-budget：预算沿革 10 → 100 → 10（2026-10-27 用户
        // 拍板回收 10 次——快速失败优于长挂）。配合 3–30s 八档探测梯，10 次 × 30s
        // 封顶约 5 分钟仍为有限预算（宿主按步骤边界重置计数，此为单个 agent 步骤
        // 内预算），更长故障显式失败。分级档位 3–30s 八档封顶
        // （保住恢复第一时间接上的探测灵敏度）。
        maxRetries: 10,
        // suite：重试类别由 llm-retry 的单一决策模块给出（EMPTY/RATE_LIMIT/SERVER/
        // TIMEOUT/TRANSPORT 重试；QUOTA/ACCOUNT_QUOTA 池耗尽不硬重试——
        // contract.test 钉的就是这份决策，这里恢复它的运行时读者）。
        retryableCodes: retryableCodes(),
        backoff: { maxDelayMs: PROVIDER_RETRY_AFTER_CAP_MS },
      },
      'dsh-sensenova-suite.retryPolicy',
    );
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.fetchCatalog();
    // suite 扩展：面板允许清单与额度标记在目录出线处过滤（缺省不过滤）。
    const filter = this.deps.catalogFilter?.();
    const allowed = (set: Set<string>) => (m: CatalogEntry) => set.size === 0 || set.has(m.id);
    const keep = (m: CatalogEntry) => {
      // D1 层 1（2026-11-04 拍板修）：404 失败名单读侧兜底——serve-cache 的旧
      // 目录与 filter 缺席两路统一生效，「下线模型从选择器稳定消失」不再依赖
      // 重拉成功（旧实现被播种劫持：fetchedAt=0 双语义让 TTL 内旧目录续命）。
      if (this.failedModels.has(m.id)) return false;
      if (filter === undefined) return true;
      return allowed(new Set(filter.enabledIds))(m) && !filter.unavailableIds.includes(m.id);
    };
    // 输入模态申报跟「可看图」勾选集走（唯一真源，实时读）：勾选 → ["text","image"]
    // （宿主放行并按视觉模型对待）；未勾选 → 不申报（宿主对 undefined 放行图片，
    // 转述兜底才有米下锅；申报「纯文本」= 宿主剥图占位，2026-10-27 两次事故）。
    const checked = new Set(this.deps.visionModelIds?.() ?? []);
    return models.filter(keep).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...(checked.has(model.id) ? { inputModalities: IMAGE_INPUT_MODALITIES } : {}),
    }));
  }

  /**
   * 目录获取入口（listModels 专用）：TTL 内从缓存应答，过期后单飞实发 HTTP。
   * 成功刷新 TTL=CATALOG_TTL_MS（24h）；失败退避 CATALOG_FAILURE_RETRY_MS（60s）
   * 并维持旧缓存可读，避免宿主秒级问询在故障时退化为秒级重试循环。
   * 凭据或 apiBase 变化立即失效（换 key/换端点后旧目录不再可信）。
   */
  private async fetchCatalog(): Promise<CatalogEntry[]> {
    const connection = this.deps.options();
    let apiKey: string;
    try {
      apiKey = await this.deps.resolveApiKey(connection);
    } catch (error) {
      // 没有任何 key 时保持空目录；其他解析/凭据桥接错误必须交给 host，
      // 否则 modelCatalog 只会静默丢失 provider 分组而没有 failures 诊断。
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return [];
      throw error;
    }
    const now = Date.now();
    // 冷启动播种：新实例（catalogFetchedAt === 0）认领模块级种子的条件 = 同凭据、
    // 同端点。认领后 TTL 判定照常——种子过期照样实发，不会无限续命。
    if (this.catalogFetchedAt === 0 && catalogSeed !== undefined
      && catalogSeed.credential === apiKey && catalogSeed.apiBase === connection.apiBase) {
      this.catalog = catalogSeed.entries;
      this.catalogCredential = catalogSeed.credential;
      this.catalogApiBase = catalogSeed.apiBase;
      this.catalogFetchedAt = catalogSeed.fetchedAt;
    }
    // 发/不发/发之前回什么——判定走 catalog-gate 纯模块（peer-free 单测钉），
    // TTL、失败退避与退避期内的两条降级路（种子回落 / 空缓存每段补发一次）
    // 一个判据源，见 catalog-gate.ts 模块头。
    const seed = catalogSeed;
    const gate = planCatalogFetch(
      {
        cachedEntries: this.catalog.length,
        fetchedAt: this.catalogFetchedAt,
        nextRetryAt: this.catalogNextRetryAt,
        emptyRetryUsed: this.catalogEmptyRetryUsed,
      },
      {
        now,
        credential: apiKey,
        apiBase: connection.apiBase,
        cacheCredential: this.catalogCredential,
        cacheApiBase: this.catalogApiBase,
        seed,
      },
    );
    if (gate.action === "serve-cache") return this.catalog;
    if (gate.action === "serve-seed") {
      // 退避期内的种子回落按冷启动认领同款语义落进实例：后续调用走缓存/TTL
      // 判定；fetchedAt 保持种子原值，种子过期照样实发，不会无限续命。gate 只
      // 在种子可用时返回本分支——防御性兜底：seed 缺席（不可能）时回现有缓存。
      if (seed !== undefined) {
        this.catalog = seed.entries;
        this.catalogCredential = apiKey;
        this.catalogApiBase = connection.apiBase;
        this.catalogFetchedAt = seed.fetchedAt;
      }
      return this.catalog;
    }
    if (gate.action === "serve-empty") return this.catalog;
    // send = 正常路径（补发额度重置，新失败段又有一次）；send-forced = 退避期
    // 内空缓存的每段一次补发（标记置位，本段不再补）。
    this.catalogEmptyRetryUsed = gate.action === "send-forced";
    // 单飞去重：并发调用共享同一请求。
    if (this.catalogInflight !== undefined) {
      return this.catalogInflight;
    }
    const inflight = this.fetchCatalogUncached(connection, apiKey, gate.invalidateFailedModels);
    this.catalogInflight = inflight;
    // 完成后无论成败都清掉 inflight；失败时设定退避时间戳。
    inflight.then(
      () => { this.catalogInflight = undefined; },
      () => {
        this.catalogInflight = undefined;
        this.catalogNextRetryAt = Date.now() + CATALOG_FAILURE_RETRY_MS;
      },
    );
    return inflight;
  }

  /** 实际发起 HTTP 目录请求并更新缓存（仅 fetchCatalog 调用）。 */
  private async fetchCatalogUncached(
    connection: SensenovaConnection,
    apiKey: string,
    invalidateFailedModels: boolean,
  ): Promise<CatalogEntry[]> {
    const response = await this.fetchImpl(`${connection.apiBase}/models`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...attributionHeaders(),
      },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (response.status === 401) {
      throw new LlmError('llm-sensenova: SenseNova API rejected the API key (401)', LLM_CODES.invalidCredential, { status: 401 });
    }
    if (!response.ok) {
      throw new LlmError(`llm-sensenova: models endpoint returned HTTP ${response.status}`, LLM_CODES.providerHttpError, { status: response.status });
    }
    // S3（2026-11-04 拍板修）：目录 body 非 JSON（代理错误页/网关 HTML）此前裸抛
    // SyntaxError——全文件唯一不包 LlmError 的错误路径。包成协议码让宿主按
    // 已知形态接住（PROVIDER_PROTOCOL_ERROR 不在重试名单，快速失败可诊断）。
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new LlmError(
        `llm-sensenova: models endpoint returned non-JSON body（代理错误页/网关 HTML？）；SenseNova 目录响应不是合法 JSON`,
        LLM_CODES.providerProtocolError,
        { cause: error },
      );
    }
    // 失败缓存只对同一凭据和 API 地址成立；换 key 或切换端点后，旧 404 不应继续隐藏新目录。
    if (invalidateFailedModels) this.failedModels.clear();
    // 以新快照原子替换缓存，避免 listModels 新目录与 resolveModel 旧能力不一致。
    const models = parseCatalog(parsed, this.failedModels);
    this.catalogCredential = apiKey;
    this.catalogApiBase = connection.apiBase;
    this.catalogFetchedAt = Date.now();
    this.catalog = models;
    // 成功快照落到模块级种子：下一次重注册的新实例从这里冷启动（零网络）。
    catalogSeed = { credential: apiKey, apiBase: connection.apiBase, fetchedAt: this.catalogFetchedAt, entries: models };
    return models;
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // 思考档位现算覆盖（DSH 对话界面的可选档位从这里读）——目录缓存只存平台
    // 数据，改勾选即时生效，无需重启（2026-10-27「档位要重启」根因修复）。
    const entry = withUserThinking(
      this.catalog.find((m) => m.id === model),
      model,
      this.deps.thinkingOverrides?.(),
    );
    // 「上下文」窗口 = override（按模型 id）> 目录申报值 > 131072 兜底——判据
    // 与面板同一份（llm-models.contextWindowForId），badge 与请求侧算术同源。
    const contextWindow = contextWindowForId(model, entry?.contextWindow, this.deps.contextWindowOverrides?.());
    // 「最大输出」天花板 = override（按模型 id）> 目录申报值——判据与面板同一份
    // （llm-models.maxTokensForId）：面板「最大输出」读到的数字即这里申报的
    // defaultMaxTokens（D1 承诺恢复：the number you read is the number the
    // request sends）。override 可抬高目录低报/未申报的模型（文档天花板 >
    // 目录探针值，2026-10-26 拍板以文档为准）；无 override 且目录未申报则
    // 不申报，宿主 defaultMaxTokens ?? 32768 兜底。
    const maxTokens = maxTokensForId(model, entry?.maxOutputTokens, this.deps.maxTokensOverrides?.());
    // 申报跟「可看图」勾选集走（同 listModels）；旧 `?? ['text']` 兜底是宿主
    // resolveModelInfo 路径剥图的同一扳机，未勾选一律不申报。
    const checked = this.deps.visionModelIds?.().includes(model) === true;
    return {
      provider,
      id: model,
      name: entry?.name ?? displayNameFor(model),
      ...(checked ? { inputModalities: IMAGE_INPUT_MODALITIES } : {}),
      context: { contextWindow },
      ...(maxTokens !== undefined ? { defaultMaxTokens: maxTokens } : {}),
      ...(entry?.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
    };
  }

  /**
   * 4 轮轮询的「新一轮起点」：走池层 pickStart（商汤组亲和 key 恒第一、
   * 通用组游标推进）。返回 undefined = 池里没有可用 key（池空或该组全标）。
   * 缺省缝未接时退回 undefined（调用方按「无可用 key」收尾）。
   */
  private async pickRoundStart(options: GenerateOptions, excludeStart?: string): Promise<string | undefined> {
    if (this.deps.pickStartKeyForRequest === undefined) return undefined;
    try {
      return await this.deps.pickStartKeyForRequest({
        sessionId: options.sessionId,
        model: options.model,
        ...(excludeStart !== undefined ? { excludeStart } : {}),
      });
    } catch {
      return undefined;
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.deps.options();
    // 全局在途槽：排队等待而非报错，异常/中止同样释放。
    const releaseSlot = this.deps.requestSlot !== undefined
      ? await this.deps.requestSlot(options.signal)
      : undefined;
    // 目录条目驱动字段分派（catalog 未命中时静态表兜底；测试适配器常无目录）。
    const catalogEntry = this.catalog.find((m) => m.id === options.model);
    // 图像能力唯一真源 = 用户「可看图」勾选集（2026-10-27 二次事故定版）：勾选而
    // 静态表/目录都没有 image 依据的新模型，也要按视觉模型走完整请求链（投影跳过、
    // blocks 格式白名单给通用集）。注记只作用于本次请求的 entry 视图，不写回目录
    // 缓存——缓存键不含用户配置，写回会粘住。
    const visionChecked = this.deps.visionModelIds?.().includes(options.model) === true;
    const entry = withUserThinking(
      visionChecked
        ? (catalogEntry ?? { id: options.model, name: displayNameFor(options.model), inputModalities: IMAGE_INPUT_MODALITIES })
        : catalogEntry,
      options.model,
      this.deps.thinkingOverrides?.(),
    );
    // §6.1 分派点：factsFor → resolveWirePlan → 按 wire 构建请求体与路径。
    // 全量链模型（per-model-protocol-chain）：面板链覆盖经第 5 参进入生效链
    // 合成（面板 ?? 配置单线 ?? 档案默认），走查与 chat 兜底都在决策层完成。
    // wire 一旦选定，整次请求（含所有轮换重试）不再切换——否则同一轮对话会出现
    // Responses/Chat 混合历史，function_call 与 role:tool 的 id 体系会串。
    // 唯一例外是下方 400 兜底（且发生在任何内容流出之前）。
    const facts = factsFor(options.model, entry);
    const plan = resolveWirePlan(options, connection, facts, {
      responsesUnsupported: this.responsesUnsupported,
      anthropicUnsupported: this.anthropicUnsupported,
    }, this.deps.protocolOverrides?.()[options.model]);
    let wire: WireKind = plan.wire;
    // 图片桥（2026-10-27）：换图与否由「可看图」勾选集判定（vision.visionModels，
    // 换图器内部结合 bridgeMode）——勾选的模型图片原样进请求，未勾选的换成
    // 转述观察文本。换图发生在请求边界，session 与用户侧界面保持原图原文。
    let bridgedMessages: GenerateOptions['messages'] = options.messages;
    if (this.deps.imageSwapper !== undefined && Array.isArray(bridgedMessages)) {
      bridgedMessages = await this.deps.imageSwapper(bridgedMessages, {
        model: options.model,
      }) as GenerateOptions['messages'];
      // 诊断：换图器已挂但消息里仍有带附件引用的图片块 = 勾选判定的走向核对点。
      if (contentHasImage(bridgedMessages as never)) {
        traceLog(`[dsh-sensenova-suite] 图片桥: 换图后消息仍携带图片块（勾选模型走原生，属预期）`);
      }
    }
    // add-multimodal-input 2.1：非视觉模型（facts.supportsImages=false，其判据
    // 已含上方勾选注记）经宿主 projectImagesForTextModel 投影（插件不自造投影）；
    // 视觉模型原样携带。桥接换图后消息里已无图片块，投影自然成为无操作。
    const projectedMessages = facts.supportsImages
      ? bridgedMessages
      : projectImagesForTextModel(bridgedMessages);
    const request: GenerateOptions = { ...options, messages: [...projectedMessages] };
    // 图像载荷按 wire 预解析（格式交集与 kimi URL 降级是 wire 相关的）；400 兜底
    // 切 wire 时按新 wire 重建（发生在任何内容流出之前，无部分发送风险）。
    const imagePayloads = new Map<WireKind, Map<string, PreparedImage>>();
    const payloadsFor = async (w: WireKind): Promise<Map<string, PreparedImage>> => {
      let payloads = imagePayloads.get(w);
      if (payloads === undefined) {
        payloads = await prepareImages(request, entry, w, this.deps.resolveImageAccess);
        imagePayloads.set(w, payloads);
      }
      return payloads;
    };
    const buildBody = async (w: WireKind): Promise<string> => JSON.stringify(
      w === 'anthropic'
        ? buildAnthropicBody(request, entry, await payloadsFor(w))
        : w === 'responses'
          ? buildResponsesBody(request, entry, { reasoningSummary: connection.reasoningSummary }, await payloadsFor(w))
          : buildChatBody(request, entry, await payloadsFor(w)),
    );
    let body = await buildBody(wire);
    // 400 兜底只在本请求内切换一次（§5.3：标记 + 立即换 Chat 重试一次）。
    let responsesFallbackUsed = false;
    // 未分类失败（未知 429 / 402 / 403）的兜底换 key 也只在 402/403 上单次；
    // 未知 429 走完整轮池（见下方兜底段的注释）。
    let unclassifiedFallbackUsed = false;
    const tried = new Set<string>();
    const limit = connection.concurrency;
    // 三段超时（design D4/D6，2026-09-04 实测）：生产用常量，测试可注入小值。
    const connectMs = this.deps.timeouts?.connectMs ?? CONNECT_TIMEOUT_MS;
    const streamIdleMs = this.deps.timeouts?.streamIdleMs ?? STREAM_IDLE_TIMEOUT_MS;
    const queueMs = this.deps.timeouts?.queueMs;
    const quotaRotation = connection.quotaRotation === true;
    // 粘性起点（design D5）：开关开启时优先从「该会话粘住的 key」起步（指针初始
    // undefined 时等价 resolveApiKey 默认结果）；粘住的 key 若已失效（如被删除/禁用）
    // 会走既有 401 轮换路径自然恢复。开关关闭时不读写指针，行为与现状完全一致。
    const stickyKey = quotaRotation ? this.quotaStickyKeys.get(options.sessionId) : undefined;
    let apiKey = stickyKey ?? (
      this.deps.resolveApiKeyForRequest !== undefined
        ? await this.deps.resolveApiKeyForRequest({ sessionId: options.sessionId, model: options.model })
        : await this.deps.resolveApiKey(connection)
    );
    let response: Response | undefined;
    // 当前 attempt 持有的并发额度；成功进入流式阶段后保持到 finally 释放。
    let release: Release | undefined;
    // 各 attempt 的连接超时清理（清计时器 + 摘除宿主 abort 转发 listener），finally 统一执行。
    const connectCleanups: Array<() => void> = [];
    // 配额类 429 退避档位入口快照（上游 W3）：整轮共用一档，finally 里推进一格。
    // 2026-11-02 统一：快慢窗口共用同一套梯子（PROBE_BACKOFF_STEPS_MS）。
    const entryProbeHits = this.probeHitCounts.get(options.sessionId) ?? 0;
    const entryProbeFloorMs = probeFloorFor(entryProbeHits);
    let probeHitThisCall = false;
    let probeResetBySuccess = false;
    // 4 轮轮询（2026-11-02 他拍板，取代单圈轮换）：
    //   3 轮（每轮把所有可试的 key 各试一次）→ 抖动等待 5-10s → 第 4 轮 → 抛。
    // 轮边界 = rotateApiKey 选不出本轮未试过的 key（不是固定 accountCount），
    // 每轮清空 tried 让各 key 重新获得一次机会。pool 类只打标不打断流程——它的
    // 格子由池层在选 key 时自动跳过，只有「全组都标满」才算换无可换。
    let round = 1;
    const MAX_POLL_ROUNDS = 3;
    /** 第 4 轮（等待之后的那一轮）——不再有任何等待。 */
    const FINAL_ROUND = MAX_POLL_ROUNDS + 1;
    /** 累计上游尝试次数（日志与收尾行用）。 */
    let totalAttempts = 1;
    // 本轮起点（每轮推进）：裸轮转组据此把下一轮起点排除、从它的下一位环回，
    // 实现「每轮起始账户轮换，避免总是固定账户优先」（2026-11-02 他要求）。
    // 亲和组（商汤组）忽略它——亲和 key 恒第一。
    let roundStartKey: string | undefined = apiKey;

    try {
      for (;;) {
        tried.add(apiKey);
        // 按本次 attempt 实际使用的 key 获取并发额度；排队期间中止会在此 reject
        // （不占额度），排队超时以 TimeoutError reject（同样不占额度），统一映射
        // 可重试 TIMEOUT 交宿主重试层（design D4）。await 抛出时 release 保持
        // undefined，finally 不误放他人额度。
        try {
          release = await this.gate.acquire(apiKey, limit, options.signal, queueMs);
        } catch (error) {
          if (!isTimeoutReason(error)) throw error;
          // 排队超时此前全程静默（2026-11-03 真机事故：宿主 10 次重试循环全部
          // 停在这里，插件日志零痕迹——本次事故的排查盲区）——每次超时一行。
          traceLog(`[dsh-sensenova-suite] 并发闸排队超时 model=${options.model} key=${maskKey(apiKey)} 等=${Math.round((queueMs ?? DEFAULT_QUEUE_TIMEOUT_MS) / 1000)}s——交宿主重试层退避后重试`);
          throw new LlmError(
            `llm-sensenova: request queued behind the per-key concurrency limit for over ${queueMs ?? DEFAULT_QUEUE_TIMEOUT_MS}ms；SenseNova 请求排队超时（未占用并发额度），交宿主重试层退避后重试`,
            LLM_CODES.timeout,
            { cause: error },
          );
        }
        let attempt: Response;
        try {
          // 连接/首字节超时（design D4，2026-09-04 实测传输挂起 ≈1/5 且无 RST）：
          // 自管 AbortController + setTimeout，响应头到达即清除计时器——超时只约束
          // 建连/首包阶段（不可用 AbortSignal.timeout：undici 下它会在整个 body
          // 读取阶段持续生效，超过 connectMs 的健康长流会被误杀）。控制器全程转发
          // 宿主 abort，body 阶段的中止语义与直传宿主 signal 等价。
          const connectController = new AbortController();
          const connectTimer = setTimeout(() => {
            connectController.abort(new DOMException('connect timed out', 'TimeoutError'));
          }, connectMs);
          const onHostAbort = () => connectController.abort(options.signal?.reason);
          if (options.signal !== undefined) {
            if (options.signal.aborted) connectController.abort(options.signal.reason);
            else options.signal.addEventListener('abort', onHostAbort, { once: true });
          }
          connectCleanups.push(() => {
            clearTimeout(connectTimer);
            options.signal?.removeEventListener('abort', onHostAbort);
          });
          attempt = await this.fetchImpl(`${connection.apiBase}${endpointOf(wire)}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
              ...attributionHeaders(),
            },
            body,
            signal: connectController.signal,
          });
          // 响应头已到达：连接超时使命完成（finally 里的 clearTimeout 为幂等兜底）。
          clearTimeout(connectTimer);
        } catch (error) {
          release();
          release = undefined;
          if (options.signal?.aborted) throw error;
          if (isTimeoutReason(error)) {
            throw new LlmError(
              `llm-sensenova: request to ${connection.apiBase} timed out after ${connectMs}ms；SenseNova 请求建连或首包超时（已释放并发额度），交宿主重试层处理`,
              LLM_CODES.timeout,
              { cause: error },
            );
          }
          throw new LlmError(`llm-sensenova: request to ${connection.apiBase} failed: ${errorChain(error)}；连接 SenseNova API 失败，通常是网络或代理问题`, LLM_CODES.transport, { cause: error });
        }
        if (attempt.ok) {
          response = attempt;
          // 请求成功：限流相关计数归零（下次再限流从最短档 3s 重新探测）。
          // 恢复行放宽到 rate 类（2026-10-31 他批）：trail 非空 = 本会话刚吃过
          // 限流，「限速解除」时刻显式可读（第一条 429 到本行的时间差 = 窗口
          // 时长），不再靠账本重置反推。
          const priorHits = this.probeHitCounts.get(options.sessionId);
          const trailLen = this.session429Trail.get(options.sessionId)?.length ?? 0;
          if (priorHits !== undefined || trailLen > 0) {
            traceLog(`[dsh-sensenova-suite] 429 恢复 model=${options.model} key=${maskKey(apiKey)} ` +
              (priorHits !== undefined
                ? "连续限流结束，探测档归零"
                : `连续 ${trailLen} 次限流后成功`));
          }
          this.probeHitCounts.delete(options.sessionId);
          this.session429Trail.delete(options.sessionId);
          this.quotaStickyKeys.delete(options.sessionId); // 粘性使命完成（U4 顺带②B）：下一请求回池层选 key。
          probeResetBySuccess = true;
          this.deps.reportOutcome?.(apiKey, 'success');
          break; // 额度随 response 保留，由外层 finally 在流结束后释放
        }
        const errText = await attempt.text().catch(() => '');
        const retryAfterMs = parseRetryAfterMs(attempt.headers.get('retry-after'));
        // 400 一律落响应体原文（截 400 字符），三条 wire 都记（chat 也会 400——
        // 2026-10-27 kimi thinking:'disabled' 被拒时日志盲区，正是这次漏记的线）：
        // 降级判据只认 invalid_request_error 形状，商汤自家错误形状不触发降级而
        // 直接漏到对话里；「平台拒绝的是哪个字段」只有 body 原文能回答。
        if (attempt.status === 400) {
          traceLog(`[dsh-sensenova-suite] ${wire} wire 400 sid=${options.sessionId ?? "-"} model "${options.model}" body: ${errText.slice(0, 400)}`);
        }
        // §5.3 运行时不符兜底：现代协议（Anthropic / Responses）400 且
        // error.type=invalid_request_error → 记进程内 unsupported 集合 + 打日志，
        // 同请求立即沿生效链换下一跳重试一次（发生在任何内容流出之前，是 wire
        // 粘性的唯一例外）；链耗尽落全局兜底 chat，chat 400 无处可退。
        // 不持久化、不写配置——重启即清空，文档与实况不符只退化为「该模型少一条协议」。
        const hopIndex = plan.chain.indexOf(wire);
        const chainNext = hopIndex >= 0 && hopIndex + 1 < plan.chain.length ? plan.chain[hopIndex + 1] : undefined;
        const nextWire = chainNext ?? (wire === 'chat-completions' ? undefined : 'chat-completions');
        if (attempt.status === 400 && nextWire !== undefined && !responsesFallbackUsed && isInvalidRequestError(errText)) {
          if (wire === 'anthropic') this.anthropicUnsupported.add(options.model);
          else if (wire === 'responses') this.responsesUnsupported.add(options.model);
          // eslint-disable-next-line no-console -- 适配器不持有 cordis logger，降级说明走 stderr 日志（避免用户困惑）。
          traceLog(
            `[dsh-sensenova-suite] ${wire} wire rejected model "${options.model}" with 400 invalid_request_error; ` +
              `falling back to ${nextWire} for this and subsequent requests in this process`,
          );
          wire = nextWire;
          body = await buildBody(wire);
          responsesFallbackUsed = true;
          release();
          release = undefined;
          continue;
        }
        // 404 模型不可路由：标记失败且不轮换/不重试。
        const modelNotFound = attempt.status === 404 && isModelNotFoundText(errText);
        if (modelNotFound) {
          release();
          release = undefined;
          this.failedModels.add(options.model);
          // 使目录缓存失效：下次 listModels 重新拉取并过滤掉该模型（TTL 缓存否则会返回含此模型的旧快照）。
          this.catalogFetchedAt = 0;
          throw httpError(attempt.status, errText, retryAfterMs, undefined, wire);
        }
        // 429：SenseNova 渠道常态性限流，不代表账号异常。不冷却账号；默认不轮换 key
        // （一个会话固定使用一个 key，保护服务端按 key 命中的 prompt 缓存），直接抛
        // RATE_LIMIT 交宿主重试层自动退避后原 key 重试。quotaRotation 开启时，仅
        // 配额类 429（error.code 8 / 429001）粘性切换到下一把未试过的 key 重试本次
        // 请求；环回无新 key 则停留在当前 key 抛 RATE_LIMIT。401 轮换路径不变。
        // 并发闸已在源头抑制并发超限，此处为兜底。
        const classified = classify429Body(errText);
        const full = classify429Full(errText);
        const quota429 = attempt.status === 429 && classified.quota;
        // suite 扩展：池类 429 同样参与粘性换 key；池类不冷却不禁用，只由池层记
        // (key, 组) 格子。（2026-11-03：pool 类请求侧信号暂无生产者——旧特征串
        // 判定实测全为限流误标已废，积分池耗尽 body 零样本；管线保留待 tpm 持续
        // 判据/真耗尽 code 接入。）
        const pool429 = attempt.status === 429 && !classified.quota && full.kind === 'pool';
        // 配额类 429 的退避档位：取**入口快照**（上游 W3，2026-11-02 对齐）——
        // 整次 stream() 调用（= 一次宿主重试周期）内所有 internal attempt 共用
        // 同一档，整轮失败才在 finally 里 +1。原实现在 attempt 循环内就地 +1，
        // 配额轮换的 continue 会让一次调用吃多档（4 把 key 各撞一次就从 0 跳到
        // 索引 3=15s 起），宿主预算被浪费在没有区分度的区间里。
        // 2026-11-02 统一：快慢窗口共用这一套梯子（3/5/10/15/30s）。
        let dynamicFloorMs: number | undefined;
        if (classified.quota) {
          dynamicFloorMs = entryProbeFloorMs;
          probeHitThisCall = true;
        }
        // 429 诊断（2026-10-27）：限流本身此前全程静默——「为什么慢了」「key 是不是
        // 被限」无从判断。每次 429 一行：模型/key/分类/本档退避；30s 级退避下量可控。
        // 轨迹账本在此追加（换 key 的 continue 之前，保证链上每把 key 都入账）。
        // body 摘要（2026-11-03 批 C）：pool 误分类破案（2026-11-02 事故）全程被
        // 「429 行不打 body」卡住——积分池耗尽形状零样本，摘要落日志后下次真撞即可识别。
        const trail429 = this.session429Trail.get(options.sessionId) ?? [];
        if (!trail429.includes(apiKey)) trail429.push(apiKey);
        this.session429Trail.set(options.sessionId, trail429);
        traceLog(`[dsh-sensenova-suite] 429 model=${options.model} key=${maskKey(apiKey)} ` +
          `kind=${pool429 ? "pool" : classified.quota ? classified.kind : "unknown"} ` +
          `bucket=${full.bucket ?? "-"} round=${round}/${FINAL_ROUND} ` +
          `退避=${dynamicFloorMs !== undefined ? `${Math.round(dynamicFloorMs / 1000)}s` : retryAfterMs !== undefined ? `${Math.round(retryAfterMs / 1000)}s(retry-after)` : "宿主默认"} ` +
          `body=${summarize429Body(errText)}`);
        // 配额类 429 且开关开启：轮换到下一把本请求本轮未试过的 key（tried 集合做
        // 本轮内防乒乓——轮边界处清空，各 key 在下一轮重新获得一次机会）。
        // 积分池类（pool）同样参与换 key，但**只打标不打断流程**：格子由池层在选
        // key 时自动跳过，D 耗尽不代表 A/B/C 也耗尽；只有该组全部 key 都标满
        // （rotateApiKey 返回 undefined 且池层确认全标）才提前终止并抛 QUOTA。
        const quotaRotate = (quota429 || pool429) && quotaRotation;
        const rotatable = attempt.status === 401 || quotaRotate;
        if (rotatable && options.signal?.aborted !== true) {
          // 'quota-exhausted' / 'pool-exhausted' 不写任何账号状态；401 仍走禁用轮换。
          const next = await this.deps.rotateApiKey(
            apiKey,
            attempt.status === 401
              ? 'invalid-credential'
              // 踢出判据按桶：RPM 桶（code 8 / 429003 / *RPM* 族）只换不记——
              // 14s 级自愈，计入踢出阈值会误伤贴线限流的健康 key（2026-10-31 他
              // 拍板，先 429003 后 code 8）；2026-11-02 退避值统一后，这条判据
              // 仍是按桶的正判据，不随退避策略变化。
              : pool429 ? 'pool-exhausted' : bucketCountsStrike(full.bucket) ? 'quota-exhausted' : 'rate-soft',
            options.model,
            tried,
          );
          if (next !== undefined && !tried.has(next)) {
            // 预流轮换：先释放旧 key 额度，下一轮为新 key 重新获取。
            release();
            release = undefined;
            const previousKey = apiKey;
            apiKey = next;
            totalAttempts += 1;
            traceLog(`[dsh-sensenova-suite] 429 换 key model=${options.model} ${maskKey(previousKey)} → ${maskKey(next)}（轮 ${round}/${FINAL_ROUND}，本轮已试 ${tried.size} 把，累计 ${totalAttempts} 次）`);
            if (quotaRotate) {
              // 有界（U4 审计顺带②）：超上限先删最早插入的条目再写。
              if (!this.quotaStickyKeys.has(options.sessionId) && this.quotaStickyKeys.size >= QUOTA_STICKY_KEYS_MAX) {
                const oldest = this.quotaStickyKeys.keys().next().value;
                if (oldest !== undefined) this.quotaStickyKeys.delete(oldest);
              }
              this.quotaStickyKeys.set(options.sessionId, next); // 粘住新 key
              // 不在此清 probeHitCounts：计数是 per-session（不区分 key），且按入口
              // 快照语义整轮只推进一档，循环内 delete 会被 finally 的 set 覆盖——
              // 写了等于没写，还会误导后来者以为「换 key 就重置档位」。
            }
            continue;
          }
        }
        // 兜底轮换（key-health.ts shouldRotateUnclassified）：401 / 配额 429 / 池 429
        // 之外的失败里，只有「分类器不认识的 429」（旧实现原地重试到预算耗尽，
        // Endpoint 族补分类前就是这种形态）与「402/403 账号态拒绝」（欠费/禁用，
        // 不在宿主可重试清单里，不换就直接上屏）值得换 key 再试。
        // 400/404/413/422 与 5xx/超时/传输不换：换了也不会变好。
        // 429 走完整轮池（2026-10-31 实测：每个 429 都是某种限速，换 key 有实证支持；
        // 单次兜底会让宿主重试在同一个 2 把里反复撞墙）。402/403 仍只兜底一次——
        // 它们是账号态，不是瞬时负载，把整池轮一遍没有额外信息。
        // 两者都不记 strike：形状不明时判死一把 key 太武断（key-health.ts 的边界）。
        if (shouldRotateUnclassified(attempt.status, quota429 || pool429)
          && options.signal?.aborted !== true
          && (attempt.status === 429 || !unclassifiedFallbackUsed)) {
          const next = await this.deps.rotateApiKey(apiKey, 'rate-unclassified', options.model, tried);
          if (next !== undefined && !tried.has(next)) {
            release();
            release = undefined;
            const previousKey = apiKey;
            apiKey = next;
            totalAttempts += 1;
            if (attempt.status !== 429) unclassifiedFallbackUsed = true;
            traceLog(`[dsh-sensenova-suite] 未分类失败换 key model=${options.model} ` +
              `status=${attempt.status} ${maskKey(previousKey)} → ${maskKey(next)}（${attempt.status === 429 ? "本请求内轮满池" : "仅兜底一次"}，轮 ${round}/${FINAL_ROUND}，累计 ${totalAttempts} 次）`);
            continue;
          }
        }
        // ── 本轮已无可试 key：进入下一轮 / 第 4 轮 / 终止 ─────────────────────
        // **只有 429 才走轮询**：400/404/413/422 是请求问题、5xx/超时/传输是平台
        // 问题、402/403 是账号态——换 key 与重打都不会变好，落到下方统一抛出。
        // （2026-11-02 修：本块此前无状态码守卫，非 429 失败会被误判成「轮尽」
        // 而白等 5-10s 重打 3 轮。）
        // 全组池耗尽：该组每把 key（含阻塞态）都被池格标记 ⇒ 不再有任何轮次有意义，
        // 立即终止并抛 ACCOUNT_QUOTA（宿主不重试）。这是唯一「不等」的终止路径。
        // 注意：单把 key 的池耗尽**只打标不打断流程**——D 耗尽不代表 A/B/C 也耗尽，
        // 格子由池层在下一轮选 key 时自动跳过（这就是「D 不参与下一次轮询」）。
        const allPoolMarked = attempt.status === 429 && this.deps.poolFullyMarked?.(options.model) === true;
        if (attempt.status === 429 && !allPoolMarked && round < FINAL_ROUND) {
          // 3 轮结束 → 抖动等待 5-10s（每请求独立、可中止）→ 第 4 轮。
          // 第 4 轮之后不再等待（「最大主动等待次数 1 次」）。
          if (round === MAX_POLL_ROUNDS) {
            const waitMs = JITTER_WAIT_MIN_MS + Math.floor(Math.random() * (JITTER_WAIT_MAX_MS - JITTER_WAIT_MIN_MS));
            traceLog(`[dsh-sensenova-suite] 429 轮间等待 model=${options.model} ${Math.round(waitMs / 100) / 10}s（${MAX_POLL_ROUNDS} 轮全 429，抖动等待后进第 ${FINAL_ROUND} 轮）`);
            release?.();
            release = undefined;
            await abortableSleep(waitMs, options.signal);
            // S2a（2026-11-04 拍板）：用户按停止 = 原样透传 abort（与 fetch catch
            // 的 :1418 姿态一致）——不再映射 TRANSPORT 冒充「传输错误」。宿主
            // 重试层零危害不变（backoff 首行查 abort，aborted 零安排）。
            if (options.signal?.aborted === true) throw options.signal.reason;
          }
          round += 1;
          tried.clear();
          // 轮界换 key 与预流轮换同一纪律：先释放旧 key 额度再取新起点。漏放 =
          // release 变量在循环顶被新 acquire 覆盖，上一轮最后一把 key 的槽位
          // 永久泄漏——limit=1 下该 key 此后每次 acquire 都排队到超时（2026-11-03
          // 真机实录：第 4 发泄漏、第 7 发撞死、宿主 10 次重试全数静默超时 ≈15min）。
          // 第 3→4 轮的抖动分支已先放，此处 no-op 安全。
          release?.();
          release = undefined;
          // 新一轮起点重新解析（商汤组=亲和 key 恒第一；通用组=游标推进）。
          // 起点轮换：把上一轮起点排除（裸轮转组从它的下一位环回）。
          const nextStart = await this.pickRoundStart(options, roundStartKey);
          if (nextStart === undefined) {
            traceLog(`[dsh-sensenova-suite] 429 轮 ${round} 无可用 key model=${options.model}（池空或该组全标）`);
            throw httpError(attempt.status, errText, retryAfterMs, dynamicFloorMs, wire, allPoolMarked);
          }
          apiKey = nextStart;
          roundStartKey = nextStart;
          tried.add(apiKey);
          traceLog(`[dsh-sensenova-suite] 429 进入第 ${round}/${FINAL_ROUND} 轮 model=${options.model} 起点 key=${maskKey(apiKey)}`);
          continue;
        }
        if (attempt.status === 429) {
          // 轮尽（或池全标）的收尾行：已试列表 = 跨宿主重试累计的脱敏 key。
          // pool 全标走 QUOTA 出口（宿主不重试）；其余交宿主重试层（预算内自动重试）。
          const label = allPoolMarked
            ? `429 该组全池耗尽（${round} 轮终止）`
            : quota429 || pool429
              ? (quotaRotation ? `429 ${round} 轮换无可换` : "429 未轮换（quotaRotation 未开）")
              : totalAttempts > 1
                ? `429 未识别形状，已换 ${totalAttempts - 1} 次 key`
                : "429 未识别形状，无可轮换";
          traceLog(`[dsh-sensenova-suite] ${label} model=${options.model} ` +
            `已试 ${trail429.map((key) => maskKey(key)).join("/")} 共 ${trail429.length} 把、${totalAttempts} 次，` +
            `${allPoolMarked ? "抛 QUOTA（宿主不重试）" : "交宿主重试层（预算内自动重试）"}`);
        }
        release();
        release = undefined;
        throw httpError(attempt.status, errText, retryAfterMs, dynamicFloorMs, wire, allPoolMarked);
      }

      if (response === undefined) {
        // 不可达：循环要么 break（成功）要么 throw；仅用于满足明确赋值分析。
        throw new LlmError('llm-sensenova: SenseNova API returned no response', LLM_CODES.providerProtocolError);
      }
      if (response.body === null) {
        throw new LlmError('llm-sensenova: SenseNova API returned no response body', LLM_CODES.providerProtocolError);
      }
      if (wire === 'anthropic') {
        // 流断尾（无 message_stop）命中即内存级换线降级（2026-10-31 他拍板）：
        // 平台 anthropic 线时好时坏，与本进程已有的 400 运行时不符标记共用
        // anthropicUnsupported 集合——本请求内容已流出、不能原地重发（会重复
        // 输出），抛给宿主重试层；重试与后续请求经 resolveWirePlan 自动走生效链
        // 下一跳（responses/chat）。标记不持久化，重启清除。
        try {
          yield* parseAnthropicSse(response.body, options.signal, streamIdleMs, options.model, options.sessionId);
        } catch (error) {
          if (error instanceof LlmError && error.code === ANTHROPIC_TRUNCATED_CODE && !this.anthropicUnsupported.has(options.model)) {
            this.anthropicUnsupported.add(options.model);
            // stop=N：实证「断尾是否伴随 stop 序列」（平台命中 stop_sequence 时
            // 少发终止事件的假设，跑一段时间即可定论）。
            traceLog(`[dsh-sensenova-suite] anthropic 流断尾（无 message_stop）model="${options.model}" stop=${options.stop?.length ?? 0}——本进程内标记该模型 anthropic 线不支持，后续请求走生效链下一跳（重启清除）`);
          }
          throw error;
        }
      } else if (wire === 'responses') {
        yield* parseResponsesSse(response.body, options.signal, streamIdleMs, options.model, options.sessionId);
      } else {
        yield* parseOpenAiSse(response.body, options.signal, streamIdleMs, options.model, options.sessionId);
      }
    } finally {
      for (const cleanup of connectCleanups) cleanup();
      release?.();
      releaseSlot?.();
      // 退避档位推进（上游 W3）：整次 stream() 调用（含轮换出的所有 internal
      // attempt、含 4 轮）只消耗一档，仅在「撞过配额类 429 且最终未成功」时 +1；
      // 没撞（纯传输错误、非配额失败）则档位不动。成功已在循环内清零
      // （probeResetBySuccess）。2026-11-02 统一：快慢窗口共用这一套档位。
      if (probeHitThisCall && !probeResetBySuccess) {
        this.probeHitCounts.set(options.sessionId, entryProbeHits + 1);
      }
    }
  }
}
