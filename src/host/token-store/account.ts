/**
 * Block 2 of the token-store split: the account lifecycle. Owns reading the
 * username/account, logging in, saving and forgetting the account, and the
 * one-time password sweep.
 *
 * No state of its own; operates on the shared context from `state.ts`.
 * `loginFromAccount` needs two grant-block operations (read the stored grant,
 * persist the new one); they are injected by the caller so this module never
 * imports `grant.ts` (no circular dependency).
 *
 * @module dsh-sensenova-suite/token-store/account
 */

import { CODE } from "../codes.ts";
import { vaultPasswordFor } from "./accounts.ts";
import { str, verbatim, pluginError } from "../util.ts";
import type { StoreContextWiring, TokenStoreState, StoredGrant } from "./state.ts";

/**
 * The reference form of a credential name.
 *
 * `@deepseek-ai/dsh-credentials` exports `credentialRef` for this, and the
 * values below are already in the form it produces — a bare variable name.
 * Spelled out here so the store's own test does not have to resolve a peer
 * package to exercise anything; the service treats a string and its branded
 * reference identically.
 * @param {string} name - the variable name.
 * @returns {string} the reference.
 */
const credentialRef = (name: string) => name;

// 身份/密码的 ref 名上移到 constants.ts（多账号侧槽要引用，斩断循环 import）；
// 本块自用 + 原地 re-export 保持既有 import 路径。密码落盘策略已随方案 C 反转。
import { USERNAME_REF } from "./constants.ts";
export { USERNAME_REF };

/**
 * The account's identity: the stored username, with the environment as a
 * fallback. Kept apart from the password because only the username is ever
 * persisted — `state()` asks "is there an account to clear?" without
 * requiring a password to be available.
 * @returns {Promise<string>} the username, or `""` when none is known.
 */
export async function readUsername(wiring: StoreContextWiring, _state: TokenStoreState): Promise<string> {
  const { backend, env } = wiring;
  const fromStore = async (ref: string) => {
    // `resolve` is per-call by contract: a value written a moment ago is
    // visible to the next read, with no restart in between.
    const resolved = await backend().resolve(credentialRef(ref)).catch(() => undefined);
    return verbatim(resolved?.value, "");
  };
  return str(await fromStore(USERNAME_REF), "") || str(env[USERNAME_REF], "");
}

/**
 * The account to log in with: the stored (or environment) username and the
 * vault password (multi-account list, plan C — the env password channel is
 * retired: a single env slot cannot serve a multi-account vault).
 * @returns {Promise<{username: string, password: string, source: string}|undefined>}
 */
export async function readAccount(wiring: StoreContextWiring, state: TokenStoreState): Promise<{ username: string; password: string; source: string } | undefined> {
  const username = await readUsername(wiring, state);
  if (username === "") return undefined;
  // 重登密码只来自账号清单（2026-10-29 方案 C；env 密码通道同日退役——清单
  // 天生落盘多账号密码，env 单槽无存在价值）。清单没有 = 面板再要账号。
  const password = await vaultPasswordFor(wiring, username);
  if (password !== "") return { username, password, source: "vault" };
  return undefined;
}

/**
 * Log in with an account and return a self-renewing grant.
 *
 * The account is taken EXPLICITLY when the caller just typed it (the panel
 * save path: the password lives in that call's closure and is written to
 * the account list on success), and read back from the account list
 * otherwise (the auto-recovery path after a dead refresh token — plan C).
 *
 * The grant read BEFORE the sign-in is named as the one this login
 * supersedes. It has to be read first: the token pair only arrives after the
 * network walk, and naming nothing is what let a still-fresh grant from a
 * DIFFERENT account silently survive a deliberate switch — the panel said
 * "signed in" while keeping serving the previous account. Naming the read
 * grant turns the write into the same compare-and-set a refresh uses: an
 * intentional switch wins, a login racing another process's rotation defers.
 * @param {{username: string, password: string}|undefined} explicit - an account
 *   supplied by the caller (never persisted); positionally required, though
 *   `undefined` is tolerated and falls back to `readAccount`.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
 */
export async function loginFromAccount(
  wiring: StoreContextWiring,
  state: TokenStoreState,
  explicit: { username: string; password: string } | undefined,
  readStored: () => Promise<StoredGrant | undefined>,
  store: (accessToken: string, refreshToken: string, expiresIn: number, replacing?: string) => Promise<StoredGrant>
): Promise<StoredGrant> {
  const { auth, onTrace } = wiring;
  const account = explicit ?? await readAccount(wiring, state);
  if (account === undefined) {
    throw pluginError(CODE.NOT_CONFIGURED, "no console account is configured");
  }
  const previous = await readStored();
  const result = await auth.login({ username: account.username, password: account.password }, { onTrace });
  return store(result.accessToken, result.refreshToken, result.expiresIn, previous?.accessToken);
}

/**
 * Forget the stored account.
 *
 * The grant is left alone at first: the panel keeps working on the refresh
 * token until that runs out, and only then asks for the account again. With
 * no account left to recover a dead refresh token, `acquire` also reaps the
 * expired grant then, so nothing ownerless is left behind.
 * @returns {Promise<void>}
 */
export async function forgetAccount(wiring: StoreContextWiring, state: TokenStoreState): Promise<void> {
  const { backend } = wiring;
  await backend().unset(credentialRef(USERNAME_REF));
  state.cached = null;
}
