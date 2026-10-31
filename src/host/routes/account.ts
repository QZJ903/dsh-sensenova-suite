/**
 * The account route — the panel configures itself without editing `.env`.
 *
 * Part of the routes split (see `../routes.ts` for the family map). One GET
 * answer (stored-state), POST = sign in / switch / remove: the form never
 * learns the password, and a rejected sign-in reports the platform's own
 * words plus the sanitized trace file. （`forget` 分支已随清除按钮退役——
 * 2026-10-29：多账号下移除走 switch/remove，身份清除会废掉 vault 自动重登。）
 *
 * @module dsh-sensenova-suite/routes/account
 */
import { name } from "../host-config.ts";
import { CODE } from "../codes.ts";
import { writeLoginTrace } from "../trace.ts";
import { str, optional } from "../util.ts";
import { clearCoalescedFetch } from "../coalesced-fetch.ts";
import { writeJson, refuseMethod, readJsonBodyOr400, withOrigin, redactedError } from "./http.ts";
import type { PluginError, Wiring } from "../types.ts";

/** The account route: the panel configures itself without editing `.env`. */
export const ACCOUNT_PATH = `/api/${name}/account`;

/**
 * Register the account route. Wiring subset: `settings`, `tokenStore`,
 * `cache`, `inflight`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Pick<Wiring, "settings" | "tokenStore" | "cache" | "inflight">} wiring
 *   - the subset this route reads, as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerAccountRoute(ctx: any, wiring: Pick<Wiring, "settings" | "tokenStore" | "cache" | "inflight">) {
  const { settings, tokenStore, cache, inflight } = wiring;

  /** 登录类失败的上屏（saveAccount 与 switchAccount 共用一条报告路径，防双抄漂移）。 */
  const reportAuthFailure = async (response: any, e: unknown): Promise<void> => {
    const error = e as Partial<PluginError>;
    const traceFile = await writeLoginTrace(error?.trace, str(error?.code, CODE.AUTH_ERROR));
    writeJson(response, 200, {
      ...(await optional(tokenStore.state())),
      ok: false,
      code: str(error?.code, CODE.AUTH_ERROR),
      error: redactedError(error),
      // The platform's own words ride along so the panel can show them
      // beneath the classified line.
      ...(error?.detail === undefined ? {} : { detail: String(error.detail) }),
      // The sanitized hop-by-hop record of this attempt: the panel links
      // to it, and a support question becomes answerable.
      ...(traceFile !== null ? { traceFile } : {}),
      // When the platform names a wait, the panel greys the form out for
      // that long: retrying inside the window is what extends a lockout.
      ...(typeof error?.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {})
    }, { "cache-control": "no-store" });
  };

  return ctx.webServer.register({
    kind: "exact",
    path: ACCOUNT_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // The same fence as the snapshot route: without it, any page the
      // browser visits could post an account into this panel.
      const method = request.method === undefined ? "POST" : request.method;
      if (method === "GET") {
        // The form needs to know whether an account is already stored, and
        // must never be told the password.
        writeJson(response, 200, { ok: true, ...(await tokenStore.state()) }, { "cache-control": "no-store" });
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // 一键切换（2026-10-29 方案 C）：把目标槽的 grant 装上活动槽并当场要一次
      // 令牌——成败在这次 POST 里给答案（冷账号的死令牌会用存档密码自动重登）。
      if (body.value.action === "switch" && typeof body.value.id === "string") {
        try {
          await tokenStore.switchAccount(body.value.id);
        } catch (e) {
          // 切换失败保持已生效（用户可再切走）；失败原因按登录类上屏。
          // U5 顺带 2：快照路径失败时身份/grant 已可能换人——上一账号的
          // 缓存响应不得越界存活，与成功路径同一条纪律（否则 ≤cacheSeconds
          // 窗口内面板把旧号的额度/目录挂在可能是新号的会话上）。
          clearCoalescedFetch(cache, inflight);
          await reportAuthFailure(response, e);
          return;
        }
        // 新账号的额度/目录从下一次拉取开始：上一账号的缓存响应不得越界存活。
        clearCoalescedFetch(cache, inflight);
        writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
        return;
      }
      // 移除存档：只删侧槽（密码+令牌快照），活动会话不动。
      if (body.value.action === "remove" && typeof body.value.id === "string") {
        await tokenStore.removeAccount(body.value.id);
        clearCoalescedFetch(cache, inflight);
        writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
        return;
      }
      try {
        // mode=add（2026-10-30 拍板「验证但不接管」；本注释 2026-10-31 修正——
        // 旧文「不验证不登录」描述的是 0.1.29 形状，与 store 实现和 account-vault
        // 套件的钉相反）：提交 mode=add 时登录一次只为**验证凭据**并落令牌快照，
        // 错密码当场红字报平台原话、不落清单、该号进冷却；活动槽/身份/当前会话
        // 全不动。无账号（或未带 mode）= 登录并接管。
        const mode = body.value.mode === "add" ? "add" : "login";
        await tokenStore.saveAccount(
          { username: body.value.username, password: body.value.password },
          { activate: mode !== "add" }
        );
        // The success trace is persisted through `onTrace`; no path is owed
        // to the panel for a sign-in that worked.
      } catch (e) {
        // A rejected password is the common case, and it is the user's to
        // correct: report the reason and leave the panel usable.
        await reportAuthFailure(response, e);
        return;
      }
      // The grant that just landed answers the very next poll, so the cached
      // console responses from the previous account must not survive it.
      // Generation-bumping clear — see the note on the forget branch above.
      clearCoalescedFetch(cache, inflight);
      writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
    }, settings.allowedHosts)
  });
}
