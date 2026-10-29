/**
 * SenseNova console token store — the seam between the credentials service and
 * the panel's console calls.
 *
 * The console JWT lives 180 minutes; this store keeps it renewed, so the
 * panel never needs the pre-store ritual of copying a fresh token out of
 * devtools into `$DSH_HOME/.env` and restarting.
 *
 * How it works:
 *
 * - The grant lives in `ctx.credentials` as a `grant` record, never on disk in
 *   this plugin and never in the environment. Writing goes through
 *   `modifyRecord`, the service's serialized read-modify-write path, so two
 *   Host processes rotating the same refresh token cannot lose one another's
 *   write.
 * - `getToken()` returns a token that is valid for at least
 *   `skewMs`, renewing through `refresh_token` when the stored one is close to
 *   expiry. Hydra rotates refresh tokens, so every renewal also replaces the
 *   stored refresh token.
 * - `invalidate()` drops the in-memory token after a 401 so the next call
 *   renews once rather than looping on a token the console already rejected.
 *
 * Sign-in is throttled, never retried on a poll timer. The platform locks an
 * account after a few bad attempts, so an automatic retry turns one mistake
 * into a lockout. Two kinds of refusal are treated differently:
 *
 * - A time-shaped one (locked, rate-limited, a platform fault) waits out a
 *   backoff — the platform's own window when it states one, otherwise a local
 *   one that doubles per attempt up to half an hour. The throttle is persisted,
 *   so a second Host process does not keep knocking during the wait.
 * - A credential-shaped one (wrong password, a captcha the user must clear) is
 *   parked outright: waiting cannot fix it, so the panel asks for the account
 *   again and only an explicit resubmit retries. This is what stops a panel
 *   left open overnight from spending an attempt every minute on a password
 *   nobody has corrected.
 *
 * Account login happens through the panel (or, historically, an env
 * bootstrap whose password channel is retired on 2026-10-29 — plan C stores
 * every account's password in the multi-account vault, so a dead refresh
 * token re-signs in from the vault without anyone typing anything).
 *
 * Structure: this file is the FACADE — `createTokenStore` builds the shared
 * context via `createStoreContext` (`./token-store/state.ts`) and delegates to
 * the four extracted blocks (grant / account / renewal / throttle, in
 * `./token-store/{grant,account,renewal,throttle}.ts`) plus the acquire seam
 * (`./token-store/acquire.ts`). Public API and export surface are unchanged.
 * The split doc is `docs/TOKEN-STORE-SPLIT.md`.
 *
 * @module dsh-sensenova-suite/token-store
 */

import { CODE } from "./codes.ts";
import { str, obj, num, verbatim, pluginError } from "./util.ts";
import { name as RECORD_SCOPE } from "./host-config.ts";
import { createStoreContext } from "./token-store/state.ts";
import { RECORD_ID, THROTTLE_ID } from "./token-store/constants.ts";
import type { AuthLike, ThrottleStore, StoredGrant } from "./token-store/state.ts";
import {
  readStored as readStoredImpl,
  storeGrant,
  grantEnvelope,
  purgeGrant as purgeGrantImpl,
  isFresh as isFreshImpl
} from "./token-store/grant.ts";
import {
  throttleError as throttleErrorImpl,
  readThrottle as readThrottleImpl,
  writeThrottle as writeThrottleImpl,
  clearThrottle as clearThrottleImpl,
  inForceWaitMs as inForceWaitMsImpl,
  DEFAULT_LOGIN_BACKOFF_MS,
  MAX_LOGIN_BACKOFF_MS
} from "./token-store/throttle.ts";
import {
  readUsername as readUsernameImpl,
  readAccount as readAccountImpl,
  loginFromAccount as loginFromAccountImpl,
  forgetAccount as forgetAccountImpl,
  USERNAME_REF
} from "./token-store/account.ts";
import { renewWithRefresh as renewWithRefreshImpl } from "./token-store/renewal.ts";
import {
  listAccountViews,
  listVaultEntries,
  readVaultEntry,
  writeVaultEntries,
  removeAccountRecord,
  upsertAccount,
  vaultPasswordFor
} from "./token-store/accounts.ts";
import { acquire as acquireImpl } from "./token-store/acquire.ts";

/**
 * The reference form of a credential name.
 *
 * `@deepseek-ai/dsh-credentials` exports `credentialRef` for this, and the
 * values below are already in the form it produces — a bare variable name.
 * Spelled out here so the store's own test does not have to resolve a peer
 * package to exercise anything; the service treats a string and its branded
 * reference identically, which check 14 pins down.
 * @param {string} name - the variable name.
 * @returns {string} the reference.
 */
const credentialRef = (name: string) => name;

/**
 * Build the token store.
 *
 * @param {object} options - wiring.
 * @param {object|null} options.credentials - the `ctx.credentials` service, or
 *   `null` when the Host has none. A missing service must not disable the
 *   panel: everything falls back to this process's memory, so the account form
 *   still works and the token renews for as long as the Host lives. Only a
 *   restart then asks again.
 * @param {object} [options.auth] - a `createAuth()` instance; defaults to one
 *   built on the platform defaults. The Host passes its configured instance so
 *   the login flow and token refresh target the operator's endpoints, not the
 *   shipped ones.
 * @param {Function} options.credentialKey - the service's key factory, so the
 *   branded key is built by the service that owns the type.
 * @param {object} [options.env] - environment source (defaults to
 *   `process.env`); injected by the tests.
 * @param {number} [options.skewMs] - renew this long before expiry.
 * @param {object} [options.throttleStore] - where sign-in refusals are
 *   remembered; defaults to this plugin's own file, which is what lets one
 *   Host process see a lock another is waiting out. Injected by the tests.
 * @param {() => number} [options.now] - clock source; injected by the tests so
 *   a backoff window can be crossed deliberately instead of by waiting.
 * @param {function(?object[], ?(Error & {code?: unknown})): void} [options.onTrace] - called with
 *   the sanitized hop list when a sign-in attempt ENDS, success or failure;
 *   the second argument is `null` on success and the thrown error otherwise
 *   (matching the contract `sensenova-auth.ts` uses).
 * @returns the store: `getToken`, `invalidate`, `saveAccount`,
 *   `forgetAccount`, and `state`.
 */
export function createTokenStore(options: {
  credentials?: unknown;
  auth?: AuthLike;
  env?: Record<string, string | undefined>;
  skewMs?: number;
  throttleStore?: ThrottleStore;
  /** 账号清单存储（方案 C，插件状态文件自持）；缺省 = 清单功能降级为空。 */
  accountsStore?: import("./token-store/state.ts").AccountsStore;
  now?: () => number;
  onTrace?: (hops: unknown[], error: unknown) => void;
  credentialKey: (scope: string, id: string) => string;
}) {
  const { wiring, state } = createStoreContext(options);
  const { backend, ephemeral } = wiring;
  const { rejected } = state;

  /** One-line delegations to the extracted blocks. */
  const readStored = () => readStoredImpl(wiring);
  const store = (accessToken: string, refreshToken: string, expiresAt: number, replacing?: string) => storeGrant(wiring, state, accessToken, refreshToken, expiresAt, replacing);
  const purgeGrant = (accessToken?: string) => purgeGrantImpl(wiring, state, accessToken);
  const isFresh = (token: StoredGrant | null | undefined, at?: number) => isFreshImpl(wiring, state, token, at);
  const readThrottle = (username: string) => readThrottleImpl(wiring, username);
  const clearThrottle = (username: string) => clearThrottleImpl(wiring, username);
  const writeThrottle = (username: string, error: unknown) => writeThrottleImpl(wiring, username, error);
  const throttleError = (held: import("./token-store/state.ts").HeldThrottle, cause?: Error) => throttleErrorImpl(held, cause);
  const inForceWaitMs = (held: import("./token-store/state.ts").HeldThrottle | null) => inForceWaitMsImpl(wiring, held);
  const readUsername = () => readUsernameImpl(wiring, state);
  const readAccount = () => readAccountImpl(wiring, state);
  const loginFromAccount = (explicit?: { username: string; password: string }) => loginFromAccountImpl(wiring, state, explicit, readStored, store);
  /** 多账号侧槽（2026-10-29 方案 C）：清单/落槽/切换/移除，一行委托同其余块。 */
  const listAccounts = async () => listAccountViews(wiring, await readUsername());
  const renewWithRefresh = (stored: StoredGrant | undefined) => renewWithRefreshImpl(wiring, state, stored, store);
  const acquire = () => acquireImpl(wiring, state, {
    readThrottle, clearThrottle,
    readStored, isFresh,
    renewWithRefresh,
    readAccount, loginFromAccount,
    writeThrottle, throttleError, purgeGrant
  });

  return {
    /**
     * A console access token that should not be rejected for expiry.
     * @returns {Promise<string>}
     */
    async getToken() {
      if (isFresh(state.cached)) return state.cached.accessToken;
      // A manual sign-in in flight (`saveAccount`) may be refreshing the grant
      // this call wants — wait for it instead of starting a SECOND sign-in,
      // which is the lockout the throttle exists to prevent. Its failure is its
      // own; if it rejected, fall through to acquire and report what that finds.
      if (state.saveInflight !== null) {
        try { await state.saveInflight; } catch { /* proceed to acquire */ }
      }
      // One acquisition in flight: a panel poll storm must not trigger a
      // login stampede or a burst of refresh-token rotations.
      state.inflight ??= acquire()
        .then((token) => {
          state.lastError = null;
          return token;
        })
        .catch((error) => {
          state.lastError = error;
          throw error;
        })
        .finally(() => {
          state.inflight = null;
        });
      return state.inflight;
    },

    /**
     * Forget the token the console just rejected, so the next call renews
     * exactly once instead of replaying a token the server already refused.
     * @param {string} [token] - the token that was refused; defaults to the
     *   cached one.
     */
    invalidate(token?: string) {
      const refused = verbatim(token, state.cached?.accessToken ?? "");
      if (refused !== "") {
        rejected.add(refused);
        // Bounded: only the most recent refusals can still be in play, since a
        // token that was superseded is never handed out again.
        while (rejected.size > 8) rejected.delete(rejected.values().next().value ?? "");
      }
      state.cached = null;
    },

    /**
     * Store a console account, then log in with it.
     *
     * This is what the panel's setup form calls. Only the USERNAME goes to
     * `ctx.credentials` (owner-only on disk, never in this plugin's own
     * files); the password stays in this call's closure and is gone when the
     * attempt ends. The resulting grant is what keeps the panel alive
     * afterwards, so a rejected password leaves nothing secret at rest.
     * @param {{username: string, password: string}} account - the credentials.
     * @returns {Promise<void>}
     */
    async saveAccount(account: { username: string; password: string }, opts?: { activate?: boolean }) {
      const username = str(account?.username, "");
      const password = verbatim(account?.password, "");
      const activate = opts?.activate !== false;
      if (username === "" || password.trim() === "") {
        throw pluginError(CODE.MISSING_CREDENTIALS, "a username and a password are both required");
      }

      if (activate) {
        // Persist first, then log in: if the write is rejected (a read-only
        // environment shadows the reference) the user is told before any login
        // attempt, instead of being left with a token that dies at restart.
        await backend().set(credentialRef(USERNAME_REF), username);
        // The password may differ from the one that produced the current grant.
        state.cached = null;
      }
      rejected.clear();
      // A deliberate resubmit is the user acting on what the panel told them,
      // so it clears THIS account's throttle — otherwise a corrected password
      // would be refused by this store's own timer. It is the ONE path that
      // does: every automatic route into `acquire` is still blocked, and
      // other accounts' parks are untouched（分钥的本意）.
      await clearThrottle(username);
      // De-dupe with any sign-in the poll loop has already started (the
      // `inflight` `getToken` set): two sign-ins at once is the lockout the
      // throttle exists to prevent, and a manual submit must not run alongside
      // an in-flight refresh. Reuse the one in flight instead of a second.
      // (A concurrent submit is caught by `saveInflight` below.)
      if (state.inflight !== null) {
        try { await state.inflight; } catch { /* its outcome is separate; we still sign in with the new account */ }
      }
      // One manual sign-in in flight: a double-submit (or this submit racing a
      // prior one still settling) reuses the one in flight rather than firing
      // a second login at the platform. The first to land wins the slot; the
      // others await it — so the panel shows one "signing in…", never a stampede.
      state.saveInflight ??= (async () => {
        try {
          if (!activate) {
            // 添加模式（2026-10-29 方案 A 定稿）：登录一次只为**验证凭据**——
            // 打错的密码当场红字报平台原话，坏条目不进清单。验证拿到的令牌快照
            // 随条目落清单（之后切到它多半秒切），**活动槽/身份/内存令牌一概
            // 不动**（密码登录开新会话，不轮换当前号的刷新令牌，会话无损）。
            const { auth: authApi, onTrace: trace, now: clock } = wiring;
            const result = await authApi.login({ username, password }, { onTrace: trace });
            await upsertAccount(wiring, {
              username,
              password,
              grant: {
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                expiresAt: clock() + num(result.expiresIn, 10800) * 1000
              }
            });
            state.lastError = null;
            return;
          }
          // The typed account is handed over directly: the password lives only
          // in this closure, so the env-based `readAccount` must not be asked
          // for it here.
          await loginFromAccount({ username, password });
          // A successful manual sign-in supersedes whatever failure the panel
          // last saw. `state.lastError` is otherwise cleared only inside
          // `acquire`'s success path — which never runs while the fresh grant
          // short-circuits `getToken` — so without this line an old
          // `login_rejected` would keep the header claiming "needs login" long
          // after the account works.
          state.lastError = null;
          // 方案 C：登录成功即把 {username, password, grant 快照} 落进侧槽——
          // 这是「一键切换」的本体（readAccount 的 vault 回退从这里拿密码重登）。
          // 密码落盘是用户拍板：sk- key 与活动 grant 本就明文同住凭据文档，密码同级。
          const storedGrant = await readStored();
          if (storedGrant === undefined) {
            throw new Error("login succeeded but no grant could be read back; the side slot was not written");
          }
          await upsertAccount(wiring, { username, password, grant: storedGrant });
        } catch (error) {
          // A deliberate submit is the one path allowed to spend an attempt, but
          // a REFUSED one must still be recorded. This call's caller reads
          // `state()` the moment it rejects, and with no throttle on record the
          // panel reports "no wait, nothing for the user to do" — so the next
          // poll walks straight into another attempt with the same bad password,
          // which is exactly what the park exists to prevent.
          // 登录模式的拒绝记在「正在登录的这个号」名下（多账号分钥）。
          if (obj(error).code !== CODE.NOT_CONFIGURED) await writeThrottle(username, error);
          throw error;
        }
      })();
      try {
        await state.saveInflight;
      } finally {
        state.saveInflight = null;
      }
    },

    /**
     * Forget the stored account.
     *
     * The grant is left alone at first: the panel keeps working on the refresh
     * token until that runs out, and only then asks for the account again. With
     * no account left to recover a dead refresh token, `acquire` also reaps the
     * expired grant then, so nothing ownerless is left behind.
     * @returns {Promise<void>}
     */
    async forgetAccount() {
      const result = await forgetAccountImpl(wiring, state);
      // Clearing the account supersedes any earlier login failure: the grant
      // (or its absence) is what the panel should read, not an old error.
      state.lastError = null;
      return result;
    },

    /**
     * 已存账号清单（无密码）：槽号/用户名/是否有令牌快照/是否当前。
     * 面板账号卡的列表与切换按钮的数据源。
     */
    async listAccounts() {
      return listAccounts();
    },

    /**
     * 一键切换账号（方案 C）：当前 grant 快照回写它的槽 → 目标槽 grant 装上
     * 活动槽 → USERNAME_REF 换人 → 内存作废 → **当场要一次令牌**。冷账号的
     * 刷新令牌多半已死，级联（refresh 失败 → invalidate → acquire）会用槽里
     * 的存档密码自动重登——切换的成败在这一个调用里给答案，失败原样抛出
     * （路由带 code/retryAfterMs/trace 上屏），切换本身保持生效（可再切走）。
     */
    async switchAccount(id: string) {
      // 与在途登录/续期互斥（同 getToken/saveAccount 的纪律）：等它们落定再动记录，
      // 否则切换与轮换交叉读写同一份 grant。它们的失败与切换无关，吞掉。
      if (state.saveInflight !== null) {
        try { await state.saveInflight; } catch { /* proceed with the switch */ }
      }
      if (state.inflight !== null) {
        try { await state.inflight; } catch { /* proceed with the switch */ }
      }
      const target = await readVaultEntry(wiring, str(id, "").trim());
      if (target === undefined) {
        throw pluginError(CODE.NOT_CONFIGURED, "no stored account with that username");
      }
      const currentUsername = await readUsername();
      const currentGrant = await readStored();
      // 旧会话回写它的清单条目（快照保命）：切失败时靠它一键切回。
      const accounts = await listVaultEntries(wiring);
      if (currentUsername !== "" && currentGrant !== undefined && currentUsername !== target.username) {
        const mine = accounts.find((entry) => entry.username === currentUsername);
        if (mine !== undefined) mine.grant = currentGrant;
        else accounts.push({ username: currentUsername, password: "", grant: currentGrant });
      }
      if (target.grant !== null) {
        // 快照路径：装上目标快照 → 身份换人 → 当场取令牌验货（快照死了会走
        // 存档密码重登；仍失败则 park 记在目标号名下，旧会话已回写可切回）。
        await wiring.backend().modifyRecord(wiring.key, () => grantEnvelope(target.grant as StoredGrant));
        await wiring.backend().set(USERNAME_REF, target.username);
        state.cached = null;
        state.lastError = null;
        await this.getToken();
      } else {
        // 无快照目标（理论不该有——添加模式已验证并落快照；防御路径）：
        // **先登录成功才动会话**——失败时旧令牌与身份原样保留（2026-10-30
        // 用户实测教训：先删后登会让人挂在新号的失败上，旧号被顶掉）。
        await loginFromAccountImpl(wiring, state, { username: target.username, password: target.password }, readStored, store);
        await wiring.backend().set(USERNAME_REF, target.username);
        state.lastError = null;
      }
      await writeVaultEntries(wiring, accounts);
    },

    /**
     * 移除一个存档账号。**移除的就是当前登录账号 = 退出登录语义**（2026-10-29
     * 用户拍板 B）：孤儿会话不允许存在——清单条目、活动令牌记录、身份引用一并
     * 清除，面板回到登录态；其余账号的存档不受影响。移除非当前号时活动会话不动。
     */
    async removeAccount(id: string) {
      await removeAccountRecord(wiring, id);
      const target = str(id, "").trim();
      if (target !== "" && target === await readUsername()) {
        await forgetAccountImpl(wiring, state); // 身份引用 + 内存令牌
        await purgeGrant();                      // 活动令牌记录（无参 = 无条件删）
      }
    },

    /**
     * A description of the store for the panel: whether a token is held, when
     * it expires, and the last failure. No secret is included.
     */
    async state() {
      const stored = await readStored();
      const account = await readAccount();
      // The stored USERNAME is the account's identity. The password is not
      // persisted (the environment is its only durable source), so whether an
      // account is present must not depend on a password being available —
      // otherwise the panel's "clear the saved account" affordance would
      // vanish the moment no vault password exists.
      const username = await readUsername();
      // 读当前活动账号的 park（多账号分钥）：面板显示的倒计时/需要改密码，
      // 都是「现在在台上的这个号」的账；切号后下一次快照自动跟人。
      const held = await readThrottle(username);
      return {
        // "configured" means the panel can get a token: either it already has
        // one, or an account is stored to obtain the next one.
        configured: stored !== undefined || account !== undefined,
        // 已存账号清单（方案 C，无密码）：账号卡的切换列表。每次 state() 现扫
        // 侧槽（≤5 次记录读，凭据服务本地文档，可忽略）。
        accounts: await listAccounts(),
        hasAccount: username !== "",
        // 当前活动账号在清单里是否有存档密码（2026-10-29 方案 C）：面板脚注
        // 三岔的判据——有 = 死令牌自动重登；无 = 令牌死了面板再要账号。
        vaultPasswordArmed: await vaultPasswordFor(wiring, username) !== "",
        hasRefreshToken: verbatim(stored?.refreshToken, "").trim() !== "",
        expiresAt: stored?.expiresAt ?? null,
        // Why the panel should ask for an account: nothing works yet.
        needsAccount: stored === undefined && account === undefined,
        // True when the Host has no credentials service, so the account lives
        // in this process only and must be re-entered after a restart.
        ephemeral: ephemeral(),
        // While a refused sign-in is still inside its wait, the panel shows a
        // countdown rather than inviting an immediate retry. `null` when
        // nothing is being waited out.
        retryAfterMs: inForceWaitMs(held),
        // A refusal the clock cannot fix — a wrong password, or a captcha the
        // user must clear. The panel says so instead of showing a countdown
        // that would tick down to another attempt that never happens.
        needsUserAction: held !== null && held.parked,
        error: state.lastError === null ? null : state.lastError instanceof Error ? state.lastError.message : String(state.lastError)
      };
    }
  };
}

export {
  RECORD_SCOPE,
  RECORD_ID,
  USERNAME_REF,
  THROTTLE_ID,
  DEFAULT_LOGIN_BACKOFF_MS,
  MAX_LOGIN_BACKOFF_MS
};
