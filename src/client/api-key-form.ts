/**
 * The inference API-key editor (`sk-…`) with the llm section assembled around
 * it. Same security shape as `AccountForm`: show/hide, save/forget, busy and
 * outcome notes, and the value leaves component state the moment it is saved.
 * It is hook-based, so like AccountForm the render suite does not mount it;
 * the secret-free half it displays IS covered, via `ProviderStatus`. The key
 * is NEVER populated from the snapshot — the Host only reports whether one
 * exists.
 */
import { POOL_PATH, SENSENOVA_SIGNUP_URL } from "./const.ts";
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

  const submit = useCallback(async (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    // A whitespace check, not a prefix check: the platform owns the key
    // format, and rejecting a shape it later changes would lock users out.
    if (apiKey.trim() === "") {
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
      const body = await post({ forget: true });
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
        ? h("button", { type: "button", style: S.button, disabled: busy, onClick: forget }, tt("llm.forget"))
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
    llm?.hasApiKey === true
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
    h(ProviderStatus, { llm, tt }),
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
          keys.map((entry) => h(
            "li",
            { key: entry.id, style: { ...S.modelRow, ...(entry.disabled || entry.deleted ? S.modelRowOff : {}) } },
            h(
              "div",
              { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap" } },
              // key 脱敏名（无框大字）。
              h("span", { style: { ...S.modelName, flex: "none" }, title: entry.id },
                entry.label ?? entry.id),
              // 备注紧跟 key、同一行（2026-10-27 用户拍板：不单独换行、不右对齐）。
              // 未编辑 = 有内容显示内容、空显示「备注」占位（点击进入编辑）；
              // 编辑 = 输入框内联。提交路径只有一条（setNote：失焦/回车/保存同源）。
              editingId === entry.id
                ? h("input", {
                    style: { ...S.input, flex: "1 1 140px", minWidth: 140, height: 26, fontSize: 12, padding: "0 6px", boxSizing: "border-box" },
                    value: noteDraft,
                    autoFocus: true,
                    placeholder: tt("poolMng.note"),
                    disabled: busyId !== null,
                    onChange: (event: { target: { value: string } }) => setNoteDraft(event.target.value),
                    onBlur: () => { if (editingId === entry.id) void setNote(entry.id, noteDraft); },
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
                    style: { ...S.muted, fontSize: 12, cursor: "pointer", flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                    title: entry.note !== null && entry.note !== "" ? entry.note : tt("poolMng.note"),
                    onClick: () => { setEditingId(entry.id); setNoteDraft(entry.note ?? ""); }
                  }, entry.note !== null && entry.note !== "" ? entry.note : tt("poolMng.note")),
              editingId === entry.id
                ? h("button", {
                    type: "button", style: S.rosterBulk, disabled: busyId !== null,
                    onClick: () => void setNote(entry.id, noteDraft)
                  }, tt("poolMng.saveName"))
                : null,
              h("span", { style: { ...S.modelBadge, marginLeft: "auto" } },
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
                      type: "button", style: S.rosterBulk, disabled: busyId !== null,
                      onClick: () => void act({ action: "delete", id: entry.id }, entry.id)
                    }, tt("poolMng.delete"))
                  )
            )
          ))
        ),
    error !== null ? h("p", { style: S.formError, role: "alert" }, error) : null
  );
}
