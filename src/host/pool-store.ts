/**
 * Key 池的运营状态存储（PLAN §5 的面板管理面）：面板可以对 key 做**停用 / 恢复 /
 * 删除**、调**全局并发数**、给模型选**协议**——这些是运营决策，不属于
 * `cordis.patch.yml`（部署默认），所以落在本插件自己的状态文件
 * `$DSH_HOME/state/[<profile>/]<plugin>/pool.json`，与 provider 开关
 * （provider-store.ts）同一纪律。
 *
 * 优先级：面板保存值 > patch 配置默认。`globalConcurrency` 未保存时回落配置；
 * `disabledIds` / `deletedIds` 在配置之上做减法（配置里有的账号也可能被停用）；
 * `modelProtocols` 完全面板所有（配置无此键）。
 *
 * 完整性沿用 catalog-store：版本化载荷 + 临时文件原子改名 + owner-only 目录 +
 * 「不认识的版本一律读作未设置」——损坏或降级的文件代价是一次重新设置，绝不是崩溃。
 *
 * @module dsh-sensenova-suite/pool-store
 */
import { join } from "node:path";
import { obj, degrade } from "./util.ts";
import { name } from "./host-config.ts";
import { profileStateDir, readStateJson, createStateReadCache, createVersionedJsonWriter } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** 形状版本；不兼容变更时递增。 */
export const POOL_STORE_VERSION = 1;
export const KNOWN_POOL_STORE_VERSIONS: readonly number[] = [1];

/** 池状态文件所在目录（按 profile 分段，见 PITFALLS §23）。 */
function poolStoreDir(profile: string | null) {
  return profileStateDir(name, profile);
}

/** 出图单工具的面板设置（仅保存面板改过的键；未设键回落配置）。 */
export interface ImageToolSettings {
  model?: string;
  size?: string;
  outputFormat?: string;
  responseFormat?: string;
  watermark?: boolean;
  promptExtend?: boolean;
  outputDir?: string;
}

/** 视觉卡的面板设置。 */
export interface VisionSettings {
  model?: string;
  bridgeMode?: string;
  bridgePrompt?: string;
  /** 用户勾选为「可识图」的模型 id 列表（在接入 API tab 思考档位旁勾选）。 */
  visionModels?: string[];
}

/** 工具开关（面板为主设置；配置 text2imgEnabled 等为部署默认）。 */
export interface ToolsEnabled {
  text2img?: boolean;
  img2img?: boolean;
  visionTools?: boolean;
}

/** 一把面板添加的 key：id 稳定（key-<n>），name 现在是「备注」字段（面板填的，可为空）。 */
export interface PoolKeyEntry {
  id: string;
  /** 备注：显示在脱敏名后；空 = 无备注。 */
  name: string;
}

/** 一份池运营状态。 */
export interface PoolStoreRecord {
  version: number;
  /** 停用的账号 id（可恢复）。 */
  disabledIds: string[];
  /** 删除的账号 id（不参与轮转；配置改动后想恢复需在此清除）。 */
  deletedIds: string[];
  /** 面板保存的全局并发数；null = 跟随配置。 */
  globalConcurrency: number | null;
  /** 模型 → 协议（auto | anthropic | responses | chat-completions）。 */
  modelProtocols: Record<string, string>;
  /** 面板添加的 key 清单（秘钥本体在凭据服务；此处只存 id 与名称）。 */
  keys: PoolKeyEntry[];
  /** 多模态面板设置（仅存面板改过的键）。 */
  toolsEnabled: ToolsEnabled;
  text2img: ImageToolSettings;
  img2img: ImageToolSettings;
  vision: VisionSettings;
  /** 每模型可用思考档位（用户配置；modelId → 档位列表）。空 = 用平台/静态默认。 */
  thinking: Record<string, string[]>;
}

/** 空白记录（全部回落配置默认）。 */
export function emptyPoolRecord(): PoolStoreRecord {
  return {
    version: POOL_STORE_VERSION,
    disabledIds: [], deletedIds: [], globalConcurrency: null, modelProtocols: {},
    keys: [],
    toolsEnabled: {}, text2img: {}, img2img: {}, vision: {}, thinking: {}
  };
}

/** 解析一份磁盘载荷；不是本插件的形状返回 null。 */
export function parsePoolPayload(raw: unknown): PoolStoreRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (source.version !== POOL_STORE_VERSION) return null;
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id !== "") : [];
  const protocols: Record<string, string> = {};
  if (typeof source.modelProtocols === "object" && source.modelProtocols !== null && !Array.isArray(source.modelProtocols)) {
    for (const [key, value] of Object.entries(source.modelProtocols as Record<string, unknown>)) {
      if (typeof key === "string" && key !== "" && typeof value === "string"
        && ["auto", "anthropic", "responses", "chat-completions"].includes(value)) {
        protocols[key] = value;
      }
    }
  }
  const concurrency = typeof source.globalConcurrency === "number" && Number.isFinite(source.globalConcurrency)
    ? Math.max(0, Math.floor(source.globalConcurrency))
    : null;
  // 多模态分区：白名单键 + 类型过滤（错型丢弃，不抛）。
  const boolOf = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
  const strOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
  const readImage = (value: unknown): ImageToolSettings => {
    const out: ImageToolSettings = {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
    const rec = value as Record<string, unknown>;
    const model = strOf(rec.model); if (model !== undefined) out.model = model;
    const size = strOf(rec.size); if (size !== undefined) out.size = size;
    const outputFormat = strOf(rec.outputFormat); if (outputFormat !== undefined) out.outputFormat = outputFormat;
    const responseFormat = strOf(rec.responseFormat); if (responseFormat !== undefined) out.responseFormat = responseFormat;
    const watermark = boolOf(rec.watermark); if (watermark !== undefined) out.watermark = watermark;
    const promptExtend = boolOf(rec.promptExtend); if (promptExtend !== undefined) out.promptExtend = promptExtend;
    const outputDir = strOf(rec.outputDir); if (outputDir !== undefined) out.outputDir = outputDir;
    return out;
  };
  const readVision = (value: unknown): VisionSettings => {
    // 可看图勾选默认集（2026-10-27 用户拍板）：deepseek-flash / kimi-k3 /
    // sensenova-6.8-flash-lite 原生看图（不走转述）。字段缺省 = 按此默认；
    // 显式保存的空数组（全不勾）尊重用户选择。
    const out: VisionSettings = { visionModels: ["deepseek-flash", "kimi-k3", "sensenova-6.8-flash-lite"] };
    if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
    const rec = value as Record<string, unknown>;
    const model = strOf(rec.model); if (model !== undefined) out.model = model;
    const bridgeMode = strOf(rec.bridgeMode);
    if (bridgeMode === "off" || bridgeMode === "on" || bridgeMode === "auto") out.bridgeMode = bridgeMode;
    const bridgePrompt = strOf(rec.bridgePrompt); if (bridgePrompt !== undefined) out.bridgePrompt = bridgePrompt;
    if (Array.isArray(rec.visionModels)) {
      out.visionModels = rec.visionModels.filter((id): id is string => typeof id === "string" && id !== "");
    }
    return out;
  };
  const readTools = (value: unknown): ToolsEnabled => {
    const out: ToolsEnabled = {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
    const rec = value as Record<string, unknown>;
    for (const key of ["text2img", "img2img", "visionTools"] as const) {
      const flag = boolOf(rec[key]);
      if (flag !== undefined) out[key] = flag;
    }
    return out;
  };
  const keyList: PoolKeyEntry[] = Array.isArray(source.keys)
    ? source.keys
        .map((entry: unknown) => {
          const rec = entry as Record<string, unknown>;
          if (typeof rec !== "object" || rec === null) return null;
          const id = typeof rec.id === "string" && rec.id !== "" ? rec.id : "";
          // name = 备注，允许空字符串（无备注）。
          const note = typeof rec.name === "string" ? rec.name.trim() : "";
          return id !== "" ? { id, name: note } : null;
        })
        .filter((entry): entry is PoolKeyEntry => entry !== null)
    : [];
  return {
    version: POOL_STORE_VERSION,
    disabledIds: ids(source.disabledIds),
    deletedIds: ids(source.deletedIds),
    globalConcurrency: concurrency,
    modelProtocols: protocols,
    keys: keyList,
    toolsEnabled: readTools(source.toolsEnabled),
    text2img: readImage(source.text2img),
    img2img: readImage(source.img2img),
    vision: readVision(source.vision),
    thinking: readThinking(source.thinking)
  };
}

/** 读取每模型可用思考档位（modelId → string[]；仅保留已知档位）。 */
function readThinking(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  const ALLOWED = ["off", "low", "medium", "high", "xhigh", "max"] as const;
  for (const [modelId, levels] of Object.entries(value as Record<string, unknown>)) {
    if (modelId === "" || !Array.isArray(levels)) continue;
    const clean = levels.filter((l): l is string => typeof l === "string" && (ALLOWED as readonly string[]).includes(l));
    if (clean.length > 0) out[modelId] = clean;
  }
  return out;
}

/** 一个 key 的运营状态（快照/路由读）。 */
export interface PoolKeyState {
  id: string;
  phase: "running" | "blocked" | "absent";
  disabled: boolean;
  deleted: boolean;
}

/**
 * 创建文件存储。方法面刻意小：读（带 TTL 缓存）、写整份记录、三个定向变更。
 * 跨进程可见性沿 catalog-store 的短 TTL 读缓存，不做一次性缓存。
 */
export function createFilePoolStore(options: StoreOptions = {}) {
  const { profile = null, now = Date.now, ttlMs, logger } = options;
  const file = join(poolStoreDir(profile), "pool.json");
  const writePool = createVersionedJsonWriter({
    file,
    versions: KNOWN_POOL_STORE_VERSIONS,
    label: "pool",
    onRefuse: (reason) => degrade(reason, null, logger, null),
    now
  });

  let held: PoolStoreRecord | null | undefined;
  const cacheOptions: Parameters<typeof createStateReadCache<PoolStoreRecord | null>>[1] = { now };
  if (ttlMs !== undefined) cacheOptions.ttlMs = ttlMs;
  const cache = createStateReadCache(async () => parsePoolPayload(await readStateJson(file)), cacheOptions);
  const seen = async (): Promise<PoolStoreRecord> => {
    held = await cache.read();
    return held ?? emptyPoolRecord();
  };
  // 写后把新记录灌进读缓存（remember）：自己的写入必须立刻对自己可见，不等 TTL。
  const apply = async (record: PoolStoreRecord): Promise<void> => {
    held = record;
    await writePool(held);
    cache.remember(held);
  };

  return {
    /** 整份读取（未设置处回落空白）。 */
    async read(): Promise<PoolStoreRecord> {
      return seen();
    },
    /** 面板保存全局并发数；null = 清除面板值回落配置。 */
    async setGlobalConcurrency(value: number | null): Promise<void> {
      const record = await seen();
            await apply({ ...record, globalConcurrency: value === null ? null : Math.max(0, Math.floor(value)) });
    },
    /** 停用一个账号 id（可恢复）。 */
    async disable(id: string): Promise<void> {
      const record = await seen();
      await apply({
        ...record,
        disabledIds: record.disabledIds.includes(id) ? record.disabledIds : [...record.disabledIds, id]
      });
    },
    /** 恢复一个账号 id（从停用与删除名单中同时清除）。 */
    async restore(id: string): Promise<void> {
      const record = await seen();
      await apply({
        ...record,
        disabledIds: record.disabledIds.filter((item) => item !== id),
        deletedIds: record.deletedIds.filter((item) => item !== id)
      });
    },
    /** 删除一个账号 id（不可自动恢复；配置重加同名 id 时需先在此恢复）。 */
    async delete(id: string): Promise<void> {
      const record = await seen();
      await apply({
        ...record,
        disabledIds: record.disabledIds.filter((item) => item !== id),
        deletedIds: record.deletedIds.includes(id) ? record.deletedIds : [...record.deletedIds, id]
      });
    },
    /**
     * 多模态分区保存：section ∈ toolsEnabled | text2img | img2img | vision，
     * values 为该分区的部分键（合并进已存值）。值已在 parse 时白名单过滤，
     * 这里只做键合并。
     */
    /** 面板 key 清单写入（add/rename/remove 的落盘半边）。 */
    async setKeys(keys: PoolKeyEntry[]): Promise<void> {
      const record = await seen();
            await apply({ ...record, keys });
    },
    async setSection(
      section: "toolsEnabled" | "text2img" | "img2img" | "vision" | "thinking",
      values: Record<string, unknown>
    ): Promise<void> {
      const record = await seen();
      // 合并进目标分区，而不是整体替换：`[section]: values` 会把该分区原有的
      // 其它键一起抹掉 —— 例如 toolsEnabled 只有 text2img 时，再开 img2img 就
      // 把 text2img 的 true 冲掉（三个工具永远只能开一个的根因，2026-10-25）。
      const merged = section === "toolsEnabled"
        ? { ...record.toolsEnabled, ...values }
        : section === "text2img"
          ? { ...record.text2img, ...values }
          : section === "img2img"
            ? { ...record.img2img, ...values }
            : section === "vision"
              ? { ...record.vision, ...values }
              : { ...record.thinking, ...values };
      const parsed = parsePoolPayload({
        version: POOL_STORE_VERSION,
        disabledIds: record.disabledIds,
        deletedIds: record.deletedIds,
        globalConcurrency: record.globalConcurrency,
        modelProtocols: record.modelProtocols,
        // keys 必须带上：漏掉它会让每次分区保存把 key 清单清空
        // （2026-10-24 实测：加完 key 再改一个多模态设置，key 就消失了）。
        keys: record.keys,
        toolsEnabled: record.toolsEnabled,
        text2img: record.text2img,
        img2img: record.img2img,
        vision: record.vision,
        thinking: record.thinking,
        [section]: merged
      });
      if (parsed === null) return;
      await apply(parsed);
    },
    /** 设置/清除一个模型的协议覆盖（"auto" 即清除）。 */
    async setModelProtocol(modelId: string, protocol: string | null): Promise<void> {
      const record = await seen();
      const protocols = { ...record.modelProtocols };
      if (protocol === null || protocol === "auto") delete protocols[modelId];
      else protocols[modelId] = protocol;
            await apply({ ...record, modelProtocols: protocols });
    }
  };
}

/** 给快照/路由的形状化读取（obj 兜底，避免调用方判空）。 */
export async function poolRecordSnapshot(store: { read(): Promise<PoolStoreRecord> }): Promise<PoolStoreRecord> {
  const record = await store.read().catch(() => emptyPoolRecord());
  return obj(record) as PoolStoreRecord;
}
