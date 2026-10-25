/**
 * dsh-sensenova-suite — Host half (thin router).
 *
 * Reads the SenseNova Token Plan quota through the platform's own console API
 * (the same endpoints the web console calls) and serves the result to the
 * Client panel over one read-only `/api` route.
 *
 * The heavy lifting lives in focused sibling modules so this file stays a
 * readable orchestrator:
 *
 *   - `host-config.ts`    config contract + the `isAdmitted` trust fence
 *   - `routes.ts`         the HTTP route handlers (peer-free, wiring-injected)
 *   - `lifecycle.ts`      mount seed / vision step two / teardown
 *   - `console-client.ts` console/catalog fetch with cache + single-flight
 *   - `parsers.ts`        response normalization + shape-drift detection
 *   - `snapshot-aggregate.ts` the snapshot body's data aggregation
 *   - `provider-publish.ts`  the provider registration state machine
 *   - `state-store.ts`    atomic state-file primitives for the stores
 *   - `trace.ts`          login-trace persistence (already sanitized upstream)
 *   - `util.ts`           the small `str`/`num`/`obj` readers + the bounded
 *                         mount-time service resolver
 *
 * This file keeps the Cordis entry (`name`/`inject`/`apply`), the wiring
 * assembly, and the unmount effect — the parts that are about *this* plugin's
 * surface rather than reusable logic.
 *
 * 2026-10 收编裁定：仅保留积分面板 + key 池 + 三协议接入 + 出图/视觉作为交付面；
 * provider 发布状态机保留并接到自有 wire 适配器（三协议实现，见 wire/ 与 adapter.ts）。
 *
 * @module dsh-sensenova-suite
 */

import { createAuth } from "./sensenova-auth.ts";
import { createTokenStore } from "./token-store.ts";
import { createFileThrottleStore } from "./throttle-store.ts";
import { createFileCatalogStore } from "./catalog-store.ts";
import { createFileProviderStore } from "./provider-store.ts";
import { profileSegment } from "./state-store.ts";
import { createApiKeyStore } from "./api-key-store.ts";
import { KeyOrchestrator, DEFAULT_ORCHESTRATOR_PARAMS } from "./key-orchestrator.ts";
import { createFilePoolStore } from "./pool-store.ts";
import { installVisionBridge } from "./vision/bridge.ts";
import { createProviderPublisher } from "./provider-publish.ts";
import { registerRoutes } from "./routes.ts";
import { startSideEffects, teardown } from "./lifecycle.ts";
import { createEffectRegistry, MOUNT_EFFECT_DRAIN_TIMEOUT_MS } from "./effects.ts";
import { CODE } from "./codes.ts";
import { writeLoginTrace } from "./trace.ts";
import {
  resolveSettings,
  resolveAuthOverrides,
  CONFIG_DEFAULTS,
  isAdmitted,
  hostName,
  inject,
  name
} from "./host-config.ts";
import { str, errMsg, maskKey } from "./util.ts";
import type { HostDeps } from "./types.ts";

/**
 * The record address format, matching `@deepseek-ai/dsh-credentials`.
 *
 * The service exports `credentialKey` for this, but a plugin that imports it
 * statically cannot be exercised without that peer package present — which is
 * what kept the test suite from running on a clean checkout. The Host's
 * credentials service treats the plain `"scope/id"` string identically. Exported
 * so `test/config.test.mjs` can pin its LITERAL shape on every machine (a clean
 * checkout included), and `test/store.test.mjs` can assert it EQUALS the real
 * peer function where that peer resolves — together they close the gap the old
 * comment claimed was already closed but never actually tested.
 * @param {string} scope - the plugin's namespace.
 * @param {string} id - the record's name.
 * @returns {string} the record key.
 */
export const credentialKey = (scope: string, id: string) => `${scope}/${id}`;

/**
 * A cheap signature of the model set a provider registration would offer.
 *
 * Re-exported here so the snapshot route's quota branch keeps using the same
 * function the publisher uses — two copies of the signature would drift and
 * the poll would either churn the registration or skip a needed rebuild.
 */
export { catalogSignature } from "./provider-publish.ts";

/**
 * Host body: assemble the wiring, register the six routes, run the mount
 * side effects, and hang the unmount effect. The route handlers live in
 * `routes.ts`, the side effects in `lifecycle.ts` — this function only
 * decides what they may touch.
 * @param {any} ctx - host root context.
 * @param {any} config - the row's raw patch config. There is no DSH Config schema, so
 *   values arrive unvalidated; the endpoint overrides are checked where they
 *   are consumed (`createAuth` throws on a malformed origin) and the failure
 *   is surfaced through the snapshot instead of crashing the route.
 * @param {HostDeps} deps - test-only seams (the peer adapter module). The real
 *   Loader passes nothing.
 */
function apply(ctx: any, config: any = {}, deps: HostDeps = {}) {
  // A malformed row is reported through the snapshot rather than thrown out of
  // `apply`, which would take the whole plugin down at mount.
  const { settings, configError: rowError } = resolveSettings(config);
  let configError: string | null = rowError;
  // Build the auth instance once, at mount: after this every console call,
  // token renewal, and password seal uses the configured hosts. A malformed
  // override must fail loudly here rather than become a baffling network error
  // on the first poll.
  //
  // Annotated `ReturnType<typeof createAuth> | null` rather than `any`:
  // under strictNullChecks a `null` initializer would pin the type to `null`
  // and make the `createAuth(...)` assignment below — plus every later `auth`
  // read — a type error, which is what an `any` annotation was working around
  // (docs/IMPROVEMENTS.md §8). Naming the shape costs nothing at the call site
  // and now lets the compiler check the two places `auth` is consumed.
  let auth: ReturnType<typeof createAuth> | null = null;
  if (configError === null) {
    try {
      auth = createAuth(settings.auth);
    } catch (error) {
      configError = errMsg(error);
    }
  }
  // The inference API key (`sk-…`) is shared by the catalog poll and the
  // directly-registered LLM provider. It is held as the `SENSENOVA_API_KEY`
  // CREDENTIAL REFERENCE (owner-only credentials service), with the raw
  // process environment as a fallback — the value may live in
  // `~/.dsh/.credentials.yaml` alone, which a sibling shell never sees, so
  // reading `process.env` first is what left this panel blind on machines
  // where the key is stored there. The panel save/forget route below writes
  // the reference through the same store. Treated as optional: absent → the
  // model lists and provider degrade, the quota panel still works.
  const apiKeyStore = createApiKeyStore({
    credentials: () => ctx.get("credentials") ?? null
  });
  const resolveApiKey = async () => (await apiKeyStore.resolve()).value;
  /** @type {Map<string, import("./console-client.ts").CacheEntry>} */
  const cache = new Map();
  /** One in-flight console fetch per URL, so concurrent polls share a call. */
  const inflight = new Map();

  // Two profiles can host this plugin at once and they are NOT the same build
  // (see PITFALLS §22): the Desktop profile runs an installed copy, the web
  // profile commonly symlinks this source tree. Each therefore gets its OWN
  // directory for the three switch-shaped states below, derived from the Host's
  // optional `profileContext.name`. `null` (no service, no name, unsafe name)
  // degrades to today's single shared directory — behaviour unchanged.
  // The throttle deliberately stays shared; see `throttle-store.ts`.
  const profile = profileSegment(ctx);

  // Step three's PRIVATE catalog file: the last `/v1/models` answer the key
  // fetched, plus the curated enabled-model allow-list. It lives under
  // `$DSH_HOME/state/[<profile>/]<plugin>/catalog.json`, never in the settings
  // row or the patch layer — a catalog is operational state, not an operator
  // decision.
  const catalogStore = createFileCatalogStore({ profile, logger: ctx.logger });
  // The panel's live provider switch (docs/PROVIDER-HOT-RELOAD.md). A value
  // saved from the panel overrides the patch's `registerProvider`; an untouched
  // state file falls back to it, so configuration-driven deployments keep
  // working unchanged.
  const providerStore = createFileProviderStore({ profile, logger: ctx.logger });

  /** Read an optional service without throwing on a Host that lacks it. */
  const getService = (service: string) => {
    try {
      return ctx.get?.(service) ?? null;
    } catch {
      return null;
    }
  };

  // The directly-registered provider's live registration state now lives in
  // the peer-free `provider-publish.ts` module: the `publishChain` that
  // serialises publishes, the `disposed` gate, the single-point `registerPair`
  // and the rollback path (PITFALLS §18 / §19). `index.ts` drives it from the
  // mount seed, the catalog poll, the provider switch, the roster save and the
  // api-key forget, and reads its `state` for the snapshot's `llm` block.
  // `llm` is an OPTIONAL service (this plugin injects only `webServer`), read
  // through `ctx.get` like the other optional services: on a Host without an
  // LLM runtime the panel still works and `llm.providerRegistered` simply
  // stays false. Everything registration-related is wrapped so a peer that
  // fails to load degrades to "models absent", never "panel down".
  // ── Key 编排层：多账号池 / 按积分组亲和 / (key,组) 池格 / 全局并发 / 探测 ──
  // key 清单 = 面板默认 key（apiKeyStore，credential-ref SENSENOVA_API_KEY 语义）
  // + 配置面 accounts[]（各自 credential-ref，经宿主凭据服务解析；解析失败静默跳过，
  // 缺 key 不拖垮其他账号）。activeAccount 钉选暂由池序首位语义承担（钉选 = 面板只
  // 配一把 key 的特例），完整钉选优先级在面板账号 UI（第 5 步）落位时接线。
  // 面板添加的池 key 的 credential-ref 名：dsh-credentials 只允许
  // /^[A-Za-z_][A-Za-z0-9_]*$/（字母开头、仅字母数字下划线）——旧的
  // `dsh-sensenova-suite/pool-key-<n>` 带 `/` 和 `-`，宿主启动解析凭据文件即抛
  // TypeError、credentials 插件起不来、DSH 整台崩溃（2026-10-25 实测）。统一为
  // `dsh_pool_key_<n>`（index.ts 是唯一写注册处，v0.1.0 起用新名）。
  const poolRef = (id: string): string => `dsh_pool_${id.replace(/^key-/, "key_")}`;
  /** 解析一个 credential-ref 的值（服务可能是异步或同步形状；失败回落 undefined）。 */
  const resolveRefValue = async (credentials: any, ref: string): Promise<string | undefined> => {
    try {
      const resolved = credentials?.resolve?.(ref);
      const value = resolved && typeof resolved.then === "function"
        ? ((await resolved.catch(() => undefined)) as { value?: unknown } | undefined)?.value
        : (resolved as { value?: unknown } | undefined)?.value;
      return typeof value === "string" && value.trim() !== "" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const resolvePoolKeys = async (): Promise<Array<{ id: string; key: string }>> => {
    const entries: Array<{ id: string; key: string }> = [];
    const panelKey = (await apiKeyStore.resolve().catch(() => ({ value: "" }))).value;
    if (typeof panelKey === "string" && panelKey !== "") entries.push({ id: "default", key: panelKey });
    const credentials = getService("credentials");
    // 面板「多模态/接入 API」添加的 key（key-<n>）：秘钥在凭据服务 pool-<id> ref。
    const savedPool = await poolStore.read().catch(() => null);
    for (const entry of savedPool?.keys ?? []) {
      const value = await resolveRefValue(credentials, poolRef(entry.id));
      if (value !== undefined && !entries.some((item) => item.key === value)) {
        entries.push({ id: entry.id, key: value });
      }
    }
    for (const account of settings.accounts) {
      const value = await resolveRefValue(credentials, account.apiKeyRef);
      if (value !== undefined && !entries.some((item) => item.key === value)) {
        entries.push({ id: account.id, key: value });
      }
    }
    return entries;
  };
  // The credentials service, read once for maskKey display (and pool refs).
  const credentialsService = getService("credentials");
  // 池运营状态存储（面板管理面：停用/恢复/删除、全局并发、模型协议）。
  // params 需要同步读，所以本地持一份记录：本路由的每次写后刷新 + 探测时钟兜底刷新
  // （外部进程直改状态文件的可见性延迟 ≤ 一个探测周期，可接受）。
  const poolStore = createFilePoolStore({ profile, logger: ctx.logger });
  let poolRecord: import("./pool-store.ts").PoolStoreRecord = { version: 1, disabledIds: [], deletedIds: [], globalConcurrency: null, modelProtocols: {}, keys: [], toolsEnabled: {}, text2img: {}, img2img: {}, vision: {}, thinking: {} };
  const refreshPoolRecord = async () => {
    poolRecord = await poolStore.read().catch(() => poolRecord);
  };
  void refreshPoolRecord();
  // 面板停用/删除的账号不进池：解析后按 id 过滤（pool-store 的名单先于池）。
  const orchestrator = new KeyOrchestrator({
    params: () => ({
      ...DEFAULT_ORCHESTRATOR_PARAMS,
      globalConcurrency: effectiveConcurrency(),
      modelGroups: settings.modelGroups,
    }),
    resolveKeys: async () => {
      const excluded = new Set([...poolRecord.disabledIds, ...poolRecord.deletedIds]);
      return (await resolvePoolKeys()).filter((entry) => !excluded.has(entry.id));
    },
    probe: async (key: string) => {
      // 最轻探测：GET {apiBase}/models（不耗积分、不占对话速率桶的目录读）。
      try {
        const origin = settings.apiBase.replace(/\/+$/, "");
        const response = await fetch(`${origin}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    logger: ctx.logger,
  });
  // 字面量动态 import 必须保持字面量：rolldown 构建期据此把 "./llm-adapter.ts"
  // 改写为产物 "./llm-adapter.js"（llm-adapter 是独立 entry）；改成变量路径会让
  // 产物带着 .ts 说明符在宿主里找不到模块（2026-10-24 注册失败事故）。
  const loadAdapterModule = deps.loadAdapterModule ?? (async () => {
    const module = await import("./llm-adapter.ts");
    return { createSensenovaAdapter: module.createAdapterFactory({ orchestrator, protocolOverrides: () => poolRecord.modelProtocols, thinkingOverrides: () => poolRecord.thinking }) };
  });
  const publisher = createProviderPublisher({
    settings,
    panelSwitch: () => providerStore.enabled().catch(() => null),
    loadAdapterModule,
    getLlm: (service: string) => getService(service),
    resolveApiKey,
    // The Host's emitter, handed over RAW and unwrapped. Both publishers accept
    // an absent one and route it to `publish-core`'s `emitAdaptersUpdated`,
    // which is the single place that tolerates a missing or refusing emitter.
    // This module used to wrap it in its own `try { ctx.emit?.(event) } catch {}`
    // — one of three layers doing one job, and the two upstream of it could
    // never reach their fallback once it had swallowed the throw.
    emit: ctx.emit,
    logger: ctx.logger
  });
  const providerState = publisher.state;
  // `unavailableModelIds` is annotated rather than left to the `= []`
  // initializer: a default initializer types the parameter from it, so without
  // the annotation it read as `never[]` and `publisher.publish` (which takes a
  // `string[]`) was unreachable — and the wrapper's OWN type in `Wiring`
  // declared the parameter as `string[]` (docs/IMPROVEMENTS.md §8).
  const publishProvider = (entries: unknown, enabledIds: unknown, unavailableModelIds: string[] = []) =>
    publisher.publish(entries, enabledIds, unavailableModelIds);
  const releaseProvider = () => publisher.release();

  // ADR-008: the mount-time effects start concurrently and are tracked by
  // one registry, so the unmount can let them settle (bounded) instead of
  // racing their post-hoc disposed guards.
  const effects = createEffectRegistry(ctx.logger);

  // The credentials service is how the console token and account are held and
  // renewed. It is optional: a Host without one still gets a working panel,
  // with the account kept in memory for that process's lifetime rather than on
  // disk. Refusing to build a store at all would leave such a Host with no way
  // to sign in.
  const tokenStore = createTokenStore({
    // The configured auth instance; a malformed config already set configError
    // above, but the account route may still be reached, so fall back to a
    // defaults-built instance rather than a `null` that would disable login.
    auth: auth ?? createAuth(),
    // A resolver, not a snapshot: the credentials service may register after
    // this plugin mounts, and a one-time lookup would freeze a wrong
    // "ephemeral" claim into every later poll.
    credentials: () => ctx.get("credentials") ?? null,
    credentialKey,
    skewMs: settings.tokenSkewSeconds * 1000,
    // Explicit, because the store defaults to an in-memory throttle: a wait
    // that only this process knows about is no protection against a second
    // Host process walking into the lock this one is waiting out. This is the
    // one place that default is wrong. The logger is what turns a refused or
    // failed write into something a person can see (ADR-006).
    throttleStore: createFileThrottleStore({ logger: ctx.logger }),
    // Every sign-in attempt (success or failure) leaves one sanitized trace
    // file behind: a "browser works but the panel does not" report is only
    // debuggable by diffing a working attempt against a failing one. The
    // failure half is named by its code; a success has none, so it says so.
    onTrace: (hops, error) => {
      void writeLoginTrace(hops, error === null ? "ok" : str((error as { code?: unknown } | null | undefined)?.code, CODE.AUTH_ERROR));
    }
  });
  // Vision step two (ARCHITECTURE.md §5.1): the settings-row writer the
  // snapshot route calls after it has computed the vision list. Filled in
  // by `startSideEffects`; until then it is a no-op, so a Host without a
  // settings service still answers polls.

  // 池管理面（pool 路由）：标签（default=面板 key，accounts 用配置 label）、
  // 相位、池侧动作、面板 key 的 forget。
  const accountLabel = (id: string): string | null => {
    if (id === "default") return null;
    return settings.accounts.find((account) => account.id === id)?.label ?? null;
  };
  /** 生效中的全局并发数：面板保存值 > 配置 >（编排层再兜底 key 数）。 */
  const effectiveConcurrency = () => poolRecord.globalConcurrency ?? settings.globalConcurrency;
  /**
   * 管理面 key 行（面板默认 key 在前，随后 store 清单）——GET /pool 与快照的
   * pool 块共用：列的是「配置了什么」，不是「凭据解析成功了什么」。
   * 显示名 = 主 key 的脱敏（maskKey），无需单独 label 字段；
   * store 清单的 name 字段现在是「备注」（面板填的、展示在脱敏名后）。
   */
  const poolKeyRows = async (): Promise<Array<{
    id: string; label: string | null; note: string | null;
    phase: "running" | "blocked" | "absent"; disabled: boolean; deleted: boolean;
  }>> => {
    // 相位必须等池 seed 过才有意义：ensureSeeded 懒加载在第一次 pick/status 时
    // 才发生，poolKeyRows 若抢在它前面，keyOf 恒 undefined → phaseOf='absent'
    // （新 key 一直显示「未入池」的根因）。先 await 一次 statusById 触发 seed。
    const phaseById = new Map((await orchestrator.statusById()).map((row) => [row.id, row.phase]));
    const savedPool = await poolStore.read().catch(() => null);
    const rows: Array<{
      id: string; label: string | null; note: string | null;
      phase: "running" | "blocked" | "absent"; disabled: boolean; deleted: boolean;
    }> = [];
    const panelKeyValue = (await apiKeyStore.resolve().catch(() => ({ value: "" }))).value;
    if (typeof panelKeyValue === "string" && panelKeyValue !== "") {
      rows.push({
        id: "default", label: maskKey(panelKeyValue), note: null,
        phase: phaseById.get("default") ?? "absent",
        disabled: poolRecord.disabledIds.includes("default"),
        deleted: poolRecord.deletedIds.includes("default")
      });
    }
    // 已见过的 key 值：default 与新 key 值相同时不重复列（按 key 去重）。
    const seenKeys = new Set<string>();
    if (typeof panelKeyValue === "string" && panelKeyValue !== "") seenKeys.add(panelKeyValue);
    for (const entry of savedPool?.keys ?? []) {
      const value = await resolveRefValue(credentialsService, poolRef(entry.id));
      // name 现在是「备注」；存量旧默认名（Key1/Key2…）不算备注。
      const isLegacyDefault = /^Key\d+$/.test(entry.name);
      if (typeof value === "string" && value !== "" && seenKeys.has(value)) {
        // 同一把 key 值已被 default（或前面的 store 条目）列过 → 跳过，避免「显示两遍」。
        continue;
      }
      if (typeof value === "string" && value !== "") seenKeys.add(value);
      rows.push({
        id: entry.id,
        label: typeof value === "string" && value !== "" ? maskKey(value) : entry.id,
        note: entry.name !== "" && !isLegacyDefault ? entry.name : null,
        phase: phaseById.get(entry.id) ?? "absent",
        disabled: poolRecord.disabledIds.includes(entry.id),
        deleted: poolRecord.deletedIds.includes(entry.id)
      });
    }
    return rows;
  };
  /** 全量账号清单（未过滤停用/删除）+ 标签——池管理与池诊断共源。 */
  const listAccounts = async (): Promise<Array<{ id: string; label: string | null }>> => {
    const entries = await resolvePoolKeys();
    return entries.map((entry) => ({ id: entry.id, label: accountLabel(entry.id) }));
  };
  const wiring = {
    settings,
    configError,
    cache,
    inflight,
    tokenStore,
    apiKeyStore,
    catalogStore,
    providerStore,
    poolAdmin: {
      store: poolStore,
      accounts: listAccounts,
      phaseOf: (id: string) => orchestrator.phaseOf(orchestrator.keyOf(id)),
      apply: async (action: "disable" | "restore" | "delete", id: string) => {
        if (action === "disable") orchestrator.disableById(id);
        else if (action === "restore") await orchestrator.restoreById(id);
        else orchestrator.deleteById(id);
      },
      forgetPanelKey: async () => { await apiKeyStore.forget().catch(() => undefined); },
      addKeySecret: async (id: string, apiKey: string) => {
        const credentials = getService("credentials");
        // 凭据 ref 名必须合规（^[A-Za-z_][A-Za-z0-9_]*$）；旧 `…/pool-key-<n>`
        // 带 `/`/`-`，存进去会让宿主启动解析凭据文件即崩（2026-10-25）。
        const refName = poolRef(id);
        if (credentials !== null && typeof credentials.set === "function") {
          await credentials.set(refName, apiKey);
        }
      },
      removeKeySecret: async (id: string) => {
        const credentials = getService("credentials");
        const refName = poolRef(id);
        if (credentials !== null && typeof credentials.unset === "function") {
          await credentials.unset(refName);
        }
      },
      effectiveConcurrency: async () => {
        await refreshPoolRecord();
        return effectiveConcurrency();
      },
      hasPanelKey: async () => {
        const value = (await apiKeyStore.resolve().catch(() => ({ value: "" }))).value;
        return typeof value === "string" && value !== "";
      },
      refresh: refreshPoolRecord
    },
    publisher,
    providerState,
    publishProvider,
    releaseProvider,
    resolveApiKey,
    poolStore,
    poolRefresh: refreshPoolRecord,
    poolSnapshot: async () => {
      const keys = await poolKeyRows();
      return {
        keys,
        poolGrid: orchestrator.snapshot().poolGrid,
        inflight: orchestrator.snapshot().inflight,
        modelProtocols: poolRecord.modelProtocols,
        globalConcurrency: effectiveConcurrency(),
        // 多模态面板设置（已保存值；面板以此渲染控件初值）。
        settings: {
          toolsEnabled: { ...poolRecord.toolsEnabled },
          text2img: { ...poolRecord.text2img },
          img2img: { ...poolRecord.img2img },
          vision: { ...poolRecord.vision },
          thinking: { ...poolRecord.thinking }
        }
      };
    },
    // 每模型可用思考档位（面板行内勾选；snapshot roster 与发布链读取）。
    thinkingOverrides: () => poolRecord.thinking,
    logger: ctx.logger,
    // The background provider refresher's handle (review #1b): a SLOT like
    // slots — null = nothing armed; `startSideEffects`
    // arms it when `providerRefreshMinutes > 0` AND the effective provider
    // switch is on, and `teardown` closes the interval.
    providerRefresh: { current: null }
  };

  // The six route handlers (trust fence, method allowances, body ceilings,
  // trace writes, publish-after-save) — see routes.ts.
  const offs = registerRoutes(ctx, wiring);
  // Mount-time side effects (persisted-catalog seed, vision step two) — see
  // lifecycle.ts. Each one is tracked by the effect registry; the unmount
  // cleanup below lets them settle before teardown.
  startSideEffects(ctx, wiring, effects);

  // ── 出图 + 视觉 ────────────────────────────────────────────────────────
  /** 视觉调用结局回池（单份定义，tools 与桥共用——两段手抄会漂）。 */
  const visionFeedback: import("./vision/run.ts").VisionFeedback = {
    on429: (key, kind) => {
      if (kind === "pool") orchestrator.reportPoolExhausted(key, orchestrator.groupOf(poolRecord.vision?.model ?? settings.visionModel));
      else orchestrator.reportRateLimited(key);
    },
    on401: (key) => orchestrator.reportAuthRejected(key),
    onSuccess: (key) => orchestrator.reportSuccess(key)
  };
  // 工具集：按工具开关（text2imgEnabled/img2imgEnabled/visionToolsEnabled，
  // 面板「多模态」为主设置）且 Host 暴露 tools 服务才注册；视觉桥
  // （visionBridgeMode !== 'off'）独立于工具开关——它不注册任何工具，只让纯文本
  // 主模型拖图不被阻断。视觉/出图调用都经池解析 key（按模型积分组）。
  ctx.effect(() => {
    const disposers: Array<() => void> = [];
    const tools = getService("tools") as { register?: (tool: unknown) => () => void } | null;
    if (tools !== null && typeof tools.register === "function"
      && (settings.text2imgEnabled || settings.img2imgEnabled || settings.visionToolsEnabled
        || poolRecord.toolsEnabled?.text2img === true || poolRecord.toolsEnabled?.img2img === true
        || poolRecord.toolsEnabled?.visionTools === true)) {
      try {
        // 懒加载 peer 半区（vision/tools.ts import dsh-tools）；失败降级为工具缺席。
        void import("./vision/tools.ts").then(async (module) => {
          await refreshPoolRecord(); // 开关读取前面板值已就位
          const enabled = (name: string): boolean => {
            if (name === "sn_text2img") return settings.text2imgEnabled || poolRecord.toolsEnabled.text2img === true;
            if (name === "sn_img2img") return settings.img2imgEnabled || poolRecord.toolsEnabled.img2img === true;
            if (name === "sn_describe_image" || name === "sn_describe_images") {
              return settings.visionToolsEnabled || poolRecord.toolsEnabled.visionTools === true;
            }
            return false;
          };
          const toolset = module.buildToolset({
            visionOptions: () => ({
              apiBase: settings.apiBase,
              model: poolRecord.vision?.model ?? settings.visionModel,
              imageMode: settings.visionImageMode,
              timeoutMs: settings.visionTimeoutMs,
            }),
            resolveVisionKey: async () => {
              const picked = await orchestrator.pickStart({ model: settings.visionModel });
              return picked.key;
            },
            visionFeedback: () => visionFeedback,
            // 每工具生效值：面板保存值（pool-store）> patch 默认 > 代码默认。
            imageOptions: (tool: "text2img" | "img2img") => {
              const saved = tool === "text2img" ? poolRecord.text2img : poolRecord.img2img;
              const model = (tool === "text2img" ? settings.text2imgModel : settings.img2imgModel);
              return {
                apiBase: settings.apiBase,
                defaultModel: saved?.model ?? model,
                // 面板开关语义是「关闭水印」：ON（默认）= 去水印。商汤的
                // watermark 字段是「是否添加官方 Logo」（true = 加），所以这里
                // 必须反转面板值——面板 ON → 商汤 false。两者默认一致：
                // 未保存时面板显示开（去水印），这里也去水印。
                watermark: !(saved?.watermark ?? true),
                defaultSize: saved?.size ?? "",
                outputFormat: saved?.outputFormat ?? "png",
                responseFormat: saved?.responseFormat ?? "b64_json",
                promptExtend: saved?.promptExtend ?? true,
                outputDir: saved?.outputDir ?? "",
                timeoutMs: settings.imageTimeoutMs,
              };
            },
            toolEnabled: (tool: "text2img" | "img2img") =>
              tool === "text2img"
                ? (poolRecord.toolsEnabled?.text2img === true || settings.text2imgEnabled)
                : (poolRecord.toolsEnabled?.img2img === true || settings.img2imgEnabled),
            resolveImageKey: async (model) => {
              try {
                const picked = await orchestrator.pickStart({ model });
                return picked.key;
              } catch (error) {
                throw new Error(`出图 key 解析失败（池空）：${error instanceof Error ? error.message : String(error)}`);
              }
            },
            reportImageSuccess: (key) => orchestrator.reportSuccess(key),
            ctx: { get: (service: string) => getService(service) },
          });
          for (const tool of toolset) {
            if (enabled(String((tool as { name?: unknown }).name ?? ""))) {
              disposers.push(tools.register?.(tool) ?? (() => {}));
            }
          }
        }).catch((error: unknown) => {
          ctx.logger?.warn?.(`${name}: vision/image tools peer load failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        ctx.logger?.warn?.(`${name}: toolset build failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (settings.visionBridgeMode !== "off") {
      try {
        const bridge = installVisionBridge({
          ctx: ctx as unknown as import("./vision/bridge.ts").BridgeCtx,
          options: () => ({
            apiBase: settings.apiBase,
            model: poolRecord.vision?.model ?? settings.visionModel,
            imageMode: settings.visionImageMode,
            timeoutMs: settings.visionTimeoutMs,
            bridgeMode: (poolRecord.vision?.bridgeMode ?? settings.visionBridgeMode) as "off" | "on" | "auto",
            bridgePrompt: poolRecord.vision?.bridgePrompt ?? settings.visionBridgePrompt,
          }),
          resolveKey: async () => {
            const picked = await orchestrator.pickStart({ model: poolRecord.vision?.model ?? settings.visionModel });
            return picked.key;
          },
          feedback: visionFeedback,
        });
        disposers.push(bridge);
      } catch (error) {
        ctx.logger?.warn?.(`${name}: vision bridge install failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return () => { for (const dispose of disposers) dispose(); };
  }, `${name}: image/vision`);

  // 探测时钟：每 15s 扫一次到期探测——探测与 agent 请求解耦，
  // 「只在 2xx 清零」的短路死锁由此根治。挂 ctx.effect 随插件卸载清掉。
  const probeTimer = setInterval(() => { void orchestrator.runDueProbes(); }, 15_000);
  probeTimer.unref?.();
  ctx.effect(() => () => clearInterval(probeTimer), `${name}: probe timer`);

  ctx.effect(() => {
    // The effect callback returns the unmount cleanup: Cordis runs it when
    // this fiber disposes, NOT at registration — a teardown that ran early
    // would unregister every route the moment they were created.
    return async () => {
      // ADR-008: let the still-settling mount effects finish first —
      // bounded, so a hung effect can never hold the unmount hostage; a
      // straggler is reported and left to the disposed guards that already
      // protect every write path (PITFALLS §18 / §31, P0-1 `65ab2dc`).
      const stragglers = await effects.drain(MOUNT_EFFECT_DRAIN_TIMEOUT_MS);
      if (stragglers.length > 0) {
        ctx.logger?.warn?.(
          `${name}: unmount drain (${MOUNT_EFFECT_DRAIN_TIMEOUT_MS}ms) left still-settling effects: ${stragglers.join(", ")} — their disposed guards remain the backstop`
        );
      }
      teardown(wiring, offs);
    };
  }, `${name}: routes`);
}

export { apply, inject, name, resolveSettings, resolveAuthOverrides, CONFIG_DEFAULTS, hostName, isAdmitted };