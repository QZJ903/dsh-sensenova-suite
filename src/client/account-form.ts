/**
 * The setup form shown when no account is configured.
 *
 * This is the whole point of the account route: the user types a username
 * and a password once, and the Host signs in, stores the account in the
 * DSH credentials, and renews the token from then on. No `.env` editing,
 * no restart, and the password is never sent anywhere but this Host.
 *
 * `bare` strips the inner card and title: the account section card that
 * embeds this form (when a token already works) supplies both itself.
 *
 * Hook-based, so the Node render suite does not mount this form; its
 * secret-free halves are covered via `ProviderStatus` and the route tests.
 */
import { ACCOUNT_PATH, SENSENOVA_SIGNUP_URL } from "./const.ts";
import { format } from "./format.ts";
import { postJson } from "./http.ts";
import { clientModal, h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { REFUSAL_TEXT } from "./snapshot.ts";
import { platformDetail } from "./snapshot.ts";
import { S } from "./styles.ts";
import type { AuthData } from "./wire.ts";

export function AccountForm({ auth, onDone, tt, bare, snapshotAt }: {
  auth?: AuthData | null;
  onDone?: () => void;
  tt: Tt;
  bare?: boolean;
  /** Epoch millis of the last snapshot the parent read; 0 until one lands. */
  snapshotAt?: number;
}): unknown {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // The user must be able to see what they actually typed: a browser
  // autofill or an IME full-width character looks identical to a real
  // password behind the dots, and every failed guess burns a lockout
  // attempt on the platform.
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // The platform's own words for a classified refusal, shown beneath the
  // canned line: the canned text translates, the prose carries the lockout
  // policy and anything else the platform wanted to say.
  const [formDetail, setFormDetail] = useState<string | null>(null);
  // `saved` means a sign-in was stored. It is NOT a generic "the request
  // worked" flag (2026-10-29：清除账号按钮已退役——多账号下移除走清单行内
  // 「移除」，身份清除会废掉自动重登找清单的钥匙）。
  const [saved, setSaved] = useState(false);
  // `added` = 「添加账号」模式的成功横幅（不接管当前登录，措辞与登录分开）。
  const [added, setAdded] = useState(false);
  // When the LAST submit outcome was produced. The outcome note
  // ("已保存并登录，正在读取额度…") is a transient claim: it must land once
  // a snapshot AFTER it arrives. Without the marker, `saved` never resets
  // and the in-progress sentence hangs forever even though the quota is
  // already on screen above it.
  const outcomeAt = useRef(0);
  // Epoch millis until which the platform asked us not to retry. While
  // this is in the future the submit button stays disabled, because a
  // retry inside the window is what extends a lockout.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  // 平台的锁定窗口记在账号上（多账号：Qiubaba1 的 10 分钟不该禁「添加别的号」）。
  const [cooldownUser, setCooldownUser] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // One ticking clock drives the countdown; it stops when the wait ends.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= cooldownUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  // The outcome note lands when a snapshot AFTER it arrives. The parent
  // (PanelPage) stamps every successful snapshot read; once one is newer
  // than the last submit, the "正在读取额度…" claim has been superseded by
  // real data and must not hang around.
  useEffect(() => {
    if (typeof snapshotAt === "number" && snapshotAt > outcomeAt.current) {
      setSaved(false);
      setAdded(false);
    }
  }, [snapshotAt]);

  // 已存账号（2026-10-29 方案 C）：切换/移除。错误走同一条 formError；
  // 切到冷账号的登录失败会带平台原话与退避，与表单提交同一套处理。
  const accounts = Array.isArray(auth?.accounts) ? auth.accounts : [];
  // 两态表单（2026-10-29 用户拍板）：无账号 = 「登录」（连上该号）；有账号 =
  // 「添加账号」（只入清单，不验证不登录，当前登录保持不变）。
  const hasAccounts = accounts.length > 0;
  const [accountBusy, setAccountBusy] = useState<string | null>(null);
  // 切换/移除共用一条动作路径（busy/错误/成功刷新同源）——两份手抄会被
  // duplication-gate 抓，也会漂移。
  const accountAction = useCallback(async (payload: Record<string, unknown>, id: string) => {
    setAccountBusy(id);
    setFormError(null);
    setFormDetail(null);
    try {
      const body = await postJson(ACCOUNT_PATH, payload);
      if (body?.ok !== true) {
        setFormError(typeof body?.error === "string" ? body.error : tt("auth.network"));
        return;
      }
      onDone?.();
    } catch (caught) {
      setFormError(caught instanceof Error && caught.message !== "" ? caught.message : tt("auth.network"));
    } finally {
      setAccountBusy(null);
    }
  }, [onDone, tt]);
  const switchAccount = useCallback((id: string) => accountAction({ action: "switch", id }, id), [accountAction]);
  const removeAccount = useCallback((id: string) => accountAction({ action: "remove", id }, id), [accountAction]);
  // 移除二次确认（2026-10-29 用户拍板：与 key 管理同款——红字 + 宿主 Modal）。
  // 宿主 primitives 缺席（旧宿主模块表没有这个键）时回落原生 confirm；
  // 「破坏性动作必须二次确认」不随宿主版本打折。
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const requestRemove = useCallback((id: string) => {
    if (clientModal() === null) {
      if (globalThis.confirm(tt("auth.removeConfirm"))) void removeAccount(id);
      return;
    }
    setPendingRemove(id);
  }, [removeAccount, tt]);

  // 冷却只约束「被平台锁定的那个账号」：换一个号提交不受窗口牵连。
  const cooling = now < cooldownUntil && username.trim() === cooldownUser;
  const coolingMinutes = Math.max(1, Math.ceil((cooldownUntil - now) / 60_000));

  const setCooldown = useCallback((ms: number, username: string) => {
    setCooldownUntil(Date.now() + ms);
    setCooldownUser(username);
    setNow(Date.now());
  }, []);

  const submit = useCallback(async (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    // Refuse to fire inside the platform's own wait window (same account only).
    if (cooling) return;
    if (username.trim() === "" || password === "") {
      setFormError(tt("auth.empty"));
      return;
    }
    setBusy(true);
    setFormError(null);
    setFormDetail(null);
    try {
      const body = await postJson(ACCOUNT_PATH, { username: username.trim(), password, mode: hasAccounts ? "add" : "login" });
      if (body && body.ok === true) {
        // Clear BOTH fields the moment they are no longer needed: the
        // password lives on in the Host's credentials, and the username is
        // on screen in the 已存账号 list (2026-10-29 用户报：登录后只清了
        // 密码，用户名还挂在框里——多账号下它会被当成下一个新号继续填)。
        setUsername("");
        setPassword("");
        setSaved(true);
        setAdded(hasAccounts === true);
        // Stamp the outcome: the "正在读取额度…" note stays until a snapshot
        // newer than this lands (the parent's `snapshotAt` clears it).
        outcomeAt.current = Date.now();
        onDone?.();
        return;
      }
      const code = body?.code;
      // The Host's own backoff is authoritative: retrying inside it is what
      // turns a bad password into a locked account, so surface the wait
      // instead of a plain refusal.
      const waitMs = typeof body?.retryAfterMs === "number" ? body.retryAfterMs : null;
      if (waitMs !== null && waitMs > 0) {
        setCooldown(waitMs, username.trim());
        // The line comes from the table, not from a second copy of the two
        // codes: `account_locked` and `rate_limited` are already classified
        // there, and a code this branch compares inline could be renamed in
        // `codes.ts` while the table kept working — the check below reads the
        // table, so a literal here would have drifted out of its sight.
        setFormError(tt(REFUSAL_TEXT[typeof code === "string" ? code : ""] ?? "auth.rateLimited"));
        return;
      }
      // Only say "wrong password" when the platform said so. Every other
      // refusal gets its own line, and anything unrecognised shows the
      // platform's own words rather than a guess. A missing `code` is by
      // definition not a known refusal — the old `REFUSAL_TEXT[undefined]`
      // read missed and fell through to the same lines the guard takes now.
      if (typeof code === "string" && typeof REFUSAL_TEXT[code] === "string") {
        // The dictionary key is the decision, never the wire code: comparing a
        // code inline was a third home for the taxonomy, outside these tables
        // and outside every check that pins them (F2b now fails on any inline
        // comparison). A key carrying a `{token}` is interpolated (`auth.failed`
        // wants the platform's own reason); any other refusal is a plain line.
        const refusalKey = REFUSAL_TEXT[code];
        setFormError(refusalKey.includes("{")
          ? format(tt(refusalKey), { reason: body?.error ?? "" })
          : tt(refusalKey));
        setFormDetail(typeof body?.detail === "string" && body.detail !== "" ? body.detail : null);
        return;
      }
      setFormError(body?.error ?? tt("auth.network"));
    } catch {
      setFormError(tt("auth.network"));
    } finally {
      setBusy(false);
    }
  }, [username, password, onDone, tt, cooling, cooldownUser, setCooldown]);

  return h(
    "div",
    { style: bare ? {} : { ...S.card, maxWidth: 420 } },
    // `bare` drops the inner card and title: the caller (the account
    // section card) already supplies both.
    bare ? null : h("div", { style: S.sectionTitle }, tt("auth.title")),
    // The official entry, visible in BOTH states: no account yet → the
    // sign-up page; account present → quota management / API keys.
    // Shown in both standalone and bare embed forms.
    h("a", {
      href: SENSENOVA_SIGNUP_URL,
      target: "_blank",
      rel: "noreferrer",
      // Inline: the shared `styles.ts` is under a concurrent rewrite
      // (roster/model-row restyle), so this one-off link skin lives here.
      style: S.externalLink
    }, tt(auth?.hasAccount ? "auth.portalHint" : "auth.registerHint")),
    h(
      "form",
      { onSubmit: submit },
      h(
        "label",
        { style: S.field },
        h("span", { style: S.fieldLabel }, tt("auth.username")),
        h("input", {
          style: S.input,
          value: username,
          autoComplete: "username",
          placeholder: tt("auth.placeholderUser"),
          disabled: busy,
          onChange: (event: { target: { value: string } }) => setUsername(event.target.value)
        })
      ),
      h(
        "label",
        { style: S.field },
        h("span", { style: S.fieldLabel }, tt("auth.password")),
        h(
          "div",
          { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("input", {
            style: { ...S.input, flex: 1 },
            type: showPassword ? "text" : "password",
            value: password,
            autoComplete: "current-password",
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setPassword(event.target.value)
          }),
          h(
            "button",
            {
              type: "button",
              style: { ...S.button, flex: "none" },
              disabled: busy,
              onClick: () => setShowPassword((shown) => !shown)
            },
            showPassword ? tt("auth.hide") : tt("auth.show")
          )
        )
      ),
      h(
        "div",
        { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
        h(
          "button",
          {
            type: "submit",
            style: { ...S.primary, ...(busy || cooling ? S.primaryBusy : {}) },
            disabled: busy || cooling
          },
          busy
            ? (hasAccounts ? tt("auth.adding") : tt("auth.submitting"))
            : (hasAccounts ? tt("auth.addAccount") : tt("auth.submit"))
        ),
      ),
      saved
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" },
            added === true ? tt("auth.added") : tt("auth.working"))
        : null,
      formError ? h("p", { style: S.formError, role: "alert" }, formError) : null,
      formError && formDetail
        ? h("p", { style: S.formNote }, platformDetail(formDetail, tt))
        : null,
      // The wait is stated with the platform's own number, so the reason
      // the button is greyed out is never a mystery.
      cooling
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } },
            format(tt("auth.retryAfter"), { minutes: coolingMinutes }))
        : null,
      // 已存账号列表（方案 C）：一行 = 用户名 + 当前徽标 + 切换/移除。
      // 当前号的「切换」不渲染（已是它）；移除随时可用（删的是存档，
      // 活动会话不动，重新登录一次即回槽）。
      accounts.length > 0
        ? h(
            "div",
            { style: { marginTop: 12 } },
            h("div", { style: { ...S.fieldLabel, marginBottom: 6 } }, tt("auth.accounts")),
            accounts.map((entry) => h(
              "div",
              { key: entry.id, style: { display: "flex", gap: 8, alignItems: "center", padding: "4px 0" } },
              h("span", { style: { ...S.modelName, fontSize: 13 } }, entry.username),
              entry.active === true
                ? h("span", { style: S.modelBadge }, tt("auth.accountCurrent"))
                : null,
              h("span", { style: { marginLeft: "auto", display: "flex", gap: 4 } },
                entry.active === true
                  ? null
                  : h("button", {
                      type: "button", style: S.rosterBulk, disabled: busy || accountBusy !== null,
                      onClick: () => void switchAccount(entry.id)
                    }, tt("auth.accountSwitch")),
                h("button", {
                  type: "button", style: S.rosterBulkDanger, disabled: busy || accountBusy !== null,
                  onClick: () => requestRemove(entry.id)
                }, tt("auth.accountRemove"))
              )
            ))
          )
        : null,
      // One note carries the persistence facts. The auto-recovery variant
      // REPLACES the saved line when armed: the saved line's "需重新输入一次"
      // would contradict an automatic re-login. When not armed, the saved
      // line already covers the manual path — a second "自动恢复：未开启" line
      // would be jargon that says the same thing twice.
      // 持久化脚注只在「有东西可描述」时开口（needsAccount = 什么都没配置，
      // 此时任何「已保存」都是谎话）；没到能承诺的时候（无存档密码的迁移边缘）
      // 同样沉默——边缘自愈（重登一次）后「自动重登」自然亮起。
      auth?.needsAccount === true
        ? null
        : h("p", { style: S.formNote },
            auth?.ephemeral === true
              ? tt("auth.ephemeral")
              : auth?.vaultPasswordArmed === true
                ? tt("auth.saved")
                : null)
    ),
    // 移除确认弹窗（宿主 Modal；requestRemove 已兜住 kit 缺席的旧宿主）。
    pendingRemove !== null
      ? h(clientModal() as (props: Record<string, unknown>) => unknown, {
          open: true,
          onClose: () => setPendingRemove(null),
          title: tt("auth.accountRemove"),
          description: tt("auth.removeConfirm"),
          footer: h(
            "div",
            { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
            h("button", { type: "button", style: S.button, onClick: () => setPendingRemove(null) }, tt("auth.cancel")),
            h("button", {
              type: "button", style: S.rosterBulkDanger, disabled: busy || accountBusy !== null,
              onClick: () => {
                const id = pendingRemove;
                setPendingRemove(null);
                if (id !== null) void removeAccount(id);
              }
            }, tt("auth.accountRemove"))
          )
        })
      : null
  );
}
