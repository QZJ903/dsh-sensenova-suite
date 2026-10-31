/** 静态模型能力档案 + 目录合并（add-model-facts tasks 1.1–2.1）。
 *
 * 数值与 align-request-fields-with-docs 落地后的 KNOWN_EFFORTS/KNOWN_SAMPLING_PARAMS
 * 同源（原文 /tmp/sn_docs_zh.md；Chat 出站行为零变化，见 adapter.ts 消费注释）。 */
import type { FactsCatalogEntry, ModelFacts, WireKind } from './types.ts';

/** 未知/未声明格式模型的通用宽容集：格式白名单只拦「已知不支持」，未知不预拦
 * （交平台 API 自行裁决）。已知分支缺省与未知分支开图共用同一份（duplication 门）。 */
const GENERIC_IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'gif'];

/** 全模型统一默认降级链（2026-10-31 用户拍板，两步：先加回 kimi/glm 的
 * anthropic 撤销分岔，再把顺序定为 re→an→chat——responses 线没出现过空流/断尾
 * 形态，anthropic 的时好时坏由运行时降级兜底：ANTHROPIC_TRUNCATED / 400 命中即
 * 内存级标记换线，重启清除）。策略层——链走查仍与 supportedWires 求交，能力外
 * 的线被跳过。 */
const STANDARD_CHAIN: readonly WireKind[] = ['responses', 'anthropic', 'chat-completions'];

/** 未收录模型 id 的通用兜底档案（不抛错；Chat 行为与迁移前「未知模型」路径一致）。 */
const GENERIC_FACTS: ModelFacts = {
  id: '',
  supportedWires: ['chat-completions'],
  // 未知模型能力面只有 chat；链仍写标准链（策略统一），走查会跳过能力外的线。
  defaultChain: STANDARD_CHAIN,
  efforts: [],
  defaultEffort: null,
  responsesDefaultEffort: null,
  anthropicDefaultEffort: null,
  outputLimitField: 'max_tokens',
  outputLimitMax: null,
  supportsStreamOptions: false, // 未知模型保守不发 stream_options（迁移前同）
  requiresReasoningReplay: false,
  forbidThinkingDisabled: false,
  noneMapsToThinkingDisabled: false,
  fixedTemperature: null,
  fixedTopP: null,
  blockedSampling: [],
  supportsImages: false,
  imageFormats: [],
  imageRequiresBase64: false,
  anthropicSupportsImages: false,
  responsesMaxOutputTokens: null,
  responsesSupportsJsonSchema: false,
};

/** 静态档案表（deepseek-v4-pro 已下线，不收录）。
 * 行号锚点：6.8 参数表 :543-560；v4-flash :1288-1320；deepseek-flash :1665-1673；
 * glm-5.2 :2022 起；kimi-k3 :2403-2451；Responses §3.2（升级计划 docs/sensenova-upgrade-plan.md:111-114）。 */
const STATIC_FACTS: ReadonlyMap<string, ModelFacts> = new Map([
  ['sensenova-6.8-flash-lite', {
    id: 'sensenova-6.8-flash-lite',
    supportedWires: ['chat-completions', 'responses', 'anthropic'],
    defaultChain: STANDARD_CHAIN,
    efforts: ['low', 'medium', 'high', 'max', 'none'],
    defaultEffort: 'high',
    responsesDefaultEffort: 'high',
    anthropicDefaultEffort: 'high',
    outputLimitField: 'max_tokens',
    outputLimitMax: 65536,
    supportsStreamOptions: true,
    requiresReasoningReplay: false,
    forbidThinkingDisabled: false,
    noneMapsToThinkingDisabled: false,
    fixedTemperature: null,
    fixedTopP: null,
    blockedSampling: [],
    samplingParameters: ['seed', 'n', 'parallel_tool_calls'],
    supportsImages: true,
    imageFormats: ['jpg', 'jpeg', 'png', 'webp'],
    imageRequiresBase64: false,
    anthropicSupportsImages: true, // 文档 #api-compatibility-params：仅 6.8 支持图片块
    responsesMaxOutputTokens: 65536,
    responsesSupportsJsonSchema: false,
  }],
  ['deepseek-v4-flash', {
    id: 'deepseek-v4-flash',
    supportedWires: ['chat-completions', 'responses', 'anthropic'],
    defaultChain: STANDARD_CHAIN,
    efforts: ['low', 'medium', 'high', 'max', 'none'],
    defaultEffort: 'high',
    responsesDefaultEffort: 'high',
    anthropicDefaultEffort: 'high',
    outputLimitField: 'max_tokens',
    outputLimitMax: 384000,
    supportsStreamOptions: true,
    requiresReasoningReplay: true,
    forbidThinkingDisabled: false,
    noneMapsToThinkingDisabled: false,
    fixedTemperature: null,
    fixedTopP: null,
    blockedSampling: [],
    supportsImages: false,
    imageFormats: [],
    imageRequiresBase64: false,
    anthropicSupportsImages: false,
    responsesMaxOutputTokens: 384000,
    responsesSupportsJsonSchema: false,
  }],
  ['deepseek-flash', {
    // V4.1 Flash：原生档 none/low/high/max + 兼容映射；Responses 上限文档未列（待实测）。
    id: 'deepseek-flash',
    supportedWires: ['chat-completions', 'responses', 'anthropic'],
    defaultChain: STANDARD_CHAIN,
    efforts: ['none', 'low', 'high', 'max'],
    defaultEffort: 'high',
    responsesDefaultEffort: 'high',
    anthropicDefaultEffort: 'high',
    effortCompat: { minimal: 'low', medium: 'high', xhigh: 'high', ultra: 'max' },
    outputLimitField: 'max_tokens',
    outputLimitMax: 393216,
    supportsStreamOptions: true,
    requiresReasoningReplay: true,
    forbidThinkingDisabled: false,
    noneMapsToThinkingDisabled: false,
    fixedTemperature: null,
    fixedTopP: null,
    blockedSampling: [],
    supportsImages: true,
    imageFormats: ['jpeg', 'png', 'gif', 'webp'],
    imageRequiresBase64: false,
    // 2026-10-27 用户真机实测：deepseek-flash 走 anthropic wire 发图成功——
    // 此前按文档 api-compatibility-params 写的 false（「仅 6.8 支持图片块」）
    // 与实测不符，已翻 true；auto 模式带图不再降级离开 anthropic。
    anthropicSupportsImages: true,
    responsesMaxOutputTokens: null, // §3.2 范围表漏列 deepseek-flash，须实测
    responsesSupportsJsonSchema: true,
  }],
  ['glm-5.2', {
    id: 'glm-5.2',
    supportedWires: ['chat-completions', 'responses', 'anthropic'],
    // 2026-10-30 曾因偶发 200 空流静态排除 anthropic；2026-10-31 加回（他拍板）：
    // 空流/断尾由运行时降级兜底（ANTHROPIC_TRUNCATED/400 → 内存级标记换线），
    // 档案层不再分岔。
    defaultChain: STANDARD_CHAIN,
    efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'],
    defaultEffort: 'max',
    responsesDefaultEffort: 'max',
    anthropicDefaultEffort: 'max',
    outputLimitField: 'max_tokens',
    outputLimitMax: 131072,
    supportsStreamOptions: false,
    requiresReasoningReplay: false,
    forbidThinkingDisabled: true,
    noneMapsToThinkingDisabled: false,
    fixedTemperature: null,
    fixedTopP: null,
    blockedSampling: [],
    supportsImages: false,
    imageFormats: [],
    imageRequiresBase64: false,
    anthropicSupportsImages: false,
    responsesMaxOutputTokens: 131072,
    responsesSupportsJsonSchema: false,
  }],
  ['kimi-k3', {
    id: 'kimi-k3',
    supportedWires: ['chat-completions', 'responses', 'anthropic'],
    // 2026-10-30 曾因 200 空流连续 4 次静态排除 anthropic（定案「不支持 an 线」）；
    // 2026-10-31 加回（他拍板）：与 glm 同理，运行时降级兜底，档案层不再分岔。
    defaultChain: STANDARD_CHAIN,
    // none 入表依据：官方文档思考强度梯子明确列 `none`＝关闭推理；2026-09-29
    // 全模型探测口径 thinkingLevelMap off→none 同证（其余模型 efforts 均含 none）。
    efforts: ['low', 'medium', 'high', 'max', 'none'],
    defaultEffort: 'max',
    responsesDefaultEffort: 'max',
    anthropicDefaultEffort: 'max',
    outputLimitField: 'max_completion_tokens',
    outputLimitMax: 1048576, // 1M−prompt 软上限
    supportsStreamOptions: true,
    requiresReasoningReplay: false,
    forbidThinkingDisabled: false,
    // 2026-10-27 真机实测修正（原注释「文档自相矛盾，待实测」的实测结果）：
    // `thinking:'disabled'`（string）被平台 400 invalid arguments code 3 拒绝；
    // 关闭思考走 reasoning_effort:'none'（efforts 已含 none，文档梯子表背书）。
    noneMapsToThinkingDisabled: false,
    fixedTemperature: 1,
    fixedTopP: 0.95,
    blockedSampling: ['frequency_penalty', 'presence_penalty', 'temperature', 'top_p'],
    samplingParameters: ['seed', 'parallel_tool_calls'],
    supportsImages: true,
    imageFormats: ['jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif'],
    imageRequiresBase64: true, // 不支持公网 URL，仅 base64
    // 2026-10-27 用户真机实测：kimi-k3 走 anthropic 发图成功（与 deepseek-flash
    // 同批确认），档案从文档口径的 false 翻 true。
    anthropicSupportsImages: true,
    responsesMaxOutputTokens: 1048576,
    responsesSupportsJsonSchema: true,
  }],
]);

/** 静态档案查询（未收录返回 undefined；adapter 的目录解析路径使用）。 */
export function staticFacts(model: string): ModelFacts | undefined {
  return STATIC_FACTS.get(model);
}

/** 面板思考梯子（与 client 的 THINKING_CHOICES 同一五档；facts 不 import client）。 */
const PANEL_LADDER: readonly string[] = ["off", "low", "medium", "high", "max"];

/**
 * 模型的面板思考档位首装默认集（2026-10-27 用户拍板）：按官方文档的**原生
 * 档位**（静态表 efforts 就是文档口径）∩ 面板五档——`none` 与面板 `off` 同义
 * 归一；xhigh/minimal 等面板表达不了的拼写不管（梯子本就没有，0.1.4 移除）。
 * 未收录模型返回 []（文档没覆盖的模型不给臆造默认）。
 */
export function defaultThinkingLevels(modelId: string): string[] {
  const facts = STATIC_FACTS.get(modelId);
  if (facts === undefined) return [];
  const out = new Set<string>();
  for (const level of facts.efforts) {
    const panel = level === "none" ? "off" : level;
    if (PANEL_LADDER.includes(panel)) out.add(panel);
  }
  return PANEL_LADDER.filter((level) => out.has(level));
}

/** 全部已知模型的默认集（pool-store readThinking 播种用；id → 档位升序）。 */
export function nativeThinkingDefaults(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of STATIC_FACTS.keys()) out[id] = defaultThinkingLevels(id);
  return out;
}

/** 目录实测值 > 静态档案：context/max_output/input_modalities/supported_sampling_parameters
 * 覆盖静态对应项，缺失回退静态；未知目录字段宽容忽略；未收录模型返回通用兜底（不抛错）。 */
export function factsFor(model: string, entry: FactsCatalogEntry | undefined): ModelFacts {
  const base = STATIC_FACTS.get(model);
  if (base === undefined) {
    // 未知模型：目录能补的只有输出上限、图像与采样白名单（与迁移前未知模型路径一致）。
    // 图像：目录申报含 image（含请求期勾选注记，adapter stream）即开——用户勾选
    // 「可看图」的新模型不因静态表未收录而被格式白名单/投影拦死（2026-10-27）。
    const catalogImage = entry?.inputModalities?.includes('image') === true;
    return {
      ...GENERIC_FACTS,
      id: model,
      outputLimitMax: entry?.maxOutputTokens ?? null,
      ...(catalogImage ? { supportsImages: true, imageFormats: GENERIC_IMAGE_FORMATS } : {}),
      ...(entry?.supportedSamplingParameters !== undefined
        ? { samplingParameters: entry.supportedSamplingParameters }
        : {}),
    };
  }
  const outputLimitMax = entry?.maxOutputTokens ?? base.outputLimitMax;
  // input_modalities 实测覆盖：目录申报含 image 才开图像；申报缺像（undefined，
  // modality.inputModalitiesFor 对无 image 的结论一律不申报）回退静态表。静态
  // supportsImages 的模型在 parseCatalog 已强制并入 image，两条路不再打架。
  const catalogDeclaresImage = entry?.inputModalities?.includes('image') ?? base.supportsImages;
  const supportsImages = catalogDeclaresImage;
  const imageFormats = supportsImages
    ? (base.imageFormats.length > 0 ? base.imageFormats : GENERIC_IMAGE_FORMATS)
    : [];
  return {
    ...base,
    outputLimitMax,
    supportsImages,
    imageFormats,
    ...(entry?.supportedSamplingParameters !== undefined
      ? { samplingParameters: entry.supportedSamplingParameters }
      : {}),
  };
}
