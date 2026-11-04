/**
 * Key 池的运营状态存储（PLAN §5 的面板管理面）：面板可以对 key 做**停用 / 恢复 /
 * 删除**、调**全局并发数**、给模型选**协议**——这些是运营决策，不属于
 * `cordis.patch.yml`（部署默认），所以落在本插件自己的状态文件
 * `$DSH_HOME/state/[<profile>/]<plugin>/pool.json`，与 provider 开关
 * （provider-store.ts）同一纪律。
 *
 * 优先级：面板保存值 > patch 配置默认。`globalConcurrency` 未保存时回落配置；
 * `disabledIds` / `deletedIds` 在配置之上做减法（配置里有的账号也可能被停用）；
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
import { nativeThinkingDefaults } from "./wire/facts.ts";
import { truncateChainAtChat } from "./wire/chain.ts";
import type { StoreOptions } from "./types.ts";

/** 形状版本；不兼容变更时递增。 */
export const POOL_STORE_VERSION = 1;
export const KNOWN_POOL_STORE_VERSIONS: readonly number[] = [1];

/** 可看图勾选默认集（2026-10-27 用户拍板的三件套）。readVision 的「字段缺省」
 * 与 emptyPoolRecord 的「文件还不存在」共用这一份——别抄第二份。 */
const DEFAULT_VISION_MODELS: readonly string[] = ["deepseek-flash", "kimi-k3", "sensenova-6.8-flash-lite"];

/** 池状态文件所在目录（按 profile 分段，见 PITFALLS §23）。 */
function poolStoreDir(profile: string | null) {
  return profileStateDir(name, profile);
}

/** 出图单工具的面板设置（仅保存面板改过的键；未设键回落配置）。 */
export interface ImageToolSettings {
  model?: string;
  size?: string;
  outputFormat?: string;
  watermark?: boolean;
  promptExtend?: boolean;
  outputDir?: string;
}

/** 视觉卡的面板设置。 */
export interface VisionSettings {
  model?: string;
  bridgePrompt?: string;
  /** 用户勾选为「可识图」的模型 id 列表（在接入 API tab 思考档位旁勾选）。 */
  visionModels?: string[];
  /** 手动取消过的「原生看图」模型 id 墓碑（2026-11-03 拍板：自动勾为底、手动
   * 优先级最高）——原生看图模型（目录 input_modalities 含 image）默认自动勾，
   * 用户显式取消的记录在此，自动勾不再翻案；手动勾选（含目录没报 image 的
   * 模型）进 visionModels 原样保留。 */
  autoOffIds?: string[];
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
  /** 模型 → 降级链覆盖（有序子集 ≤3；仅存面板写过的模型，未写走档案默认链）。 */
  modelProtocols: Record<string, string[]>;
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

/** 空白记录（全部回落配置默认）。vision 带默认勾选集：文件还不存在的新用户
 * 直接站在默认上（2026-11-03 S3 拍板——默认值是给新用户用的；此前要等首次
 * 任意保存+读缓存过期才播种，新用户零勾选全走转述桥）。 */
export function emptyPoolRecord(): PoolStoreRecord {
  return {
    version: POOL_STORE_VERSION,
    disabledIds: [], deletedIds: [], globalConcurrency: null, modelProtocols: {},
    keys: [],
    toolsEnabled: {}, text2img: {}, img2img: {}, vision: { visionModels: [...DEFAULT_VISION_MODELS], autoOffIds: [] }, thinking: {}
  };
}

/** 解析一份磁盘载荷；不是本插件的形状返回 null。 */
const CHAIN_WIRES = ["anthropic", "responses", "chat-completions"];

/**
 * 单条降级链值归一（per-model-protocol-chain）：字符串（0.1.31 旧单线值）当作
 * 长度 1 的链；"auto"（旧「无覆盖」值）与空值 → undefined；数组 → 白名单过滤 +
 * 去重保序、截到 3（三个槽位的上限；超长截头 = 保留用户排在前面的优先线）。
 * 全非法 → undefined（该模型无覆盖，走档案默认链——兜底往保守侧）。
 */
function normalizeChainValue(value: unknown): string[] | undefined {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !CHAIN_WIRES.includes(entry)) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
  }
  // chat 后截断（2026-10-31 他拍板）：chat 无降级条件，其后槽位永不可达——
  // 存储层即截断，面板槽位与实际行为一致（规则单一来源 = chain.truncateChainAtChat）。
  return out.length > 0 ? truncateChainAtChat(out).slice(0, 3) : undefined;
}

export function parsePoolPayload(raw: unknown): PoolStoreRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (source.version !== POOL_STORE_VERSION) return null;
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id !== "") : [];
  const concurrency = typeof source.globalConcurrency === "number" && Number.isFinite(source.globalConcurrency)
    ? Math.max(0, Math.floor(source.globalConcurrency))
    : null;
  const protocols: Record<string, string[]> = {};
  if (typeof source.modelProtocols === "object" && source.modelProtocols !== null && !Array.isArray(source.modelProtocols)) {
    for (const [key, value] of Object.entries(source.modelProtocols as Record<string, unknown>)) {
      if (typeof key !== "string" || key === "") continue;
      const chain = normalizeChainValue(value);
      if (chain !== undefined) protocols[key] = chain;
    }
  }
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
    const watermark = boolOf(rec.watermark); if (watermark !== undefined) out.watermark = watermark;
    const promptExtend = boolOf(rec.promptExtend); if (promptExtend !== undefined) out.promptExtend = promptExtend;
    // outputDir 归一：剥一层成对引号（资源管理器「复制文件地址」自带引号）
    // 与首尾空白——面板保存时已校验，这里兜底直改状态文件的写入。
    const outputDir = strOf(rec.outputDir); if (outputDir !== undefined) out.outputDir = outputDir.trim().replace(/^"(.*)"$/, "$1").trim();
    return out;
  };
  const readVision = (value: unknown): VisionSettings => {
    // 可看图勾选默认集（2026-10-27 用户拍板）：deepseek-flash / kimi-k3 /
    // sensenova-6.8-flash-lite 原生看图（不走转述）。字段缺省 = 按此默认；
    // 显式保存的空数组（全不勾）尊重用户选择。
    const out: VisionSettings = { visionModels: [...DEFAULT_VISION_MODELS], autoOffIds: [] };
    if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
    const rec = value as Record<string, unknown>;
    const model = strOf(rec.model); if (model !== undefined) out.model = model;
    const bridgePrompt = strOf(rec.bridgePrompt); if (bridgePrompt !== undefined) out.bridgePrompt = bridgePrompt;
    if (Array.isArray(rec.visionModels)) {
      out.visionModels = rec.visionModels.filter((id): id is string => typeof id === "string" && id !== "");
    }
    if (Array.isArray(rec.autoOffIds)) {
      out.autoOffIds = rec.autoOffIds.filter((id): id is string => typeof id === "string" && id !== "");
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
    thinking: readThinking(source.thinking),
  };
}

/** 读取每模型可用思考档位（modelId → string[]；仅保留已知档位）。
 * 首装播种（2026-10-27 用户拍板）：文件里没有条目的已知模型按文档原生档位
 * 给默认集（wire/facts.nativeThinkingDefaults）——与 readVision 的默认集同一
 * 纪律：缺省 = 按默认；显式保存的空数组（全不勾）尊重用户，因此空条目保留。 */
function readThinking(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const present = typeof value === "object" && value !== null && !Array.isArray(value);
  if (present) {
    // 与 client/model-picker.ts 的 THINKING_CHOICES 同表（2026-11-03 拍板：UI 层与
    // 存储过滤层统一 5 值，改动必须两边同步）。xhigh 曾是照 API 词表抄进来的化石
    // （2026-10-26「xhigh 彻底移除」拍板后面板已给不出它）；API 归一另有 facts.efforts
    // 词表，不在此层。旧文件若手编过 xhigh 会被白名单滤掉。
    const ALLOWED = ["off", "low", "medium", "high", "max"] as const;
    for (const [modelId, levels] of Object.entries(value as Record<string, unknown>)) {
      if (modelId === "" || !Array.isArray(levels)) continue;
      out[modelId] = levels.filter((l): l is string => typeof l === "string" && (ALLOWED as readonly string[]).includes(l));
    }
  }
  for (const [modelId, defaults] of Object.entries(nativeThinkingDefaults())) {
    if (!(modelId in out)) out[modelId] = defaults;
  }
  return out;
}

/**
 * 可看图「生效集」= 显式勾选 ∪（原生看图目录 id − 手动取消墓碑）。
 *
 * 2026-11-03 拍板：**自动勾为底、手动优先级最高**。原生看图模型（目录
 * `input_modalities` 含 image）默认自动勾上——有原生能力不该被迫走转述；
 * 用户显式取消的原生模型进 `autoOffIds` 墓碑，自动勾不翻案；手动勾选（含
 * 目录没报 image 但实测可看图的模型，如默认三件套里的 deepseek-flash /
 * kimi-k3）进 `visionModels` 原样保留。nativeIds 由调用方给（index 的发布
 * 在服目录），本模块不读目录。
 * @param {object} [vision] - the parsed vision partition.
 * @param {Iterable<string>} nativeIds - catalog ids whose `input_modalities`
 *   declare image (the auto-check base set).
 * @returns {string[]} the effective checked set, saved order first, then new
 *   native ids, de-duplicated.
 */
export function effectiveVisionModels(vision: VisionSettings | undefined, nativeIds: Iterable<string>): string[] {
  const saved = vision?.visionModels ?? [];
  const off = new Set(vision?.autoOffIds ?? []);
  const out: string[] = [];
  for (const id of [...saved, ...nativeIds]) {
    if (typeof id === "string" && id !== "" && !off.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 工具开关的生效值（2026-11-04 U12-D1 案 A 拍板）：面板存过值（true/false）
 * 听面板的，没存过（undefined = 从未动过该开关）回落 patch 配置默认。
 *
 * 与面板显示基 `savedBool(section, key) ?? fallback` 同构——面板显示什么，
 * 注册门就认什么。旧的 `settings.X || pool === true` OR 门让 patch 默认
 * true 恒赢，面板「关」永远落不了地（U12 台账 D1）；本接口的 ToolsEnabled
 * 注释「面板为主设置；配置为部署默认」自始就是这个 tri-state 语义。
 * @param saved - 面板存过该键的布尔值；没存过 = undefined。
 * @param patchDefault - patch 配置里的部署默认（text2imgEnabled 等）。
 */
export function effectiveToolEnabled(saved: boolean | undefined, patchDefault: boolean): boolean {
  return saved ?? patchDefault;
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

  const cacheOptions: Parameters<typeof createStateReadCache<PoolStoreRecord | null>>[1] = { now };
  if (ttlMs !== undefined) cacheOptions.ttlMs = ttlMs;
  const cache = createStateReadCache(async () => parsePoolPayload(await readStateJson(file)), cacheOptions);
  const seen = async (): Promise<PoolStoreRecord> => (await cache.read()) ?? emptyPoolRecord();
  // 写后把新记录灌进读缓存（remember）：自己的写入必须立刻对自己可见，不等
  // TTL。ADR-006 拒绝必须表面化（provider-store 同款纪律；2026-10-31 审计顺带
  // ①）：盘上是更新构建写的 pool.json 时，静默 no-op 会让面板显示「已保存」、
  // 缓存 TTL 过期后回跳磁盘旧值——拒因抛给路由的 catch（routes/pool 与
  // routes/models 都整段包 try），面板拿到 ok:false 与原话；缓存不 remember
  // 未落盘的值。
  const apply = async (record: PoolStoreRecord): Promise<void> => {
    const refusal = await writePool(record);
    if (refusal !== null) throw new Error(refusal);
    cache.remember(record);
  };

  // 读-改-写串行化（2026-10-31 审计顺带②）：每个变更方法都是「读整份 → 改一
  // 处 → 写整份」，并发的两个变更各自读到同一份底稿、后写者把先写者的变更
  // 整份冲掉（丢更新）。面板多 tab、动作与分区保存并发时在此排队；队列隔离
  // 失败——前一个变更的拒绝（上面 throw）不挡后一个。跨进程并发不在此列：
  // §22 双构建并存的机器按既定纪律升级时先杀干净旧 Host 进程，写侧版本护栏
  // 管「别覆盖别的版本」。
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.catch(() => undefined).then(work);
    tail = run;
    return run;
  };

  return {
    /** 整份读取（未设置处回落空白）。 */
    async read(): Promise<PoolStoreRecord> {
      return seen();
    },
    /** 面板保存全局并发数；null = 清除面板值回落配置。 */
    async setGlobalConcurrency(value: number | null): Promise<void> {
      await enqueue(async () => {
        const record = await seen();
        await apply({ ...record, globalConcurrency: value === null ? null : Math.max(0, Math.floor(value)) });
      });
    },
    /** 停用一个账号 id（可恢复）。 */
    async disable(id: string): Promise<void> {
      await enqueue(async () => {
        const record = await seen();
        await apply({
          ...record,
          disabledIds: record.disabledIds.includes(id) ? record.disabledIds : [...record.disabledIds, id]
        });
      });
    },
    /** 恢复一个账号 id（从停用与删除名单中同时清除）。 */
    async restore(id: string): Promise<void> {
      await enqueue(async () => {
        const record = await seen();
        await apply({
          ...record,
          disabledIds: record.disabledIds.filter((item) => item !== id),
          deletedIds: record.deletedIds.filter((item) => item !== id)
        });
      });
    },
    /** 删除一个账号 id（不可自动恢复；配置重加同名 id 时需先在此恢复）。 */
    async delete(id: string): Promise<void> {
      await enqueue(async () => {
        const record = await seen();
        await apply({
          ...record,
          disabledIds: record.disabledIds.filter((item) => item !== id),
          deletedIds: record.deletedIds.includes(id) ? record.deletedIds : [...record.deletedIds, id]
        });
      });
    },
    /**
     * 多模态分区保存：section ∈ toolsEnabled | text2img | img2img | vision，
     * values 为该分区的部分键（合并进已存值）。值已在 parse 时白名单过滤，
     * 这里只做键合并。
     */
    /** 面板 key 清单写入（add/rename/remove 的落盘半边）。 */
    async setKeys(keys: PoolKeyEntry[]): Promise<void> {
      await enqueue(async () => {
        const record = await seen();
        await apply({ ...record, keys });
      });
    },
    /** 设置/清除一个模型的降级链覆盖（null/非法 = 清除覆盖，回落档案默认链）。 */
    async setModelProtocol(modelId: string, chain: readonly string[] | null): Promise<void> {
      await enqueue(async () => {
        const record = await seen();
        const protocols = { ...record.modelProtocols };
        const normalized = chain === null ? undefined : normalizeChainValue(chain);
        if (normalized === undefined) delete protocols[modelId];
        else protocols[modelId] = normalized;
        await apply({ ...record, modelProtocols: protocols });
      });
    },
    async setSection(
      section: "toolsEnabled" | "text2img" | "img2img" | "vision" | "thinking",
      values: Record<string, unknown>
    ): Promise<void> {
      await enqueue(async () => {
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
      });
    },
  };
}

/** 给快照/路由的形状化读取（obj 兜底，避免调用方判空）。 */
export async function poolRecordSnapshot(store: { read(): Promise<PoolStoreRecord> }): Promise<PoolStoreRecord> {
  const record = await store.read().catch(() => emptyPoolRecord());
  return obj(record) as PoolStoreRecord;
}
