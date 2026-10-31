/** 内容块 → wire 出站项翻译（add-multimodal-input 1.x；规划 §6.3、design 决策 1/2/5）。
 *
 * 双分支形态（硬约束，测试断言形状）：
 * - chat：`{type:'image_url', image_url:{url}}`（嵌套）+ `{type:'text', text}`；
 * - responses：`{type:'input_image', image_url}`（**扁平字段**）+ `{type:'input_text', text}`。
 *
 * 图像数据流（design 前提假设，0.1.7-rc.2 类型面）：ImageBlock 只携带
 * `attachment: ImageAttachmentRef`（attachmentId/name/width/height/mediaType，无内联
 * 字节或 URL）。宿主 `resolveImageAttachmentAccess` 需要 AttachmentStore + 宿主路径
 * 映射，二者均为宿主内部服务、不向 adapter 暴露——因此本模块把「ref → 图像来源」
 * 定义为可注入的 `ImageAccessResolver`（生产侧由装配层桥接 resolveImageAttachmentAccess
 * 的结果；缺省 undefined → 图像按宿主 textOnlyImageText 占位，绝不静默丢弃后发空请求）。
 * 检测/投影一律复用宿主 re-export：contentHasImage / projectImagesForTextModel /
 * offloadedImageText / textOnlyImageText（tasks 1.4 grep 自查：无自造等价物；
 * 注：宿主 0.1.7-rc.2 无 `offloadRequestImagesWithPolicy` 导出，卸载决策由宿主
 * 路由层负责，本插件只消费已带 `offloaded:true` 标记的块）。
 * @module dsh-sensenova-suite/wire/blocks
 */
import { readFile } from 'node:fs/promises';
import { LlmError, contentHasImage, offloadedImageText, textOnlyImageText } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, ImageBlock } from '@deepseek-ai/dsh-llm';
import { factsFor } from './facts.ts';
import { traceLog } from '../trace-log.ts';
import type { FactsCatalogEntry, WireKind } from './types.ts';

/** 宿主持久化图像引用（0.1.7 类型面 ImageBlock.attachment 的索引访问，避免直接
 * import 未随 dsh-llm 发布的 @deepseek-ai/dsh-attachment 类型包）。 */
export type ImageRef = ImageBlock['attachment'];

/** 一个图像出站前解析到的来源：本地只读路径（读文件转 base64 data URL）、现成 URL、
 * 或内存字节（附件服务直读 → 直接组 data URL）。byteLength 可选覆盖实际字节数
 * （测试注入大文件阈值用）。 */
export type ImageAccess =
  | { readonlyPath: string; byteLength?: number | undefined }
  | { url: string }
  | { base64: string; mediaType: string };

/** 装配层注入的图像来源解析器（附件服务直读或本地路径）。允许返回 Promise：
 * 附件读取是异步的（vision/bridge 与原生出图共用同一读取口）；Promise 落空
 * （undefined）→ 占位出站。 */
export type ImageAccessResolver = (ref: ImageRef) => ImageAccess | undefined | Promise<ImageAccess | undefined>;

/** 出站前已备好的一个图像载荷。 */
export interface PreparedImage {
  /** data:…;base64,… 或公网 URL——两种 wire 都填进各自的 image_url 字段。 */
  url: string;
  /** 来源是否为公网 URL（kimi-k3 仅 base64，URL 需降级，design 决策 3）。 */
  fromUrlSource: boolean;
}

/** 无图像参与时 builders 保持纯文本现状（零回归）；有图像时按 wire 出数组。 */
export type UserContentWire = string | Array<Record<string, unknown>>;

/** Responses input_image 协议格式集（文档 §Responses :3210 段，spec「图像限制校验」）。 */
const RESPONSES_IMAGE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'gif', 'webp']);

/** deepseek-flash 图像限制（文档 :1468-1500；design 前提假设按 1024 进制）。 */
const DEEPSEEK_FLASH_IMAGE_LIMITS = {
  singleBytes: 50 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  maxCount: 200,
} as const;

/** mediaType → 规范扩展名（jpg 与 jpeg 归一为 jpeg；白名单两侧同样归一）。 */
function formatOf(mediaType: string): string | undefined {
  switch (mediaType) {
    case 'image/png': return 'png';
    case 'image/jpg':
    case 'image/jpeg': return 'jpeg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'image/bmp': return 'bmp';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    default: return undefined;
  }
}

function refKey(ref: ImageRef): string {
  return String(ref.attachmentId);
}

/**
 * data URL → Anthropic base64 source（`{type:'base64',media_type,data}`）。
 * data URL 形如 `data:image/png;base64,AAAA`，拆出 media_type 与纯 base64 数据
 * （Anthropic 协议不收带前缀的 data URL，文档 #api-compatibility-images）。
 */
function parseBase64Source(dataUrl: string): { type: 'base64'; media_type: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (match === null) return { type: 'base64', media_type: 'image/png', data: dataUrl };
  // 正则命中时捕获组必然存在；?? 仅为满足 noUncheckedIndexedAccess，不改变运行时行为。
  return { type: 'base64', media_type: match[1] ?? 'image/png', data: match[2] ?? '' };
}

/** 是否为需要出站的图像块（offloaded 块由 builders 直接投影占位文本，不进本路径）。 */
function isLiveImage(block: ContentBlock): block is ImageBlock {
  return block.type === 'image' && block.offloaded !== true;
}

/**
 * 出站前预解析全部图像块（唯一的异步步骤；builders 同步消费结果）：
 * - 格式校验：mediaType → 扩展名后对照模型 imageFormats（Responses wire 再与
 *   png/jpeg/gif/webp 求交）；不支持 → 报错（文案含支持列表，spec「格式不支持」）。
 * - 限制校验：deepseek-flash 单图 50MB / 总 64MB / 200 张（spec「大小与数量超限」）；
 *   「URL 总量 200MB」是文档侧约束，客户端无从测量字节、不预校验——超限/不可达由
 *   平台侧报错（2026-10-31 实测：URL 抓取失败为 code 3「image download failed」，
 *   302 跳转源与签名过期同样落到它；平台抓外国源仅 15–25KB/s，200MB 是否真拒
 *   未测——需国内快速源方能触到该分界）。
 * - 编码：本地只读路径 → base64 data URL；URL 来源原样保留（kimi-k3 仅 base64：
 *   URL 图像不进载荷表，builders 会以占位文本顶替并在此打日志，design 决策 3）。
 * - 解析不到来源的图像同样不进载荷表（builders 投影 textOnlyImageText 占位）。
 *
 * @returns attachmentId → 载荷； builders 用 has() 区分「占位」与「直传」。
 */
export async function prepareImages(
  options: GenerateOptions,
  entry: FactsCatalogEntry | undefined,
  wire: WireKind,
  resolveImageAccess: ImageAccessResolver | undefined,
): Promise<Map<string, PreparedImage>> {
  const facts = factsFor(options.model, entry);
  const whitelist = new Set(facts.imageFormats.map((format) => format === 'jpg' ? 'jpeg' : format));
  if (wire === 'responses') {
    for (const format of whitelist) {
      if (!RESPONSES_IMAGE_FORMATS.has(format)) whitelist.delete(format);
    }
  }
  const limits = options.model === 'deepseek-flash' ? DEEPSEEK_FLASH_IMAGE_LIMITS : undefined;
  // deepseek-flash 限额（单张/总量）的共用判定：两个解析分支（路径/内存字节）
  // 同一把尺，重复写第二遍会被 duplication 门抓住（2026-10-27 教训）。
  const checkImageLimits = (byteLength: number): void => {
    if (limits === undefined) return;
    if (byteLength > limits.singleBytes) {
      throw new LlmError(
        `llm-sensenova: deepseek-flash 单张图片不超过 50 MB（${(byteLength / 1024 / 1024).toFixed(1)} MB）；请压缩图片`,
        'INVALID_REQUEST',
      );
    }
    totalBytes += byteLength;
    if (totalBytes > limits.totalBytes) {
      throw new LlmError(
        'llm-sensenova: deepseek-flash 请求图片总量不超过 64 MB；请减少或压缩图片',
        'INVALID_REQUEST',
      );
    }
  };

  const prepared = new Map<string, PreparedImage>();
  let count = 0;
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const message of options.messages) {
    for (const block of message.content) {
      if (!isLiveImage(block)) continue;
      count += 1;
      if (limits !== undefined && count > limits.maxCount) {
        throw new LlmError(
          `llm-sensenova: deepseek-flash 单请求最多 ${limits.maxCount} 张图片，当前 ${count} 张；请减少图片数量或换用其他模型`,
          'INVALID_REQUEST',
        );
      }
      const ref = block.attachment;
      const key = refKey(ref);
      if (seen.has(key)) continue; // 同一 attachment 多次出现只编码一次
      seen.add(key);
      const format = formatOf(ref.mediaType);
      if (format === undefined || !whitelist.has(format)) {
        throw new LlmError(
          `llm-sensenova: 模型 ${options.model} 不支持图片格式 ${ref.mediaType ?? '(未知)'}${wire === 'responses' ? '（Responses 协议）' : ''}；支持的格式：${[...whitelist].join(', ')}`,
          'INVALID_REQUEST',
        );
      }
      const access = resolveImageAccess !== undefined ? await resolveImageAccess(ref) : undefined;
      if (access === undefined) {
        // 诊断：解析失败的图片走占位——模型「看不了图」最常见的原因就在这。
        traceLog(`[dsh-sensenova-suite] 图片出站解析失败（无 resolver 或读取失败）→ 占位文本，模型看不到这张图`);
        continue; // 占位（builders 处理）
      }
      if ('url' in access) {
        if (facts.imageRequiresBase64) {
          // design 决策 3：kimi-k3 无公网 URL 通路——占位保连续性，不拒绝整次对话。
          traceLog(
            `[dsh-sensenova-suite] model ${options.model} accepts base64 images only; ` +
              `public-URL image ${JSON.stringify(ref.name ?? String(ref.attachmentId))} was replaced with a text placeholder`,
          );
          continue;
        }
        // URL 图像字节量客户端无从测量（不预校验「URL 总量 200MB」）；超限/抓取
        // 失败由平台侧报错，实测形状见 prepareImages 头注（2026-10-31）。
        prepared.set(key, { url: access.url, fromUrlSource: true });
        continue;
      }
      if ('base64' in access) {
        // 内存字节（附件服务直读）：直接组 data URL；限额与路径分支同一把尺
        // （base64 长度 ×3/4 ≈ 原始字节数）。
        const byteLength = Math.floor(access.base64.length * 3 / 4);
        checkImageLimits(byteLength);
        prepared.set(key, { url: `data:${access.mediaType};base64,${access.base64}`, fromUrlSource: false });
        continue;
      }
      const bytes = await readFile(access.readonlyPath);
      const byteLength = access.byteLength ?? bytes.byteLength;
      checkImageLimits(byteLength);
      prepared.set(key, {
        url: `data:${ref.mediaType};base64,${bytes.toString('base64')}`,
        fromUrlSource: false,
      });
    }
  }
  return prepared;
}

/**
 * 翻译一条 user 消息的 content（add-multimodal-input 1.2/1.3；
 * add-anthropic-wire-protocol 增加第三种形状）：
 * 无图像块 → 纯文本字符串（与迁移前出站完全一致，零回归）；
 * 有图像块 → 按 wire 输出对象数组（kimi「content 必须是对象数组」同时满足）。
 *
 * 三种 wire 的文本/图像块形状（硬约束，测试断言形状）：
 * - responses：`{type:'input_text',text}` + `{type:'input_image',image_url}`（扁平）；
 * - anthropic：`{type:'text',text}` + `{type:'image',source:{type,media_type?,data?}}`；
 * - chat：`{type:'text',text}` + `{type:'image_url',image_url:{url}}`（嵌套）。
 *
 * offloaded 图像用宿主 offloadedImageText 投影；解析不到来源的图像用宿主
 * textOnlyImageText 占位——三条路径都不再「静默丢弃」（P0-2）。
 */
export function translateUserContent(
  content: readonly ContentBlock[],
  wire: WireKind,
  images: Map<string, PreparedImage> | undefined,
): UserContentWire {
  const hasImage = contentHasImage(content); // 宿主检测（tasks 1.4：不自造等价物）
  if (!hasImage) {
    return content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  }
  // Responses 的文本块叫 input_text；anthropic 与 chat 都叫 text。
  const textType = wire === 'responses' ? 'input_text' : 'text';
  const items: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === 'text') {
      items.push({ type: textType, text: block.text });
      continue;
    }
    if (block.type !== 'image') continue; // 文件块已被请求装配层投影为文本（宿主语义）
    const ref = block.attachment;
    if (block.offloaded === true) {
      items.push({ type: textType, text: offloadedImageText(ref) });
      continue;
    }
    const prepared = images?.get(refKey(ref));
    if (prepared === undefined) {
      items.push({ type: textType, text: textOnlyImageText(ref) });
      continue;
    }
    if (wire === 'anthropic') {
      // Anthropic image 块：base64 与 URL 两种 source 形状（文档 #api-compatibility-images）。
      items.push(prepared.fromUrlSource
        ? { type: 'image', source: { type: 'url', url: prepared.url } }
        : { type: 'image', source: parseBase64Source(prepared.url) });
      continue;
    }
    if (wire === 'responses') {
      items.push({ type: 'input_image', image_url: prepared.url }); // 扁平（design 决策 2）
    } else {
      items.push({ type: 'image_url', image_url: { url: prepared.url } }); // 嵌套
    }
  }
  return items;
}
