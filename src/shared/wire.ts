/**
 * The wire contracts BOTH halves read: the snapshot body.
 *
 * This is the ONE declaration of what the Host builds and the panel reads.
 * The Host has no typed view of the snapshot (see `src/host/snapshot-aggregate.ts`,
 * where `buildSnapshotBody` is annotated `@returns {Promise<object>}`), so the
 * only place these shapes used to be spelled out was a hand-written mirror in
 * the client bundle — with nothing on the other side for the compiler to
 * compare it against, and nothing pinning the nested structure at all.
 *
 * This module is TYPE-ONLY: every export here is an `interface` / a `type`.
 * It carries no runtime value, so tsdown erases it from both bundles — the
 * client artifact stays dependency-free apart from `react`, and the host
 * bundle gains no browser code. It is the one thing both sides are allowed to
 * import, and the one reason the two halves can share a shape without sharing
 * state or runtime logic.
 *
 * `test/package.test.mjs` walks the host source graph and requires every
 * reachable module to live under `src/host/` — this directory is the single
 * declared exception (see that check's whitelist). Do not add a runtime
 * export here: a real value would be the first host runtime logic to enter the
 * browser artifact, which is where the isolation `docs/ARCHITECTURE.md` §5
 * actually begins to loosen.
 *
 * Every property is optional on purpose: a missing field must render as
 * "no data yet", never throw — so reading code falls back with `??` /
 * `Array.isArray` exactly as the pre-split closure did. Types are loaded,
 * never enforced at runtime.
 *
 * @module dsh-sensenova-suite/shared-wire
 */

/** One pool's 5h/7d quota window, as `parsePools` normalizes it. */
export interface QuotaWindowData {
  limit?: number;
  used?: number;
  remaining?: number;
  /**
   * The wall-clock instant the window resets, **in SECONDS since the epoch** —
   * not milliseconds. This is the one field in the snapshot whose unit the
   * panel mixes into expressions that also carry millisecond timestamps
   * (`updatedAt`), so the unit is the whole point: `parsers.ts` normalizes
   * `reset_at` to seconds, and a seconds-for-milliseconds swap drew no reset
   * time on screen at all until 2026-10-16.
   */
  resetAt?: number | null;
}

/** One pool row of the `pools.pools` array. */
export interface PoolData {
  id?: string;
  name?: string;
  poolType?: string;
  modelIds?: string[];
  window5h?: QuotaWindowData | null;
  window7d?: QuotaWindowData | null;
  grantBalance?: number;
  /** SECONDS since the epoch — same unit rule as {@link QuotaWindowData.resetAt}. */
  nearestGrantExpiry?: number | null;
  nearestGrantExpiringBalance?: number;
  /** Filled by the Host when a catalog was available. */
  callableModels?: string[];
  lockedModels?: string[];
}

/** The `pools` block: the plan header plus the pool deck. */
export interface PoolsData {
  plan?: { id?: string; name?: string; type?: string };
  pools?: PoolData[];
}

/** One per-model consumption row of the trend chart. */
export interface TrendRowData {
  model: string;
  credits: number;
  /** Operator-configured pseudo multiplier (×N); absent when no key matched. */
  /** 该模型是否为出图模型（catalog 的 output_modalities 严格判定）。 */
  imageGen?: boolean;
  multiplier?: number;
}

/** The `trend` block: the window the chart covers and its rows. */
export interface TrendData {
  hours?: number;
  models?: TrendRowData[];
}

/** One catalogue entry the roster/picker offers. */
export interface ModelData {
  id?: string;
  name?: string;
  vision?: boolean;
  available?: boolean;
  quotaExhausted?: boolean;
  /** Positive window from `contextWindowOf`: declared value or the 128k fallback. */
  contextWindow?: number;
  /** Platform-declared output ceiling from `max_output_length`; 0/absent = unknown. */
  maxOutputLength?: number;
  /** Operator pseudo credit multiplier (×N); absent when no config key matched. */
  /** 该模型是否为出图模型（catalog 的 output_modalities 严格判定）。 */
  imageGen?: boolean;
  multiplier?: number;
  /** Thinking levels the DSH selector offers for this model, escalation order. */
  thinkingLevels?: string[];
}

export interface AuthData {
  configured?: boolean;
  hasAccount?: boolean;
  /** 当前活动账号在清单里有存档密码（方案 C）：脚注「自动重登」承诺的判据。 */
  vaultPasswordArmed?: boolean;
  hasRefreshToken?: boolean;
  /** SECONDS since the epoch — the access token's own expiry (`retryAfterMs` below is the exception that really is milliseconds). */
  expiresAt?: number | null;
  needsAccount?: boolean;
  ephemeral?: boolean;
  retryAfterMs?: number | null;
  needsUserAction?: boolean;
  error?: string | null;
  /** 多账号侧槽清单（2026-10-29 方案 C）：槽号/用户名/是否有令牌快照/是否当前。无密码。 */
  accounts?: Array<{ id: string; username: string; hasGrant: boolean; active: boolean }>;
}

/** The `llm` block: key presence, registration state, and the roster. */
export interface LlmData {
  hasApiKey?: boolean;
  keySource?: string | null;
  ephemeral?: boolean;
  registerProvider?: boolean;
  registerSource?: string;
  llmAvailable?: boolean;
  providerRegistered?: boolean;
  providerId?: string;
  modelCount?: number;
  visionCount?: number;
  /** Thinking effort the profile pins as DSH's "Default" (same constant the adapter dispatches). */
  thinkingDefault?: string;
  /** 每模型协议覆盖（auto=未覆盖；面板"协议"列的数据源）。 */
  modelProtocols?: Record<string, string>;
  models?: ModelData[];
  /** 全目录行（含出图模型）供多模态下拉自选；`models` 只含对话模型。 */
  allModels?: ModelData[];
  enabledModelIds?: string[];
  quotaBlockedModelIds?: string[];
  providerError?: string;
}

/** One shape-drift report line, keyed by upstream contract. */
export interface ShapeWarningData {
  api?: string;
  missing?: string;
}

/**
 * Why the quota block is empty: the console could not be reached.
 *
 * Carried INSIDE an `ok:true` snapshot — a signed-out or unreachable console
 * no longer blanks the whole body. The `code` is the same taxonomy the
 * `ok:false` failure path uses, so the panel words it with the same guidance.
 */
export interface QuotaErrorData {
  code?: string;
  message?: string;
}

/**
 * The whole snapshot body `buildSnapshotBody` returns, as the panel reads it.
 *
 * `pollSeconds` drives the panel's own poll cadence (it is consumed, not
 * rendered); `cacheSeconds` is quoted into the footnote; `auth` drives the
 * self-renew chip; `pools`/`trend` are the two content sections; `llm` is the
 * setup tab; the rest are banner lines.
 */
/** `identifyVisionModel` 的判读结果（parsers 的契约；2026-10-24 起 vision 三键
 * 已退役，此类型只服务于 roster 徽章与发布签名，不再进快照）。 */
export interface VisionModelData {
  id?: string;
  vision?: boolean;
  /** 判读来源：目录声明 / 名字推断。 */
  source?: "field" | "name" | null;
}

/** 一个账号的池状态（管理面；key 本身不出——面板按 id 操作）。 */
export interface PoolKeyData {
  id: string;
  /** 账号标签（accounts 的 label；面板 key 为 null）。 */
  label: string | null;
  /** 用户备注（面板「备注」字段；无则为 null）。显示在脱敏名后。 */
  note: string | null;
  phase: "running" | "blocked" | "absent";
  disabled: boolean;
  deleted: boolean;
}

/** Key 池诊断块（只读——账号在 cordis.patch.yml 配，面板只看与管理）。 */
export interface PoolDiagData {
  keys: PoolKeyData[];
  /** (key,组) 池耗尽格子的组侧摘要（key 打码为尾 4 位）。 */
  poolGrid: string[];
  /** 当前全局在途请求数。 */
  inflight: number;
  /** 生效中的全局并发数（面板保存值 ?? 配置 ?? key 数）。 */
  globalConcurrency: number;
  /** 多模态面板已保存设置（仅面板改过的键；未设键回落配置）。 */
  settings: {
    toolsEnabled: Record<string, boolean>;
    text2img: Record<string, unknown>;
    img2img: Record<string, unknown>;
    vision: Record<string, unknown>;
    thinking: Record<string, string[]>;
  };
}

export interface SnapshotData {
  /** Key 池诊断（无凭据服务/旧 Host 上缺省）。 */
  pool?: PoolDiagData | null;
  ok?: boolean;
  now?: number;
  consoleBase?: string;
  cacheSeconds?: number;
  pollSeconds?: number;
  auth?: AuthData | null;
  catalogAvailable?: boolean;
  catalogModels?: string[];
  uncountedModels?: string[];
  llm?: LlmData | null;
  pools?: PoolsData | null;
  trend?: TrendData | null;
  quotaError?: QuotaErrorData | null;
  shapeWarnings?: ShapeWarningData[];
}
