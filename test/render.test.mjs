/**
 * The panel's rendered output, checked against the code the browser loads.
 *
 * The decision tests assert WHICH view renders; nothing asserted WHAT that
 * view says. The known blind spot was a numeric swap — a `WindowRow` that
 * renders `limit/used` instead of `used/limit`, or drops the remaining
 * figure, passed the whole suite. These checks feed arithmetic the reader can
 * verify by hand (12345 of 60000 is 20.575%) into the panel's REAL rendering
 * components and inspect what would reach the screen.
 *
 * There is no DOM and no React here: `panel-render.js` lifts the components
 * out of client.js and evaluates them with a recording `h`, so function
 * components stay uncalled until a check expands them — the tree a check sees
 * is the tree React would receive.
 */
import { render, styles as S, texts, findElement, findAll } from "./panel-render.js";
import { h, surface, reactStandin } from "./client-surface.js";
import { applyChainSlotEdit, lastLevelGuard } from "../src/client/model-picker.ts";
import { poolFor } from "../src/client/composer-usage-pill.ts";
import { errorMessageFrom, concurrencyEnterAction } from "../src/client/api-key-form.ts";
import { results, check, finish } from "./harness.mjs";


/** Identity dictionary: assertions are about WHICH key applies, not its text. */
const tt = (key) => key;

/** Render a lifted component to its element tree (function components uncalled). */
const treeOf = (component, props) => component(props);

/** Collect the text a rendered component would put on screen. */
const rendered = (component, props) => texts(treeOf(component, props));

/** The panel's progress-bar element, wherever it sits in the tree. */
const bar = (tree) => findElement(tree, (props) => props["aria-valuenow"] !== undefined);

// === G0. ToggleSwitch 的 onChange 契约：不带参数调用 ======================
// 事故（2026-10-24）：把 onChange 直接交给 <input>，React 传事件对象进来，调用方
// 按 boolean 收参 → JSON.stringify(HTMLInputElement) 抛 circular structure，
// 面板显示成「网络层失败」。契约是 `() => void`，组件必须自己吞掉事件。
{
  const received = [];
  const tree = treeOf(render.ToggleSwitch, {
    checked: false,
    onChange: (arg) => { received.push(arg); },
    label: "x"
  });
  const input = findAll(tree, (props) => props.type === "checkbox")[0];
  check("ToggleSwitch renders a real checkbox", input !== undefined, "no input[type=checkbox]");
  if (input !== undefined) {
    input.props.onChange({ target: { checked: true } });
    check("the change handler is called with NO argument (the event is swallowed)",
      received.length === 1 && received[0] === undefined, JSON.stringify(received.map(String)));
  }
}

// === A. the quota card's arithmetic is the one the reader can verify ======
// 12345 of 60000 is 20.575%. Any swap of used/limit/remaining turns these
// figures into different numbers, so this block is the anti-mirror for the
// exact bug the decision tests could not see.
{
  const tree = treeOf(render.QuotaCard, {
    label: "pool.window5h",
    window: { limit: 60000, used: 12345, remaining: 47655, resetAt: 1800000000 },
    tt
  });
  const meta = texts(tree).join("\n");
  check("the used figure is the USED count against the limit",
    meta.includes("pool.used 12,345 / 60,000"), meta);
  // The headline and the bar point the SAME way: both are the bare used
  // percentage, so a filled bar and a big figure can never contradict each
  // other (the old "remaining %" headline over a usage bar read as "drained"
  // at 100.0%). No "已用" prefix — four sibling cards would repeat it.
  check("the headline is the bare used percentage",
    meta.includes("20.6%") && !meta.includes("79.4%"), meta);
  check("the raw remaining count is not on the card — the percentage implies it",
    !meta.includes("47,655"), meta);

  const fill = bar(tree);
  check("the bar reports the same percentage to assistive tech",
    Number(fill?.props["aria-valuenow"]) === 20.6, String(fill?.props["aria-valuenow"]));
  const inner = findElement(fill, (props) => typeof props.style?.width === "string");
  check("the bar's width is the same fraction the text shows",
    inner?.props.style.width === "20.575%", String(inner?.props.style.width));
  check("the reset time is rendered when present", meta.includes("pool.reset"), meta);
}

// === B. a window without a reset time stays quiet about resets ============
{
  const out = rendered(render.QuotaCard, {
    label: "pool.window7d",
    window: { limit: 60000, used: 1, remaining: 59999, resetAt: null },
    tt
  });
  check("no reset time means no reset line", !out.includes("pool.reset"), out.join("\n"));
}

// === C. the bar's tone escalates as the window fills ======================
// The thresholds live in the client (70 warn / 90 error); a check hard-coding
// a colour would pass a tone swap. The values come from the lifted S instead.
{
  const fillFor = (used) => {
    const fill = bar(treeOf(render.QuotaCard, {
      label: "l", window: { limit: 60000, used, remaining: 60000 - used, resetAt: null }, tt
    }));
    return findElement(fill, (p) => typeof p.style?.width === "string")?.props.style;
  };
  check("an ordinary window uses the brand fill",
    fillFor(30000).background === S.barFill.background, JSON.stringify(fillFor(30000)));
  check("past 70% the bar turns to the warn fill",
    fillFor(42000).background === S.barFillWarn.background, JSON.stringify(fillFor(42000)));
  check("past 90% the bar turns to the error fill",
    fillFor(54000).background === S.barFillError.background, JSON.stringify(fillFor(54000)));
}

// === D. an empty limit is unknown, never a fake percentage ================
{
  const tree = treeOf(render.QuotaCard, {
    label: "l", window: { limit: 0, used: 0, remaining: 0, resetAt: null }, tt
  });
  check("a zero limit renders as an em dash, not 0.0%", texts(tree).includes("—") && !texts(tree).includes("%"), texts(tree).join("\n"));
  check("the bar's reported value stays a number",
    bar(tree)?.props["aria-valuenow"] !== undefined && Number(bar(tree)?.props["aria-valuenow"]) === 0,
    String(bar(tree)?.props["aria-valuenow"]));
}

// === E. the trend table lists rows in order, with the credited amounts ====
{
  const out = rendered(render.TrendTable, {
    trend: { models: [{ model: "Alpha", credits: 42.5 }, { model: "Beta", credits: 0 }] },
    tt
  });
  const alpha = out.indexOf("Alpha");
  check("the table carries both models", alpha !== -1 && out.includes("Beta"), out.join("\n"));
  check("row order follows the data", alpha !== -1 && alpha < out.indexOf("42.5") && out.indexOf("42.5") < out.indexOf("Beta"),
    out.join("\n"));
  check("a zero-credit row still renders", out.includes("0"), out.join("\n"));
  check("the table is a table, not the empty note", !out.includes("trend.none"), out.join("\n"));
}

// === E2. the trend card visualises which model consumed the most ========
// The bare table earned a card and a per-row bar: each bar is relative to
// the LARGEST consumer, so the top model fills the track and the rest
// shrink proportionally — that is the "who is burning credits" answer.
{
  const tree = treeOf(render.TrendTable, {
    trend: { models: [{ model: "Alpha", credits: 42.5 }, { model: "Beta", credits: 0 }] },
    tt
  });
  check("the trend rows sit inside a card like the quota cards",
    tree.props?.style?.background === S.card.background && tree.props?.style?.borderRadius === S.card.borderRadius,
    JSON.stringify(tree.props?.style ?? {}));
  const bars = findAll(tree, (props) => props["aria-valuenow"] !== undefined);
  // Sub-1% rows draw NO bar: on a linear scale relative to the top consumer
  // their bar is a 1px sliver — a shape carrying no readable information.
  // The name and the absolute number stay (block E pins both).
  check("sub-1% rows draw no bar", bars.length === 1, `found ${bars.length}`);
  const widths = bars.map((bar) => findElement(bar, (p) => typeof p.style?.width === "string")?.props.style?.width);
  check("the biggest consumer fills the track", widths.includes("100%"), JSON.stringify(widths));
  check("the bars report the same fractions to assistive tech",
    bars[0]?.props["aria-valuenow"] === 100,
    bars.map((bar) => bar.props["aria-valuenow"]).join(", "));
  check("the absolute amount still sits beside the model name",
    texts(tree).includes("42.5") && texts(tree).includes("0"), texts(tree).join("\n"));
}

// === E3. the ×N chip mirrors the operator config, ×1 included ============
// The roster marks every configured factor (model-picker, ×0 included);
// the chart used to gate ×1 out, so the same config showed on one surface
// and vanished on the other. A configured factor is a fact — show it.
{
  const tree = treeOf(render.TrendTable, {
    trend: { models: [{ model: "Alpha", credits: 42.5, multiplier: 1 }, { model: "Beta", credits: 3, multiplier: 2 }, { model: "Gamma", credits: 1 }] },
    tt
  });
  const text = texts(tree).join("\n");
  const chips = findAll(tree, (props) => props.title === "trend.multiplierLegend");
  check("a configured ×1 labels the row like any other factor", text.includes("×1"), text);
  check("a non-1 factor still labels the row", text.includes("×2"), text);
  check("every labelled row carries the honesty tooltip", chips.length === 2, String(chips.length));
  const bare = texts(treeOf(render.TrendTable, {
    trend: { models: [{ model: "Alpha", credits: 42.5 }, { model: "Beta", credits: 3 }] },
    tt
  })).join("\n");
  check("unconfigured rows stay unlabelled", !bare.includes("×"), bare);
}

// === F. an empty trend says so instead of rendering an empty table ========
{
  const out = rendered(render.TrendTable, { trend: { models: [] }, tt });
  check("an empty trend shows the empty note", out.includes("trend.none"), out.join("\n"));
  const none = rendered(render.TrendTable, { trend: null, tt });
  check("a missing trend shows the empty note too", none.includes("trend.none"), none.join("\n"));
  const emptyTree = treeOf(render.TrendTable, { trend: { models: [] }, tt });
  check("the empty note sits inside a card too",
    emptyTree.props?.style?.background === S.card.background, JSON.stringify(emptyTree.props?.style ?? {}));
}

// === G. the pool card assembles its own sections ==========================
{
  const pool = {
    name: "通用池", poolType: "default",
    modelIds: ["Model-A", "Model-B"],
    lockedModels: ["Model-C"],
    window5h: { limit: 60000, used: 1, remaining: 59999, resetAt: null },
    window7d: { limit: 600000, used: 2, remaining: 599998, resetAt: null },
    grantBalance: 0
  };
  const out = rendered(render.PoolCard, { pool, tt });
  check("the pool's name is rendered", out.includes("通用池"), out.join("\n"));
  check("a default pool is labelled as such", out.includes("pool.default"), out.join("\n"));
  check("both quota windows are present",
    out.includes("pool.window5h") && out.includes("pool.window7d"), out.join("\n"));
  // 2026-10-27: the 模型与返赠详情 fold is gone — every callable model is
  // configurable in the 接入 API tab, the composer pill footnote carries the
  // grant expiry, and the coverage lists read as noise. Pin the REMOVAL: no
  // fold, no coverage copy, no model chips, even though the snapshot still
  // carries `callableModels`/`lockedModels`/`modelIds` (wire contract).
  check("no details fold, no coverage lists, no model chips",
    !out.includes("pool.details") && !out.includes("pool.callable") && !out.includes("pool.locked")
      && !out.includes("Model-A") && !out.includes("Model-C"), out.join("\n"));
  check("no grant text when the balance is zero", !out.includes("pool.grant"), out.join("\n"));

  const dedicated = rendered(render.PoolCard, { pool: { ...pool, poolType: "dedicated" }, tt });
  check("a dedicated pool is labelled as such", dedicated.includes("pool.dedicated"), dedicated.join("\n"));

  const grantedTree = treeOf(render.PoolCard, {
    pool: { ...pool, grantBalance: 500, nearestGrantExpiry: 1760000000, nearestGrantExpiringBalance: 480 }, tt
  });
  check("a grant balance is rendered when present", texts(grantedTree).includes("pool.grant"), texts(grantedTree).join("\n"));
  // tooltip 活在 title 属性上，texts() 看不见属性——走 findElement 的 props 断言。
  const grantChip = findElement(grantedTree, (props) => typeof props.title === "string" && props.title.startsWith("pool.grant"));
  check("the grant tooltip quotes the nearest expiring grant",
    grantChip !== undefined && grantChip.props.title.startsWith("pool.grantNearest"), String(grantChip?.props.title));
}

// === G2. sections are collapsible card headers, expanded by default ======
// The two content sections live behind a workbuddy-style card header: a
// full-width button (title + rotating chevron) that tucks the body away.
// The header is hook-free — `open`/`onToggle` arrive as props — so the
// toggle is exercised here; `PanelPage` starts both sections expanded.
{
  const children = ["inner"];
  const openTree = treeOf(render.SectionCard, {
    title: "section.pools", open: true, onToggle: () => {}, tt, children
  });
  check("the section sits in a card like the quota cards",
    openTree.props?.style?.background === S.card.background && openTree.props?.style?.borderRadius === S.card.borderRadius,
    JSON.stringify(openTree.props?.style ?? {}));
  const head = findElement(openTree, (props) => props["aria-expanded"] !== undefined);
  check("the section header is a real button", head?.type === "button", String(head?.type));
  check("an open section reports aria-expanded=true", head?.props["aria-expanded"] === true,
    String(head?.props["aria-expanded"]));
  check("the header announces the collapse action",
    head?.props["aria-label"] === "section.collapse: section.pools", String(head?.props["aria-label"]));
  check("the header hands the click to the toggle", typeof head?.props.onClick === "function", "");
  check("an open section renders its body", texts(openTree).includes("inner"), texts(openTree).join("\n"));
  check("an open body is not hidden",
    findElement(openTree, (props) => props.hidden !== undefined)?.props.hidden === false, "");
  const chev = findElement(openTree, (props) => typeof props.viewBox === "string");
  check("the header carries a chevron", chev !== null, "");
  check("the chevron flips when the section is open",
    chev?.props.style?.transform === "rotate(180deg)", String(chev?.props.style?.transform));

  const closedTree = treeOf(render.SectionCard, {
    title: "section.trend", open: false, onToggle: () => {}, tt, children
  });
  const closedHead = findElement(closedTree, (props) => props["aria-expanded"] !== undefined);
  check("a closed section reports aria-expanded=false", closedHead?.props["aria-expanded"] === false,
    String(closedHead?.props["aria-expanded"]));
  check("the header announces the expand action",
    closedHead?.props["aria-label"] === "section.expand: section.trend", String(closedHead?.props["aria-label"]));
  check("a closed section hides its body", !texts(closedTree).includes("inner"), texts(closedTree).join("\n"));
  check("the body stays mounted but hidden when closed",
    findElement(closedTree, (props) => props.hidden !== undefined)?.props.hidden === true, "");
  const closedChev = findElement(closedTree, (props) => typeof props.viewBox === "string");
  check("the chevron points down when the section is closed",
    closedChev?.props.style?.transform === undefined, String(closedChev?.props.style?.transform));
}

// === G3. the step-three provider status is secret-free and stateful ======
// ProviderStatus (key card) speaks only when the key is MISSING (or the
// host is ephemeral); the registration states live in ProviderRegStatus
// (provider card) since the panel grew one card per concern. These render
// with the REAL zh dictionary: the identity `tt` returns the key itself,
// which carries no `{placeholder}` to expand, so composition (the id, the
// source) could not be checked through it.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;

  check("no llm block renders nothing",
    rendered(render.ProviderStatus, { llm: null, tt }).length === 0
      && rendered(render.ProviderStatus, { llm: "x", tt }).length === 0
      && rendered(render.ProviderRegStatus, { llm: null, tt }).length === 0
      && rendered(render.ProviderRegStatus, { llm: "x", tt }).length === 0);

  const off = rendered(render.ProviderStatus, {
    llm: { hasApiKey: false, keySource: null, ephemeral: false, registerProvider: false,
      llmAvailable: false, providerRegistered: false, providerId: "sensenova-suite" },
    tt: ttZh
  });
  check("no key asks for one", off.some((line) => line.includes(zh["llm.noKey"])), off.join("\n"));
  check("the key card does NOT speak for the provider card",
    !off.some((line) => line.includes("未向 DSH 注册")), off.join("\n"));
  // 2026-10-29 真机（sk- 框保存进池、不写面板主 key）：池里有 key 的卡片是
  // 「已配置」，催贴 key 的提示必须静默——否则它催的动作治不了它自己。
  // 不传 poolConfigured（旧调用方/旧行为）仍催，上一条钉住的就是它。
  const poolConfigured = rendered(render.ProviderStatus, {
    llm: { hasApiKey: false, keySource: null, ephemeral: false, registerProvider: false,
      llmAvailable: false, providerRegistered: false, providerId: "sensenova-suite" },
    tt: ttZh,
    poolConfigured: true
  });
  check("pool keys silence the no-key nudge", poolConfigured.length === 0, poolConfigured.join("\n"));

  const regOff = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: false, keySource: null, ephemeral: false, registerProvider: false,
      llmAvailable: false, providerRegistered: false, providerId: "sensenova-suite" },
    tt: ttZh
  });
  check("the opt-in being off is stated",
    regOff.some((line) => line.includes("未向 DSH 注册") && line.includes("开关")), regOff.join("\n"));
  check("the provider id is shown",
    regOff.some((line) => line.includes("sensenova-suite")), regOff.join("\n"));

  const registered = rendered(render.ProviderStatus, {
    llm: { registerProvider: true,
      llmAvailable: true, providerRegistered: true, providerId: "sensenova-suite",
      modelCount: 3, visionCount: 1,
      // A defensive field the Host never sends: it must never reach the screen.
      value: "sk-secret-value" },
    poolConfigured: true,
    tt: ttZh
  });
  const regOn = rendered(render.ProviderRegStatus, {
    llm: { registerProvider: true,
      llmAvailable: true, providerRegistered: true, providerId: "sensenova-suite",
      modelCount: 3, visionCount: 1, value: "sk-secret-value" },
    tt: ttZh
  });
  // 2026-10-27: the happy path is SILENT — a configured pool and a registered
  // provider both render nothing (the counts said nothing the 接入 API tab's
  // own model list didn't). The secret guard stays as a regression tripwire:
  // if a status line ever comes back, the key value must still never ride it.
  // (2026-11-03: the nudge tracks the POOL only — the primary-key concept was
  // dismantled, so poolConfigured is the whole story.)
  check("a configured pool is silent", registered.length === 0, registered.join("\n"));
  check("a fully registered provider is silent", regOn.length === 0, regOn.join("\n"));
  check("the key value itself never renders",
    !registered.some((line) => line.includes("sk-secret-value"))
      && !regOn.some((line) => line.includes("sk-secret-value")), regOn.join("\n"));

  const fromEnv = rendered(render.ProviderStatus, {
    llm: { registerProvider: true,
      llmAvailable: true, providerRegistered: true, providerId: "p", modelCount: 0, visionCount: 0 },
    tt: ttZh
  });
  check("an empty pool renders the nudge (its only remaining line)",
    fromEnv.length === 1 && fromEnv.some((line) => line.includes(zh["llm.noKey"])), fromEnv.join("\n"));

  const noService = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: false, providerRegistered: false, providerId: "p" },
    tt: ttZh
  });
  check("enabled without an llm service says so",
    noService.some((line) => line.includes(zh["llm.noService"])), noService.join("\n"));

  const failed = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: true, providerRegistered: false, providerId: "p", providerError: "DUPLICATE_ADAPTER" },
    tt: ttZh
  });
  check("a failed registration shows the error line",
    failed.some((line) => line.includes("DUPLICATE_ADAPTER")), failed.join("\n"));

  // The switch is ticked, no error, service present, but registration has
  // not landed: the line must NOT claim the switch is off — that is the
  // same visibility lie the account editor used to tell after a "forget".
  const pending = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: true, providerRegistered: false, providerId: "p" },
    tt: ttZh
  });
  // Match a placeholder-free substring of the pending line, not the raw
  // dictionary string (which still carries the unfilled `{id}`).
  check("a ticked switch without a landed registration says pending, not off",
    pending.some((line) => line.includes("开关已开但注册尚未生效"))
      && !pending.some((line) => line.includes("未向 DSH 注册")), pending.join("\n"));

  // A specific failure outranks a capability gap: both llmAvailable false
  // and a providerError present must show the error, not the capability line.
  const both = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: false, providerRegistered: false, providerId: "p", providerError: "DUPLICATE_ADAPTER" },
    tt: ttZh
  });
  check("a specific error outranks the no-service line",
    both.some((line) => line.includes("DUPLICATE_ADAPTER"))
      && !both.some((line) => line.includes(zh["llm.noService"])), both.join("\n"));
}

// === G4. the model roster: which rows exist, and which are ticked ==========
// The picker's rows are the single source of truth for "what could this key be
// pushed": a curated id that no longer exists must never become a checkbox, and
// each checkbox state must be exactly what the Host's allow-list says. The row
// is hook-free, so the render suite drives the real one.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const roster = [
    { id: "nova-flash-lite", name: "Nova Flash Lite", vision: false },
    { id: "nova-vl", name: "Nova VL", vision: true },
    { id: "nova-pro", name: "Nova Pro", vision: false }
  ];
  const treeOfRoster = (enabledIds, extra = {}) =>
    treeOf(render.ModelRoster, { models: roster, enabledIds, tt: ttZh, ...extra });
  const boxes = (tree) => findAll(tree, (props) => props.type === "checkbox").map((el) => el.props);

  const allOn = treeOfRoster([]);
  const allOnTexts = texts(allOn);
  check("every catalogue entry becomes one tickable row", boxes(allOn).length === 3,
    `found ${boxes(allOn).length} checkboxes`);
  check("row order follows the catalogue, not the allow-list",
    (() => {
      const flat = texts(allOn).join(" ");
      const a = flat.indexOf("Nova Flash Lite");
      const b = flat.indexOf("Nova VL");
      const c = flat.indexOf("Nova Pro");
      return a !== -1 && b !== -1 && c !== -1 && a < b && b < c;
    })(), texts(allOn).join("\n"));
  check("an empty allow-list ticks every model",
    JSON.stringify(boxes(allOn).map((props) => props.checked)) === JSON.stringify([true, true, true]),
    JSON.stringify(boxes(allOn).map((props) => props.checked)));

  const partial = treeOfRoster(["nova-pro", "nova-vl"]);
  check("a curated allow-list ticks exactly those models, in row order",
    JSON.stringify(boxes(partial).map((props) => props.checked)) === JSON.stringify([false, true, true]),
    JSON.stringify(boxes(partial).map((props) => props.checked)));

  const none = treeOfRoster([surface.helpers.HIDE_ALL_MODELS]);
  check("the hide-all sentinel unticks every model",
    JSON.stringify(boxes(none).map((props) => props.checked)) === JSON.stringify([false, false, false]),
    JSON.stringify(boxes(none).map((props) => props.checked)));

  // 2026-10-27 口径：可看图不是行内徽章——它住进「模型设置」面板（打开才画），
  // 勾选状态只跟 visionIds（pool.json vision 分区）走，与行是否被勾选无关。
  // 旧「vision 徽章」钉随徽章移除而退役；findAll 的回调拿到的是 props，不是
  // 元素，所以识别勾选框走 aria-label、对齐走 style.marginLeft。
  const visionOpen = treeOfRoster([], {
    openThinkingId: "nova-vl", onThinkingToggle: () => {}, onThinkingOpen: () => {},
    visionIds: ["nova-vl"], onVisionToggle: () => {}
  });
  const visionBoxes = findAll(visionOpen, (props) => typeof props["aria-label"] === "string" && props["aria-label"].includes("识图"));
  check("the open panel shows the vision checkbox exactly for visionIds",
    visionBoxes.length === 1 && visionBoxes.every((el) => el.props.checked === true),
    JSON.stringify(visionBoxes.map((el) => [el.props["aria-label"], el.props.checked])));
  check("a closed panel draws no vision control",
    texts(allOn).every((line) => line !== zh["llm.rosterVision"]), texts(allOn).join("\n"));
  const visionUnticked = treeOfRoster([surface.helpers.HIDE_ALL_MODELS], {
    openThinkingId: "nova-vl", onThinkingToggle: () => {}, onThinkingOpen: () => {},
    visionIds: ["nova-vl"], onVisionToggle: () => {}
  });
  check("an unticked row keeps its vision checkbox state",
    findAll(visionUnticked, (props) => typeof props["aria-label"] === "string" && props["aria-label"].includes("识图"))
      .every((el) => el.props.checked === true),
    "vision follows visionIds, not the allow-list tick");

  const busy = treeOfRoster(["nova-vl"], { busy: true });
  check("a save in flight disables every checkbox",
    boxes(busy).every((props) => props.disabled === true),
    JSON.stringify(boxes(busy).map((props) => props.disabled)));
  check("an idle roster leaves the checkboxes live",
    boxes(allOn).every((props) => props.disabled !== true));

  // Each box hands its edit back to the picker; without the callback a row is
  // display-only and the allow-list could not be changed one model at a time.
  const withToggle = treeOfRoster(["nova-vl"], { onToggle: (id) => id });
  const toggles = boxes(withToggle).map((props) => props.onChange);
  check("every checkbox carries its edit handler",
    toggles.length === 3 && toggles.every((fn) => typeof fn === "function"),
    JSON.stringify(toggles.map((fn) => typeof fn)));
  check("a roster without a handler stays display-only",
    boxes(allOn).every((props) => props.onChange === undefined));

  check("a checkbox announces the model name to assistive tech",
    JSON.stringify(boxes(allOn).map((props) => props["aria-label"])) === JSON.stringify(["Nova Flash Lite", "Nova VL", "Nova Pro"]),
    JSON.stringify(boxes(allOn).map((props) => props["aria-label"])));

  check("a missing display name falls back to the id",
    texts(treeOf(render.ModelRoster, { models: [{ id: "nova-bare" }], enabledIds: [], tt })).includes("nova-bare"),
    texts(treeOf(render.ModelRoster, { models: [{ id: "nova-bare" }], enabledIds: [], tt })).join("\n"));

  check("a curated id that is no longer in the catalogue draws no row",
    boxes(treeOf(render.ModelRoster, { models: roster, enabledIds: ["ghost-model"], tt })).length === 3,
    String(boxes(treeOf(render.ModelRoster, { models: roster, enabledIds: ["ghost-model"], tt })).length));

  // The WorkBuddy-shape additions: the parameter line and the pseudo rate.
  // The 1048576 → "1M" reading is exactly the `1049k` placeholder bug the old
  // decimal rounding drew, so it stays pinned here and in tokenSize below.
  const rich = [{
    id: "deepseek-v4-flash", name: "deepseek-v4-flash", vision: false, available: false, quotaExhausted: true,
    contextWindow: 1048576, maxOutputLength: 65536, multiplier: 10
  }];
  const richTree = treeOf(render.ModelRoster, { models: rich, enabledIds: [], tt: ttZh });
  const richText = texts(richTree).join("\n");
  check("1048576 tokens reads as 1M — never the decimal 1049k",
    richText.includes("1M 上下文") && !richText.includes("1049k"), richText);
  check("the platform-declared output ceiling lands in the parameter line",
    richText.includes("最大输出 64K"), richText);
  check("the row no longer quotes a thinking meta line (it moved into the dropdown panel)",
    !richText.includes("思考 关闭") && !richText.includes(zh["llm.metaLevels"]), richText);
  check("the provider-wide default never repeats per row (it lives in the header)",
    !richText.includes("默认思考强度") && !richText.includes(zh["llm.rosterThinkingDefault"]), richText);
  check("the pseudo multiplier labels the row ×N", richText.includes("×10"), richText);
  check("a quota-exhausted row names why it cannot answer",
    richText.includes(zh["llm.rosterExhausted"]), richText);
  check("a row without declared figures draws no parameter line",
    texts(allOn).every((line) => !line.includes("上下文")), texts(allOn).join("\n"));

  // 思考档位化为「下拉（多选面板）」：点击 chip 展开该模型行的面板（六档复选
  // + 右侧「可看图」+ 独立一行协议）。已勾选的档位以复选状态呈现；未展开则
  // 面板与「可看图」都不出现在行内。列表只引用目录声明的元信息行的逆命题——这一举动。
  {
    const thinkingTree = treeOf(render.ModelRoster, {
      models: rich, enabledIds: [], tt: ttZh,
      thinkingById: { "deepseek-v4-flash": ["off", "medium"] },
      onThinkingToggle: () => {},
      visionIds: [], onVisionToggle: () => {},
      openThinkingId: "deepseek-v4-flash", onThinkingOpen: () => {},
      modelProtocols: { "deepseek-v4-flash": ["anthropic", "responses", "chat-completions"] }, onChainSlotChange: () => {},
    });
    const thinkingTexts = texts(thinkingTree).join("\n");
    const levelBoxes = findAll(thinkingTree, (p) => p.type === "checkbox")
      .filter((el) => (el.props["aria-label"] ?? "").includes("档位"));
    check("opening the thinking panel shows its title and the five labelled choices",
      thinkingTexts.includes(zh["llm.rosterThinking"])
        && ["关闭", "低", "中", "高", "最高"].every((word) => thinkingTexts.includes(word))
        && !thinkingTexts.includes("极高"),
      thinkingTexts);
    check("the thinking panel quotes only the user's ticked levels as checked",
      JSON.stringify(levelBoxes.map((el) => el.props.checked)) === JSON.stringify([true, false, true, false, false]),
      JSON.stringify(levelBoxes.map((el) => [el.props["aria-label"], el.props.checked])));
    check("the vision checkbox sits ON the thinking row, right-aligned",
      (() => {
        const visionBox = findAll(thinkingTree, (props) => typeof props["aria-label"] === "string" && props["aria-label"].includes("识图"));
        const rightAligned = findAll(thinkingTree, (props) => props.style?.marginLeft === "auto");
        return visionBox.length === 1 && rightAligned.length >= 1;
      })(), texts(thinkingTree).join("\n"));
    check("the three chain slot selects live INSIDE the open panel on their own line",
      (() => {
        const slots = findAll(thinkingTree, (props) => typeof props["aria-label"] === "string" && props["aria-label"].includes("协议"));
        return slots.length === 3
          && slots.map((el) => el.props["aria-label"]).join(",") === "deepseek-v4-flash 协议1,deepseek-v4-flash 协议2,deepseek-v4-flash 协议3"
          && slots.every((el) => el.props.disabled !== true);
      })(), texts(thinkingTree).join("\n"));
    check("slot options follow the no-duplicate rule (chosen wires vanish from later slots)",
      (() => {
        const slots = findAll(thinkingTree, (props) => typeof props["aria-label"] === "string" && props["aria-label"].includes("协议"));
        // h shim 把 children 放在元素上（el.children），不在 props 上。
        const optionsOf = (el) => (Array.isArray(el.children) ? el.children : []).map((o) => o?.props?.value);
        return JSON.stringify(optionsOf(slots[0])) === JSON.stringify(["anthropic", "responses", "chat-completions"])
          && JSON.stringify(optionsOf(slots[1])) === JSON.stringify(["", "responses", "chat-completions"])
          && JSON.stringify(optionsOf(slots[2])) === JSON.stringify(["", "chat-completions"]);
      })(), texts(thinkingTree).join("\n"));
    check("only a slot whose PREDECESSOR is unfilled is disabled (a blanked slot itself stays editable)",
      (() => {
        const shortTree = treeOf(render.ModelRoster, {
          models: rich, enabledIds: [], tt: ttZh,
          onThinkingToggle: () => {}, visionIds: [], onVisionToggle: () => {},
          openThinkingId: "deepseek-v4-flash", onThinkingOpen: () => {},
          modelProtocols: { "deepseek-v4-flash": ["responses"] }, onChainSlotChange: () => {},
        });
        const slots = findAll(shortTree, (props) => typeof props["aria-label"] === "string" && props["aria-label"].includes("协议"));
        // 链长 1：槽 2 空着但必须可编辑（否则置空后永远填不回去——2026-10-31 他报的 bug）；
        // 槽 3 才因前一槽未填而禁用。
        return slots.length === 3 && slots[0].props.disabled !== true
          && slots[1].props.disabled !== true && slots[2].props.disabled === true;
      })(), texts(thinkingTree).join("\n"));
    check("a chat in the prefix disables the slots after it (real-time narrowing, 2026-10-31)",
      (() => {
        const chatTree = treeOf(render.ModelRoster, {
          models: rich, enabledIds: [], tt: ttZh,
          onThinkingToggle: () => {}, visionIds: [], onVisionToggle: () => {},
          openThinkingId: "deepseek-v4-flash", onThinkingOpen: () => {},
          modelProtocols: { "deepseek-v4-flash": ["responses", "chat-completions"] }, onChainSlotChange: () => {},
        });
        const slots = findAll(chatTree, (props) => typeof props["aria-label"] === "string" && props["aria-label"].includes("协议"));
        // chat 无降级条件、其后槽位死位：槽 3 禁用且为空；chat 自己的槽（槽 2）保持可编辑。
        return slots.length === 3 && slots[0].props.disabled !== true && slots[1].props.disabled !== true
          && slots[2].props.disabled === true && slots[2].props.value === "";
      })(), texts(thinkingTree).join("\n"));
    check("applyChainSlotEdit: chat selection narrows in place (post-chat wires dropped)",
      JSON.stringify(applyChainSlotEdit(["anthropic", "responses", "chat-completions"], 0, "chat-completions")) === JSON.stringify(["chat-completions"])
        && JSON.stringify(applyChainSlotEdit(["anthropic", "responses", "chat-completions"], 1, "chat-completions")) === JSON.stringify(["anthropic", "chat-completions"]),
      "slot0/slot1 chat edits");
    check("applyChainSlotEdit: non-chat edits keep the keep-unused-tail semantics",
      JSON.stringify(applyChainSlotEdit(["anthropic", "responses", "chat-completions"], 0, "responses")) === JSON.stringify(["responses", "chat-completions"])
        && JSON.stringify(applyChainSlotEdit(["anthropic", "responses"], 2, "")) === JSON.stringify(["anthropic", "responses"]),
      "tail-keep + blank");
    check("lastLevelGuard: the last remaining level cannot be unchecked (D1A, 2026-11-04)",
      lastLevelGuard(["high"], "high") === true
        && lastLevelGuard(["off", "high"], "high") === false
        && lastLevelGuard(["high"], "off") === false
        && lastLevelGuard(undefined, "off") === false
        && lastLevelGuard([], "off") === false,
      "[] 与 undefined 必须不设防——零档位没有拼法，守卫只锁「只剩一档」");
    check("poolFor: a drained covering pool yields to a live one, liveness before dedicated (T1)",
      (() => {
        const drainedGeneral = { id: "pg", poolType: "default", modelIds: ["m"], window5h: { limit: 100, used: 100 }, window7d: null };
        const drainedDedicated = { id: "pd", poolType: "dedicated", modelIds: ["m"], window5h: { limit: 100, used: 100 }, window7d: null };
        const liveGeneral = { id: "pg-live", poolType: "default", modelIds: ["m"], window5h: { limit: 100, used: 10 }, window7d: null };
        const liveDedicated = { id: "pd-live", poolType: "dedicated", modelIds: ["m"], window5h: { limit: 100, used: 10 }, window7d: null };
        return poolFor([drainedGeneral, liveDedicated], "m", "sensenova-suite") === liveDedicated
          && poolFor([drainedDedicated, liveGeneral], "m", "sensenova-suite") === liveGeneral
          && poolFor([drainedDedicated, drainedGeneral], "m", "sensenova-suite") === drainedDedicated
          && poolFor([{ ...liveGeneral, window5h: { limit: 0, used: 0 } }], "m", "sensenova-suite")?.id === "pg-live";
      })(),
      "满表让位给有余额池（活性先于专属）；limit 0 是 unknown 不算耗尽——pill 与 picker 不得对同一事实各执一词");
    // U11-T3（2026-11-05）：saveConcurrency/act 的错误文案判定与并发框回车
    // 动作抽成导出纯函数后的回归钉——D2（「无法连接本机 Host」吞宿主内部错）
    // 与 D3（回车隐式提交误报 sk- 红字）都曾各漂一次，无钉即会再漂。组件内
    // 的 JSX 接线（preventDefault/save 调用）仍由 render-dom 在构建轮验证。
    check("errorMessageFrom: non-JSON 4xx 给换路由文案、其余原文上屏、空/非 Error 回落网络文案 (D2)",
      errorMessageFrom(new Error("POST /pool → non-JSON HTTP 404"), "网络文案", "换路由文案") === "换路由文案"
        && errorMessageFrom(new Error("宿主内部错误原文"), "网络文案", "换路由文案") === "宿主内部错误原文"
        && errorMessageFrom(new Error(""), "网络文案", "换路由文案") === "网络文案"
        && errorMessageFrom(undefined, "网络文案", "换路由文案") === "网络文案",
      "act() 与 saveConcurrency 共用此判定——对偶由单源保证，不再各自手写正则");
    check("concurrencyEnterAction: Enter 一律吞掉（防外层 form 隐式提交）、dirty 才保存 (D3)",
      concurrencyEnterAction("Enter", true) === "save"
        && concurrencyEnterAction("Enter", false) === "swallow"
        && concurrencyEnterAction("Escape", true) === "none"
        && concurrencyEnterAction("Escape", false) === "none",
      "swallow=只 preventDefault 不保存——非 dirty 的 Enter 也不许冒泡成 sk- 误报");
    const unopened = treeOf(render.ModelRoster, {
      models: rich, enabledIds: [], tt: ttZh,
      thinkingById: { "deepseek-v4-flash": ["off"] },
      onThinkingToggle: () => {},
      visionIds: ["deepseek-v4-flash"], onVisionToggle: () => {},
      onThinkingOpen: () => {}
    });
    check("a closed thinking panel draws no panel body for it",
      !texts(unopened).includes(zh["llm.rosterThinkingLevels"] + "：")
        && !texts(unopened).includes(zh["llm.rosterVision"])
        && findAll(unopened, (props) => typeof props["aria-label"] === "string" && props["aria-label"].includes("档位")).length === 0,
      texts(unopened).join("\n"));
  }
  const tokenSize = surface.helpers.tokenSize;
  check("tokenSize keeps decimal and binary figures at home",
    tokenSize(1048576) === "1M" && tokenSize(262144) === "256K" &&
    tokenSize(128000) === "128K" && tokenSize(65536) === "64K" &&
    tokenSize(0) === "" && tokenSize("junk") === "",
    [tokenSize(1048576), tokenSize(262144), tokenSize(128000), tokenSize(65536), tokenSize(0)].join("/"));

  check("an empty catalogue draws no rows at all",
    boxes(treeOf(render.ModelRoster, { models: [], enabledIds: [], tt })).length === 0);

  check("a junk models value reads as an empty catalogue",
    boxes(treeOf(render.ModelRoster, { models: "nope", enabledIds: [], tt })).length === 0);
}

// === G5. the exhaustion notice explains WHY models vanish and WHEN back ===
// When a pool hits zero the host drops its models from the picker; without this
// line the reader sees models disappear with no cause or recovery expectation.
// The component is hook-free and reads only the snapshot's pools, so the render
// suite drives the real one. It must stay silent when nothing is exhausted, and
// must surface the EARLIEST reset among the exhausted windows.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const when = surface.helpers.when;

  const clean = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 1, remaining: 99, resetAt: null }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } }
  ] }, tt: ttZh });
  check("a fully-stocked plan renders no exhaustion notice", clean.length === 0, clean.join("\n"));

  const exhausted = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 },
      window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } }
  ] }, tt: ttZh });
  check("an exhausted pool surfaces the notice",
    exhausted.some((line) => line.includes("部分积分池已耗尽") && line.includes("暂不可选")), exhausted.join("\n"));
  check("the notice carries the earliest reset time",
    exhausted.some((line) => line.includes(when(1800003600))), exhausted.join("\n"));
  check("the notice is marked as a status role for assistive tech",
    treeOf(render.PoolExhaustionNotice, { pools: { pools: [
      { window5h: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } }
    ] }, tt: ttZh })?.props?.role === "status");

  // Two exhausted windows across pools: the EARLIEST reset wins, not the latest.
  const two = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 100, remaining: 0, resetAt: 1800007200 }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } },
    { window5h: { limit: 100, used: 1, remaining: 99, resetAt: null }, window7d: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 } }
  ] }, tt: ttZh });
  check("the earliest of multiple exhausted resets is shown",
    two.some((line) => line.includes(when(1800003600))) && !two.some((line) => line.includes(when(1800007200))),
    two.join("\n"));

  // A window whose limit is unknown is NOT drained: the host skips such a pool
  // for the same reason (limit 0 is a shape drift, not a reading). A red banner
  // over an unquantified pool would be a claim the data never made.
  const drift = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 0, used: 0, remaining: 0, resetAt: null }, window7d: { limit: 0, used: 0, remaining: 0, resetAt: null } }
  ] }, tt: ttZh });
  check("a window with an unknown limit is not reported as exhausted", drift.length === 0, drift.join("\n"));

  // The banner answers "which models can I not pick", and under the all-pools
  // rule that is NO LONGER the same question as "which meters read zero": the
  // host also lists a model in its dedicated pool, so a drained general pool can
  // block nothing at all. `llm.quotaBlockedModelIds` is the authoritative answer
  // and the only thing that may raise the banner when it is present.
  const SOON = 1800003600;
  const LATE = 1800007200;
  const drainedGeneral = {
    modelIds: ["m1", "m2"],
    window5h: { limit: 100, used: 100, remaining: 0, resetAt: SOON },
    window7d: { limit: 100, used: 1, remaining: 99, resetAt: null }
  };
  const silent = rendered(render.PoolExhaustionNotice, {
    pools: { pools: [drainedGeneral] }, tt: ttZh, blockedModelIds: []
  });
  check("a drained pool that blocks no model raises no banner",
    silent.length === 0, silent.join("\n"));

  const loud = rendered(render.PoolExhaustionNotice, {
    pools: { pools: [drainedGeneral] }, tt: ttZh, blockedModelIds: ["m1"]
  });
  check("the banner follows the host's blocked set, not the meters alone",
    loud.some((line) => line.includes("部分积分池已耗尽") && line.includes(when(SOON))),
    loud.join("\n"));

  // Blocked ids that belong to OTHER pools must not resurrect this pool's
  // banner: the drained meter says nothing about a model it does not name.
  const foreign = rendered(render.PoolExhaustionNotice, {
    pools: { pools: [drainedGeneral] }, tt: ttZh, blockedModelIds: ["elsewhere"]
  });
  check("a drained pool raises nothing when the blocked models belong to another pool",
    foreign.length === 0, foreign.join("\n"));

  // And the reset clock must come from a pool that actually blocks something —
  // quoting the earliest drained meter would promise recovery at a time that
  // does nothing for the model the banner is about.
  const twoDrained = rendered(render.PoolExhaustionNotice, {
    pools: { pools: [
      { modelIds: ["a"], window5h: { limit: 100, used: 100, remaining: 0, resetAt: LATE }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } },
      { modelIds: ["b"], window5h: { limit: 100, used: 100, remaining: 0, resetAt: SOON }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } }
    ] }, tt: ttZh, blockedModelIds: ["a"]
  });
  check("the quoted reset belongs to the pool that blocks the model, not the earliest drained one",
    twoDrained.some((line) => line.includes(when(LATE))) && !twoDrained.some((line) => line.includes(when(SOON))),
    twoDrained.join("\n"));
}

// === G6. a zeroed quota window is labelled "已耗尽", not just 0 ============
// The bare "0 / 100%" left the reader to infer exhaustion; a chip names it, and
// the reset line is suppressed on that window (the notice above carries recovery).
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const when = surface.helpers.when;
  const tree = treeOf(render.QuotaCard, {
    label: "pool.window5h",
    window: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 },
    tt: ttZh
  });
  check("a zeroed window is labelled 已耗尽",
    texts(tree).includes(zh["pool.exhausted"]), texts(tree).join("\n"));
  // The reset line must NOT appear on the exhausted window (the notice owns it).
  check("the exhausted window does not also print its own reset line",
    !texts(tree).includes(zh["pool.reset"]), texts(tree).join("\n"));

  const ok = treeOf(render.QuotaCard, {
    label: "pool.window7d",
    window: { limit: 100, used: 1, remaining: 99, resetAt: 1800003600 },
    tt: ttZh
  });
  check("a non-zero window keeps its reset line and no exhausted chip",
    texts(ok).includes(zh["pool.reset"].replace("{time}", when(1800003600))) && !texts(ok).includes(zh["pool.exhausted"]),
    texts(ok).join("\n"));
  // 1800003600 is 2027-01-15, months from now, so the day must travel with the
  // time. The old assertion pinned the bare "重置 17:00", which read as "resets
  // later TODAY" — the weekly-reset bug.
  //
  // Both sides derive from the same epoch: `when()` renders in the runner's
  // LOCAL timezone, and pinning "01-15 17:00" is +0800's rendering — that made
  // this suite red on every UTC runner (the §30 gate incident).
  const reset = when(1800003600);
  const timeOnly = reset.split(" ").pop();
  check("a cross-day weekly reset carries its MM-DD date",
    texts(ok).join("\n").includes(reset) && !texts(ok).join("\n").includes(zh["pool.reset"].replace("{time}", timeOnly)),
    texts(ok).join("\n"));
}

// === G7. a reset clock that crosses midnight carries its day ==============
// `clock` yields HH:MM only. That is honest for the 5-hour window, but it
// rendered the WEEKLY reset — an absolute instant days away — as "重置 18:10",
// which reads as "today at 18:10". `when` keeps the compact form on the current
// local day and adds the MM-DD date once the instant falls on another day.
{
  const when = surface.helpers.when;
  const pad = (value) => String(value).padStart(2, "0");
  // A local instant `daysOut` days from now, at hour:minute.
  const at = (daysOut, hour, minute) => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysOut, hour, minute).getTime() / 1000;
  };

  check("a reset still due today stays a compact HH:MM", when(at(0, 18, 10)) === "18:10", when(at(0, 18, 10)));

  const tomorrow = at(1, 18, 10);
  const tomorrowDate = new Date(tomorrow * 1000);
  check("a reset on another day carries its MM-DD date",
    when(tomorrow) === `${pad(tomorrowDate.getMonth() + 1)}-${pad(tomorrowDate.getDate())} 18:10`,
    when(tomorrow));

  const farOff = 1800003600;
  const farOffDate = new Date(farOff * 1000);
  check("a far-off weekly reset still carries its MM-DD date",
    when(farOff) === `${pad(farOffDate.getMonth() + 1)}-${pad(farOffDate.getDate())} ${pad(farOffDate.getHours())}:${pad(farOffDate.getMinutes())}`,
    when(farOff));

  check("a junk reset time degrades to the em dash",
    when(null) === "—" && when(0) === "—" && when(-1) === "—",
    `${when(null)}|${when(0)}|${when(-1)}`);

  // The card and the notice agree with the helper they share.
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const weeklyCard = texts(treeOf(render.QuotaCard, {
    label: "pool.window7d",
    window: { limit: 100, used: 1, remaining: 99, resetAt: 1800003600 },
    tt: ttZh
  })).join(" ");
  check("the weekly quota card prints the date-aware reset",
    weeklyCard.includes(`重置 ${when(1800003600)}`), weeklyCard);

  const notice = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 1, remaining: 99, resetAt: null },
      window7d: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 } }
  ] }, tt: ttZh });
  check("the exhaustion notice carries the same date-aware weekly reset",
    notice.some((line) => line.includes(when(1800003600))), notice.join("\n"));
}

// === G8. a drifted payload degrades to a line, never a crash ==============
// The Host flags top-level shape drift but still passes the data through, so
// a pool row whose window is absent — or a trend block with no models — must
// render nothing/empty instead of throwing and blanking the whole panel. One
// malformed pool must not take the quota view (and its shape warning) down.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;

  check("a quota window that is not an object renders nothing",
    texts(treeOf(render.QuotaCard, { label: "pool.window5h", window: null, tt: ttZh })).length === 0
      && texts(treeOf(render.QuotaCard, { label: "pool.window5h", window: undefined, tt: ttZh })).length === 0,
    texts(treeOf(render.QuotaCard, { label: "pool.window5h", window: null, tt: ttZh })).join("\n"));

  const barePool = rendered(render.PoolCard, {
    pool: { name: "通用池", poolType: "default", grantBalance: 0 }, tt: ttZh
  });
  check("a pool missing both windows still renders its identity",
    barePool.includes("通用池") && barePool.includes(zh["pool.default"]), barePool.join("\n"));

  const emptyTrend = rendered(render.TrendTable, { trend: {}, tt: ttZh });
  check("a trend block without models shows the empty note, not a crash",
    emptyTrend.includes(zh["trend.none"]), emptyTrend.join("\n"));
}

// === H. the rendering came from the shipped client ========================
// Reaching here means every extraction marker was found. These checks pin the
// lifted pieces themselves, so a refactor that silently empties one of them
// cannot read as a green suite.
{
  check("the style tokens were lifted from the client", S.card?.borderRadius === 12 && S.bar?.height === 6,
    JSON.stringify(S.card ?? {}));
  check("the number formatter was lifted", render.PoolCard instanceof Function && render.TrendTable instanceof Function
    && render.QuotaCard instanceof Function);
  check("count renders its input unchanged for small numbers",
    rendered(render.TrendTable, { trend: { models: [{ model: "m", credits: 12.345 }] }, tt }).includes("12.35"),
    "count(12.345) should round to 2 places");

  // === H2. the first frame says "loading", not "sign in" ==================
  // `viewOf(null, null)` reads as needsSetup, so the OLD PanelPage rendered
  // AccountForm for the whole first poll — `panel.loading` was dead code, and
  // a configured user saw the sign-in form flash on every mount. The
  // `loadedOnce` gate (set in the load's finally) is invisible to `viewOf`;
  // only driving the mounted page proves the gate is wired. The stand-in
  // returns useState's INITIAL value, so this is the true first frame. The
  // tab bar is part of it: the loading / error / setup states live INSIDE the
  // quota tab, so the api and multimodal tabs (both independent of the Token
  // Plan console) stay reachable before a snapshot lands.
  {
    const firstFrame = rendered(render.PanelPage, {
      onClose: () => {}, tt, localeSubscribe: undefined
    });
    check("the first frame shows the loading line", firstFrame.includes("panel.loading"),
      firstFrame.join("\n"));
    check("the first frame does NOT show the sign-in form", !firstFrame.includes("auth.title"),
      firstFrame.join("\n"));
    // The plugin's name is printed by the SHELL, 32px above this card's own
    // section (`.detailSections`' margin-top). The card used to print it a
    // second time in its header, so the same string appeared twice on one
    // screen with a gap in between. `tt` is the identity here, so a surviving
    // call site shows up as the literal key.
    check("the card body does not restate the plugin name",
      !firstFrame.includes("panel.title"), firstFrame.join("\n"));
    check("the tab bar renders before the first snapshot lands",
      firstFrame.includes("tab.quota") && firstFrame.includes("tab.api") && firstFrame.includes("tab.multimodal"),
      firstFrame.join("\n"));
  }

  // === H2b. quota-only copy never leaks into the api/multimodal header ======
  // The pinned header is now a SHELL: its right cluster is produced by
  // `HeaderStatus`, which each tab feeds with its own facts. The renewal chip
  // ("令牌自动续期中") and the stale-data banner ("读取失败") describe the
  // console login token, which the api tab (an API key) and the multimodal tab
  // (its own credential line) have nothing to say about. This pin guards the
  // exact regression the demotion was meant to prevent: a quota-only chip
  // growing back into a "global" header. It mirrors the raccoon-leak pin at
  // group J (render.test.mjs:~837) — the guard that stopped the second
  // upstream borrowing the Token Plan's rate tooltip, kept so the shape cannot
  // re-form.
  {
    const quotaChip = h("span", { style: {}, title: "x" }, "auth.selfRenew");
    const quotaFailure = { message: "boom" };

    // Quota: chip + banner ARE expected.
    const quotaCluster = rendered(render.HeaderStatus, {
      activeTab: "quota", hasData: true, updatedAt: 1_700_000_000_000,
      failure: quotaFailure, authChip: quotaChip, tt, onRefreshQuota: () => {}
    });
    check("quota header carries the renewal chip", quotaCluster.includes("auth.selfRenew"), quotaCluster.join("\n"));
    check("quota header carries the stale-data banner", quotaCluster.includes("panel.error"), quotaCluster.join("\n"));

    // API: NEITHER the chip nor the banner may appear — it is a different
    // credential, not the console grant the chip speaks to.
    const apiCluster = rendered(render.HeaderStatus, {
      activeTab: "api", hasData: true, updatedAt: 1_700_000_000_000,
      failure: quotaFailure, authChip: quotaChip, tt, onRefreshQuota: () => {}
    });
    check("api header does NOT carry the renewal chip", !apiCluster.includes("auth.selfRenew"), apiCluster.join("\n"));
    check("api header does NOT carry the stale-data banner", !apiCluster.includes("panel.error"), apiCluster.join("\n"));

    // Multimodal（原 raccoon tab，2026-10 改名）: 同样 NEITHER——它是另一条凭据
    // 线，自己的读取失败在 tab 体内呈现，不借 quota 头部的横幅。
    const multiCluster = rendered(render.HeaderStatus, {
      activeTab: "multimodal", hasData: true, updatedAt: 1_700_000_000_000,
      failure: quotaFailure, authChip: quotaChip, tt, onRefreshQuota: () => {}
    });
    check("multimodal header does NOT carry the renewal chip", !multiCluster.includes("auth.selfRenew"), multiCluster.join("\n"));
    check("multimodal header does NOT carry the stale-data banner", !multiCluster.includes("panel.error"), multiCluster.join("\n"));
    check("multimodal header still shows the shared updated chip", multiCluster.includes("panel.updated"), multiCluster.join("\n"));
    check("multimodal header does not borrow the quota failure message",
      !multiCluster.join("\n").includes("boom"), multiCluster.join("\n"));

    // 没有任何快照（hasData=false）时头部只剩刷新按钮：更新于 chip 是有据可
    // 依的时间戳，没有数据就不该冒充有。
    const idle = rendered(render.HeaderStatus, {
      activeTab: "multimodal", hasData: false, updatedAt: 1_700_000_000_000,
      failure: quotaFailure, authChip: quotaChip, tt, onRefreshQuota: () => {}
    });
    check("an idle header carries only the refresh button",
      idle.length === 1 && idle.includes("panel.refresh"), idle.join("\n"));
  }
}

// === I. the decision table: every wire code gets an answer ================
// `viewOf` is a deliberate copy of the Host's taxonomy and nothing else in the
// suite drove it, so a code added to `codes.js` and forgotten here — or a
// guidance value pointing at a dictionary key that does not exist — read as a
// green suite. The last loop is what keeps the copy honest: a bad key would
// render the key itself on screen.
{
  const { viewOf, errorOfStatus, dictionaries, tables } = surface;
  const viewOfCode = (code, message = "an error") =>
    viewOf(null, { message, code, auth: null }, tt);

  // A non-2xx snapshot response carries no body, so the status code is the only
  // clue. 401/403 must read as "the token is gone" and keep the sign-in form on
  // screen; anything else stays a plain transport string.
  for (const status of [401, 403]) {
    const rejected = errorOfStatus(status);
    check(`HTTP ${status} reads as an expired token`,
      rejected.code === "jwt_expired" && rejected.message === `HTTP ${status}` && rejected.auth === null,
      JSON.stringify(rejected));
    const rejectedView = viewOf(null, rejected, tt);
    check(`HTTP ${status} still reaches the sign-in form`,
      rejectedView.needsSetup === true && rejectedView.guidanceKey === "panel.jwtExpired",
      String(rejectedView.guidanceKey));
  }
  for (const status of [408, 429, 500, 503]) {
    check(`HTTP ${status} stays a plain transport string`,
      errorOfStatus(status) === `HTTP ${status}`, String(errorOfStatus(status)));
  }

  // The console not answering is the code this table used to have no line for:
  // the sign-in form was correctly withheld, but the reader was left with a
  // bare error string that implied a permanent failure.
  const consoleDown = viewOfCode("console_error");
  check("a console outage has its own guidance line",
    consoleDown.guidanceKey === "panel.consoleTransient", String(consoleDown.guidanceKey));
  check("a console outage does not offer the sign-in form",
    consoleDown.needsSetup === false);

  check("an expired token still names the renewal failure",
    viewOfCode("jwt_expired").guidanceKey === "panel.jwtExpired",
    String(viewOfCode("jwt_expired").guidanceKey));
  check("an unconfigured host still reaches the sign-in form",
    viewOfCode("not_configured").guidanceKey === "panel.jwtMissing"
      && viewOfCode("not_configured").needsSetup === true);

  // Every code the form must not answer to is one the table can explain.
  for (const code of tables.FORM_EXCLUDED_CODES) {
    check(`the form-excluded code ${code} keeps the form hidden`,
      viewOfCode(code).needsSetup === false);
  }

  // A guidance value is a dictionary key, in both languages.
  for (const [code, key] of Object.entries(tables.GUIDANCE_BY_CODE)) {
    check(`guidance for ${code} resolves to real text in both languages`,
      typeof dictionaries.zh[key] === "string" && typeof dictionaries.en[key] === "string", key);
  }

  // No code at all still means "the account is the answer", never a dead end.
  check("a transport failure keeps the sign-in form reachable",
    viewOf(null, "network down", tt).needsSetup === true);
  check("an unrecognised code keeps the sign-in form reachable",
    viewOfCode("some_new_code").needsSetup === true);
}

// === H. the shared polling loop: visibility, back-off, teardown ===========
// `use-polling-interval.ts` is the loop BOTH tabs drive, and two behaviours
// were missing when each tab carried its own copy (PITFALLS §34/§36 — the
// quota copy had learned to pause while hidden, the Raccoon copy never did):
//
//   - a hidden page must stop asking (nobody is watching, and every poll holds a
//     Host connection open);
//   - a failing read must back off, not keep asking at full speed (the Host is
//     exactly the thing that is down when the panel cannot reach it).
//
// `client-surface.js`'s stand-in runs effects as no-ops, so this drives the REAL
// module with a micro React that actually records and runs effects, plus a
// controllable `document` and timer. No DOM library: the hook only ever asks
// `document.visibilityState` and for `addEventListener`/`removeEventListener`.
{
  // A React stand-in that really runs effects: `useEffect` records its callback
  // and cleanup, and `mount` runs the recorded effects (React's mount order).
  const effects = [];
  const hookReact = {
    createElement: h,
    Fragment: Symbol("Fragment"),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: (effect) => { effects.push(effect); },
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial })
  };
  const mount = () => {
    // Run every recorded effect and collect its cleanup.
    const cleanups = effects.map((effect) => effect());
    effects.length = 0;
    return () => { for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup(); };
  };

  const fakeDocument = {
    visibilityState: "visible",
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    },
    fire(type) { for (const fn of this.listeners.get(type) ?? []) fn(); }
  };
  // A manual clock: the hook only calls setInterval/clearInterval, so a stub
  // that records the cadence and lets a check "tick" makes the timing exact and
  // the test instantaneous.
  let scheduled = null;
  let tickCount = 0;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const fakeSetInterval = (fn, ms) => { scheduled = { fn, ms }; return { fake: true }; };
  const fakeClearInterval = () => { scheduled = null; };
  const tick = () => { tickCount += 1; scheduled?.fn(); };
  const realDocument = globalThis.document;
  globalThis.document = fakeDocument;
  globalThis.setInterval = fakeSetInterval;
  globalThis.clearInterval = fakeClearInterval;

  try {
    // The hook reaches React through `runtime.ts`'s seam, which
    // `client-surface.js` already filled with its NO-OP stand-in. Hand it the
    // recording one for the duration of this group, then put the original back
    // so later groups (and any suite sharing this module) see what they expect.
    const runtime = await import("../src/client/runtime.ts");
    runtime.provideClientReact(hookReact);
    const { usePollingInterval, ERROR_BACKOFF_MS } = await import("../src/client/use-polling-interval.ts");
    check("the shared loop exports a back-off floor of at least a minute",
      typeof ERROR_BACKOFF_MS === "number" && ERROR_BACKOFF_MS >= 60_000, String(ERROR_BACKOFF_MS));

    // 1. happy path: it runs immediately, then on the STATED cadence.
    {
      let calls = 0;
      effects.length = 0;
      usePollingInterval(() => { calls += 1; }, 30_000, {});
      const unmount = mount();
      check("a visible page polls once on mount", calls === 1, `calls=${calls}`);
      check("a visible page keeps the Host-stated cadence",
        scheduled?.ms === 30_000, `interval=${scheduled?.ms}`);
      tick();
      check("the interval re-polls on its cadence", calls === 2, `calls=${calls}`);
      unmount();
      check("unmount clears the interval", scheduled === null);
    }

    // 2. the visibility pause — the behaviour the Raccoon tab never had.
    {
      let calls = 0;
      effects.length = 0;
      scheduled = null;
      usePollingInterval(() => { calls += 1; }, 30_000, {});
      const unmount = mount();
      const afterMount = calls;
      fakeDocument.visibilityState = "hidden";
      fakeDocument.fire("visibilitychange");
      check("hiding the page stops the interval", scheduled === null);
      // Even if something still fires the old handle, the loop's own liveness
      // gate must swallow it.
      tick();
      check("a hidden page does not poll", calls === afterMount, `calls=${calls}`);
      fakeDocument.visibilityState = "visible";
      fakeDocument.fire("visibilitychange");
      check("coming back polls once immediately", calls === afterMount + 1, `calls=${calls}`);
      check("coming back restarts the interval", scheduled?.ms === 30_000);
      fakeDocument.visibilityState = "visible";
      unmount();
    }

    // 3. mounting while already hidden must not even fire once.
    {
      let calls = 0;
      fakeDocument.visibilityState = "hidden";
      effects.length = 0;
      scheduled = null;
      usePollingInterval(() => { calls += 1; }, 30_000, {});
      const unmount = mount();
      check("a mount into a hidden page polls nothing", calls === 0, `calls=${calls}`);
      fakeDocument.visibilityState = "visible";
      unmount();
    }

    // 4. the error back-off — never faster than the healthy cadence.
    {
      effects.length = 0;
      scheduled = null;
      usePollingInterval(() => {}, 30_000, { failed: true });
      const unmount = mount();
      check("a failed read backs off to a minute",
        scheduled?.ms === Math.max(30_000, ERROR_BACKOFF_MS), `interval=${scheduled?.ms}`);
      unmount();
    }
    // …and a cadence faster than the floor (the Raccoon scan's 2 s) is not sped
    // up by the back-off logic into something below the floor either.
    {
      effects.length = 0;
      scheduled = null;
      usePollingInterval(() => {}, 2_000, { failed: true });
      const unmount = mount();
      check("a failing fast poll still backs off to the floor, not below it",
        scheduled?.ms === ERROR_BACKOFF_MS, `interval=${scheduled?.ms}`);
      unmount();
    }
    // …while a cadence SLOWER than the floor is left alone (the floor is a
    // minimum, not a new cadence).
    {
      effects.length = 0;
      scheduled = null;
      usePollingInterval(() => {}, 300_000, { failed: true });
      const unmount = mount();
      check("a slow cadence is not sped up or reset by the back-off",
        scheduled?.ms === 300_000, `interval=${scheduled?.ms}`);
      unmount();
    }

    // 5. There is no "off" switch, and that is deliberate. An earlier version
    // of this suite pinned `enabled: false` meaning "no loop"; the flag is gone
    // because the invariant behind it was never true — the Raccoon switch gated
    // registration, not reading, and a login scan reports its `scanUrl` and its
    // settled outcome through GET alone. A loop that could be switched off was
    // one `enabled={state?.enabled}` away from deadlocking the QR login. So the
    // honest assertion is the opposite one: a mount ALWAYS polls, whatever the
    // caller believes, and a tab with a genuine "don't poll yet" condition must
    // decline to mount rather than pass a flag here.
    {
      let calls = 0;
      effects.length = 0;
      scheduled = null;
      // A caller passing a dead `enabled` must not silently regain the meaning
      // it used to have: the option object is now `{ failed }` only, so this
      // degrades to the healthy cadence instead of going silent.
      usePollingInterval(() => { calls += 1; }, 30_000, { enabled: false });
      const unmount = mount();
      check("a retired `enabled` flag cannot silence the loop",
        calls === 1 && scheduled !== null && scheduled?.ms === 30_000,
        `calls=${calls} scheduled=${scheduled?.ms}`);
      unmount();
    }

    // 6. a degenerate cadence cannot become a busy loop.
    {
      effects.length = 0;
      scheduled = null;
      usePollingInterval(() => {}, 0, {});
      const unmount = mount();
      check("a zero cadence is clamped to 1 ms, never 0",
        scheduled?.ms === 1, `interval=${scheduled?.ms}`);
      unmount();
    }
  } finally {
    // Hand the seam back to the surface's own stand-in so a later group (or a
    // suite importing this file) mounts against what it expects.
    const runtime = await import("../src/client/runtime.ts");
    runtime.provideClientReact(reactStandin);
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
}

// === I. the polling CORE: generation guard, kept value, stated cadence ======
// `use-remote-read.ts` is the lifecycle the loop serves, and none of it was
// executed anywhere: panel.test scans its SOURCE, the loop group above drives
// only the stateless interval. The core is five pieces of state plus two refs,
// so the loop group's stateless stand-in cannot drive it — this group mounts
// it with cells that PERSIST across renders, `setState` writing synchronously,
// and effects that re-run with real deps diffing (cleanup first, React's
// order). Re-renders are explicit `render()` calls; nothing schedules them.
{
  const runtime = await import("../src/client/runtime.ts");
  const { useRemoteRead } = await import("../src/client/use-remote-read.ts");
  const { ERROR_BACKOFF_MS } = await import("../src/client/use-polling-interval.ts");

  // A stateful micro React: one persistent cell per hook slot (the core's hook
  // order is fixed, so the index is the identity), refs included.
  const makeStatefulReact = () => {
    const cells = [];
    const installed = [];
    const queued = [];
    let ptr = 0;
    return {
      react: {
        createElement: h,
        useState: (initial) => {
          const i = ptr++;
          if (cells[i] === undefined) cells[i] = { value: typeof initial === "function" ? initial() : initial };
          const set = (value) => {
            cells[i].value = typeof value === "function" ? value(cells[i].value) : value;
          };
          return [cells[i].value, set];
        },
        useEffect: (effect, deps) => { queued.push({ effect, deps }); },
        useCallback: (callback) => callback,
        useMemo: (factory) => factory(),
        useRef: (initial) => {
          const i = ptr++;
          if (cells[i] === undefined) cells[i] = { value: { current: initial } };
          return cells[i].value;
        }
      },
      render: () => {
        ptr = 0;
        const effects = queued.splice(0);
        const nextInstalled = [];
        for (let i = 0; i < effects.length; i++) {
          const { effect, deps } = effects[i];
          const prev = installed[i];
          const changed = deps === undefined || prev === undefined || prev.deps === undefined
            || prev.deps.length !== deps.length
            || deps.some((d, j) => !Object.is(prev.deps[j], d));
          if (changed) {
            if (prev && typeof prev.cleanup === "function") prev.cleanup();
            nextInstalled.push({ deps, cleanup: effect() });
          } else {
            nextInstalled.push(prev);
          }
        }
        installed.length = 0;
        installed.push(...nextInstalled);
      },
      unmount: () => {
        for (const entry of installed) if (entry && typeof entry.cleanup === "function") entry.cleanup();
        installed.length = 0;
      },
      reset: () => { cells.length = 0; installed.length = 0; queued.length = 0; }
    };
  };

  // The route is the module-scope shape the two real readers use; `parse` and
  // `fetch` are swapped per scenario through these two slots.
  const route = { path: "/api/dsh-sensenova-suite/snapshot", parse: (body, status) => parseImpl(body, status) };
  let parseImpl = null;
  let fetchImpl = null;
  const fetchCalls = [];
  const fakeFetch = (path, init) => { fetchCalls.push({ path, init }); return fetchImpl(path, init); };
  // One setImmediate drains every pending microtask; three covers the longest
  // await chain inside `load` (fetch → response.json() → state writes).
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  const realFetch = globalThis.fetch;
  const realDocument2 = globalThis.document;
  const realSetInterval2 = globalThis.setInterval;
  const realClearInterval2 = globalThis.clearInterval;
  let scheduled = null;
  globalThis.document = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {}
  };
  globalThis.setInterval = (fn, ms) => { scheduled = { fn, ms }; return { fake: true }; };
  globalThis.clearInterval = () => { scheduled = null; };
  globalThis.fetch = fakeFetch;

  try {
    // 1. happy path: the value lands, the clock is stamped, the stated cadence
    //    is adopted (the interval is rebuilt at 5 s and fires one fresh read).
    {
      const io = makeStatefulReact();
      runtime.provideClientReact(io.react);
      io.reset();
      fetchCalls.length = 0;
      parseImpl = (body) => ({ value: body.v, failure: null, cadenceSeconds: body.pollSeconds });
      fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ v: "one", pollSeconds: 5 }) });
      let api = null;
      const renderReader = () => { api = useRemoteRead(route, 30_000); io.render(); };
      renderReader();
      await flush();
      renderReader();
      check("a successful read lands the value and stamps the clock",
        api.data === "one" && api.error === null && api.loadedOnce === true && api.updatedAt > 0,
        `data=${String(api.data)} updatedAt=${api.updatedAt}`);
      check("a stated cadence is adopted: the interval rebuilds at 5 s",
        scheduled?.ms === 5_000, `interval=${scheduled?.ms}`);
      check("a cadence rebuild fires one fresh read",
        fetchCalls.length === 2, `calls=${fetchCalls.length}`);
      io.unmount();
    }

    // 2. a failed read keeps the PREVIOUS reading and never moves the clock —
    //    the guarantee the pill's "stale data" mark and the panel's setup-form
    //    suppression both stand on.
    {
      const io = makeStatefulReact();
      runtime.provideClientReact(io.react);
      io.reset();
      parseImpl = (body) => (body !== null && body.v !== undefined
        ? { value: body.v, failure: null }
        : { value: null, failure: "console unreadable" });
      let phase = 0;
      fetchImpl = async () => ({ ok: true, status: 200, json: async () => (phase === 0 ? { v: "kept" } : {}) });
      let api = null;
      const renderReader = () => { api = useRemoteRead(route, 30_000); io.render(); };
      renderReader();
      await flush();
      renderReader();
      const stampedAt = api.updatedAt;
      check("the first successful read is on screen",
        api.data === "kept" && api.error === null && api.updatedAt > 0,
        `data=${String(api.data)} updatedAt=${api.updatedAt}`);
      phase = 1;
      await api.load();
      renderReader();
      check("a failed read keeps the previous reading",
        api.data === "kept" && api.error === "console unreadable" && api.loadedOnce === true,
        `data=${String(api.data)} error=${String(api.error)}`);
      check("a failed read does not move the freshness stamp",
        api.updatedAt === stampedAt, `${api.updatedAt} vs ${stampedAt}`);
      io.unmount();
    }

    // 3. supersession: only the newest load may write, and starting it aborts
    //    the request it supersedes; a late answer from the old generation is
    //    skipped whole (no value write, no error write).
    {
      const io = makeStatefulReact();
      runtime.provideClientReact(io.react);
      io.reset();
      fetchCalls.length = 0;
      parseImpl = (body) => ({ value: body?.v ?? null, failure: null });
      const pendings = [];
      fetchImpl = () => new Promise((resolve, reject) => { pendings.push({ resolve, reject }); });
      let api = null;
      const renderReader = () => { api = useRemoteRead(route, 30_000); io.render(); };
      renderReader();
      const refresh = api.load;
      const second = refresh();
      check("a newer load aborts the request it supersedes",
        fetchCalls[0]?.init?.signal?.aborted === true, String(fetchCalls[0]?.init?.signal?.aborted));
      pendings[1].resolve({ ok: true, status: 200, json: async () => ({ v: "newest" }) });
      await second;
      renderReader();
      check("the newest read is the one on screen",
        api.data === "newest" && api.error === null, `data=${String(api.data)}`);
      pendings[0].resolve({ ok: true, status: 200, json: async () => ({ v: "late" }) });
      await flush();
      renderReader();
      check("a late superseded answer cannot clobber the newer reading",
        api.data === "newest" && api.error === null, `data=${String(api.data)}`);
      io.unmount();
    }

    // 4. unmount ONLY (not a cadence rebuild) supersedes an in-flight poll:
    //    the generation is bumped and the connection is released.
    {
      const io = makeStatefulReact();
      runtime.provideClientReact(io.react);
      io.reset();
      fetchCalls.length = 0;
      fetchImpl = () => new Promise(() => {});
      let api = null;
      const renderReader = () => { api = useRemoteRead(route, 30_000); io.render(); };
      renderReader();
      const inFlightSignal = fetchCalls[0]?.init?.signal;
      io.unmount();
      check("unmount aborts the in-flight poll",
        inFlightSignal?.aborted === true, String(inFlightSignal?.aborted));
      check("unmount stops the loop", scheduled === null);
    }

    // 5. a thrown fetch becomes the error line, keeps the value, and flips the
    //    loop into the back-off cadence.
    {
      const io = makeStatefulReact();
      runtime.provideClientReact(io.react);
      io.reset();
      parseImpl = (body) => ({ value: body?.v ?? null, failure: null });
      let fail = false;
      fetchImpl = async () => {
        if (fail) throw new Error("net down");
        return { ok: true, status: 200, json: async () => ({ v: "pre" }) };
      };
      let api = null;
      const renderReader = () => { api = useRemoteRead(route, 30_000); io.render(); };
      renderReader();
      await flush();
      renderReader();
      fail = true;
      await api.load();
      renderReader();
      check("a thrown fetch sets the error and keeps the previous value",
        api.data === "pre" && typeof api.error === "string" && api.error.includes("net down"),
        `data=${String(api.data)} error=${String(api.error)}`);
      check("the failure flips the loop into the back-off cadence",
        scheduled?.ms === ERROR_BACKOFF_MS, `interval=${scheduled?.ms}`);
      io.unmount();
    }

    // 6. a non-2xx carries no body but IS handed to the route's parse with its
    //    status (401 keeps the sign-in form on screen); the attempt still
    //    concludes — loadedOnce lands even on a failed FIRST read.
    {
      const io = makeStatefulReact();
      runtime.provideClientReact(io.react);
      io.reset();
      let seenStatus = null;
      parseImpl = (body, status) => { seenStatus = status; return { value: null, failure: "unauthorized" }; };
      fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
      let api = null;
      const renderReader = () => { api = useRemoteRead(route, 30_000); io.render(); };
      renderReader();
      await flush();
      renderReader();
      check("a non-2xx is handed to the route's parse with its status",
        seenStatus === 401 && api.error === "unauthorized",
        `status=${String(seenStatus)} error=${String(api.error)}`);
      check("a failed FIRST read still concludes (loadedOnce lands)",
        api.loadedOnce === true && api.data === null,
        `loadedOnce=${String(api.loadedOnce)} data=${String(api.data)}`);
      io.unmount();
    }
  } finally {
    runtime.provideClientReact(reactStandin);
    globalThis.fetch = realFetch;
    if (realDocument2 === undefined) delete globalThis.document;
    else globalThis.document = realDocument2;
    globalThis.setInterval = realSetInterval2;
    globalThis.clearInterval = realClearInterval2;
  }
}

// === J. statedCadenceMs: the gate between a Host-stated rate and the timer ==
// The loop clamps at 1 ms, but the honest gate sits upstream: whatever reaches
// `usePollingInterval` must already be a finite positive whole-second rate in
// ms. The helper is the ONE thing standing between a hostile snapshot field
// and a setInterval busy loop, so its rejections are pinned here.
{
  const { statedCadenceMs } = await import("../src/client/format.ts");
  check("an integer stated rate passes through as milliseconds",
    statedCadenceMs(2, 30_000) === 2_000, String(statedCadenceMs(2, 30_000)));
  check("a sub-second stated rate rounds UP to one second, never 0",
    statedCadenceMs(0.5, 30_000) === 1_000, String(statedCadenceMs(0.5, 30_000)));
  check("a fractional rate floors to its whole seconds",
    statedCadenceMs(1.9, 30_000) === 1_000, String(statedCadenceMs(1.9, 30_000)));
  check("a string is not a usable rate",
    statedCadenceMs("2", 30_000) === 30_000, String(statedCadenceMs("2", 30_000)));
  check("NaN is not a usable rate",
    statedCadenceMs(NaN, 30_000) === 30_000, String(statedCadenceMs(NaN, 30_000)));
  check("zero and negative stated rates fall back",
    statedCadenceMs(0, 30_000) === 30_000 && statedCadenceMs(-3, 30_000) === 30_000,
    `${statedCadenceMs(0, 30_000)}/${statedCadenceMs(-3, 30_000)}`);
  check("a missing rate falls back",
    statedCadenceMs(undefined, 30_000) === 30_000, String(statedCadenceMs(undefined, 30_000)));
}

// The ledger MUST be reported. This suite ran silent for its whole life —
// checks recorded into `results`, nothing printed, exit 0 — so a failed pin
// (the registered-status fall-through, 2026-10-27) never reached the runner
// and every standalone `render OK` verdict was vacuous. finish() prints the
// ledger and hard-exits 1 on any failure, the same contract every other
// suite's tail implements.
finish();
