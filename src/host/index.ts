/**
 * dsh-sensenova-suite — Host half (thin router).
 *
 * Reads the SenseNova Suite quota through the platform's own console API
 * (the same endpoints the web console calls) and serves the result to the
 * Client panel over one read-only `/api` route.
 *
 * The heavy lifting lives in focused sibling modules so this file stays a
 * readable orchestrator:
 *
 *   - `host-config.ts`    config contract + the `isAdmitted` trust fence
 *   - `routes.ts`         the HTTP route handlers (peer-free, wiring-injected)
 *   - `lifecycle.ts`      mount seed / provider-refresh / teardown
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
import { createFileAccountsStore } from "./token-store/accounts.ts";
import { createFileThrottleStore } from "./throttle-store.ts";
import { createFileCatalogStore } from "./catalog-store.ts";
import { createFileProviderStore } from "./provider-store.ts";
import { profileSegment, profileStateDir } from "./state-store.ts";
import { KeyOrchestrator, DEFAULT_ORCHESTRATOR_PARAMS } from "./key-orchestrator.ts";
import { createFilePoolStore, emptyPoolRecord, effectiveToolEnabled, effectiveVisionModels } from "./pool-store.ts";
import { thinkingWithDefaults } from "./wire/facts.ts";
import { identifyVisionModel } from "./llm-models.ts";
import { createImageSwapper, installCapabilityOverride } from "./vision/bridge.ts";
import { createProviderPublisher } from "./provider-publish.ts";
import { registerRoutes } from "./routes.ts";
import { startSideEffects, teardown } from "./lifecycle.ts";
import { createEffectRegistry, MOUNT_EFFECT_DRAIN_TIMEOUT_MS } from "./effects.ts";
import { CODE } from "./codes.ts";
import { writeLoginTrace } from "./trace.ts";
import { openTraceFile, setTraceSink, traceLog } from "./trace-log.ts";
import { join } from "node:path";
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
 * Host body: assemble the wiring, register the five routes, run the mount
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
  // read — a type error, which is what an `any` annotation was working around.
  // Naming the shape costs nothing at the call site
  // and now lets the compiler check the two places `auth` is consumed.
  let auth: ReturnType<typeof createAuth> | null = null;
  if (configError === null) {
    try {
      auth = createAuth(settings.auth);
    } catch (error) {
      configError = errMsg(error);
    }
  }
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
  // 诊断文件日志（2026-10-27）：桌面主进程接管宿主 stdout，终端看不到插件的
  // [dsh-sensenova-suite] 行——同步追加进状态目录（与 pool.json 同目录），tail 排障。
  const traceSink = openTraceFile(join(profileStateDir(name, profile), "dsh-sensenova-suite.log"));
  setTraceSink(traceSink);
  traceLog(`[dsh-sensenova-suite] host 启动，诊断日志就绪（状态目录与 pool.json 同级）`);

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
  // key 清单 = 配置面 accounts[]（各自 credential-ref，经宿主凭据服务解析；
  // 解析失败静默跳过，缺 key 不拖垮其他账号）。activeAccount 钉选暂由池序首位
  // 语义承担（钉选 = 面板只配一把 key 的特例），完整钉选优先级在面板账号 UI
  // （第 5 步）落位时接线。
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
  // 池成员人人平等（2026-11-03 拍板拆除主 key）：key-<n> 面板池 key +
  // accounts 账号 key，按值去重；不再有「面板默认 key」这一特殊成员。
  const resolvePoolKeys = async (): Promise<Array<{ id: string; key: string }>> => {
    const entries: Array<{ id: string; key: string }> = [];
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
  // The credentials service is looked up PER USE (`getService`), never captured:
  // DSH may register it after this plugin mounts, and a mount-time capture would
  // stay null for the whole process (label fallback + degraded seed, 2026-10-27).
  // 池运营状态存储（面板管理面：停用/恢复/删除、全局并发、模型协议）。
  // params 需要同步读，所以本地持一份记录：本路由的每次写后刷新 + 探测时钟兜底刷新
  // （外部进程直改状态文件的可见性延迟 ≤ 一个探测周期，可接受）。
  const poolStore = createFilePoolStore({ profile, logger: ctx.logger });
  let poolRecord: import("./pool-store.ts").PoolStoreRecord = emptyPoolRecord();
  let reregisterImageTools: (() => Promise<void>) | undefined;
  // 发布签名引用（publisher 在下方才创建，TDZ 规避同 reregisterImageTools 模式）。
  let publishSignature: { signature: string } | undefined;
  const refreshPoolRecord = async () => {
    const previousToolsEnabled = JSON.stringify(poolRecord.toolsEnabled ?? {});
    // 影响浏览器端模型目录的两块用户配置：思考档位下拉读 reasoning.efforts、
    // 发图能力读 inputModalities——adapter 读取边界是热的，但浏览器只在收到
    // llm/adapters-updated（注册重建）时才重拉目录，变更必须触发一次重建。
    const previousCatalogAffecting = JSON.stringify([poolRecord.thinking ?? {}, poolRecord.vision?.visionModels ?? []]);
    poolRecord = await poolStore.read().catch(() => poolRecord);
    // 工具开关热重挂（2026-10-27）：toolsEnabled 变更触发拆旧重挂。**绝不 await**：
    // 重挂内部任何一步慢/挂都会顺着 await 把保存路由一起吊死（2026-10-27 真机：
    // 按工具开关卡住）——触发即返回，重挂在后台串行队列里自己走完。
    if (reregisterImageTools !== undefined && previousToolsEnabled !== JSON.stringify(poolRecord.toolsEnabled ?? {})) {
      void reregisterImageTools().catch((error: unknown) => {
        ctx.logger?.warn?.(`${name}: 工具重挂失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }
    // 思考档位/可看图勾选变更 → 作废发布签名，下一轮探测（≤30s）走「目录变更」
    // 路径重建注册并广播 adapters-updated，浏览器重拉目录后下拉即新（2026-10-27
    // 「档位要重启」链路最后一环）。作废只此一处写：重建后由
    // syncSignaturesAfterPublish 恢复真值，不会死循环。
    if (publishSignature !== undefined
      && previousCatalogAffecting !== JSON.stringify([poolRecord.thinking ?? {}, poolRecord.vision?.visionModels ?? []])) {
      publishSignature.signature = "";
    }
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
      // 凭据服务未注册（DSH 启动时序：插件 mount 可早于它）时这次解析是降级
      // 空集，绝不能被 seed 当成「真的没有 key」钉死——seeded 每进程只置一次
      // （2026-10-27 真机：早于服务注册的首种让 store 里的 key 全部永远未入池）。
      // 抛错让首种保持未种，下次 pick/status/refreshKeys 再试，服务就绪即自愈。
      if (getService("credentials") === null) {
        throw new Error("dsh-sensenova-suite: credentials service not registered yet");
      }
      const excluded = new Set([...poolRecord.disabledIds, ...poolRecord.deletedIds]);
      return (await resolvePoolKeys()).filter((entry) => !excluded.has(entry.id));
    },
    logger: ctx.logger,
  });
  // 面板目录线的 key，两级回落：①pickStart（健康 key 优先，与适配器同源，
  // 通用组无亲和——不推进游标、不占并发槽）→ ②任意一把已解析的池 key。
  // 2026-11-03 两修：**(a)** 目录腿曾只认「主 key」——那个概念已整体拆除
  // （池成员人人平等），旧实现主 key ref 常空导致 catalog.json 七天零更新；
  // **(b)** ①被拒时直落会跟着推理健康门瞎：pickStart 尊重池格标记/blocked
  // （真机 04:55 四把 key 被 pool 429 全标满 30min，目录腿跟着报「无可用
  // key」）——但 /v1/models 是免费读，不耗积分、不占推理配额，池格标记对它
  // 无意义，所以标满时仍可用②取 key。仍尊重 disabled/deleted（用户明确踢出
  // 的 key 不借）。两级全空由聚合层上屏 catalog_unavailable。
  const resolveCatalogApiKey = async (): Promise<string> => {
    try {
      const picked = await orchestrator.pickStart({ model: "" });
      if (typeof picked?.key === "string" && picked.key !== "") return picked.key;
    } catch {
      // 池健康门拒绝（全标满/全 blocked/凭据服务未就绪）：不是目录线的终点。
    }
    const excluded = new Set([...poolRecord.disabledIds, ...poolRecord.deletedIds]);
    const fallback = (await resolvePoolKeys()).find(
      (entry) => !excluded.has(entry.id) && typeof entry.key === "string" && entry.key !== ""
    );
    return fallback !== undefined ? fallback.key : "";
  };
  // 字面量动态 import 必须保持字面量：rolldown 构建期据此把 "./llm-adapter.ts"
  // 改写为产物 "./llm-adapter.js"（llm-adapter 是独立 entry）；改成变量路径会让
  // 产物带着 .ts 说明符在宿主里找不到模块（2026-10-24 注册失败事故）。
  /** 读一张已入库聊天图片 → base64（附件服务桥接）。图片桥转述与原生出图
   * 共用同一个读取口，避免两段手抄漂移。 */
  const loadImageAttachment = async (ref: unknown): Promise<{ base64: string; mediaType: string }> => {
    const attachments = getService("attachments") as
      | { readImage?: (ref: unknown) => Promise<{ data?: unknown; ref?: { mediaType?: string } }> }
      | undefined;
    const stored = await attachments?.readImage?.(ref);
    if (stored === undefined) throw new Error("图片附件为空或不可读");
    const bytes = stored.data;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new Error("图片附件为空或不可读");
    }
    return { base64: Buffer.from(bytes).toString("base64"), mediaType: stored.ref?.mediaType ?? "image/png" };
  };
  /** 原生出图通路的图像解析：附件 → base64（失败 → undefined → 占位出站）。 */
  const resolveImageAccess = (ref: unknown) =>
    loadImageAttachment(ref).then((img) => ({ base64: img.base64, mediaType: img.mediaType })).catch(() => undefined);
  const loadAdapterModule = deps.loadAdapterModule ?? (async () => {
    const module = await import("./llm-adapter.ts");
    // 图片桥换图器（请求边界换图；vision/bridge.ts createImageSwapper）。
    // deps 全部是闭包：visionFeedback 在下方才声明，用 getter 延迟解引用。
    const imageSwapper = createImageSwapper({
      options: () => ({
        apiBase: settings.apiBase,
        model: poolRecord.vision?.model ?? settings.visionModel,
        timeoutMs: settings.visionTimeoutMs,
        bridgePrompt: poolRecord.vision?.bridgePrompt ?? settings.visionBridgePrompt,
        // 工具开关生效值走 tri-state 面板优先（U12-D1 案 A，同 enabled() 注）：
        // 面板存过值听面板、没存过回落 patch 默认——「识图关掉=原样放行」从
        // 不可达变为可达（host-config visionToolsEnabled 注释自 U9 起就这么说）。
        relayOn: effectiveToolEnabled(poolRecord.toolsEnabled.visionTools, settings.visionToolsEnabled),
      }),
      checkedIds: () => visionView(),
      resolveKey: async () => {
        const picked = await orchestrator.pickStart({ model: poolRecord.vision?.model ?? settings.visionModel });
        return picked.key;
      },
      // 读图桥 429 换 key（2026-11-04 批 H 遍历式，同出图链）：exclude = 本轮已试
      // key 全集；不打格不记账，与 429 分类无关。
      rotateOnQuota: async (key, exclude) => {
        const group = orchestrator.groupOf(poolRecord.vision?.model ?? settings.visionModel);
        return await orchestrator.pickNext(new Set([key, ...exclude]), group);
      },
      get feedback() {
        return visionFeedback;
      },
      loadImage: loadImageAttachment,
    });
    return { createSensenovaAdapter: module.createAdapterFactory({ orchestrator, protocolOverrides: () => poolRecord.modelProtocols, thinkingOverrides: () => thinkingView(), visionSwapper: imageSwapper as (messages: unknown, context: { model: string }) => Promise<unknown>, resolveImageAccess, visionModelIds: () => visionView() }) };
  });
  const publisher = createProviderPublisher({
    settings,
    panelSwitch: () => providerStore.enabled().catch(() => null),
    loadAdapterModule,
    getLlm: (service: string) => getService(service),
    // The Host's emitter, handed over RAW and unwrapped. The publisher accepts
    // an absent one and routes it to `publish-core`'s `emitAdaptersUpdated`,
    // which is the single place that tolerates a missing or refusing emitter.
    // This module used to wrap it in its own `try { ctx.emit?.(event) } catch {}`
    // — one of three layers doing one job, and the two upstream of it could
    // never reach their fallback once it had swallowed the throw.
    emit: ctx.emit,
    logger: ctx.logger
  });
  const providerState = publisher.state;
  publishSignature = publisher.state;
  // ── 每模型用户配置的「生效视图」（2026-11-03 拍板）────────────────────────
  // 目录里出现的新模型在 pool.json 没有键（播种只发生在写盘时刻），缺键在
  // 这两个视图里按默认补齐，面板勾选与 DSH 可选面读同一份，不会各说各话。
  // ids 取 providerState.entries（发布在服目录，同步可得，与适配器同一目录
  // 事实）；已存键原样尊重（含显式空数组——「全不勾」的保存不被翻案）。
  // 只在挂载完成后的调用点使用（适配器 deps / 快照投影/池路由），首种前的
  // refreshPoolRecord 变更检测仍比原始记录，无 TDZ 面。
  const catalogIdsInView = (): string[] => {
    const ids: string[] = [];
    for (const entry of (providerState.entries ?? []) as Array<{ id?: unknown }>) {
      const id = str(entry?.id, "");
      if (id !== "") ids.push(id);
    }
    return ids;
  };
  /** 思考档位视图：存储记录 ∪ 缺键默认集（未收录模型默认只勾 high）。 */
  const thinkingView = (): Record<string, string[]> => thinkingWithDefaults(poolRecord.thinking ?? {}, catalogIdsInView());
  /** 原生看图 id（目录 input_modalities 含 image——与面板 vision 徽章同一判据
   * identifyVisionModel）：「可看图自动勾」的底集。目录错报时以手动为准。 */
  const nativeVisionIds = (): string[] => {
    const out: string[] = [];
    for (const entry of (providerState.entries ?? []) as Array<Record<string, unknown>>) {
      const id = str(entry?.id, "");
      if (id !== "" && identifyVisionModel(entry).vision === true) out.push(id);
    }
    return out;
  };
  /** 可看图生效集：显式勾选 ∪（原生 − 手动取消墓碑），手动优先级最高。 */
  const visionView = (): string[] => effectiveVisionModels(poolRecord.vision, nativeVisionIds());
  // `unavailableModelIds` is annotated rather than left to the `= []`
  // initializer: a default initializer types the parameter from it, so without
  // the annotation it read as `never[]` and `publisher.publish` (which takes a
  // `string[]`) was unreachable — and the wrapper's OWN type in `Wiring`
  // declared the parameter as `string[]`.
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
    // 账号清单（方案 C）落插件状态文件 accounts.json——**绝不进凭据服务**：
    // credentials-local 对记录 kind 是封闭白名单，启动整文件校验，自造 kind
    // = 凭据插件激活失败 = 整机无法启动（2026-10-30 真机崩溃实录）。
    accountsStore: createFileAccountsStore({ profile, logger: ctx.logger }),
    // The configured auth instance; a malformed config already set configError
    // above, but the account route may still be reached, so fall back to a
    // defaults-built instance rather than a `null` that would disable login.
    auth: auth ?? createAuth(),
    // A resolver, not a snapshot: the credentials service may register after
    // this plugin mounts, and a one-time lookup would freeze a wrong
    // "ephemeral" claim into every later poll. getService 包裹与本文件其余
    // 读取同款：ctx.get 若对缺席/失败服务抛错，异常就地吞掉、不进轮询路径
    // （U12-S2——这是全文件唯一一处裸 ctx.get）。
    credentials: () => getService("credentials"),
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
  // （原「Vision step two settings-row writer」注释随机制拆除：该写入器已在
  // 收编中删除，startSideEffects 现在只有 catalog-seed 与 provider-refresh
  // 两个效果——U12-D5。）

  // 池管理面（pool 路由）：相位、池侧动作。（原 accountLabel/listAccounts
  // 死装配链已删：poolAdmin.accounts 接口声明过、路由零调用——U12-D3。）
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
    // 已见过的 key 值：同值不重复列（按 key 去重，accounts 与池条目可能同值）。
    const seenKeys = new Set<string>();
    for (const entry of savedPool?.keys ?? []) {
      // 凭据服务必须现查：mount 时捕获的实例在 DSH 服务注册晚于插件挂载时是
      // null，全部 label 会回退成裸 id（2026-10-27 真机：三行全显示 key-<n>）。
      const value = await resolveRefValue(getService("credentials"), poolRef(entry.id));
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
  const wiring = {
    settings,
    configError,
    cache,
    inflight,
    tokenStore,
    catalogStore,
    providerStore,
    poolAdmin: {
      store: poolStore,
      // 「可看图自动勾」的底集来源（目录原生看图 id）；vision 保存路径据此把
      // 「期望生效集 − 原生」写进墓碑（手动取消不被自动勾翻案）。
      nativeVisionIds,
      phaseOf: (id: string) => orchestrator.phaseOf(orchestrator.keyOf(id)),
      // GET /pool 与快照 pool 块同一份行（U11 顺带1 单源对齐，2026-11-04）。
      keyRows: poolKeyRows,
      apply: async (action: "disable" | "restore" | "delete", id: string) => {
        if (action === "disable") orchestrator.disableById(id);
        else if (action === "restore") await orchestrator.restoreById(id);
        else orchestrator.deleteById(id);
      },
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
      // add 查重的解析半边：resolvePoolKeys 本身按值去重、先到先得，
      // 其首个持有者与池的生效条目一致，正好是查重的判据。
      findKeyHolder: async (value: string) =>
        (await resolvePoolKeys()).find((entry) => entry.key === value)?.id ?? null,
      /** 面板改凭据后重解析池（加 key / 面板 key 保存与清除后调用，免重启入池）。 */
      refreshKeys: () => orchestrator.refreshKeys(),
      refresh: refreshPoolRecord
    },
    publisher,
    providerState,
    publishProvider,
    releaseProvider,
    resolveCatalogApiKey,
    poolStore,
    poolRefresh: refreshPoolRecord,
    poolSnapshot: async () => {
      const keys = await poolKeyRows();
      const snap = orchestrator.snapshot(); // 一次取用：poolGrid 与 inflight 同帧（U4 顺带⑤）
      return {
        keys,
        poolGrid: snap.poolGrid,
        inflight: snap.inflight,
        modelProtocols: poolRecord.modelProtocols,
        globalConcurrency: effectiveConcurrency(),
        // 多模态面板设置（已保存值；面板以此渲染控件初值）。vision/thinking
        // 走「生效视图」：目录内缺键的新模型补默认（可看图自动勾/思考只勾
        // high），已存键原样——面板看到的即适配器在用的，两侧不各说各话。
        settings: {
          toolsEnabled: { ...poolRecord.toolsEnabled },
          text2img: { ...poolRecord.text2img },
          img2img: { ...poolRecord.img2img },
          vision: { ...poolRecord.vision, visionModels: visionView() },
          thinking: { ...thinkingView() }
        }
      };
    },
    logger: ctx.logger,
    // The background provider refresher's handle (review #1b): a SLOT like
    // slots — null = nothing armed; `startSideEffects`
    // arms it when `providerRefreshMinutes > 0` (the effective provider switch
    // is re-read per tick — off means every tick no-ops), and `teardown` closes
    // the interval.
    providerRefresh: { current: null },
    // 额度驱动的池格写点（2026-10-31）：pools 是 **console 登录账号** 的 token
    // plan 池，只对该账号自己的 key 有发言权。本插件目前拿不到「console 当前
    // 登录的是哪个账号」（tokenStore 不暴露活动账号 id——方案 C 子系统的边界），
    // 多 key 部署（README 规矩：每把 key 应来自不同账号）时**宁可不标也不错标**
    // ——错标会把别家账号的健康 key 误伤 30 分钟，正是本机制要防的事。唯一无
    // 歧义形态 = 池内只剩一把 key，此时 pools 必然描述它。活动账号身份暴露后
    // 此处一行接上（key = orchestrator.keyOf(activeAccountId)）。
    onQuotaPools: (pools: { pools?: unknown }) => {
      const snap = orchestrator.snapshot();
      const tracked = [...snap.running, ...snap.blocked.map((entry) => entry.key)];
      if (tracked.length !== 1) return;
      const only = tracked[0];
      if (only !== undefined) orchestrator.reportQuotaPools(only, pools);
    }
  };

  // The five route handlers (trust fence, method allowances, body ceilings,
  // trace writes, publish-after-save) — see routes.ts.
  const offs = registerRoutes(ctx, wiring);
  // Mount-time side effects (persisted-catalog seed, provider-refresh) — see
  // lifecycle.ts. Each one is tracked by the effect registry; the unmount
  // cleanup below lets them settle before teardown.
  startSideEffects(ctx, wiring, effects);

  // ── 出图 + 视觉 ────────────────────────────────────────────────────────
  /** 视觉调用结局回池（读图桥专用；出图链与桥的 429 都走各自换 key，不经此）。
   * 2026-11-04 批 G：on429 记账分支撤（他裁定「读图桥也和出图链一样，与 429
   * 分类无关，只保证服务继续」——429 由桥内换 key 重试处理），只留 401/成功。 */
  const visionFeedback: import("./vision/bridge.ts").VisionFeedback = {
    on401: (key) => orchestrator.reportAuthRejected(key),
    onSuccess: (key) => orchestrator.reportSuccess(key)
  };
  // 工具集：按工具开关（text2imgEnabled/img2imgEnabled/visionToolsEnabled，
  // 面板「多模态」为主设置）且 Host 暴露 tools 服务才注册；视觉桥
  // 恒开（2026-10-27 读图桥设置删除）——它不注册任何工具，只让纯文本
  // 主模型拖图不被阻断。视觉/出图调用都经池解析 key（按模型积分组）。
  ctx.effect(() => {
    const disposers: Array<() => void> = [];
    // 卸载竞态门（2026-11-04 U12-S1）：重挂链可能跨越卸载时刻——cleanup 先跑
    // （此刻 toolDisposers 可能为空），链继续把新工具注册进已卸载的宿主 =
    // 泄漏且无人认领。链首与注册前各查一次 disposed，过门即弃（防御性：
    // 宿主对 register-after-dispose 的行为——静默收下或抛错——未实测）。
    let disposed = false;
    // 工具热重挂（2026-10-27）：注册不再是启动一次性——toolsEnabled 变更时
    // 拆旧重挂（register 返回 disposer，拆除的机械能力在）。DSH 的 agent 对
    // 工具集没有中途注销语义：新会话必然按新集合走，进行中的会话视宿主实现
    // 而定——这是本路径唯一的宿主侧未知，验收按「新会话生效」口径。
    let toolDisposers: Array<() => void> = [];
    let chain: Promise<void> = Promise.resolve();
    const registerImageTools = (): Promise<void> => {
      chain = chain.catch(() => {}).then(async () => {
        if (disposed) return; // 卸载后才轮到的重挂：过门即弃（U12-S1）。
        // 阶段标记 + 看门狗：重挂若挂死，30s 后日志报出最后阶段——保存路由已
        // 解耦不受影响，但工具缺席/卡顿的原因就在这一行里。
        let stage = "拆除旧注册";
        const startedAt = Date.now();
        const watchdog = setTimeout(() => {
          ctx.logger?.warn?.(`${name}: 工具重挂超时未完成（>30s），最后阶段=${stage}——保存路由已解耦不受影响`);
        }, 30_000);
        try {
          for (const dispose of toolDisposers) {
            try { dispose(); } catch { /* 拆除失败静默：重挂覆盖同名注册。 */ }
          }
          toolDisposers = [];
          stage = "检查 tools 服务";
          // 工具注册表走 inject 注入的 ctx.tools（上游 image 插件同款）；它不经
          // ctx.get 暴露——此前 ctx.get("tools") 恒 null，工具从未注册（2026-10-27）。
          const tools = (ctx as { tools?: { register?: (tool: unknown) => () => void } }).tools ?? null;
          if (tools === null || typeof tools.register !== "function") {
            ctx.logger?.warn?.(`${name}: ctx.tools 未注入（inject 缺 "tools"），出图工具未注册`);
            return;
          }
          stage = "读取 pool.json";
          await refreshPoolRecord(); // 开关读取磁盘现值（面板保存已落盘）
          // 工具注册门（2026-11-04 U12-D1 案 A 拍板）：tri-state——面板存过值听
          // 面板、没存过回落 patch 默认，与面板显示基 savedBool ?? fallback 同构
          // （effectiveToolEnabled，pool-store）。旧写法 `settings.X || pool===true`
          // 的 OR 门让 patch 默认 true 恒赢，面板「关」永远落不了地。
          const enabled = (name: string): boolean => {
            if (name === "sn_text2img") return effectiveToolEnabled(poolRecord.toolsEnabled.text2img, settings.text2imgEnabled);
            if (name === "sn_img2img") return effectiveToolEnabled(poolRecord.toolsEnabled.img2img, settings.img2imgEnabled);
            return false; // 识图工具已下线（2026-11-04：原生看图+读图桥覆盖，见 vision/tools.ts）
          };
          const anyEnabled = enabled("sn_text2img") || enabled("sn_img2img");
          if (!anyEnabled) return; // 全关：保持零注册（与旧行为一致，peer 也不加载）。
          stage = "加载 tools 模块";
          const module = await import("./vision/tools.ts");
          stage = "构建工具集";
          const toolset = module.buildToolset({
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
                promptExtend: saved?.promptExtend ?? true,
                outputDir: saved?.outputDir ?? "",
                timeoutMs: settings.imageTimeoutMs,
              };
            },
            resolveImageKey: async (model) => {
              try {
                const picked = await orchestrator.pickStart({ model });
                return picked.key;
              } catch (error) {
                throw new Error(`出图 key 解析失败（池空）：${error instanceof Error ? error.message : String(error)}`);
              }
            },
            reportImageSuccess: (key) => orchestrator.reportSuccess(key),
            // 出图额度耗尽换 key（2026-11-04 批 H 遍历式）：只换不打格——exclude =
            // 本轮已试 key 全集，池层返回未试过的一把；与对话链的耗尽账本无关。
            rotateImageKey: async (key, model, exclude) =>
              orchestrator.pickNext(new Set([key, ...exclude]), orchestrator.groupOf(model)),
            ctx: { get: (service: string) => getService(service) },
          });
          stage = "注册工具";
          if (disposed) return; // pool.json/模块加载期间卸载了：不注册（U12-S1）。
          for (const tool of toolset) {
            if (enabled(String((tool as { name?: unknown }).name ?? ""))) {
              toolDisposers.push(tools.register?.(tool) ?? (() => {}));
            }
          }
        } catch (error: unknown) {
          ctx.logger?.warn?.(`${name}: 工具重挂失败（阶段=${stage}）：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          clearTimeout(watchdog);
          if (Date.now() - startedAt > 3000) {
            ctx.logger?.warn?.(`${name}: 工具重挂完成但耗时 ${Date.now() - startedAt}ms（阶段=${stage}）——保存路由已解耦，不再卡面板`);
          }
        }
      });
      return chain;
    };
    reregisterImageTools = registerImageTools;
    void registerImageTools();
    // 图片桥能力覆盖：让 DSH 的发送前图片校验放行（换图本体在适配器请求
    // 边界，vision/bridge.ts createImageSwapper）。恒开、装一次（2026-10-27
    // 读图桥设置已删，能力覆盖不再有开关）。
    const restoreCapability = installCapabilityOverride(
      ctx as unknown as import("./vision/bridge.ts").BridgeCtx,
      () => true,
    );
    disposers.push(restoreCapability);
    return () => {
      disposed = true; // 先立门再拆注册：迟到的重挂链不得再进（U12-S1）。
      for (const dispose of disposers) dispose();
      for (const dispose of toolDisposers) {
        try { dispose(); } catch { /* 卸载失败静默。 */ }
      }
      toolDisposers = []; // 清单交还：卸载后链内残留引用不得再拆一遍。
    };
  }, `${name}: image/vision`);

  // 恢复时钟：每 15s 扫一次阻塞驻留——驻留满 10min 的 key 由时间门放回轮换
  // （考验状态），恢复检验由轮换流量的真实 429/2xx 完成（2026-11-03 批 D 拆除
  // /models 探测：恒 200 假阳性循环且令退避机制死码）。时间门是纯状态操作
  // （零网络、零 promise），同步调用即可。挂 ctx.effect 随插件卸载清掉。
  const probeTimer = setInterval(() => {
    orchestrator.releaseDueBlocked();
  }, 15_000);
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