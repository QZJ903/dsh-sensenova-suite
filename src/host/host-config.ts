/**
 * The plugin's configuration contract and the Host trust fence.
 *
 * Everything the Host half reads from the row's patch config lives here, plus
 * the `isAdmitted` check that keeps a foreign page from planting an account.
 * `test/config.test.mjs` pins `CONFIG_DEFAULTS` and the resolvers against this
 * file and `cordis.patch.yml`, so the code and the documented contract cannot
 * silently drift.
 * @module dsh-sensenova-suite/host-config
 */

import { str, obj, num, errMsg } from "./util.ts";

/**
 * The one slug every addressable surface of this plugin derives from.
 *
 * Besides the name the Loader reports for the row, it is also the `/api` route
 * prefix (`routes.ts`), the credential record's scope (`token-store.ts`) and the
 * state directory (`throttle-store.ts`) — so a rename has to carry the user's
 * stored grant and parked throttle with it, not just the text.
 *
 * The mirrors that cannot import this constant are pinned by
 * `test/config.test.mjs`, so a rename on either side goes red instead of
 * leaving the stored grant behind: §6 checks the literal `package.json#name`
 * and the patch row's `id`/`name` pair against it, and §6b checks that every
 * route literal in `src/client/const.ts` (the browser bundle cannot derive them)
 * equals the `/api/${name}/…` this half builds in `routes.ts`.
 */
export const name = "dsh-sensenova-suite";
/** Cordis services this plugin needs; without `webServer` it stays inactive.
 * `tools` 是 DSH 的工具注册表（上游 image 插件同款 inject + ctx.tools.register；
 * 2026-10-27：此前只靠 ctx.get("tools") 取，该服务不经 get 暴露，工具从未注册）。 */
export const inject = ["webServer", "tools"];

/**
 * The plugin's configuration contract in one place.
 *
 * Every default the Host half reads lives here, so the code and the
 * `cordis.patch.yml` that documents it cannot silently drift: `test/config.test.mjs`
 * pins both against this object. The `auth` sub-object lists the operator-facing
 * login-flow overrides (their patch.yml entries are commented by default, which is
 * why they default to empty/zero and mean "use the platform default").
 *
 * ⚠️ That `auth` block is only the DEFAULTS SHAPE — do NOT copy it into
 * `cordis.patch.yml` as a nested block. The patch row must spell these keys at
 * the TOP LEVEL, and {@link resolveAuthOverrides} throws on a nested `auth`
 * block: the loader accepts one, this resolver drops it, and the panel would
 * keep talking to the real platform (redline 3).
 */
export const CONFIG_DEFAULTS = Object.freeze({
  consoleBase: "https://platform.sensenova.cn",
  apiBase: "https://token.sensenova.cn/v1",
  trendHours: 24,
  /**
   * Pseudo multipliers for the trend table, keyed by a case-insensitive
   * SUBSTRING of a model id (first matching key wins, in insertion order).
   * The platform returns raw credits with no official per-model rate, so
   * these numbers are the operator's own comparison aid — the panel labels
   * them as custom/non-official and rows without a match stay unmultiplied.
   * Shipped defaults = 2026-10-31 运营者实测（kimi 30 / glm 15 / 商汤 0.8 /
   * deepseek 1）——初版 ×10/×20 是移植源的拍脑袋值，与实测不符，已替换。
   */
  // 顺序承重：lite 的 id 包含 flash 的 id 作子串，lite 键必须在 flash 键前
  // （首中语义），否则 lite 被 ×1 抢走。
  trendMultipliers: { "glm-5.2": 15, "kimi-k3": 30, "sensenova-6.8-flash-lite": 0.8, "sensenova-6.8-flash": 1, "deepseek": 1 },
  cacheSeconds: 60,
  pollSeconds: 30,
  consoleTimeoutMs: 15_000,
  tokenSkewSeconds: 120,
  auth: {
    iamBase: "",
    tokenEndpoint: "",
    jwksEndpoint: "",
    redirectUri: "",
    clientId: "",
    scope: "",
    encKeyId: "",
    maxHops: 0,
    loginTimeoutMs: 0,
    requestTimeoutMs: 0
  },
  /** Host names the Host answers as, by default. The operator's list is added. */
  admittedHosts: ["localhost", "127.0.0.1", "[::1]", "::1"],
  /**
   * Step three ("one-stop service"): register the LLM provider DIRECTLY.
   *
   * When true, the plugin calls `ctx.llm.registerAdapter` itself with an
   * OpenAI-compatible pi-ai adapter aimed at `apiBase`, the catalog poll feeds
   * its model list, vision models carry image input automatically, and the
   * panel-saved `SENSENOVA_API_KEY` reference authenticates requests. Off by
   * default: registering a model
   * source is a Host-wide change, not a read-only panel view, so it stays an
   * explicit opt-in and an operator with the hand-written `llm-pi-ai` row is
   * not suddenly offered two providers.
   */
  registerProvider: false,
  /**
   * Per-model OUTPUT CEILING overrides, keyed by EXACT model id.
   *
   * The catalogue is FETCHED, not authored, and it can understate a model: the
   * module header of `llm-models.ts` probed `deepseek-v4-flash` accepting
   * 131072 while the catalogue states 65536. Without this field the only way to
   * disagree with the platform was to edit the stored catalogue — which the
   * next poll overwrites, so the correction silently reverts, and a ceiling
   * that reverts is worse than one that was never raised.
   *
   * Precedence: this map > the catalogue's `max_output_length` > undeclared
   * (the harness then applies `defaultMaxTokens ?? 32768`). Defaults pin the
   * DOCUMENTED ceilings where the fetched catalogue understates a model
   * (sensenova-docs-full.md, 2026-10-26): `deepseek-flash` max_tokens
   * [1, 393216]，`kimi-k3` max_completion_tokens 默认 128K。目录探测比文档
   * 滞后（探测返回 65536），以文档为准。
   * Read by `llm-models.maxTokensForId`, which BOTH the panel roster and the
   * registered adapter call (resolveModel → `defaultMaxTokens`) — the value
   * sent and the value displayed are one order (the promise the patch row
   * records; the wire side used to drop the map — U6 ledger D1).
   * Scope: the DIRECTLY-REGISTERED provider (`registerProvider`) and the panel
   * roster that mirrors it.
   */
  // 单行值：docs.test 按行解析 CONFIG_DEFAULTS，多行对象会让它 JSON.parse 失败。
  maxTokensOverrides: { "deepseek-flash": 393216, "kimi-k3": 131072, "sensenova-6.8-flash": 131072 },
  /**
   * Per-model CONTEXT WINDOW overrides ({ modelId → tokens }), the same shape
   * and precedence as `maxTokensOverrides` above: override > the catalogue's
   * declared figure > FALLBACK_CONTEXT_WINDOW. Read by BOTH the panel roster
   * (llm-models.contextWindowOf → the 「上下文」 badge) and the registered
   * adapter (resolveModel → context.contextWindow) — the displayed window and
   * the request-side arithmetic cannot disagree. Motivated 2026-11-03: the
   * catalogue understates new models — sensenova-6.8-flash probes 262144
   * (256K) while the official documentation states 1M（运营者口径；docs dump
   * 尚未收录该新模型）. Single-line value: docs.test parses CONFIG_DEFAULTS
   * line by line.
   */
  contextWindowOverrides: { "sensenova-6.8-flash": 1048576 },
  /**
   * Background freshness for the registered provider (2026-10 review #1b).
   * The panel polls only while it is open, but a registered provider is a
   * STANDING execution channel — its catalog/quota state used to decay until
   * somebody opened the panel. While the effective provider switch is ON, the
   * Host drives one aggregate refresh every N minutes (the same engine the
   * snapshot route calls, sharing its cache — a panel that polls in between
   * costs the platform nothing extra). `0` disables it; a panel-only Host
   * (switch off) never schedules the timer, keeping the opt-in shape.
   */
  providerRefreshMinutes: 15,
  /**
   * 多账号池：每项 { id, label, apiKeyRef }。apiKeyRef 是 DSH
   * 凭据服务的 credential-ref 名（如 SENSENOVA_API_KEY），经宿主凭据服务解析；
   * 非法/缺失的条目被静默丢弃。面板保存的默认 key（api-key 路由）始终作为
   * 第一把 key 参与轮转，无需在这里重复。
   */
  accounts: [],
  /** 钉选账号 id（手动优先级）；空 = 纯轮转。 */
  activeAccount: "",
  /**
   * 全局在途上限：per-key 固定 1 由适配器闸负责；这里管总量。
   * 0 = 跟随 key 数（有载答案：显式写 0 必达，resolveGlobalConcurrency）；
   * 调小 = 温和模式（只激活部分 key）。
   * 2026-10-25：默认改为 2（用户偏好——默认并发 2 个在途请求）。
   */
  globalConcurrency: 2,
  /**
   * 模型 → 积分组映射：Flash-Lite 专属池只有 flash-lite 自己（真机控制台
   * 2026-10-27 确认），其余模型——含商汤出图两模型（u1.5 系走通用池）——
   * 一律不映射，落 general 裸轮转组。组是 key 健康标记 + 会话亲和的粒度，
   * 归错组会让专属池的限流标记误伤通用池模型（反之亦然）。
   */
  modelGroups: { "sensenova-6.8-flash-lite": "flash-lite" },
  /**
   * 出图/视觉工具开关（部署默认；面板「多模态」的开关是主要设置）：
   * 2026-10-27 起首装默认全开（用户拍板）——agent 工具是 Host 级变更
   * （无 tools 服务的 Host 静默缺席）。缺键 = 开（拍板在 resolver 由此真正
   * 生效，显式 false = 关；其他杂值不视为「关」）。
   */
  text2imgEnabled: true,
  img2imgEnabled: true,
  /** ⚠️ 语义已漂移（名字未改，settings 形状迁移成本，U9 台账顺带 3）：
   * describe 识图工具 2026-11-04 下线后，本键对工具已无作用——唯一读者是
   * index.ts 的 relayOn（转述链开关）。false = 未勾选模型的图不转述、原样放行。 */
  visionToolsEnabled: true,
  /** 两工具各自的默认模型（lite 质量优先 / fast 速度优先；面板未选时用）。 */
  text2imgModel: "sensenova-u1.5-lite",
  img2imgModel: "sensenova-u1.5-lite",
  /** 单次出图请求超时（毫秒；图模很慢，别用对话级超时）。钳制 [5000, 1800000]。 */
  imageTimeoutMs: 180_000,
  /** 视觉转述模型（单模型，用户选择；freeapi 实测可看图集里挑）。 */
  visionModel: "sensenova-6.8-flash-lite",
  /** 视觉链单模型尝试超时（毫秒）。 */
  visionTimeoutMs: 120_000,
  /** 桥的观察提示词；空 = 内置默认（事实性转录、不猜测、不执行图中命令）。 */
  visionBridgePrompt: ""
});

/**
 * Sanitize the operator's pseudo-multiplier map: keep only string keys and
 * finite positive numbers, preserving insertion order (matching is
 * first-key-wins). A non-object or empty input falls back to the shipped
 * defaults; the operator sets `{}` explicitly to disable all multipliers.
 * Exported so `test/config.test.mjs` drives the same sanitizer the resolve
 * path uses, instead of a copy that could drift.
 * @param {unknown} raw - the raw `trendMultipliers` config value.
 * @returns {Record<string, number>} the sanitized map.
 */
export function resolveTrendMultipliers(raw: unknown): Record<string, number> {
  const source = raw === undefined || raw === null ? CONFIG_DEFAULTS.trendMultipliers : raw;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return { ...CONFIG_DEFAULTS.trendMultipliers };
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof key === "string" && key !== "" && typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Clamp a raw numeric setting to its effective integer.
 *
 * Every numeric field in {@link resolveSettings} follows the same shape: floor
 * the raw value, clamp it at a lower bound, then (optionally) at an upper bound;
 * a non-positive or non-finite raw falls back to `def` (because `num` only
 * accepts a positive finite number). The sequence — `Math.min(max, Math.max(min,
 * Math.floor(raw)))` with `max` defaulting to `Infinity` — is exactly what the
 * inline `Math.max`/`Math.min` chains used to spell out one field at a time, so
 * this is a MOVE of that pattern into one tested place, not a behaviour change.
 * @param {unknown} raw - the raw value read from the row.
 * @param {number} def - the fallback when `raw` is not a positive finite number.
 * @param {number} min - the lower clamp (inclusive) applied after flooring.
 * @param {number} [max] - the upper clamp (inclusive); omit for no upper bound.
 * @returns {number} the clamped integer.
 */
export function clampInt(raw: unknown, def: number, min: number, max = Infinity): number {
  return Math.min(max, Math.max(min, Math.floor(num(raw, def))));
}

/**
 * Resolve the background-refresher cadence, where ZERO IS A LOADED ANSWER.
 *
 * Every other numeric setting reads through `clampInt`, whose `num` treats a
 * non-positive value as "unset" and falls back. Here `0` means "the refresher
 * is disabled" — a deliberate operator decision — so an explicit finite number
 * always travels (floored and clamped to [0, 1440]); only a non-number / NaN /
 * ±Infinity falls back to the shipped default.
 * @param {unknown} raw - the raw `providerRefreshMinutes` row value.
 * @returns {number} the effective cadence in minutes (0 = off).
 */
export function resolveProviderRefreshMinutes(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return CONFIG_DEFAULTS.providerRefreshMinutes;
  return Math.min(1440, Math.max(0, Math.floor(raw)));
}

/**
 * Resolve the global in-flight cap, where ZERO IS A LOADED ANSWER — same shape
 * as {@link resolveProviderRefreshMinutes} above.
 *
 * `0` = 跟随 key 数（CONFIG_DEFAULTS 的声明语义，闸门按
 * `configured > 0 ? configured : key 数` 消费，key-orchestrator.ts）。但底座
 * `num` 把 0 读作「未设」，旧路径 `clampInt` 会把显式 0 静默改成默认 2——声明
 * 的 0 语义从配置面不可达，而面板缝（pool-store）保留 0，两条缝互相矛盾
 * （U1 审计确定问题 1）。与 providerRefreshMinutes 同形：显式有限数（0 与负数
 * 含）floor 后必达、钳下限 0；非数 / NaN / ±Infinity 回落出货默认。不设上限：
 * 大数值就是「事实不限」，不会与 0 的语义混淆（那是 providerRefreshMinutes 要
 * 钳 1440 的原因，这里不成立）。
 * @param {unknown} raw - the raw `globalConcurrency` row value.
 * @returns {number} the effective cap (0 = follow the key count).
 */
export function resolveGlobalConcurrency(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return CONFIG_DEFAULTS.globalConcurrency;
  return Math.max(0, Math.floor(raw));
}

/**
 * Sanitize the operator's per-model output-ceiling map.
 *
 * Keys are EXACT model ids — deliberately NOT the case-insensitive SUBSTRING
 * match {@link resolveTrendMultipliers} uses. A multiplier is a comparison aid,
 * so a loose match is convenient; a ceiling is a REQUEST PARAMETER, so a loose
 * match would silently retune models the operator never named (the key `flash`
 * alone would land on five catalogue entries). Values must be positive
 * INTEGERS: a fractional token count is a typo, and `0` is reserved for
 * "undeclared" by `llm-models.maxTokensFor`, so it is not an expressible
 * ceiling here.
 *
 * A malformed map falls back to the shipped default (`{}` — the catalogue is
 * authoritative) instead of throwing: one bad row must not take the panel down,
 * which is the same shape {@link resolveTrendMultipliers} uses.
 * Exported so `test/config.test.mjs` drives the same sanitizer the resolve path
 * uses, instead of a copy that could drift.
 * @param {unknown} raw - the raw `maxTokensOverrides` config value.
 * @returns {Record<string, number>} the sanitized map.
 */
export function resolveMaxTokensOverrides(raw: unknown): Record<string, number> {
  return sanitizePositiveIntMap(raw, CONFIG_DEFAULTS.maxTokensOverrides);
}

/**
 * The shared walker behind BOTH override sanitizers (`maxTokensOverrides` and
 * `contextWindowOverrides`): exact string keys, positive-integer values, junk
 * dropped; a malformed map falls back to the shipped default instead of
 * throwing — one bad row must not take the panel down. Inlined twice used to
 * be a duplication-gate finding; this is the extraction it asked for.
 */
function sanitizePositiveIntMap(raw: unknown, fallback: Record<string, number>): Record<string, number> {
  const source = raw === undefined || raw === null ? fallback : raw;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return { ...fallback };
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof key === "string" && key !== "" && typeof value === "number" && Number.isInteger(value) && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Sanitize the `contextWindowOverrides` config row — the same rules as
 * {@link resolveMaxTokensOverrides}: exact string keys, positive integers,
 * junk dropped. Re-validated at the read point (`contextWindowForId`), so
 * this is a fast path, not the only gate.
 * @param {unknown} raw - the raw `contextWindowOverrides` config value.
 * @returns {Record<string, number>} the sanitized map.
 */
export function resolveContextWindowOverrides(raw: unknown): Record<string, number> {
  return sanitizePositiveIntMap(raw, CONFIG_DEFAULTS.contextWindowOverrides);
}

/** The resolved settings shape `resolveSettings` produces and consumers read. */
export interface ResolvedSettings {
  consoleBase: string;
  apiBase: string;
  trendHours: number;
  trendMultipliers: Record<string, number>;
  cacheSeconds: number;
  pollSeconds: number;
  consoleTimeoutMs: number;
  allowedHosts: Set<string>;
  tokenSkewSeconds: number;
  auth: Record<string, unknown>;
  registerProvider: boolean;
  /**
   * Per-model output-ceiling overrides, keyed by exact model id. Read by
   * `llm-models.maxTokensFor` at descriptor-build time and quoted by the panel
   * roster from the same function — one order, two readers.
   */
  maxTokensOverrides: Record<string, number>;
  contextWindowOverrides: Record<string, number>;
  /** Background refresher cadence while the provider registration is ON (0 = off). */
  providerRefreshMinutes: number;
  /** 多账号池配置（原始条目，凭据解析在 index.ts）。 */
  accounts: AccountConfig[];
  /** 钉选账号 id；空 = 纯轮转。 */
  activeAccount: string;
  /** 全局在途上限（0 = 跟随 key 数）。 */
  globalConcurrency: number;
  /** 模型 → 积分组映射。 */
  modelGroups: Record<string, string>;
  /** 出图/视觉工具集开关。 */
  text2imgEnabled: boolean;
  img2imgEnabled: boolean;
  visionToolsEnabled: boolean;
  text2imgModel: string;
  img2imgModel: string;
  imageTimeoutMs: number;
  visionModel: string;
  visionTimeoutMs: number;
  visionBridgePrompt: string;
}

/** 一个账户槽位（settings 配置面；凭据 ref，不存明文）。 */
export interface AccountConfig {
  id: string;
  label: string;
  apiKeyRef: string;
}

/**
 * 归一化账户清单：非对象/缺 ref/空串的条目丢弃；id/label 缺省补齐；
 * 重 id 与保留 id `default` 丢弃（先到先得）。
 * 导出供测试与 index.ts 复用同一判据。
 */
export function normalizeAccounts(raw: unknown): AccountConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: AccountConfig[] = [];
  const seenIds = new Set<string>();
  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    const ref = typeof record.apiKeyRef === "string" ? record.apiKeyRef.trim() : "";
    if (ref === "") return;
    const id = typeof record.id === "string" && record.id.trim() !== "" ? record.id.trim() : `account-${index + 1}`;
    // id 是池管理/显示的索引键（phaseById、disable/restoreById 都按 id 作用），
    // 重复 id 会让两行池条目串号（U1 审计确定问题 4）：先到先得，后来的丢弃——
    // 与 resolvePoolKeys 按 key 值去重的既有口径一致。"default" 保留给面板主
    // key（resolvePoolKeys 恒以它为首条），配置里出现即视为撞名丢弃。
    if (id === "default" || seenIds.has(id)) return;
    seenIds.add(id);
    const label = typeof record.label === "string" && record.label.trim() !== "" ? record.label.trim() : `Account ${index + 1}`;
    out.push({ id, label, apiKeyRef: ref });
  });
  return out;
}

/**
 * 归一化模型分组映射：只收 string→string；值去掉空白。缺省回落内置映射。
 */
export function normalizeModelGroups(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...CONFIG_DEFAULTS.modelGroups };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (typeof key !== "string" || key.trim() === "") continue;
    out[key.trim()] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : { ...CONFIG_DEFAULTS.modelGroups };
}

/**
 * Resolve the row's raw patch config into effective settings.
 *
 * A malformed row must not throw out of here: `apply` runs at mount, and an
 * exception would take the whole plugin down instead of leaving a panel that
 * explains itself. So problems are returned as `configError` and surfaced
 * through the snapshot route.
 * @param {unknown} config - the row's raw patch config.
 * @returns {{settings: ResolvedSettings, configError: string|null}}
 */
export function resolveSettings(config: unknown): { settings: ResolvedSettings; configError: string | null } {
  const source = obj(config);
  const consoleBase = str(source.consoleBase, CONFIG_DEFAULTS.consoleBase).replace(/\/+$/, "");
  const apiBase = str(source.apiBase, CONFIG_DEFAULTS.apiBase).replace(/\/+$/, "");
  // Shape-check the two bases before anything builds URLs out of them: a
  // malformed base (`"https://"` survives `str` and the trailing-slash strip
  // turns it into `"https:"`) would fail at every fetch with a TypeError and be
  // reported as console_error ("usually transient") — never as configError,
  // contradicting this function's contract and the strict validation
  // auth-config.ts applies to the override fields (U1 审计确定问题 3)。
  // plain http 仅限回环是 auth-config 的口径，这里只把关必填的 host 与协议族，
  // 回环 http（e2e 假平台）照常通过。
  const isHttpOrigin = (value: string) => {
    try {
      const parsed = new URL(value);
      return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.host !== "";
    } catch {
      return false;
    }
  };
  const safeConsoleBase = isHttpOrigin(consoleBase) ? consoleBase : CONFIG_DEFAULTS.consoleBase;
  const safeApiBase = isHttpOrigin(apiBase) ? apiBase : CONFIG_DEFAULTS.apiBase;
  try {
    if (!isHttpOrigin(consoleBase) || !isHttpOrigin(apiBase)) {
      throw new Error(
        `consoleBase and apiBase must be absolute http(s) origins (got consoleBase: ${consoleBase}, apiBase: ${apiBase})`
      );
    }
    return {
      settings: {
        consoleBase,
        apiBase,
        trendHours: clampInt(source.trendHours, CONFIG_DEFAULTS.trendHours, 1, 168),
        // Pseudo trend multipliers: only well-formed entries travel (string
        // key, finite positive number); anything else is dropped rather than
        // throwing — a typo in one row must not take the panel down.
        trendMultipliers: resolveTrendMultipliers(source.trendMultipliers),
        cacheSeconds: clampInt(source.cacheSeconds, CONFIG_DEFAULTS.cacheSeconds, 5),
        // How often the panel asks again. The Host states it rather than the
        // panel assuming one, so the two cannot disagree about how fresh the
        // screen is.
        pollSeconds: clampInt(source.pollSeconds, CONFIG_DEFAULTS.pollSeconds, 5),
        // Deadline for one console call. The login flow has its own
        // (`loginTimeoutMs`, below): it walks several IAM hops, so the two
        // are not the same number and pretending otherwise is how a slow
        // login gets blamed on the console.
        consoleTimeoutMs: clampInt(source.consoleTimeoutMs, CONFIG_DEFAULTS.consoleTimeoutMs, 1_000),
        // Which host names this Host answers as. See `isAdmitted`: the panel
        // has a write route, so the loopback defaults can be widened but not
        // replaced.
        allowedHosts: resolveAllowedHosts(source),
        // Renew the console token this long before it actually expires, so a
        // panel poll never races the expiry boundary.
        tokenSkewSeconds: clampInt(source.tokenSkewSeconds, CONFIG_DEFAULTS.tokenSkewSeconds, 0),
        // Console login-flow overrides, handed to `createAuth` verbatim: it owns
        // the platform defaults, so only what the operator actually set travels.
        auth: resolveAuthOverrides(source, consoleBase),
        // Vision step two: the opt-in and the last published lists. The
        // lists are read back from the row so a restart does not lose the
        // answer the Host last computed (a reader that arrives before the
        // first catalog poll still sees the previous catalog's set).
        // Step three opt-in: register the OpenAI-compatible LLM provider
        // directly (strict boolean).
        registerProvider: source.registerProvider === true,
        // Per-model output-ceiling overrides. Sanitized AT THIS SEAM, not in
        // `llm-models.ts`: that module is peer-free and reachable from the
        // offline suite, and the descriptor builder must be able to assume a
        // well-formed map. `maxTokensFor` re-validates anyway, because it is
        // exported — two checks, one of them the contract.
        maxTokensOverrides: resolveMaxTokensOverrides(source.maxTokensOverrides),
        // 同构的上下文窗口覆盖（sanitize 一次，contextWindowForId 读取点再验一次）。
        contextWindowOverrides: resolveContextWindowOverrides(source.contextWindowOverrides),
        // NOT `clampInt`: `num` reads 0 as "unset", but 0 here is the LOADED
        // answer ("the background refresher is off"), so an explicit number —
        // zero included — always wins over the default. A set value floors and
        // clamps into [0, 1440] (one day: anything longer is a typo, and the
        // timer would be indistinguishable from "disabled" in practice). A
        // non-number / NaN / ±Infinity falls back to the shipped default.
        providerRefreshMinutes: resolveProviderRefreshMinutes(source.providerRefreshMinutes),
        accounts: normalizeAccounts(source.accounts),
        activeAccount: str(source.activeAccount, ""),
        globalConcurrency: resolveGlobalConcurrency(source.globalConcurrency),
        modelGroups: normalizeModelGroups(source.modelGroups),
        // 缺键 = 声明默认（true，2026-10-27 拍板「首装默认全开」）——旧形状
        // `=== true` 让缺键行静默关掉工具、CONFIG_DEFAULTS 的 true 形同虚设
        // （U1 审计疑似 1，用户拍板缺键行兜 true）。只有布尔 false 是「关」的
        // 拼法：显式 false 必须被尊重，杂值不视为「关」。
        text2imgEnabled: source.text2imgEnabled !== false,
        img2imgEnabled: source.img2imgEnabled !== false,
        visionToolsEnabled: source.visionToolsEnabled !== false,
        text2imgModel: str(source.text2imgModel, CONFIG_DEFAULTS.text2imgModel),
        img2imgModel: str(source.img2imgModel, CONFIG_DEFAULTS.img2imgModel),
        imageTimeoutMs: clampInt(source.imageTimeoutMs, CONFIG_DEFAULTS.imageTimeoutMs, 5_000, 1_800_000),
        visionModel: str(source.visionModel, CONFIG_DEFAULTS.visionModel),
        visionTimeoutMs: clampInt(source.visionTimeoutMs, CONFIG_DEFAULTS.visionTimeoutMs, 5_000),
        visionBridgePrompt: str(source.visionBridgePrompt, ""),
      },
      configError: null
    };
  } catch (error) {
    // Fall back to the shipped defaults so the panel still mounts and can show
    // the reason, rather than vanishing. Every field the happy path declares is
    // present here with its default, so a consumer cannot tell the branches apart.
    return {
      settings: {
        consoleBase: safeConsoleBase,
        apiBase: safeApiBase,
        trendHours: CONFIG_DEFAULTS.trendHours,
        trendMultipliers: CONFIG_DEFAULTS.trendMultipliers,
        cacheSeconds: CONFIG_DEFAULTS.cacheSeconds,
        pollSeconds: CONFIG_DEFAULTS.pollSeconds,
        consoleTimeoutMs: CONFIG_DEFAULTS.consoleTimeoutMs,
        allowedHosts: new Set(CONFIG_DEFAULTS.admittedHosts),
        tokenSkewSeconds: CONFIG_DEFAULTS.tokenSkewSeconds,
        auth: { consoleOrigin: safeConsoleBase },
        registerProvider: false,
        maxTokensOverrides: CONFIG_DEFAULTS.maxTokensOverrides,
        contextWindowOverrides: CONFIG_DEFAULTS.contextWindowOverrides,
        providerRefreshMinutes: CONFIG_DEFAULTS.providerRefreshMinutes,
        accounts: [],
        activeAccount: "",
        globalConcurrency: CONFIG_DEFAULTS.globalConcurrency,
        modelGroups: { ...CONFIG_DEFAULTS.modelGroups },
        text2imgEnabled: CONFIG_DEFAULTS.text2imgEnabled,
        img2imgEnabled: CONFIG_DEFAULTS.img2imgEnabled,
        visionToolsEnabled: CONFIG_DEFAULTS.visionToolsEnabled,
        text2imgModel: CONFIG_DEFAULTS.text2imgModel,
        img2imgModel: CONFIG_DEFAULTS.img2imgModel,
        imageTimeoutMs: CONFIG_DEFAULTS.imageTimeoutMs,
        visionModel: CONFIG_DEFAULTS.visionModel,
        visionTimeoutMs: CONFIG_DEFAULTS.visionTimeoutMs,
        visionBridgePrompt: ""
      },
      configError: errMsg(error)
    };
  }
}

/**
 * Collect just the auth keys the operator actually set.
 *
 * The keys are read from the TOP LEVEL of the row. That is not obvious, and
 * getting it wrong is not a harmless typo: a nested `auth:` block is accepted
 * by the loader, silently dropped here, and the panel then runs on its shipped
 * defaults — which point at the REAL platform. An end-to-end run meant to talk
 * to a local stub then posts a real login attempt, which is exactly how this
 * plugin locked an account once already. So a nested `auth` key is reported as
 * a configuration error rather than ignored.
 * @param {object} source - the row's raw patch config.
 * @param {string} consoleBase - the resolved console origin.
 * @returns {object} the override object for `createAuth`.
 * @throws {Error} when the row looks like it nests overrides it does not read.
 */
export function resolveAuthOverrides(source: Record<string, unknown>, consoleBase: string): Record<string, unknown> {
  // ANY nested `auth` block is refused, not just the two names below: none of
  // its keys are read, so a block of any shape is silently ignored. Testing for
  // a fixed list would leave `auth: { iamBase: ... }` — the exact key an
  // operator reaches for — as the one case that still fails quietly.
  if (source.auth !== undefined && source.auth !== null) {
    const keys = Object.keys(obj(source.auth));
    throw new Error(
      "auth overrides are top-level keys on this row, not a nested `auth:` block" +
        `${keys.length === 0 ? "" : ` (found: ${keys.join(", ")})`}. ` +
        "Use `iamBase`, `tokenEndpoint`, `jwksEndpoint`, `redirectUri`, `clientId`, " +
        "`scope` or `encKeyId` at the top level; a nested block is ignored and the " +
        "panel would keep using the real platform."
    );
  }
  const text = (key: string) => str(source[key], "");
  const overrides: Record<string, unknown> = { consoleOrigin: consoleBase };
  const set = (key: string, value: unknown, transform?: (value: string) => string) => {
    if (value === "") return;
    overrides[key] = transform === undefined ? value : transform(value as string);
  };
  set("iamOrigin", text("iamBase"), (value) => value.replace(/\/+$/, ""));
  set("tokenEndpoint", text("tokenEndpoint"));
  set("jwksEndpoint", text("jwksEndpoint"));
  set("redirectUri", text("redirectUri"));
  set("clientId", text("clientId"));
  set("scope", text("scope"));
  set("encKeyId", text("encKeyId"));
  const maxHops = Math.floor(num(source.maxHops, 0));
  if (maxHops > 0) overrides.maxHops = maxHops;
  // `requestTimeoutMs` is what this option shipped as, but it only ever fed
  // the login flow — the console calls below had their own hardcoded deadline.
  // The old name still wins when only it is set, so a config written against
  // an earlier version keeps its deadline instead of silently reverting to
  // the default.
  const loginTimeoutMs = Math.floor(num(source.loginTimeoutMs, num(source.requestTimeoutMs, 0)));
  if (loginTimeoutMs > 0) overrides.requestTimeoutMs = loginTimeoutMs;
  return overrides;
}

/**
 * Collect the host names this Host will answer as.
 *
 * The operator's list is ADDED to the defaults, never substituted: replacing
 * them would let a typo lock the panel out of itself, and there is no console
 * to fix it from.
 * @param {object} source - the row's raw patch config.
 * @returns {Set<string>} the admitted host names, lowercased.
 */
export function resolveAllowedHosts(source: Record<string, unknown>): Set<string> {
  const admitted = new Set(CONFIG_DEFAULTS.admittedHosts);
  const extra = Array.isArray(source.allowedHosts) ? source.allowedHosts : [];
  for (const entry of extra) {
    const name = str(entry, "").trim().toLowerCase();
    if (name !== "") admitted.add(name);
  }
  return admitted;
}

/**
 * The host name a `Host` header names, without its port.
 * @param {string} host - the raw header value.
 * @returns {string} the name; bracketed for IPv6 literals.
 */
export function hostName(host: string): string {
  // "[::1]:8080" keeps its brackets; "localhost:8080" loses its port.
  if (host.startsWith("[") && host.includes("]")) {
    return host.slice(0, host.indexOf("]") + 1);
  }
  // A bare IPv6 literal carries more than one colon. A "name with an optional
  // port" is valid for such a value only when the ENTIRE part after the
  // SECOND-TO-LAST colon is a bare port:
  //   "::1:3080"   -> segments ["", "", "1", "3080"], after the 2nd-to-last
  //                    colon is "3080" (digits) -> name "::1"
  //   "::1"        -> segments ["", "", "1"], after the 2nd-to-last colon is
  //                    ":1" (colons are not digits) -> name "::1"
  //   "fe80::1"    -> segments ["fe80", "", "1"], after the 2nd-to-last
  //                    colon is ":1" -> name "fe80::1"
  // So the port, when present, is ALWAYS the last segment alone, and the
  // port-separator is the last colon only when the text after it is all
  // digits AND the text between that last colon and the one before it is
  // ALSO all digits ("1:3080" — the address's final group plus the port).
  // That distinguishes "::1" (":1" after the 2nd-to-last colon: has a colon,
  // not a port) from "::1:3080" ("3080" after the last colon: bare port).
  // A host the operator did not name is returned untouched: refused, which
  // is the safe direction.
  const colons = host.split(":");
  if (colons.length > 2) {
    // "address + port" = 2nd-to-last and last segments are BOTH digits.
    const penultimate = colons[colons.length - 2] ?? "";
    const last = colons[colons.length - 1] ?? "";
    if (/^\d+$/.test(penultimate) && /^\d+$/.test(last)) {
      return host.slice(0, host.lastIndexOf(":"));
    }
    return host;
  }
  // 0 or 1 colons: a bare `:port` tail, or nothing at all.
  return colons.length > 1 ? host.slice(0, host.lastIndexOf(":")) : host;
}

/**
 * Trust fence for a route the browser can reach.
 *
 * Two different attacks have to be turned away here, and they need two
 * different facts:
 *
 * 1. DNS rebinding. The attacker's page rebinds its own name to 127.0.0.1 and
 *    POSTs an account. `Origin` and `Host` now AGREE on the attacker's name
 *    while the request lands on the Host, so comparing them to each other
 *    admits it. The `Host` header is the one thing a browser cannot forge, so
 *    it is checked against a whitelist instead of against the `Origin`.
 * 2. Cross-site forgery. A page on another origin asks the browser to post to
 *    the loopback Host. Here the whitelist alone is worthless — the Host IS
 *    legitimate — and the `Origin` is what gives it away.
 *
 * So: the `Host` must be one this Host answers as, AND any stated `Origin`
 * must agree with it. A request that states no `Origin` is the ordinary
 * same-origin GET and is admitted.
 *
 * The boundary this draws is the BROWSER, not the machine. A process running
 * as the user sets `Host` and `Origin` to whatever it likes, and there is no
 * CSRF token here to tell it apart from the panel — so anything that can open
 * a socket to this port can also plant an account. That is the same trust the
 * Host places in the user's own processes generally, but it is worth saying
 * plainly: an `Origin` check reads like more protection than it is, and a
 * reader who believes otherwise will build something on top of it. Closing
 * that gap needs a token the Host serves in its own page and the POST carries
 * back, not a header a client can choose.
 * @param {{ headers?: { host?: unknown; origin?: unknown } }} request - the incoming HTTP request.
 * @param {Set<string>} allowedHosts - the host names this Host answers as.
 * @returns {boolean} whether the request may be served.
 */
export function isAdmitted(request: { headers?: { host?: unknown; origin?: unknown } }, allowedHosts: Set<string>): boolean {
  const host = str(request.headers?.host, "").toLowerCase();
  if (host === "" || !allowedHosts.has(hostName(host))) return false;
  const origin = request.headers?.origin;
  if (typeof origin !== "string" || origin === "") return true;
  if (origin === "null") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
