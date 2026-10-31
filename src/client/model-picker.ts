/**
 * The curated model allow-list UI: the hook-free row list and the hook-based
 * picker around it.
 */
import { MODELS_PATH, POOL_PATH } from "./const.ts";
import { errorText, format, tokenSize } from "./format.ts";
import { postJsonOrThrow } from "./http.ts";
import { ModelRow } from "./model-row.ts";
import { bulkModelsIn, modelIsOn, toggleModelIn } from "./models.ts";
import { dictKey, h, useCallback, useEffect, useMemo, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import type { LlmData, ModelData, PoolDiagData } from "./wire.ts";

/**
 * The single empty roster every "the Host sent no list" fallback resolves to.
 *
 * It is a CONSTANT on purpose. A literal `[]` written at the use site is a
 * fresh object on every render, which silently breaks every `useMemo` /
 * `useCallback` that lists it as a dependency: the memo recomputes on each
 * poll, so a search keystroke re-renders the whole catalogue. Freezing one
 * instance here keeps `models` referentially stable across renders even when
 * `llm` is null - which is exactly what the memo below claims it is.
 */
const NO_MODELS: ModelData[] = [];
const NO_IDS: string[] = [];

/**
 * The model picker's row list - hook-free, so the Node render suite
 * drives the very rows the browser draws.
 *
 * This component owns only what is SPECIFIC to the Token Plan catalogue; the
 * two-line row itself is drawn by {@link ModelRow}.
 * roster (see that module for why the skeleton has one definition). What is
 * specific here: the allow-list decides `on` (`modelIsOn` — an id absent from
 * the list is OFF), the pseudo rate is always rendered `×N` because the Host
 * matched it through the operator's own config, and the parameter line quotes
 * window, output ceiling, and the thinking levels DSH's selector will really
 * offer for THIS model.
 *
 * A provider-wide constant (the default effort) never repeats per row - it is
 * stated once in the header, because a fact that never varies between rows is
 * noise, not information. The rows come only from the Host's roster, so a
 * curated id that no longer exists can never become a checkbox: curation is a
 * filter over the catalogue, never a catalogue of its own. A default ("text
 * only") earns no badge, and a figure the catalogue does not declare draws no
 * segment - the list quotes facts, never guesses.
 */
export function ModelRoster({ models, enabledIds, busy, tt, onToggle, modelProtocols, onChainSlotChange, visionIds, onVisionToggle, thinkingById, onThinkingToggle, openThinkingId, onThinkingOpen }: {
  models: ModelData[];
  enabledIds: unknown;
  busy: boolean | undefined;
  tt: Tt;
  onToggle?: (id: string) => void;
  /** 每模型生效降级链（面板"协议"三槽的数据源；host 已合成 面板覆盖??配置??档案默认）。 */
  modelProtocols?: Record<string, string[]>;
  /** 改某模型链的一个槽（value="" = 从该槽截短；写本地草稿，保存时 POST modelProtocols）。 */
  onChainSlotChange?: (id: string, slot: number, value: string) => void;
  visionIds?: string[];
  /** 勾选/取消某模型的识图能力（写本地草稿；保存时 POST vision.visionModels）。 */
  onVisionToggle?: (id: string, on: boolean) => void;
  /** 每模型可用思考档位（{ modelId → level[] }；用户勾选，含草稿）。 */
  thinkingById?: Record<string, string[]>;
  /** 切换某模型的一个思考档位（写本地草稿；保存时 POST thinking 分区）。 */
  onThinkingToggle?: (id: string, level: string, on: boolean) => void;
  /** 当前展开思考面板的模型 id（一次只开一个）；null = 全收起。 */
  openThinkingId?: string | null;
  /** 点击思考 chip 切换该模型的面板（id 或关闭）。 */
  onThinkingOpen?: (id: string | null) => void;
}): unknown {
  const list = Array.isArray(models) ? models : [];
  const visionSet = Array.isArray(visionIds) ? new Set(visionIds) : null;
const THINKING_CHOICES = ["off", "low", "medium", "high", "max"];
  return h(
    "ul",
    { style: S.modelList, role: "list" },
    list.map((model) => {
      const id = String(model?.id ?? "");
      const label = String(model?.name ?? id);
      const on = modelIsOn(enabledIds, id);
      const ctx = typeof model?.contextWindow === "number" && model.contextWindow > 0
        ? format(tt("llm.contextBadge"), { ctx: tokenSize(model.contextWindow) })
        : null;
      const out = typeof model?.maxOutputLength === "number" && model.maxOutputLength > 0
        ? format(tt("llm.metaOutput"), { out: tokenSize(model.maxOutputLength) })
        : null;
      // 思考档位的元信息行已被「下拉面板」取代（面板内列出勾选内容）；
      // 参数行只保留目录声明的窗口/输出上限（见 §G4 的 pin）。
      const meta = [ctx, out].filter(Boolean).join(" · ");
      const rate = typeof model?.multiplier === "number" ? model.multiplier : null;
      const visionOn = visionSet !== null && visionSet.has(id);
      return h(ModelRow, {
        key: id,
        id,
        label,
        on,
        busy,
        // The pseudo rate rides directly after the name like WorkBuddy's
        // `(0.29x)`: the Host matched it through the same operator config
        // that labels the trend chart, so badge and chart cannot diverge.
        // `×0` stays `×0` here — the operator's pseudo figure is exactly what
        // configured it, and the tooltip below says so.
        rateText: rate === null ? null : `×${rate}`,
        rateTitle: tt("llm.rosterRateTitle"),
        // A badge marks a NOTABLE state: image input is the exception worth
        // quoting, and `quota exhausted` says why a ticked row still will
        // not show up in the DSH picker (the buildDescriptors parity rule).
        badges: [
          model?.quotaExhausted === true
            ? h("span", { key: "exhausted", style: { ...S.modelBadge, color: "var(--dsw-alias-state-error-primary)" } }, tt("llm.rosterExhausted"))
            : null,
          // 思考档位（用户可配置该模型支持哪些档位）：一个紧凑 chip，点击展开
          // 多选面板（六档复选 + 底部「可看图」）。勾选存 pool.json `thinking`
          // 分区；DSH 对话界面的可选档位 = 此勾选集。面板只开当前模型这一个。
          onThinkingOpen !== undefined && onThinkingToggle !== undefined
            ? h("button", {
                key: "thinking",
                type: "button",
                style: {
                  ...S.modelBadge,
                  cursor: busy ? "default" : "pointer",
                  border: "none",
                  fontFamily: "inherit",
                  marginLeft: 8,
                },
                disabled: busy === true,
                "aria-expanded": openThinkingId === id,
                title: tt("llm.rosterThinking"),
                onClick: () => onThinkingOpen(openThinkingId === id ? null : id)
              },
              tt("llm.rosterThinking"),
              openThinkingId === id ? " ▾" : " ▸")
            : null
        ],
        meta,
        onToggle,
        // 思考面板（展开时）：六档复选 + 右侧「可看图」+ 底部分隔线 + 协议行。
        // 面板归属当前模型（row 内），收起则什么都不画。所有控件都只改草稿
        // （保存按钮统一落库，2026-10-26 用户拍板）。
        children: openThinkingId === id
          ? h("div", {
              key: "thinking-panel",
              style: {
                marginTop: 8,
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--dsw-alias-border-l2)",
                background: "var(--dsw-alias-bg-layer-2)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }
            },
            h("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-secondary)" } }, tt("llm.rosterThinking")),
            // 面板提示（2026-10-29 用户定稿）：默认不用调；『可看图』只给真识图
            // 的模型勾；新模型上架后再来补。跟在「模型设置」标题后面一行灰字。
            h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, tt("llm.settingsHint")),
            // 档位复选 + 「可看图」同一行：档位在左、可看图右对齐（不与最高贴太近，
            // 用户 2026-10-26 拍板：可看图提上来但靠右）。档位前缀「思考档位：」
            // 让勾选内容自解释（后面只跟关闭/低/中/高…）。
            h("div", {
              style: { display: "flex", flexWrap: "wrap", gap: "2px 10px", alignItems: "center", justifyContent: "space-between" }
            },
            h("span", { style: { display: "flex", flexWrap: "wrap", gap: "2px 10px", alignItems: "center" } },
              h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, tt("llm.rosterThinkingLevels") + "："),
              ...THINKING_CHOICES.map((level) => {
                const picking = Array.isArray(thinkingById?.[id]) && (thinkingById[id] as string[]).includes(level);
                return h("label", {
                  key: level,
                  style: { display: "inline-flex", gap: 4, alignItems: "center", cursor: busy ? "default" : "pointer", fontSize: 12 },
                },
                h("input", {
                  type: "checkbox",
                  checked: picking,
                  disabled: busy === true,
                  style: S.modelCheck,
                  "aria-label": `${label} 档位 ${level}`,
                  onChange: () => { if (onThinkingToggle) onThinkingToggle(id, level, !picking); }
                }),
                tt(dictKey("llm.level", level)));
              })),
            visionSet !== null
              ? h("label", {
                  style: { display: "inline-flex", gap: 4, alignItems: "center", cursor: busy ? "default" : "pointer", fontSize: 12, marginLeft: "auto" },
                },
                h("input", {
                  type: "checkbox",
                  checked: visionOn,
                  disabled: busy === true,
                  style: S.modelCheck,
                  "aria-label": `${label} 识图`,
                  onChange: onVisionToggle
                    ? () => onVisionToggle(id, !visionOn)
                    : undefined
                }),
                tt("llm.rosterVision"))
              : null),
            // 分隔线：档位行与协议行之间。
            h("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l1)", margin: "2px 0" } }),
            // 协议降级链并入面板：一行 label + 三个槽位 select（an>re>chat；
            // 不重复、选一个少一个、槽1 必填、槽2 空则槽3 禁用），与档位同属「保存才生效」。
            onChainSlotChange !== undefined
              ? h("label", {
                  style: { display: "flex", gap: 8, alignItems: "center", fontSize: 12, cursor: busy ? "default" : "pointer" },
                },
                h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, tt("llm.protocol")),
                [0, 1, 2].flatMap((slot) => {
                  const stored = modelProtocols?.[id];
                  const chain = Array.isArray(stored) ? stored : [];
                  // 禁用判据 =「前一槽为空」（slot 1 只依赖恒有值的槽 0，永不锁）；
                  // 旧写法 chain.length <= slot 把刚置空的槽自己也锁死——置空后
                  // 再也填不回去（2026-10-31 他报）。
                  const disabled = busy === true || (slot >= 1 && chain.length < slot);
                  // 槽间箭头（2026-10-31 他令「提升观感」）：链序视觉化。
                  const arrow = slot > 0 ? [h("span", {
                    key: `chain-arrow-${slot}`,
                    style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, userSelect: "none" }
                  }, "→")] : [];
                  const select = h("select", {
                    key: slot,
                    style: { ...S.input, width: "auto", height: 26, fontSize: 12, padding: "0 4px" },
                    value: chain[slot] ?? "",
                    disabled,
                    "aria-label": `${label} 协议${slot + 1}`,
                    onChange: (event: { target: { value: string } }) => onChainSlotChange(id, slot, event.target.value)
                  }, [
                    ...(slot > 0 ? [h("option", { key: "", value: "" }, "—")] : []),
                    // 选项文本 = wire 原文直出（与旧单选一致；an/re/chat 是他口述
                    // 简写，界面用全名——2026-10-31 他令「把协议名字补全」）。
                    ...chainSlotWires(chain, slot).map((wire) =>
                      h("option", { key: wire, value: wire }, wire))
                  ]);
                  return [...arrow, select];
                }))
              : null)
          : null
      });
    })
  );
}

const CHAIN_WIRES = ["anthropic", "responses", "chat-completions"] as const;
/** 第 slot 槽的可选线（用户规则：不重复、选一个少一个）——前缀已占用的线不再出现。 */
export function chainSlotWires(chain: readonly string[], slot: number): (typeof CHAIN_WIRES)[number][] {
  const chosen = chain.slice(0, slot);
  return CHAIN_WIRES.filter((wire) => !chosen.includes(wire));
}

/**
 * The curated model allow-list: which of this key's models get pushed to
 * DSH's model list.
 *
 * Hook-based like `ApiKeyForm`, so the render suite exercises the secret-
 * free half it draws - `ModelRoster` and the counts - instead of this
 * state machine. The edit is local until saved: the picker holds a draft
 * of the allow-list, the "unsaved" state is DERIVED by comparing it with
 * the Host's current value, and the "saved" state is the same comparison
 * after a poll echoes the write. Both therefore cannot lie: a save that
 * never reached the Host keeps showing the edits, and an edit that ends
 * up identical to the Host's value shows neither button.
 */
export function ModelPicker({ llm, pool, onDone, tt }: {
  llm?: LlmData | null;
  pool?: PoolDiagData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const models = Array.isArray(llm?.models) ? llm.models : NO_MODELS;
  const hostIds = Array.isArray(llm?.enabledModelIds) ? llm.enabledModelIds : NO_IDS;
  // 用户勾选的「可识图」模型原始快照（存在 vision.visionModels）。
  const rawVision = Array.isArray(pool?.settings?.vision?.visionModels)
    ? (pool.settings.vision.visionModels as string[])
    : [];
  const rawThinking = typeof pool?.settings?.thinking === "object" && pool.settings.thinking !== null
    ? (pool.settings.thinking as Record<string, string[]>)
    : {};
  const rawProtocols = llm?.modelProtocols ?? {};
  // 保存成功的在途写入覆盖层（2026-10-27）：POST 已确认、快照未回显的窗口里，
  // 显示与**下一次保存的载荷基座**都必须看到已写入的值——否则连存两次时第二次
  // 拿旧快照打包，把第一次的写入整段冲掉（thinking 带回旧档位、vision 用旧
  // 清单，2026-10-27 真机「连调两个模型第二个没保存」）。快照回显一致后摘除；
  // 30s 兜底强制摘除，防宿主侧后续变更被覆盖层永久遮蔽。
  const [inflight, setInflight] = useState<{
    thinking?: { values: Record<string, string[]>; at: number };
    vision?: { values: string[]; at: number };
    protocols?: { values: Record<string, string[]>; at: number };
  }>({});
  const visionHost = inflight.vision?.values ?? rawVision;
  const thinkingHost = { ...rawThinking, ...inflight.thinking?.values };
  const hostProtocols = { ...rawProtocols, ...inflight.protocols?.values };
  const [ids, setIds] = useState<string[]>(() => hostIds.slice());
  // 思考/看图/协议的「本地显示」永远 = 宿主快照 + 草稿，不设宿主镜像 state：
  // 快照轮询可能晚到（面板先挂载、宿主值后到），镜像 state 锁在 mount 时的旧值
  // 会让面板显示与宿主脱节，勾选后还把宿主已存的配置整段冲掉（2026-10-26 复现）。
  // 每次 render 都从最新 props 现算生效值，天然跟随宿主。
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  // 保存成功一次后的「已保存」回显 key（仅用于展示成功行，不参与 dirty 判据）。
  const [justSaved, setJustSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 当前展开思考面板的模型（一次只开一个；null = 全收起）。
  const [openThinkingId, setOpenThinkingId] = useState<string | null>(null);
  // 协议草稿（模型 → 协议；即改即存已废，改的是草稿，按保存才落库）。
  // 思考面板草稿（模型 → 档位集；与 vision 草稿一起按保存才落库）。
  const [draftThinking, setDraftThinking] = useState<Record<string, string[]>>({});
  // 可看图草稿（模型 → 是否勾选；与思考草稿一起按保存才落库）。
  const [draftVision, setDraftVision] = useState<Record<string, boolean>>({});
  // Whether the USER has edited the draft since the last Host sync. The
  // auto-sync must not clobber an in-flight edit; an untouched picker must
  // FOLLOW the Host. The old guard compared the CURRENT ids against the NEW
  // hostKey — unequal the instant the Host moved — so the picker never synced,
  // and a Host-side change showed as "unsaved" with a Save button that would
  // POST the stale list over the Host's value.
  const touchedRef = useRef(false);

  // Serialising the allow-lists is the picker's only per-render cost that
  // scales with the catalogue, so it is memoised on the arrays themselves:
  // a keystroke in the search box must not re-stringify every saved id.
  const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
  const idsKey = useMemo(() => JSON.stringify(ids), [ids]);
  const dirty = idsKey !== hostKey;
  // 思考/看图/协议三段用「草稿合入宿主后的**生效值**」判脏（0.1.2 起）：
  // 生效值 ≠ 宿主值才算未保存；草稿为空（未编辑过）时生效值恒等于宿主值 → 干净。
  // 直接比较草稿与宿主是错的：宿主已有配置（如 0.1.1 即改即存时代留下的 thinking）
  // 而草稿为空时会被误判为已修改，保存脚常驻、点了又没效果。
  const effectiveThinking = { ...thinkingHost, ...draftThinking };
  const effectiveVision = (() => {
    const out = new Set(visionHost);
    for (const [id, on] of Object.entries(draftVision)) {
      if (on) out.add(id);
      else out.delete(id);
    }
    return [...out];
  })();
  const thinkingDirty = JSON.stringify(effectiveThinking) !== JSON.stringify(thinkingHost);
  const visionDirty = JSON.stringify(effectiveVision.sort()) !== JSON.stringify([...visionHost].sort());
  // 协议链草稿（模型 → 生效链的覆盖；即改即存已废，改的是草稿，按保存才落库）。
  const [draftProtocols, setDraftProtocols] = useState<Record<string, string[]>>({});
  const effectiveProtocols = { ...hostProtocols, ...draftProtocols };
  // 协议链判脏按模型逐条比（草稿 vs 宿主生效链）：POST 只带变化了的模型——
  // 全量覆盖会把「没改过的模型」也钉成覆盖，档案默认链的后续修正被存量冻结。
  const protocolsDirty = Object.entries(draftProtocols).some(([id, chain]) =>
    JSON.stringify(chain) !== JSON.stringify(hostProtocols[id]));
  const anyDirty = dirty || protocolsDirty || thinkingDirty || visionDirty;
  // 覆盖层摘除：快照追平在途写入（或 30s 兜底）即放手，显示与基座交还快照。
  const snapKey = JSON.stringify([rawThinking, rawVision, rawProtocols]);
  useEffect(() => {
    setInflight((current) => {
      if (current.thinking === undefined && current.vision === undefined && current.protocols === undefined) return current;
      const now = Date.now();
      const next: typeof current = { ...current };
      const thinkingPart = next.thinking;
      if (thinkingPart !== undefined) {
        const sub = Object.fromEntries(Object.entries(rawThinking).filter(([k]) => k in thinkingPart.values));
        if (JSON.stringify(sub) === JSON.stringify(thinkingPart.values) || now - thinkingPart.at > 30_000) delete next.thinking;
      }
      const visionPart = next.vision;
      if (visionPart !== undefined) {
        if (JSON.stringify([...rawVision].sort()) === JSON.stringify([...visionPart.values].sort()) || now - visionPart.at > 30_000) delete next.vision;
      }
      const protocolsPart = next.protocols;
      if (protocolsPart !== undefined) {
        const sub = Object.fromEntries(Object.entries(rawProtocols).filter(([k]) => k in protocolsPart.values));
        if (JSON.stringify(sub) === JSON.stringify(protocolsPart.values) || now - protocolsPart.at > 30_000) delete next.protocols;
      }
      return next;
    });
    // eslint-disable 不存在；snapKey 是快照变动的唯一稳定信号（数组每次轮询都是新引用）。
  }, [snapKey]);

  // Follow the Host while the picker is untouched, so a catalogue refresh
  // reaches the list and a save from another client clears the draft.
  // `touchedRef` (not `dirty`) is the guard: an edit in flight must survive,
  // while a Host-side change on an untouched picker must land.
  useEffect(() => {
    if (!touchedRef.current) setIds(hostIds);
    // Deliberately keyed on `hostKey` alone. `hostIds` is a fresh array on
    // every poll, so listing it would re-run this effect constantly and
    // overwrite an edit in flight; `hostKey` is the stable signal that the
    // Host's value actually moved. (An `eslint-disable` sat here until it was
    // removed: this repo has no eslint config and no eslint dependency, so the
    // comment suppressed a rule nothing ran while implying a lint gate exists.)
  }, [hostKey]);

  // The "已保存" notice ends when the picker is edited again (or the
  // Host's value moves on). It must NOT end on the poll that echoes our
  // own write — that echo is exactly when the notice is supposed to show;
  // clearing it on every hostKey change made the success line unreachable.
  useEffect(() => {
    if (dirty === true) setJustSaved(false);
  }, [dirty]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      // 保存 = 四个草稿一次落库（用户 2026-10-26 拍板：思考/看图/协议都走
      // 「草稿 + 保存按钮」）。仍有变化的段各自 POST，未变化的段不发。
      // 每个 POST 都是整段覆盖（vision 提交合并后的完整数组、thinking 提交
      // 合并后的完整 map），段落内部不做 diff——勾选多次最终只落一次。
      const visionNext = [...new Set<string>([
        ...visionHost.filter((id) => !(id in draftVision)),
        ...Object.keys(draftVision).filter((id) => draftVision[id] === true)
      ])];
      const thinkingNext = Object.fromEntries(
        Object.entries({ ...thinkingHost, ...draftThinking }).filter(([, levels]) => Array.isArray(levels) && levels.length > 0)
      );
      // 协议链只提交变化了的模型（逐条 patch，见 protocolsDirty 注释）。
      const protocolsNext: Record<string, string[]> = Object.fromEntries(
        Object.entries(draftProtocols).filter(([id, chain]) =>
          JSON.stringify(chain) !== JSON.stringify(hostProtocols[id]))
      );
      const posts: Promise<unknown>[] = [];
      if (dirty) {
        posts.push(postJsonOrThrow(MODELS_PATH, { enabledModelIds: ids }).then(() => { touchedRef.current = false; }));
      }
      if (visionDirty) {
        posts.push(postJsonOrThrow(POOL_PATH, { section: "vision", values: { visionModels: visionNext } })
          .then(() => {
            // 清草稿 + 记在途写入：显示与下次保存的基座立即看到本次结果，
            // 不等快照回显（回显一致后覆盖层自动摘除）。
            setDraftVision({});
            setInflight((current) => ({ ...current, vision: { values: visionNext, at: Date.now() } }));
          }));
      }
      if (thinkingDirty) {
        posts.push(postJsonOrThrow(POOL_PATH, { section: "thinking", values: thinkingNext })
          .then(() => {
            setDraftThinking({});
            setInflight((current) => ({ ...current, thinking: { values: thinkingNext, at: Date.now() } }));
          }));
      }
      if (protocolsDirty) {
        posts.push(postJsonOrThrow(MODELS_PATH, { modelProtocols: protocolsNext })
          .then(() => {
            setDraftProtocols({});
            setInflight((current) => ({ ...current, protocols: { values: protocolsNext, at: Date.now() } }));
          }));
      }
      await Promise.all(posts);
      setJustSaved(true);
      onDone?.();
    } catch (error) {
      setNotice(format(tt("llm.rosterError"), { error: errorText(error) }));
    } finally {
      setBusy(false);
    }
    // 闭包依赖：载荷按当前草稿/宿主构造，任一组变化都得出新闭包。
    // （本仓无 eslint；panel.test F6 纪律——将来启用 lint 需补 exhaustive-deps。）
  }, [busy, ids, dirty, visionDirty, thinkingDirty, protocolsDirty, visionHost, hostProtocols, draftVision, draftThinking, thinkingHost, onDone, tt]);

  const needle = query.trim().toLowerCase();
  // `models` holds its identity between renders - it comes straight off the
  // snapshot object, and the "no list" case resolves to the frozen NO_MODELS
  // rather than a fresh `[]`. So memoising on it plus the search text gives
  // `bulk` dependency values stable by REFERENCE; the earlier
  // `JSON.stringify(...)` deps existed only to fake that stability.
  const visible = useMemo(() => models.filter((model) => {
    if (needle === "") return true;
    return String(model?.id ?? "").toLowerCase().includes(needle)
      || String(model?.name ?? "").toLowerCase().includes(needle);
  }), [needle, models]);
  const tickedCount = visible.filter((model) => modelIsOn(ids, String(model?.id ?? ""))).length;

  /** Apply "tick all" / "untick all" to the VISIBLE rows only. */
  const bulk = useCallback((allOn: boolean) => {
    // Strings, never the `{id, name, vision}` rows: the allow-list is
    // compared against a roster of ids, and an object roster would filter to
    // nothing — "tick all" would have posted the hide-all sentinel.
    const roster = models.map((model) => String(model?.id ?? ""));
    const targets = visible.map((model) => String(model?.id ?? ""));
    touchedRef.current = true;
    setIds(bulkModelsIn(ids, roster, targets, allOn));
    setNotice(null);
  }, [models, visible, ids]);

  return h(
    "div",
    { style: { marginBottom: 14 } },
    // Title and rule were sharing one line with the mechanism sentence, which
    // read as a caption bolted to a heading: a title, then a paragraph, then a
    // value, all in one breath. The rule is still the tail of the title's own
    // sentence and stays; the mechanism paragraph drops to the footnote at the
    // bottom of the block (the same stop the roster uses for its
    // fallback note), where it explains without competing with the heading.
    // The provider-wide thinking default rides here too: it is one constant for
    // every row, so the roster says it ONCE instead of repeating it seven times.
    // The dash is the title's own tail and only appears when a value follows
    // it — a lone `推送到 DSH 的模型 —` trailed off into nothing when the Host
    // declared no thinking default.
    h("p", { style: { margin: "0 0 10px" } },
      h("span", { style: S.sectionTitle }, tt("llm.roster")),
      typeof llm?.thinkingDefault === "string" && llm.thinkingDefault !== ""
        ? h("span", { style: { ...S.muted, fontSize: 12 } },
          ` — ${format(tt("llm.rosterThinkingDefault"), { level: tt(dictKey("llm.level", llm.thinkingDefault)) })}`)
        : null),
    models.length === 0
      ? h("p", { style: S.empty }, tt("llm.rosterEmpty"))
      : h(
          "div",
          null,
          h(
            "div",
            { style: S.rosterTools },
            h("input", {
              type: "search",
              style: { ...S.input, flex: "1 1 200px", width: "auto" },
              value: query,
              placeholder: tt("llm.rosterSearchPlaceholder"),
              "aria-label": tt("llm.rosterSearchPlaceholder"),
              disabled: busy,
              onChange: (event: { target: { value: string } }) => setQuery(event.target.value)
            }),
            // The count LEADS the right-hand cluster - state, then actions -
            // and the bulk buttons share the search box's 32px height, so the
            // row reads as one grouped control instead of four loose ones.
            h("span", {
              style: S.rosterCount,
              title: format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length })
            }, format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length })),
            h("button", {
              type: "button",
              style: S.rosterBulk,
              disabled: busy === true || visible.length === 0,
              onClick: () => bulk(true)
            }, tt("llm.rosterAll")),
            h("button", {
              type: "button",
              style: S.rosterBulk,
              disabled: busy === true || visible.length === 0,
              onClick: () => bulk(false)
            }, tt("llm.rosterNone"))
          ),
          visible.length === 0
            ? h("p", { style: S.empty }, tt("llm.rosterNoMatch"))
            : h("div", { style: S.modelPanel }, h(ModelRoster, {
                models: visible,
                enabledIds: ids,
                busy,
                tt,
                openThinkingId,
                onThinkingOpen: (id: string | null) => setOpenThinkingId(id),
                modelProtocols: effectiveProtocols,
                onChainSlotChange: (id: string, slot: number, value: string) => {
                  // 三槽链草稿（保存时与其它草稿一起落库）。改槽 = 前缀 + 新值，
                  // 后槽保留未被占用的旧线（换槽1 不无谓清空槽2/3）；置空 = 从该槽
                  // 截短。槽1 无空选项（链必非空），防御性忽略。
                  setDraftProtocols((current) => {
                    if (value === "" && slot === 0) return current;
                    const base = [...({ ...hostProtocols, ...current })[id] ?? []];
                    const next: string[] = value === ""
                      ? base.slice(0, slot)
                      : (() => {
                        const head = base.slice(0, slot);
                        if (!head.includes(value)) head.push(value);
                        for (const wire of base.slice(slot + 1)) {
                          if (!head.includes(wire)) head.push(wire);
                        }
                        return head;
                      })();
                    return { ...current, [id]: next };
                  });
                  setNotice(null);
                },
                // One row is toggled against the WHOLE roster, not the
                // filtered view, so an edit survives a later change of the
                // search box.
                onToggle: (id: string) => {
                  touchedRef.current = true;
                  setIds(toggleModelIn(ids, models.map((model) => String(model?.id ?? "")), id));
                  setNotice(null);
                },
                // 可看图在思考面板最底部；改的是草稿（draftVision），保存才 POST
                // 到 vision.visionModels。显示 = 宿主快照 + 草稿合并（勾选的立即
                // 反映到复选框，未保存前不落库）。
                visionIds: (() => {
                  const out = new Set(visionHost);
                  for (const [id, on] of Object.entries(draftVision)) {
                    if (on) out.add(id);
                    else out.delete(id);
                  }
                  return [...out];
                })(),
                onVisionToggle: (id: string, on: boolean) => {
                  setDraftVision((current) => ({ ...current, [id]: on }));
                  setNotice(null);
                },
                // 思考档位：面板内勾选写 draftThinking 草稿，保存时才落库
                // （DSH 对话界面的可选档位 = 保存后的勾选集，经 adapter 覆盖）。
                thinkingById: (() => {
                  const out = { ...thinkingHost };
                  for (const [id, levels] of Object.entries(draftThinking)) out[id] = levels;
                  return out;
                })(),
                onThinkingToggle: (id: string, level: string, onValue: boolean) => {
                  setDraftThinking((current) => {
                    const list = (current[id] ?? thinkingHost[id] ?? []).slice();
                    const next = onValue
                      ? (list.includes(level) ? list : [...list, level])
                      : list.filter((l) => l !== level);
                    return { ...current, [id]: next };
                  });
                  setNotice(null);
                }
              })),
          anyDirty
            ? h(
                "div",
                { style: S.rosterFoot },
                h("button", {
                  type: "button",
                  style: S.primary,
                  disabled: busy === true,
                  onClick: () => void save()
                }, busy ? tt("llm.rosterSaving") : tt("llm.rosterSave")),
                h("button", {
                  type: "button",
                  style: S.button,
                  disabled: busy === true,
                  onClick: () => {
                    // Discard is an explicit return to the Host's value; the
                    // picker may follow the Host again from here on.
                    touchedRef.current = false;
                    setIds(hostIds);
                    setDraftProtocols({});
                    setDraftThinking({});
                    setDraftVision({});
                    setNotice(null);
                  }
                }, tt("llm.rosterDiscard")),
                h("span", { style: { ...S.muted, fontSize: 12 } }, tt("llm.rosterUnsaved"))
              )
            : justSaved
              ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("llm.rosterSaved"))
              : null,
          // The mechanism sentence, at the quietest layer: what ticking a box
          // does and how a newly-catalogued model starts out. It explains the
          // list without holding the heading hostage.
          h("p", { style: { ...S.trendLegend, marginTop: 10 } }, tt("llm.rosterHint")),
          notice !== null ? h("p", { style: S.formError, role: "alert" }, notice) : null
        )
  );
}
