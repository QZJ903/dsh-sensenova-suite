/**
 * Shared structural types for the Host half.
 *
 * The Host wires its modules together with an injected dependency object
 * (`HostDeps`). That object is built once in `index.ts` from the Cordis
 * context and passed down; the runtime fields are many and come from peers
 * that ship no `.d.ts`, so the single source of truth for "what a dep may
 * carry" lives here rather than in per-file `{}` placeholders (which TS
 * reads as an empty object and then rejects every field access on).
 * @module dsh-sensenova-suite/types
 */

/**
 * A failure code this plugin can produce or carry (a `CODE` wire value).
 *
 * Imported from `codes.ts`, which owns the taxonomy, and re-exported here for
 * the consumers that already reach for it through this module — rather than
 * restated as `string`: the loose alias meant a misspelled code compiled clean,
 * so the "one taxonomy" claim held for the values but not for the type.
 */
export type { CodeValue } from "./codes.ts";
import type { CodeValue } from "./codes.ts";

/**
 * The two dependency bags the Host wires down. `HostDeps` is what `apply()`
 * (index.ts) accepts: the mount-time lazy-load seams, all test-only.
 * `ProviderPublisherDeps` is what `createProviderPublisher()` accepts: the
 * settings/llm/emitter/credential bag the publisher resolves lazily.
 *
 * Splitting the former 20-field `HostDeps` into the two bags each of its real
 * consumers actually reads — 4 here, 7 there — drops the ten historical fields
 * no module ever read (`credential`, `onTrace`, `timeoutMs`, `headers`,
 * `jwksEndpoint`, `encKeyId`, `baseUrl`, `cache`, `maxHops`,
 * `requestTimeoutMs`): a caller stopped using them but the bag kept carrying
 * them, so they widened the contract without doing any work. Narrowing is a
 * pure type-surface change — the runtime already defaulted every one of them.
 *
 * Every field is optional: each consumer falls back to a local default when a
 * field is absent, so a module keeps working even if `index.ts` does not wire
 * a given capability. Peer-typed members (`logger`, `emit`, …) use loose types
 * because the matching `@deepseek-ai/*` packages ship no declarations here.
 */
/** The mount-time lazy-load seams `apply()` accepts (test-only; defaults cover production). */
export interface HostDeps {
  /** Lazy-load the LLM adapter module (peer `dsh-llm-pi-ai`). */
  loadAdapterModule?: () => Promise<{ createSensenovaAdapter: (...args: any[]) => any }>;
}

/** The bag `createProviderPublisher()` accepts; each field resolves lazily. */
export interface ProviderPublisherDeps {
  /** Resolved plugin settings object. `Partial` is the real consumption
   * contract: the publisher reads every field degradation-safe (`?? {}`),
   * and `resolveSwitchEnabled` treats an absent config as false. */
  settings?: Partial<import("./host-config.ts").ResolvedSettings>;
  /** Toggle that flips the sidebar panel on/off from the Host. */
  panelSwitch?: () => Promise<boolean | null>;
  /** Lazy-load the LLM adapter module (peer `dsh-llm-pi-ai`). */
  loadAdapterModule?: () => Promise<{ createSensenovaAdapter: (...args: any[]) => any }>;
  /** Resolve the registered LLM instance. */
  getLlm?: (service: string) => any;
  /** Resolve the API key from the credentials service. */
  resolveApiKey?: () => Promise<string>;
  /** Cordis event emitter. */
  emit?: (event: string) => void;
  /** Cordis logger (loose: peer has no declarations here). */
  logger?: { warn?: (message: string, ...args: unknown[]) => void };
}

/** Options every file-backed store accepts. */
export interface StoreOptions {
  /** Profile key; stores are segmented per profile. */
  profile?: string | null;
  /** Clock override for tests. */
  now?: () => number;
  /** Idle entry TTL in milliseconds. */
  ttlMs?: number;
  /** Directory the store persists into. */
  dir?: string;
  /** `ctx.logger`, for the ADR-006 write-side version-guard degrade signal. */
  logger?: { warn?: (message: string) => void };
}

/** A provider/adapter configuration object. */
export interface AdapterConfig {
  providerId?: string;
  enabledIds?: string[];
  unavailableModelIds?: string[];
  baseUrl?: string;
  /**
   * `{ "<model id>": ceiling }` — the operator's per-model output ceiling,
   * already sanitized by `host-config.resolveSettings`. `llm-models.maxTokensFor`
   * consults it BEFORE the catalogue's own figure and the panel roster quotes
   * that same function, so the displayed "最大输出" and the `max_tokens` on the
   * wire cannot disagree. Absent/empty = the catalogue is authoritative.
   */
  maxTokensOverrides?: Record<string, number>;
  /**
   * `{ "<model id>": ["off","low",...] }` — the user-selected per-model 思考
   * 档位 (from pool.json `thinking`). `thinkingLevelMapFor` builds the
   * descriptor's map from it, so the DSH 对话界面的可选思考档位 = 用户勾选集.
   */
  thinkingOverrides?: Record<string, string[]>;
}

/** Options for the JWKS cache / JWE sealer. */
export interface JwksOptions {
  /** A caller-owned key-set cache; typed loosely (see createJwksCache). */
  cache?: any;
  jwksEndpoint?: string;
  encKeyId?: string;
  timeoutMs?: number;
}

/**
 * An `Error` with the stable `code` the panel branches on, plus optional
 * structured fields. The fields are attached at runtime (not inherited), so
 * this is a structural annotation: a `catch (e)` downstream may read `e.code`.
 */
export interface PluginError extends Error {
  code?: CodeValue;
  retryAfterMs?: number;
  detail?: unknown;
  trace?: unknown[];
}

/**
 * The wiring bag `index.ts` assembles once at mount and hands to the route
 * handlers (`routes.ts`). It is the single seam that decides what a route may
 * touch: every service a handler reaches for is listed here, so a route that
 * needs a new dependency gets it through the wiring, never by importing the
 * service directly.
 *
 * The stores / publishers / caches are opaque injected objects (the DSH peers
 * ship no declarations in this repo), so they are typed loosely — the shape is
 * pinned by the creators (`createFile*Store`, `createProviderPublisher`, …)
 * and by the tests, not by this annotation. A new field must keep the "one
 * seam" discipline: add it here, wire it in `index.ts`, and read it through.
 */
export interface Wiring {
  /** The resolved settings row (panel values + config defaults). */
  settings: import("./host-config.ts").ResolvedSettings;
  /** A settings/auth misconfiguration surfaced through the snapshot; `null` when clean. */
  configError: string | null;
  /** The console-response cache shared across polls. */
  cache: Map<string, { body: unknown; at: number; gen: number }>;
  /** The single-flight map shared across polls. */
  inflight: Map<string, Promise<unknown>>;
  /** The token store (`createTokenStore`). */
  tokenStore: ReturnType<typeof import("./token-store.ts").createTokenStore>;
  /** The inference API-key store (`createApiKeyStore`). */
  apiKeyStore: ReturnType<typeof import("./api-key-store.ts").createApiKeyStore>;
  /** The model-catalog store (`createFileCatalogStore`). */
  catalogStore: ReturnType<typeof import("./catalog-store.ts").createFileCatalogStore>;
  /** The provider switch store (`createFileProviderStore`). */
  providerStore: ReturnType<typeof import("./provider-store.ts").createFileProviderStore>;
  /** The directly-registered provider publisher (`createProviderPublisher`). */
  publisher: ReturnType<typeof import("./provider-publish.ts").createProviderPublisher>;
  /** The publisher's live registration state (shared reference). */
  providerState: import("./provider-publish.ts").ProviderPublisherState;
  /** `(entries, enabledIds, unavailableIds) => publisher.publish` with rollback. */
  publishProvider: (entries: unknown[], enabledIds: string[], unavailableModelIds?: string[]) => Promise<unknown>;
  /** Release the registered provider pair (adapter + directory). */
  releaseProvider: () => void;
  /** Resolve the live `sk-` key per request. */
  resolveApiKey: () => Promise<string>;
  /** Key 池诊断快照（snapshot 路由只读块；测试可省略）。 */
  poolSnapshot?: () => unknown;
  /** 每模型可用思考档位（pool.json `thinking` 分区；snapshot 路由/发布链读取）。 */
  thinkingOverrides?: () => Record<string, string[]>;
  /** Key 池管理面（pool 路由；测试可省略）。 */
  poolAdmin?: import("./routes/pool.ts").PoolAdmin;
  /** 池状态刷新（models 路由保存协议后调用；测试可省略）。 */
  poolRefresh?: () => Promise<void>;
  /** 额度驱动的池格写点（发布链每次额度轮询成功时回调 → orchestrator.reportQuotaPools；key 归属判定在本字段实现内，测试可省略）。 */
  onQuotaPools?: (pools: { pools?: unknown }) => void;
  /** `ctx.logger` (Host logging); optional so tests may omit it. */
  logger?: { warn?: (message: string, ...args: unknown[]) => void };
  /** The background provider refresher's handle (review #1b). A SLOT in the
   *  slot shape: `apply()` spells it
   *  `current: null` = "no refresher scheduled", `startSideEffects` arms it
   *  when the effective cadence is > 0, and `teardown` closes it. A slot (not
   *  an optional property) because "is a timer live?" is state the teardown
   *  must read off the contract, not off property presence. */
  providerRefresh: { current: { close(): void } | null };
}
