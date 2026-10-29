/**
 * The shared context a token store instance runs on — the seam the split
 * around `token-store.ts` stands on.
 *
 * `token-store.ts` is one closure holding four intertwined blocks (grant,
 * account, renewal, throttle) that share five mutable variables. Each block
 * lives in its own module (docs/TOKEN-STORE-SPLIT.md); what they all keep in
 * common is exactly what this file owns:
 *
 *   - `wiring` — the read side: the credentials backend (real service or the
 *     in-memory vault), the keys, the injected clock, env, auth, and the
 *     throttle store (per-account parks). Built once per instance.
 *   - `state` — the seven mutable fields, now named instead of closure-scoped:
 *     `cached`, `rejected`, `inflight`, `lastError`. Each block writes only its own
 *     fields (the ownership table lives in the split doc §1); every block may
 *     read any field through `state.`.
 *
 * @module dsh-sensenova-suite/token-store/state
 */

import { isEphemeral, resolveCredentialsService } from "../credentials-service.ts";
import { createAuth } from "../sensenova-auth.ts";
import { createMemoryThrottleStore } from "../throttle-store.ts";
import { name as RECORD_SCOPE } from "../host-config.ts";
import { RECORD_ID, THROTTLE_ID } from "./constants.ts";

/**
 * The credential backend the blocks read and write through.
 *
 * Two implementations exist: the real DSH credentials service (resolved per
 * use, so it may register after mount) and the in-memory vault above. The
 * methods are the subset the store actually calls — declared so a block's
 * `backend().readRecord(...)` is not a read off `unknown`.
 */
export interface CredentialBackend {
  readRecord(key: string): Promise<unknown>;
  modifyRecord(key: string, mutate: (current: unknown) => unknown): Promise<unknown>;
  deleteRecord(key: string): Promise<unknown>;
  resolve(ref: string): Promise<{ value?: unknown; source?: string } | undefined>;
  set(ref: string, value: string): Promise<unknown>;
  unset(ref: string): Promise<unknown>;
}

/** The throttle store the blocks persist refusals through (`throttle-store.ts`). */
export interface ThrottleStore {
  /** 读某账号的冷却；没有 = null。 */
  read(username: string): Promise<HeldThrottle | null>;
  write(username: string, held: HeldThrottle): Promise<unknown>;
  clear(username: string): Promise<unknown>;
}

/** The auth instance (`createAuth()`), as the login/renewal blocks consume it. */
export interface AuthLike {
  login(credentials: { username: string; password: string }, options?: { onTrace?: unknown }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    [key: string]: unknown;
  }>;
  refresh(refreshToken: string, options?: unknown): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    [key: string]: unknown;
  }>;
}

/**
 * The read side of the store context — everything the four blocks may reach.
 *
 * Declared for the same reason as {@link TokenStoreState}: the inferred literal
 * left `credentials` typed as its `null` default and `backend` as a function
 * over `unknown`, which is what pushed `never` into the blocks downstream.
 */
/** 账号清单存储（方案 C：插件状态文件自持，见 accounts.ts）。 */
export interface AccountsStore {
  read(): Promise<unknown>;
  write(accounts: unknown): Promise<void>;
}

export interface StoreContextWiring {
  credentials?: unknown;
  auth: AuthLike;
  env: Record<string, string | undefined>;
  skewMs: number;
  throttleStore: ThrottleStore;
  now: () => number;
  onTrace?: (hops: unknown[], error: unknown) => void;
  credentialKey: (scope: string, id: string) => string;
  key: string;
  THROTTLE_KEY: string;
  backend: () => CredentialBackend;
  ephemeral: () => boolean;
  /** 账号清单存储；缺省（旧接线/测试未注）= 清单功能降级为空。 */
  accountsStore?: AccountsStore;
}

/** Refresh this long before the stored expiry, so a request never races the token's death. */
const DEFAULT_SKEW_MS = 120_000;

/** The stored grant shape `grant.ts` parses and `acquire` carries. */
export interface StoredGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

/**
 * The refusal a throttle stands for (`throttle.ts` owns the semantics).
 *
 * `until` is `null` for a parked (credential-shaped) refusal: it has no
 * deadline, so there is nothing to count down.
 */
export interface HeldThrottle {
  /** 这个冷却属于哪个账号（2026-10-29 多账号：park 按用户名分钥）。 */
  username: string;
  code: string;
  parked: boolean;
  until: number | null;
  attempt: number;
}

/**
 * The five mutable fields the four blocks share (see the module doc above).
 *
 * Declared rather than inferred (docs/IMPROVEMENTS.md §8): under
 * strictNullChecks a bare object literal pins each field to its INITIALIZER's
 * type, so `cached: null` became the type `null` and `rejected: new Set()`
 * became `Set<never>` — every reader downstream then saw `never`. The runtime
 * values are unchanged; only the declaration is now explicit.
 */
export interface TokenStoreState {
  /** In-memory token for this process; the record is the durable truth. */
  cached: StoredGrant | null;
  /** Tokens the console has already refused (never handed out again). */
  rejected: Set<string>;
  /** One in-flight acquisition, so N concurrent polls share one login. */
  inflight: Promise<string> | null;
  /** One in-flight manual sign-in (`saveAccount`), so a submit race or a
   *  submit overlapping the poll loop does not fire a SECOND sign-in at the
   *  platform — two at once is the lockout the throttle exists to prevent. */
  saveInflight: Promise<void> | null;
  /** Last failure, surfaced to the panel instead of a bare "not configured". */
  lastError: unknown;
}

/**
 * Build one store instance's wiring + state.
 *
 * Resolves the throttle store, builds the in-memory vault, the service
 * resolver, the backend and the ephemeral check, and the key pair. The
 * defaults and their comments live here; `token-store.ts` still documents the
 * OPTIONS (they are the public face of the factory).
 *
 * @param {object} options - the same options object `createTokenStore` takes.
 * @returns {{wiring: object, state: object}}
 */
export function createStoreContext({
  credentials,
  auth = createAuth(),
  env = process.env,
  skewMs = DEFAULT_SKEW_MS,
  throttleStore: injectedThrottleStore,
  accountsStore,
  now = Date.now,
  onTrace,
  credentialKey
}: {
  credentials?: unknown;
  auth?: AuthLike;
  env?: Record<string, string | undefined>;
  skewMs?: number;
  throttleStore?: ThrottleStore;
  accountsStore?: AccountsStore;
  now?: () => number;
  onTrace?: (hops: unknown[], error: unknown) => void;
  credentialKey: (scope: string, id: string) => string;
}): { wiring: StoreContextWiring; state: TokenStoreState } {
  const key = credentialKey(RECORD_SCOPE, RECORD_ID);
  const THROTTLE_KEY = credentialKey(RECORD_SCOPE, THROTTLE_ID);
  // Resolved here rather than as a parameter default, for two reasons.
  //
  // It has to judge its window with the clock the rest of the store uses: a
  // store given an injected clock and a throttle reading the real one would
  // disagree about whether a wait is over, which is invisible in production
  // and fatal in a test that crosses the window deliberately.
  //
  /**
   * The in-memory fallback used while no credentials service is reachable. A
   * Host without the service still gets a working panel: the account and grant
   * live here, which is exactly as private as the real store and simply does
   * not outlive the process.
   */
  const memory = {
    records: new Map(),
    account: new Map(),
    async readRecord(k: string) { return this.records.get(k); },
    async modifyRecord(k: string, mutate: (current: unknown) => unknown) {
      const next = await mutate(this.records.get(k));
      if (next === undefined) return this.records.get(k);
      this.records.set(k, next);
      return next;
    },
    // Keyed, because the throttle is a second record: clearing one throttle
    // must not take a stored grant with it.
    async deleteRecord(k: string) { this.records.delete(k); },
    async resolve(ref: string) {
      const value = this.account.get(ref);
      return typeof value === "string" && value !== "" ? { value, source: "memory" } : undefined;
    },
    async set(ref: string, value: string) { this.account.set(ref, value); },
    async unset(ref: string) { this.account.delete(ref); }
  };
  // Resolved on EVERY use, not once at mount (the idiom lives in
  // `credentials-service.ts`): the service may register after this plugin
  // loads, and a flag frozen at mount would then claim "no credentials service"
  // forever while the store quietly exists on disk.
  /** The live backend: the real service when attached, else the in-memory vault. */
  const backend = () => resolveCredentialsService(credentials) ?? memory;
  // 节流存储缺省 = 内存版（上面的注释：测试套件各案例隔离）；注入缺席时保护
  // 也不能缺席——进程内锁死防护照常。跨进程共享由 index.ts 显式注入文件版，
  // 那里才是「默认错误」的注释所指。
  const throttle = injectedThrottleStore ?? createMemoryThrottleStore(now);
  /** True while nothing written through the store would survive a restart. */
  const ephemeral = () => isEphemeral(credentials);

  const wiring: StoreContextWiring = {
    credentials,
    auth,
    env,
    skewMs,
    throttleStore: throttle,
    now,
    ...(onTrace !== undefined ? { onTrace } : {}),
    credentialKey,
    key,
    THROTTLE_KEY,
    backend,
    ephemeral,
    ...(accountsStore !== undefined ? { accountsStore } : {})
  };

  const state: TokenStoreState = {
    /** In-memory token for this process; the record is the durable truth. */
    cached: null,
    /**
     * Tokens the console has already rejected.
     *
     * A 401 does not prove the token expired — it proves the console refused it —
     * so a rejected token must never be handed out again even while its `exp`
     * still looks valid. Without this the store would re-read the same record
     * and replay the token the console just refused.
     */
    rejected: new Set(),
    /** One in-flight acquisition, so N concurrent polls share one login. */
    inflight: null,
    /** One in-flight manual sign-in (`saveAccount`), de-duplicated separately
     *  from `inflight` because its result is `void`, not the token `getToken`
     *  reuses. See the field's comment. */
    saveInflight: null,
    /** Last failure, surfaced to the panel instead of a bare "not configured". */
    lastError: null,
  };

  return { wiring, state };
}
