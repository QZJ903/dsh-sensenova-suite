/**
 * The inference API-key editor (`sk-…`) with the llm section assembled around
 * it. Same security shape as `AccountForm`: show/hide, save/forget, busy and
 * outcome notes, and the value leaves component state the moment it is saved.
 * It is hook-based, so like AccountForm the render suite does not mount it;
 * the secret-free half it displays IS covered, via `ProviderStatus`. The key
 * is NEVER populated from the snapshot — the Host only reports whether one
 * exists.
 */
import { POOL_PATH, API_KEY_PATH, SENSENOVA_SIGNUP_URL } from "./const.ts";
import { postJson, postJsonOrThrow } from "./http.ts";
import { h, useCallback, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import type { LlmData, PoolDiagData } from "./wire.ts";
import { ProviderRegStatus, ProviderStatus, ProviderSwitch } from "./provider-controls.ts";
import { ModelPicker } from "./model-picker.ts";
import { S } from "./styles.ts";

export function ApiKeyForm({ llm, pool, onDone, tt }: {
  llm?: LlmData | null;
  pool?: PoolDiagData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [forgotten, setForgotten] = useState(false);

  // 上面的表单现在直接进 key 池（POST /pool {action:add}）——唯一入口。
  const post = useCallback((payload: Record<string, unknown>) => postJson(POOL_PATH, payload), []);
  /** 清除面板 key 走 API-KEY 路由（forget 分支在那里；POOL 路由不认识 forget）。 */
  const postApiKey = useCallback((payload: Record<string, unknown>) => postJson(API_KEY_PATH, payload), []);

  const submit = useCallback(async (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    // 结果横幅与错误红字同屏就是矛盾（2026-10-29 真机：上一次 add 成功的
    // 绿字「已保存」和本次查重拒绝的红字一起挂着）——提交开始即清上一次
    // 的结果横幅；本次成功会在下方重新点亮。
    setSaved(false);
    setForgotten(false);
    // 前缀校验（2026-10-27 用户要求）：必须 sk- 开头——面板加错 key（整串
    // 粘错/带了空格外的杂质）会进池参与轮转，把限流与失败怪到好 key 头上。
    if (!/^sk-[A-Za-z0-9]/.test(apiKey.trim())) {
      setFormError(tt("llm.empty"));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      // 进池（自动编号 key-<n>，名字 = 备注留空）；key 必然参与轮转。
      const body = await post({ action: "add", apiKey: apiKey.trim() });
      if (body && body.ok === true) {
        setApiKey("");
        setSaved(true);
        setForgotten(false);
        onDone?.();
        return;
      }
      setFormError(body?.error ?? tt("auth.network"));
    } catch (caught) {
      setFormError(caught instanceof Error && caught.message !== "" ? caught.message : tt("auth.network"));
    } finally {
      setBusy(false);
    }
  }, [apiKey, post, onDone, tt]);

  const forget = useCallback(async () => {
    setBusy(true);
    setFormError(null);
    try {
      const body = await postApiKey({ forget: true });
      if (body?.ok !== true) {
        setFormError(body?.error ?? tt("auth.network"));
        return;
      }
      setForgotten(true);
      setSaved(false);
      setApiKey("");
      onDone?.();
    } catch (caught) {
      setFormError(caught instanceof Error && caught.message !== "" ? caught.message : tt("auth.network"));
    } finally {
      setBusy(false);
    }
  }, [post, onDone, tt]);

  // Only a REFERENCE the panel stored can be forgotten: an environment
  // value has no panel-saved copy to clear, so the button would mislead.
  const canForget = llm?.hasApiKey === true && llm?.keySource === "credentials";
  // 「配置了 key」看两处（2026-10-29 真机：sk- 框的保存进池、不写面板主 key，
  // 只盯 hasApiKey 会给配置了池 key 的卡片永远催 key）：面板主 key 在，或池
  // 里有条目，都算配置——催贴 key 的提示与官网注册链接都以这个为准。
  const poolConfigured = Array.isArray(pool?.keys) && pool.keys.length > 0;
  // A configured key's editor sits inside the SectionCard's single fold: the
  // status block is what a working setup needs daily, while the paste-a-key
  // form is a maintenance action — one click away, not on screen. The card IS
  // the collapse; there is no inner `<details>` (see the note below). Without
  // a key the editor is the entry point and shows open.
  const keyEditor = h(
    "div",
    null,
    h(
      "label",
      { style: S.field },
      h("span", { style: S.fieldLabel }, tt("llm.keyField")),
      h(
        "div",
        { style: { display: "flex", gap: 6, alignItems: "center" } },
        h("input", {
          style: { ...S.input, flex: 1 },
          type: showKey ? "text" : "password",
          value: apiKey,
          autoComplete: "off",
          placeholder: tt("llm.placeholder"),
          disabled: busy,
          onChange: (event: { target: { value: string } }) => setApiKey(event.target.value)
        }),
        h(
          "button",
          { type: "button", style: { ...S.button, flex: "none" }, disabled: busy, onClick: () => setShowKey((shown) => !shown) },
          showKey ? tt("auth.hide") : tt("auth.show")
        )
      )
    ),
    h(
      "div",
      { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
      h(
        "button",
        { type: "submit", style: { ...S.primary, ...(busy ? S.primaryBusy : {}) }, disabled: busy },
        busy ? tt("llm.saving") : tt("llm.save")
      ),
      canForget
        ? h("button", {
            type: "button", style: S.button, disabled: busy,
            // 二次确认（2026-10-27 用户拍板）：清除是本面板最重的破坏性操作
            // （清凭据本体 + 目录缓存 + 池槽），误触一次就得重新找 key。
            onClick: () => { if (globalThis.confirm(tt("llm.forgetConfirm"))) void forget(); }
          }, tt("llm.forget"))
        : null
    ),
    forgotten
      ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("llm.forgotten"))
      : saved
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("llm.saved"))
        : null,
    formError ? h("p", { style: S.formError, role: "alert" }, formError) : null,
    h("p", { style: S.formNote }, tt("llm.footnote")),
    // The official-site link only exists for the no-key state (sign-up
    // nudge). With a key configured the management link was noise — the
    // user reaches the portal from the platform console anyway (2026-10-27).
    // 「配置了」与催 key 提示同判：面板主 key 或池 key 任一在就不催。
    (llm?.hasApiKey === true || poolConfigured)
      ? null
      : h("a", { href: SENSENOVA_SIGNUP_URL, target: "_blank", rel: "noreferrer", style: S.externalLink },
          tt("llm.keyRegisterHint"))
  );
  // The SectionCard wrapping this form is the collapse: one fold, not
  // two. An inner `<details>` around the editor meant opening the card
  // revealed only a status line and hid the very input the card is for.
  return h(
    "form",
    { onSubmit: submit },
    keyEditor,
    h(ProviderStatus, { llm, tt, poolConfigured }),
    h(PoolManager, { pool: pool ?? null, onDone, tt })
  );
}

/**
 * The provider-registration half — the live switch plus its "which models
 * get pushed" roster — as ONE card body. Split from `ApiKeyForm` when the
 * panel grew one SectionCard per concern: key, provider+push are
 * three different functions and no longer share a card.
 */
export function ProviderForm({ llm, pool, onDone, tt }: {
  llm?: LlmData | null;
  pool?: PoolDiagData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  return h(
    "div",
    null,
    // The controls read first (switch, then the roster it feeds); the
    // registration status — a diagnostic echo of what the Host reports —
    // closes the card. At the top it competed with the title and
    // duplicated the roster's own counts out of reading order.
    h(ProviderSwitch, { llm, onDone, tt }),
    h(ModelPicker, { llm, pool, onDone, tt }),
    h(ProviderRegStatus, { llm, tt })
  );
}


/**
 * Key 池管理面（并入 API Key 卡）：账号列表（停用/恢复/删除）+ 全局并发数。
 *
 * key 本身不出池——面板按账号 id 操作，动作 POST 到 `/pool`，成功后 onDone()
 * 触发快照轮询刷新。并发数本地草稿 + 显式保存（与允许清单同一交互纪律）。
 */
export function PoolManager({ pool, onDone, tt }: {
  pool: PoolDiagData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedConcurrency = pool?.globalConcurrency ?? 2;
  const [concurrency, setConcurrency] = useState<number | null>(null);
  const concurrencyValue = concurrency ?? savedConcurrency;
  const concurrencyDirty = concurrency !== null && concurrency !== savedConcurrency;

  const act = useCallback(async (payload: Record<string, unknown>, busyTag: string) => {
    setBusyId(busyTag);
    setError(null);
    try {
      const body = await postJson(POOL_PATH, payload);
      if (body === null) {
        setError(tt("auth.network"));
        return false;
      }
      if (body.ok !== true) {
        setError(typeof body.error === "string" ? body.error : tt("auth.network"));
        return false;
      }
      onDone?.();
      return true;
    } catch (caught) {
      // 原始原因（含 URL 与 HTTP 状态）比一句「无法连接」有用得多：
      // 旧 Host 构建会得到 "non-JSON HTTP 404"，网络断会得到 fetch 的异常名。
      const message = caught instanceof Error ? caught.message : "";
      setError(/non-JSON HTTP 4\d\d/.test(message) ? tt("poolMng.routeMissing") : (message || tt("auth.network")));
      return false;
    } finally {
      setBusyId(null);
    }
  }, [onDone, tt]);

  /** 行内改备注：编辑中的 id + 草稿（注释 = 备注字段，可为空）。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const setNote = useCallback(async (id: string, name: string) => {
    const ok = await act({ action: "rename", id, name }, id);
    if (ok) { setEditingId(null); setNoteDraft(""); }
  }, [act]);

  const saveConcurrency = useCallback(async () => {
    setError(null);
    try {
      const body = await postJsonOrThrow(POOL_PATH, { globalConcurrency: concurrencyValue });
      if (body?.ok !== true) {
        setError(body?.error ?? tt("auth.network"));
        return;
      }
      setConcurrency(null);
      onDone?.();
    } catch {
      setError(tt("auth.network"));
    }
  }, [concurrencyValue, onDone, tt]);

  const keys = Array.isArray(pool?.keys) ? pool.keys : [];
  const phaseLabel: Record<string, string> = {
    running: tt("poolMng.phaseRunning"),
    blocked: tt("poolMng.phaseBlocked"),
    absent: tt("poolMng.phaseAbsent")
  };
  // 相位着色（2026-10-29 用户指定）：运行=绿、未入池=红——「能不能转/有没有病」
  // 扫一眼就分；阻塞与已删除他没点名，维持默认灰。只覆盖 color，胶囊底不变。
  const phaseColor: Record<string, string> = {
    running: "var(--dsw-alias-state-success-primary)",
    absent: "var(--dsw-alias-state-error-primary)"
  };

  return h(
    "div",
    { style: { marginTop: 10 } },
    // 并发：全局在途上限（0 = 跟随 key 数）。
    h(
      "div",
      { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 } },
      h("span", { style: { ...S.fieldLabel, flex: "none" } }, tt("poolMng.concurrent")),
      h("input", {
        type: "number",
        min: 0,
        style: { ...S.input, width: 90 },
        value: String(concurrencyValue),
        disabled: busyId !== null,
        onChange: (event: { target: { value: string } }) => setConcurrency(Math.max(0, Math.floor(Number(event.target.value) || 0)))
      }),
      concurrencyDirty
        ? h("button", { type: "button", style: S.button, onClick: () => void saveConcurrency() }, tt("llm.save"))
        : null,
      h("span", { style: { ...S.muted, fontSize: 12 } }, tt("poolMng.concurrentHint"))
    ),
    keys.length === 0
      ? h("p", { style: { ...S.muted, fontSize: 12 } }, tt("poolMng.empty"))
      : h(
          "ul",
          { style: S.modelList, role: "list" },
          keys.map((entry) => {
            // 灰显分家（2026-10-29 用户指定）：停用行的「恢复」「删除」按钮要
            // 常驻正常颜色——opacity 压在 li 上是整棵子树合成，子元素救不回来，
            // 所以停用行改为逐元素压灰（textDim：脱敏名/备注/徽标），按钮不压；
            // 已删除行他没让它变，维持整行灰（rowDim，含按钮）。
            const rowDim = entry.deleted ? S.modelRowOff : {};
            const textDim = entry.disabled && !entry.deleted ? S.modelRowOff : {};
            return h(
            "li",
            { key: entry.id, style: { ...S.modelRow, ...rowDim } },
            h(
              "div",
              { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap" } },
              // key 脱敏名（无框大字）。
              h("span", { style: { ...S.modelName, flex: "none", ...textDim }, title: entry.id },
                entry.label ?? entry.id),
              // 备注紧跟 key、同一行（2026-10-27 用户拍板：不单独换行、不右对齐）。
              // 未编辑 = 有内容显示内容、空显示「备注」占位（点击进入编辑）；
              // 编辑 = 输入框内联。提交路径只有一条（setNote：失焦/回车/保存同源）。
              editingId === entry.id
                ? h("input", {
                    style: { ...S.input, flex: "1 1 140px", minWidth: 140, height: 26, fontSize: 12, padding: "0 6px", boxSizing: "border-box", ...textDim },
                    value: noteDraft,
                    autoFocus: true,
                    placeholder: tt("poolMng.note"),
                    disabled: busyId !== null,
                    onChange: (event: { target: { value: string } }) => setNoteDraft(event.target.value),
                    // 失焦 = 放弃编辑：收起编辑器、草稿作废（显示回到已存备注）——
                    // 不提交。落库唯一路径是「保存」按钮/回车；按钮 onMouseDown
                    // preventDefault（点按钮不失焦），取消不会误伤按钮通路。
                    onBlur: () => {
                      setEditingId(null);
                      setNoteDraft("");
                    },
                    onKeyDown: (event: { key: string; preventDefault?: () => void }) => {
                      // 回车保存备注；必须 preventDefault，否则会冒泡到外层
                      // form 的 onSubmit（填 key 的表单），把空的 apiKey 提交并报
                      // 「请输入 sk- 开头的 API Key」——2026-10-25 用户实测。
                      if (event.key === "Enter") {
                        event.preventDefault?.();
                        void setNote(entry.id, noteDraft);
                      }
                    }
                  })
                : h("span", {
                    style: { ...S.muted, fontSize: 12, cursor: "pointer", flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...textDim },
                    title: entry.note !== null && entry.note !== "" ? entry.note : tt("poolMng.note"),
                    onClick: () => { setEditingId(entry.id); setNoteDraft(entry.note ?? ""); }
                  }, entry.note !== null && entry.note !== "" ? entry.note : tt("poolMng.note")),
              editingId === entry.id
                ? h("button", {
                    type: "button", style: { ...S.rosterBulk, ...textDim }, disabled: busyId !== null,
                    // mousedown 阻止默认：输入框不失焦，编辑器不会在点击前被收起。
                    onMouseDown: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
                    onClick: () => void setNote(entry.id, noteDraft)
                  }, tt("poolMng.saveName"))
                : null,
              h("span", {
                style: {
                  ...S.modelBadge,
                  marginLeft: "auto",
                  ...textDim,
                  ...(!entry.deleted && phaseColor[entry.phase] !== undefined ? { color: phaseColor[entry.phase] } : {})
                }
              },
                entry.deleted ? tt("poolMng.deleted") : phaseLabel[entry.phase] ?? entry.phase),
              entry.deleted
                ? h("button", {
                    type: "button", style: S.rosterBulk, disabled: busyId !== null,
                    onClick: () => void act({ action: "restore", id: entry.id }, entry.id)
                  }, tt("poolMng.restore"))
                : h(
                    "span",
                    { style: { display: "flex", gap: 4 } },
                    entry.disabled
                      ? h("button", {
                          type: "button", style: S.rosterBulk, disabled: busyId !== null,
                          onClick: () => void act({ action: "restore", id: entry.id }, entry.id)
                        }, tt("poolMng.restore"))
                      : h("button", {
                          type: "button", style: S.rosterBulk, disabled: busyId !== null,
                          onClick: () => void act({ action: "disable", id: entry.id }, entry.id)
                        }, tt("poolMng.disable")),
                    h("button", {
                      type: "button", style: S.rosterBulkDanger, disabled: busyId !== null,
                      // 二次确认（2026-10-27 用户拍板）：删除连凭据本体一起清，误触即失。
                      onClick: () => { if (globalThis.confirm(tt("poolMng.deleteConfirm"))) void act({ action: "delete", id: entry.id }, entry.id); }
                    }, tt("poolMng.delete"))
                  )
            )
            );
          })
        ),
    error !== null ? h("p", { style: S.formError, role: "alert" }, error) : null
  );
}
