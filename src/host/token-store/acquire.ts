/**
 * The single seam where the four blocks meet: `acquire()`.
 *
 * Order of operations (frozen by the behavior baseline, must NOT change):
 *   1. throttle gate — read the in-force refusal, fail fast if parked or in window
 *   2. grant freshness — read stored (or cached), return if fresh
 *   3. renewal — try the refresh token; on a rejected refresh, fork:
 *      - account still stored → fall through to login
 *      - no account → reap the dead grant and rethrow
 *   4. login fallback — log in with the stored/env account; on a new refusal,
 *      write the throttle (except `not_configured`, which records nothing)
 *
 * All block functions are injected by the caller so this module never imports
 * them directly (no circular dependency).
 *
 * @module dsh-sensenova-suite/token-store/acquire
 */

import { obj, pluginError } from "../util.ts";
import { CODE } from "../codes.ts";
import type { StoreContextWiring, TokenStoreState, StoredGrant, HeldThrottle } from "./state.ts";

/** The four block functions `acquire` needs, injected by the caller. */
export interface AcquireBlocks {
  readThrottle: (username: string) => Promise<HeldThrottle | null>;
  clearThrottle: (username: string) => Promise<void>;
  readStored: () => Promise<StoredGrant | undefined>;
  isFresh: (token: StoredGrant | null | undefined, at?: number) => boolean;
  renewWithRefresh: (stored: StoredGrant | undefined) => Promise<StoredGrant>;
  readAccount: () => Promise<{ username: string; password: string; source: string } | undefined>;
  loginFromAccount: (account: { username: string; password: string }) => Promise<StoredGrant>;
  /**
   * Remember a refusal FOR ONE ACCOUNT (多账号分钥). The caller's re-throw
   * carries the real message and no wait is recorded when the error carried
   * no code (see `writeThrottle`'s note).
   */
  writeThrottle: (username: string, error: unknown) => Promise<HeldThrottle | null>;
  throttleError: (held: HeldThrottle, cause?: Error) => Error;
  purgeGrant: (accessToken?: string) => Promise<void>;
}

/**
 * Acquire a usable token, logging in or refreshing as needed.
 *
 * @param {object} wiring - the store context wiring.
 * @param {object} state - the store context state.
 * @param {object} blocks - the four block functions, injected by the caller.
 * @returns {Promise<string>} the access token now in effect.
 */
export async function acquire(wiring: StoreContextWiring, state: TokenStoreState, blocks: AcquireBlocks): Promise<string> {
  const { now } = wiring;
  const {
    readThrottle, clearThrottle,
    readStored, isFresh,
    renewWithRefresh,
    readAccount, loginFromAccount,
    writeThrottle, throttleError, purgeGrant
  } = blocks;

  const stored: StoredGrant | null | undefined = (await readStored()) ?? state.cached ?? undefined;
  // `isFresh` is declared boolean (not a type predicate) here on purpose: a
  // stale grant IS still a StoredGrant, so the predicate's false-branch
  // narrowing would wrongly exclude it. The explicit null/undefined checks do
  // the narrowing the code actually relies on.
  if (stored !== null && stored !== undefined && isFresh(stored)) {
    state.cached = stored;
    return stored.accessToken;
  }
  // Prefer renewal: it needs no password, and the password may have been
  // removed from the environment long after the first login. Renewal is NOT
  // gated by the login throttle: a park means "the password is wrong", and a
  // refresh attempt risks no lockout（多账号分钥后更是——B 的 park 不该拦 A 的续期）.
  if (stored !== null && stored !== undefined && stored.refreshToken !== "") {
    try {
      const renewed = await renewWithRefresh(stored);
      return renewed.accessToken;
    } catch (error) {
      // A rejected refresh token (or a grant that never had one) is
      // unrecoverable without a password. When an account is still stored we
      // fall through and re-login; when there is none — typically right after
      // the account was removed, once the live token expires — the grant is
      // dead for good, so reap it instead of leaving an ownerless pair on
      // disk and re-hitting the dead refresh on every poll.
      if (obj(error).code !== CODE.REFRESH_REJECTED && obj(error).code !== CODE.NO_REFRESH_TOKEN) throw error;
      if ((await readAccount()) === undefined) {
        await purgeGrant(stored === null || stored === undefined ? undefined : stored.accessToken);
        throw error;
      }
    }
  }
  // Login fallback. 先解析账号，再查「这个账号」的冷却（多账号分钥）：B 的
  // parked 不拦 A 的重登；A 自己的 park 才拦 A。门只挡登录尝试——续期不受它管。
  const account = await readAccount();
  if (account === undefined) {
    throw pluginError(CODE.NOT_CONFIGURED, "no console account is configured");
  }
  const held = await readThrottle(account.username);
  if (held !== null && (held.parked || (held.until !== null && held.until > now()))) {
    throw throttleError(held);
  }
  try {
    const fresh = await loginFromAccount(account);
    // A sign-in that worked clears THIS account's earlier refusal: the wait
    // is over by the only evidence that matters, and the ladder starts over.
    // Other accounts' parks are untouched（分钥的本意）.
    await clearThrottle(account.username);
    return fresh.accessToken;
  } catch (error) {
    // No account is not a refusal and no request was made, so there is
    // nothing to throttle: recording one would claim the user did something
    // wrong and would keep a fresh install looking "needs user action".
    if (obj(error).code === CODE.NOT_CONFIGURED) throw error;
    // Otherwise record the refusal FOR THIS ACCOUNT so the next poll does not
    // walk into the lock again. The platform's own error is what the panel
    // shows; the throttle only governs when the next attempt may happen.
    await writeThrottle(account.username, error);
    throw error as Error;
  }
}