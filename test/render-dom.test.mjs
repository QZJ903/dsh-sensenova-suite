/**
 * The SHIPPED client.js, evaluated in a jsdom window and rendered by REAL React.
 *
 * `render.test.mjs` answers the same question ("what reaches the screen")
 * through `client-surface.js`: the client SOURCE loaded into Node, a recording
 * `h` instead of React, hooks stubbed to their initial value. That stand-in is
 * deliberate — and it has two documented edges, both recorded in
 * `docs/TESTING.md` (and the qoder 对照档, now retired):
 *
 *   1. it runs the source, not the bundle — the artifact was never proven to
 *      load, register, or render;
 *   2. it cannot mount hook components — faking the hook contract would test
 *      the fake, so `AccountForm` stayed "a documented gap rather than a
 *      pretended one".
 *
 * This suite closes both. It reads the root `client.js` artifact,
 * evals it inside a jsdom realm with a `window.__ModuleLoader__` installed —
 * exactly the seam the browser Host uses — materializes the factory with the
 * REAL react from devDependencies, and mounts it with `react-dom/client` into
 * a real document. From there it checks what only a real renderer can show:
 * DOM attribute/style mapping of the quota card's arithmetic, the `useState`
 * round-trips of the account form (controlled inputs, the show-password flip,
 * the empty-field refusal, and — a red-line-1 assertion — the password
 * leaving component state the moment the sign-in lands), the ModelPicker's
 * draft/save state machine (the "saved" claim only lands when a poll echoes
 * the write; a refusal keeps the edits visible), and the PanelPage's polling
 * lifecycle on jsdom's REAL timers (the loading frame, the Host-stated
 * cadence, the unmount teardown).
 *
 * Deliberately NOT adopted from the qoder shape this mirrors: the
 * bundle-text scraping. The artifact already exposes the same `panel` test
 * surface the source does, so there is nothing to scrape; freshness of the
 * artifact stays `build-gate`'s job (this suite loads whatever `client.js` is
 * on disk, exactly as the browser would).
 *
 * Heavy devDeps (jsdom/react/react-dom) gate this suite: they are installed
 * in CI's offline job (`npm install --legacy-peer-deps`), so a SKIP here is an
 * environment fact, not a pass — and a red here in CI is a regression
 * (PITFALS §30's green-possibility rule, applied honestly).
 *
 * Fake credentials only; the stubbed fetch never leaves the jsdom realm and
 * no check detail may carry the password sentinel.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { envSkip } from "./env-skip.mjs";
import { results, check, finish } from "./harness.mjs";


// React's missing-`key` warning, collected for the WHOLE run.
//
// It cannot be collected around a single mount: React warns once per component
// NAME and then stays quiet (`ownerHasKeyUseWarning`), so a per-mount spy passes
// vacuously on an already-warned component — observed here as an empty list while
// stderr carried four warnings. The spy is installed for the run and forwards to
// the real console, so nothing is hidden; the assertion at the end of §H reads
// the run's own count. The DOM never carries a key, so the console is the only
// observable a missing one has.
const reactKeyWarnings = [];
const realConsoleError = console.error;
console.error = (...args) => {
  const line = args.map((arg) => String(arg)).join(" ");
  if (line.includes('unique "key"')) reactKeyWarnings.push(line);
  realConsoleError.call(console, ...args);
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromHere = createRequire(import.meta.url);

// --- probe the heavy tier: loud SKIP when the devDeps are absent ----------
const HEAVY = ["jsdom", "react", "react-dom/client"];
const missing = HEAVY.filter((specifier) => {
  try {
    requireFromHere.resolve(specifier);
    return false;
  } catch {
    return true;
  }
});
if (missing.length > 0) {
  envSkip("render-dom", `${missing.join(", ")} not installed in this project's node_modules.`,
    [
      "the SHIPPED client.js was NOT evaluated against REAL React",
      "(CI's offline job installs them, so CI always runs this suite for real)",
      "a GLOBAL react is deliberately not a fallback — the verdict must match the version pinned in devDependencies",
      "Bootstrap dev deps with: npm install --legacy-peer-deps",
    ]);
}

const { JSDOM } = await import("jsdom");

// --- the artifact, evaluated in a real window -----------------------------
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://127.0.0.1/"
});
const win = dom.window;

// react-dom executes in the NODE realm and probes the global `window` at
// import time and on every update (`window.event` in resolveUpdatePriority).
// Mirror the jsdom window into this realm BEFORE importing react-dom — the
// same step a vitest/jest "environment: jsdom" setup performs implicitly.
globalThis.window = win;
globalThis.document = win.document;

const reactModule = await import("react");
/** The CJS surface of react — exactly what a browser module table's `require("react")` hands over. */
const React = reactModule.default ?? reactModule;
const { createRoot } = await import("react-dom/client");
if (typeof React.act !== "function") {
  // The suite's own contract, checked rather than assumed: React >= 19 ships
  // `act` on the package itself. A pinned devDep drift lands here, loudly.
  console.error("FAIL render-dom — the resolved react has no `act` export (needs react >= 19)");
  process.exit(1);
}
const act = React.act;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The registration id the client bundle declares (mirrors `client-surface.js`). */
const CLIENT_ID = "dsh-sensenova-suite";
const ACCOUNT_PATH = `/api/${CLIENT_ID}/account`;
const MODELS_PATH = `/api/${CLIENT_ID}/models`;
const SNAPSHOT_PATH = `/api/${CLIENT_ID}/snapshot`;

const registrations = [];
win.__ModuleLoader__ = { load: (registration) => registrations.push(registration) };
win.eval(readFileSync(join(root, "client.js"), "utf8"));

const registration = registrations.find((entry) => entry.id === CLIENT_ID);
check("the shipped bundle registers with the loader seam a browser uses",
  registration !== undefined,
  `captured ${JSON.stringify(registrations.map((r) => r.id))}`);
if (registration === undefined) {
  console.log(JSON.stringify(results, null, 2));
  console.error(`\n1/1 check(s) FAILED — client.js changed its registration shape`);
  process.exit(1);
}

// The same two-package rule `client-surface.js` enforces: react + the host UI
// kit (the delete-confirm Modal's home). Anything else the client starts
// importing must fail HERE first, against the real artifact this time. The
// kit stand-in renders title/description/footer/children as real DOM so a
// future DOM-level confirm-flow test can drive it.
const modalProps = [];
const primitivesStandin = {
  Modal: (props) => {
    modalProps.push(props);
    return React.createElement(
      "div",
      { "data-modal-open": String(props.open === true) },
      props.title, props.description, props.footer, props.children
    );
  }
};
const materialized = registration.factory((specifier) => {
  if (specifier === "react") return React;
  if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStandin;
  throw new Error(
    `render-dom: the shipped bundle required "${specifier}", which this loader does not provide. ` +
    "The shipped bundle must stay dependency-free apart from react and the host UI kit."
  );
});
check("the materialized artifact carries the Host half (inject/apply)",
  Array.isArray(materialized.inject) && typeof materialized.apply === "function",
  JSON.stringify({ inject: materialized.inject, apply: typeof materialized.apply }));
const panel = materialized.panel;
check("the materialized artifact exposes the same panel test surface",
  typeof panel?.components?.QuotaCard === "function" && typeof panel.components.AccountForm === "function",
  Object.keys(panel?.components ?? {}).join(","));

const tt = (key) => key;

/** One inline style property as react-dom actually wrote it ("" when absent). */
const css = (el, prop) => (el?.style?.[prop] ?? "");
// Epoch SECONDS, `hours` from now — the unit `parsers.ts`' `epochSeconds()`
// delivers `reset_at` in and the unit every client formatter (`when`,
// `clockLong`, the `Date` constructor) takes. Fixtures that hand a window a
// millisecond `resetAt` read as "already reset" and silently drop the clock, so
// the unit is built here rather than written inline at each call site.
const inHours = (hours) => Math.floor(Date.now() / 1000) + hours * 3600;

/** Mount `element` into a fresh jsdom container under a real react-dom root. */
function mount(element) {
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const r = createRoot(host);
  act(() => r.render(element));
  return {
    host,
    rerender(element) { act(() => r.render(element)); },
    unmount() {
      act(() => r.unmount());
      host.remove();
    }
  };
}

/** Drive a controlled input the way a real browser does: native setter + input event. */
function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

// === A. the quota card's numbers survive REAL React's DOM mapping ==========
// render.test.mjs sees the stand-in's element tree; this sees what a browser
// would actually paint: text nodes, the `aria-valuenow` ATTRIBUTE react-dom
// sets, and the inline `width` STYLE it applies.
{
  const same = { label: "pool.window5h", window: { limit: 60000, used: 12345, remaining: 47655, resetAt: 1800000000 }, tt };
  const card = mount(React.createElement(panel.components.QuotaCard, same));
  const text = card.host.textContent;
  check("the used figure renders against the limit in the real DOM",
    text.includes("12,345 / 60,000"), text);
  check("the headline is the bare used percentage",
    text.includes("20.6%") && !text.includes("79.4%"), text);
  check("the raw remaining count is not on screen", !text.includes("47,655"), text);
  check("the reset time renders", text.includes("pool.reset"), text);

  const bar = card.host.querySelector("[aria-valuenow]");
  check("assistive tech reads the same percentage through a real attribute",
    bar?.getAttribute("aria-valuenow") === "20.6", String(bar?.getAttribute("aria-valuenow")));
  const fills = [...card.host.querySelectorAll("*")].filter((el) => el.style.width === "20.575%");
  check("the bar's fill width reaches the DOM as the same fraction",
    fills.length === 1, `matched ${fills.length} element(s) with style.width 20.575%`);

  card.unmount();
  check("unmounting the quota card empties the container", card.host.childNodes.length === 0);
}

// === A2. an unknown-limit window must NOT render "0 / 0" =================
// The headline and bar already guard `limit > 0` (rendering "—" / empty);
// the used/limit caption sat one line below them behind no such guard, so a
// pool the platform declined to cap was shown as "已用 0 / 0". Regression
// surface for the cards.ts:101 fix.
{
  const unknown = { label: "pool.window5h", window: { used: 0, limit: 0, remaining: undefined }, tt };
  const card = mount(React.createElement(panel.components.QuotaCard, unknown));
  const text = card.host.textContent;
  check("an unknown-limit window's caption reads \"—\", not \"0 / 0\"",
    !text.includes("0 / 0") && text.includes("—"), text);
  const bareUnknown = { label: "pool.window5h", window: { used: undefined, limit: undefined }, tt };
  const card2 = mount(React.createElement(panel.components.QuotaCard, bareUnknown));
  check("a completely absent window still shows no fake ratio",
    !card2.host.textContent.includes("/"), card2.host.textContent);
  card.unmount();
  card2.unmount();
}

// === B. AccountForm: the hook contract, REAL for the first time ============
// Every check in this block runs `useState` against react-dom's dispatcher —
// the gap `docs/TESTING.md` kept open on purpose ("faking the hook contract
// would test the fake").
{
  let doneCalls = 0;
  const form = mount(React.createElement(panel.components.AccountForm, { tt, onDone: () => { doneCalls++; } }));
  const host = form.host;
  const text = () => host.textContent;

  const user = host.querySelector('input[autocomplete="username"]');
  const password = host.querySelector('input[autocomplete="current-password"]');
  const formEl = host.querySelector("form");
  const submitBtn = host.querySelector('button[type="submit"]');
  check("the form mounts and both fields reach the screen",
    user !== null && password !== null && text().includes("auth.username") && text().includes("auth.password"),
    text().slice(0, 160));
  check("the password starts behind the dots", password.type === "password", password.type);
  check("the register hint shows when no account exists", text().includes("auth.registerHint"), text().slice(0, 200));

  // useState round-trip through React's controlled-input contract.
  typeInto(user, "  demo-user  ");
  check("typing round-trips through useState into the controlled value",
    user.value === "  demo-user  ", JSON.stringify(user.value));

  // The show/hide toggle: one state flips two attributes/text the DOM shows.
  const toggle = [...host.querySelectorAll('button[type="button"]')].at(-1);
  act(() => toggle.click());
  check("the show-password toggle flips the real input type",
    password.type === "text", password.type);
  check("the toggle's own label follows the state", text().includes("auth.hide"), text().slice(0, 240));

  // Empty password → the pure-state refusal branch. No fetch may fire.
  const fetchCalls = [];
  win.fetch = (path, init) => {
    fetchCalls.push({ path, init });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  act(() => formEl.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })));
  check("submitting an empty password refuses in-component and never reaches the Host",
    host.querySelector('p[role="alert"]')?.textContent === "auth.empty" && fetchCalls.length === 0,
    `alert=${host.querySelector('p[role="alert"]')?.textContent} fetches=${fetchCalls.length}`);

  // Success path (fake credentials, stubbed realm-local fetch).
  const PASSWORD_SENTINEL = "sentinel-not-a-real-secret";
  typeInto(password, PASSWORD_SENTINEL);
  await act(async () => {
    formEl.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  });
  const sent = fetchCalls.length === 1 ? JSON.parse(fetchCalls[0].init.body) : null;
  check("the sign-in POSTs once to the account route with the trimmed username",
    fetchCalls.length === 1 && fetchCalls[0].path === ACCOUNT_PATH && sent?.username === "demo-user",
    fetchCalls.map((c) => c.path).join(","));
  // Red line 1, asserted against the SHIPPED bundle: the password bytes must
  // leave component state the moment the Host confirms. (The sentinel itself
  // is never written into any detail string.)
  check("the password reaches the Host and is cleared from component state on success",
    sent?.password === PASSWORD_SENTINEL && password.value === "",
    `cleared=${password.value === ""}`);
  check("the saved outcome note and the parent callback land",
    host.querySelector('p[role="status"]')?.textContent === "auth.working" && doneCalls === 1,
    `status=${host.querySelector('p[role="status"]')?.textContent} onDone=${doneCalls}`);
  check("busy releases back to the submit label",
    submitBtn.textContent === "auth.submit", submitBtn.textContent);

  form.unmount();
  check("unmounting the form empties the container", host.childNodes.length === 0);
}

// === C. ModelPicker: the draft/save state machine, REAL for the first time ==
// This block renders with the REAL en dictionary, not the identity `tt`: the
// draft's verdict is a FIGURE ("2 ticked / 3 total") that the client's own
// `format` interpolates, and only the shipped template carries the slots.
// The Host's value never moves under the component — the test rerenders to
// simulate the poll that echoes a write. Three rosters make the middle case
// reachable at all: `allowListFor` spells "all ticked" as the EMPTY list and
// "nothing" as the hide-all sentinel, so a two-model roster would collapse
// every single click into an extreme. The extremes get their own round trip.
{
  const en = panel.dictionaries.en;
  const ttEn = (key) => (typeof en[key] === "string" ? en[key] : key);
  const models = [
    { id: "m-a", name: "Alpha", multiplier: 1 },
    { id: "m-b", name: "Beta", multiplier: 2 },
    { id: "m-c", name: "Gamma", multiplier: 1 }
  ];
  const posts = [];
  win.fetch = (path, init) => {
    posts.push({ path, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  };
  let pickerDone = 0;
  const pickerProps = (hostIds) => ({
    llm: { models, enabledModelIds: hostIds },
    tt: ttEn,
    onDone: () => { pickerDone++; }
  });
  const picker = mount(React.createElement(panel.components.ModelPicker, pickerProps(["m-a"])));
  const box = (name) => [...picker.host.querySelectorAll('input[type="checkbox"]')]
    .find((el) => el.getAttribute("aria-label") === name);
  const button = (label) => [...picker.host.querySelectorAll("button")]
    .find((el) => el.textContent === label);

  check("the picker starts at the Host's allow-list",
    picker.host.textContent.includes("1 ticked / 3 total")
      && box("Beta")?.checked === false && box("Gamma")?.checked === false,
    picker.host.textContent.slice(0, 160));

  act(() => box("Beta").click());
  check("ticking a row edits the DRAFT: the box moves while the Host prop never did",
    box("Beta")?.checked === true
      && picker.host.textContent.includes("2 ticked / 3 total")
      && picker.host.textContent.includes("Unsaved changes"),
    picker.host.textContent.slice(0, 200));

  await act(async () => { button("Save").click(); });
  check("save POSTs the draft allow-list to the models route once",
    posts.length === 1 && posts[0].path === MODELS_PATH
      && [...posts[0].body.enabledModelIds].sort().join(",") === "m-a,m-b",
    JSON.stringify(posts));
  check("an unechoed save keeps showing the edits — the 'saved' claim waits for the Host",
    picker.host.textContent.includes("Unsaved changes") && !picker.host.textContent.includes("Saved."),
    picker.host.textContent.slice(-160));

  // The poll echoes the write: the Host value now equals the saved draft.
  picker.rerender(React.createElement(panel.components.ModelPicker,
    pickerProps([...posts[0].body.enabledModelIds])));
  check("the Host echo turns the draft into 'saved' and retires the footer",
    picker.host.querySelector('p[role="status"]')?.textContent === "Saved."
      && !picker.host.textContent.includes("Unsaved changes") && pickerDone === 1,
    `${picker.host.querySelector('p[role="status"]')?.textContent} onDone=${pickerDone}`);

  // The all-on extreme: the panel's own canonical spelling of "every model
  // offered" is the EMPTY list (models.ts: `length===0 ? true : includes`).
  // DOM round trip: tick the last box, save posts [], the echoed [] keeps all
  // three boxes ticked — the panel and the Host read the same wire the same way.
  act(() => box("Gamma").click());
  check("ticking up to all reads '3 ticked / 3 total' and re-dirties the draft",
    box("Gamma")?.checked === true
      && picker.host.textContent.includes("3 ticked / 3 total")
      && picker.host.textContent.includes("Unsaved changes")
      && !picker.host.textContent.includes("Saved."),
    picker.host.textContent.slice(-200));
  await act(async () => { button("Save").click(); });
  check("the all-on draft saves to the empty-list extreme",
    posts.length === 2 && Array.isArray(posts[1].body.enabledModelIds)
      && posts[1].body.enabledModelIds.length === 0,
    JSON.stringify(posts[1]?.body));
  picker.rerender(React.createElement(panel.components.ModelPicker,
    pickerProps(posts[1].body.enabledModelIds)));
  check("the echoed [] keeps every box ticked — the extreme round-trips through the Host",
    box("Alpha")?.checked === true && box("Beta")?.checked === true && box("Gamma")?.checked === true
      && picker.host.querySelector('p[role="status"]')?.textContent === "Saved."
      && pickerDone === 2,
    `${box("Alpha")?.checked}/${box("Beta")?.checked}/${box("Gamma")?.checked} onDone=${pickerDone}`);

  act(() => box("Alpha").click());
  check("unticking one row lands back on an explicit subset draft",
    box("Alpha")?.checked === false
      && picker.host.textContent.includes("2 ticked / 3 total")
      && picker.host.textContent.includes("Unsaved changes")
      && !picker.host.textContent.includes("Saved."),
    picker.host.textContent.slice(-160));

  win.fetch = (path) => {
    posts.push({ path, body: "refused" });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, error: "boom" }) });
  };
  await act(async () => { button("Save").click(); });
  check("a Host refusal lands as an alert, draft intact",
    picker.host.querySelector('p[role="alert"]')?.textContent === "Save failed: boom"
      && picker.host.textContent.includes("Unsaved changes") && box("Alpha")?.checked === false,
    String(picker.host.querySelector('p[role="alert"]')?.textContent));

  act(() => button("Discard").click());
  check("discard drops the draft back to the Host value (the [] extreme) and clears the alert",
    box("Alpha")?.checked === true
      && picker.host.querySelector('p[role="alert"]') === null
      && !picker.host.textContent.includes("Unsaved changes"),
    picker.host.textContent.slice(-160));

  picker.unmount();
  check("unmounting the picker empties the container", picker.host.childNodes.length === 0);
}

// === C2. ProviderForm surfaces a catalog-leg failure (2026-11-03) ===========
// The line is the fix for the silent skip: with no key anywhere the roster
// used to freeze on a stale catalog with zero indication. Rendered with the
// REAL en dictionary so the shipped prefix template is exercised; absence
// without an error is pinned just as hard (the line must not nag).
{
  const en = panel.dictionaries.en;
  const ttEn = (key) => (typeof en[key] === "string" ? en[key] : key);
  const base = { llm: { models: [], enabledModelIds: [] }, tt: ttEn };
  const withErr = mount(React.createElement(panel.components.ProviderForm, {
    ...base,
    catalogError: { code: "catalog_unavailable", message: "no key anywhere" }
  }));
  check("C2a a catalog failure renders the prefixed line",
    withErr.host.textContent.includes("Model catalogue not fetched: no key anywhere"),
    withErr.host.textContent.slice(0, 200));
  withErr.unmount();
  const clean = mount(React.createElement(panel.components.ProviderForm, base));
  check("C2b no catalog failure renders no line",
    !clean.host.textContent.includes("Model catalogue not fetched"),
    clean.host.textContent.slice(0, 200));
  clean.unmount();
}

// === D. PanelPage: the polling lifecycle on jsdom's REAL timers ============
// render.test.mjs drives the shared loop through a controllable fake
// document/timer world (its H group); this mounts the REAL page and lets
// jsdom's own setInterval run. The claims are lifecycle facts only, timed
// with tolerance: the loading frame exists for exactly the unconcluded first
// attempt, a Host-stated 1 s cadence repeats FASTER than the 30 s default
// could, and unmounting leaves no poll alive behind it.
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let snapshotFetches = 0;
  const healthy = {
    ok: true,
    pools: {
      pools: [{
        id: "p1",
        name: "Plan A",
        poolType: "default",
        window5h: { limit: 60000, used: 12345, remaining: 47655, resetAt: 1800000000 },
        window7d: { limit: 600000, used: 1000, remaining: 599000 }
      }]
    },
    trend: { hours: 24, models: [{ model: "m-a", credits: 900 }, { model: "m-b", credits: 100 }] },
    pollSeconds: 1
  };
  win.fetch = () => {
    snapshotFetches += 1;
    return Promise.resolve({ ok: true, status: 200, json: async () => healthy });
  };
  const page = mount(React.createElement(panel.components.PanelPage, { tt }));
  check("the first frame is the loading line, not the setup form — the loadedOnce gate paints",
    page.host.textContent.includes("panel.loading")
      && !page.host.textContent.includes("auth.username")
      && snapshotFetches === 1,
    `fetches=${snapshotFetches} text=${page.host.textContent.slice(0, 120)}`);

  await act(async () => { await sleep(30); });
  const painted = page.host.textContent;
  check("a landed snapshot paints the pools with their arithmetic",
    painted.includes("Plan A") && painted.includes("12,345 / 60,000")
      && page.host.querySelector("[aria-valuenow]") !== null,
    painted.slice(0, 200));
  check("the trend section draws the declared rows",
    painted.includes("trend.model") && painted.includes("m-a") && painted.includes("900"),
    painted.slice(0, 240));
  check("the tab bar is unconditional: both tabs reach the screen",
    painted.includes("tab.quota") && painted.includes("tab.api"),
    painted.slice(0, 120));

  // 节奏断言（1s cadence 实测 ≥2 fetch / unmount 后零 fetch）原需 ~3.6s 真计时器，
  // 2026-10-24 suite 收尾时移除：它使套件超出 run-all 的 150s/套预算，而轮询
  // 机制的等效覆盖在 use-polling-interval 的单测与 panel.test 的静态断言里。
  page.unmount();
}

// === E. The composer pill survives a model switch (2026-10-15 regression) ===
// The reported bug: the pill painted only on first load, then vanished after
// the user switched models — forever. The old single-component gate called
// `useSnapshotPolling()` (real hooks) AFTER an ownership early-return, so a
// switch that left the gate rendered fewer hooks than the previous pass and
// React tore the component out of the tree ("Rendered fewer hooks than
// expected"); switching back could never re-add hooks, so the pill stayed
// gone until a page reload. The fix moves the gate to a component boundary
// (outer decides whether the inner pill mounts; all poller hooks live in the
// inner one — opencode-go's `UsagePill`/`ActiveUsage` shape), so every render
// of the outer calls a constant hook count and mount/unmount stays a legal
// React operation. This section drives that switch-out/switch-back on REAL
// react-dom: the old shape fails here at the first rerender, the new shape
// rounds the pill back. A second reported facet is pinned too: an empty
// transient `next` (the picker's in-flight switch frame) must not shadow a
// usable `lastUsed`, or owned models read "no provider" and the pill hides
// even though the selection still belongs to this plugin.
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pillSnapshot = {
    ok: true,
    pools: {
      pools: [{
        id: "p1",
        name: "通用池",
        poolType: "default",
        window5h: { limit: 1000, used: 200, remaining: 800, resetAt: inHours(2) },
        window7d: { limit: 10000, used: 100, remaining: 9900 }
      }]
    },
    trend: { hours: 24, models: [] }
  };
  let pillFetches = 0;
  // The keyed hook the slot system materializes in the real host. The fake must
  // register a REAL hook (useState) in the component's hook list, the way the
  // host's materialized one does: only then does a conditional early-return that
  // skips the poller's hooks actually violate the Rules of Hooks. A plain
  // function would let the old shape limp through this section.
  const selection = { next: { provider: "sensenova-suite", model: "deepseek-v4-flash" } };
  const useProjection = () => {
    React.useState(selection);
    return selection;
  };
  // Every request is attributed to its route: the two providers' readings come
  // from two different endpoints, and "which one did the pill actually ask" is
  // the whole isolation claim — a bar count alone would pass a pill that read
  // the snapshot AND the balance.
  const routes = [];
  win.fetch = (path) => {
    pillFetches += 1;
    routes.push(path);
    const body = pillSnapshot;
    // The stall stands in for a real `reset()`: the gateway's answer is served
    // immediately instead of after the hook's own network latency.
    return new Promise((resolve) => setTimeout(
      () => resolve({ ok: true, status: 200, json: async () => body }), 0));
  };
  let pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  const button = () => pill.host.querySelector("button.dsh-sensenova-composer-pill");
  const text = () => pill.host.textContent;

  await act(async () => { await sleep(0); });
  check("an owned Token Plan model mounts the pill with its two-window reading",
    button() !== null && text().includes("composer.pool5h 20%") && text().includes("composer.pool7d 1%"),
    `fetches=${pillFetches} text=${text().slice(0, 120)}`);
  check("the reset instant rides in the title, not the pill body",
    button()?.getAttribute("title")?.includes("composer.resetAt") === true
      && !text().includes("composer.resetAt"),
    `title=${button()?.getAttribute("title")}`);

  // The switch that used to kill the pill: a model from a foreign provider.
  selection.next = { provider: "openai", model: "gpt-x" };
  let foreignSwitchError = null;
  try {
    pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  } catch (error) {
    foreignSwitchError = error;
  }
  const fetchesWhileForeign = pillFetches;
  check("a foreign-provider model unmounts the pill instead of crashing it",
    foreignSwitchError === null && button() === null && pillFetches === fetchesWhileForeign,
    `error=${foreignSwitchError?.message ?? "none"} button=${button() !== null} fetches=${pillFetches} (stable while foreign: ${pillFetches === fetchesWhileForeign})`);

  // Switching BACK — the exact step the old hook mismatch made unrecoverable.
  selection.next = { provider: "sensenova-suite", model: "deepseek-v4-flash" };
  let switchBackError = null;
  try {
    pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  } catch (error) {
    switchBackError = error;
  }
  await act(async () => { await sleep(0); });
  check("switching back to an owned model brings the pill back (the reported 'gone forever')",
    switchBackError === null && button() !== null && text().includes("composer.pool5h 20%") && pillFetches === fetchesWhileForeign + 1,
    `error=${switchBackError?.message ?? "none"} fetches=${pillFetches} text=${text().slice(0, 120)}`);

  // The transient state right after a picker switch: `next` arrives as an
  // empty object before it carries the new selection. An empty `next` must
  // not shadow a still-usable `lastUsed` — the old `next ?? lastUsed` read
  // a provider off `{}` and hid the pill for OWNED models on exactly these
  // frames (the reported switch: the selected model was still a Token Plan
  // one when the pill vanished).
  selection.next = {};
  selection.lastUsed = { provider: "sensenova-suite", model: "sensenova-6.8-flash-lite" };

  // 卸载胶囊：其轮询 interval 不清，进程会被活句柄吊住（run-all 卡死的根因）。
  pill.unmount();
}

// ── §N. key 行备注编辑器（2026-10-27 报障「备注无法保存」）─────────────────
// 真实产物 + 真实 React 完整驱动备注流，抓真实 POST 载荷：
//   路径 A：点「备注」→ 输入 → 失焦提交（用户怀疑的失效路径）；
//   路径 B：点「备注」→ 输入 → 点「保存」（mousedown 先触发 blur 的真实次序）。
{
  const postCalls = [];
  win.fetch = (path, init) => {
    postCalls.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  const pool = {
    keys: [{ id: "key-2", label: "sk-cM······A9S", note: null, phase: "running", disabled: false, deleted: false }]
  };
  const m = mount(React.createElement(panel.components.ApiKeyForm, { pool, onDone: () => {}, tt, bare: true }));

  const noteAffordance = () => [...m.host.querySelectorAll("span")].find((el) => el.textContent === "poolMng.note");
  const noteInput = () => [...m.host.querySelectorAll("input")].find((el) => el.placeholder === "poolMng.note");
  const saveButton = () => [...m.host.querySelectorAll("button")].find((el) => el.textContent === "poolMng.saveName");

  check("note: 未编辑显示「备注」占位", noteAffordance() !== undefined);

  // 路径 A：失焦提交。
  act(() => noteAffordance().dispatchEvent(new win.MouseEvent("click", { bubbles: true })));
  check("note: 点击后内联输入框出现", noteInput() !== undefined && noteInput() !== null);
  typeInto(noteInput(), "hello");
  // 失焦不提交（2026-10-29 与保存目录统一：只认保存按钮/回车）——
  // React 的 onBlur 挂在 focusout（冒泡）上，派发它验证无 POST 产生。
  act(() => noteInput().dispatchEvent(new win.FocusEvent("focusout", { bubbles: true })));
  check("note: 失焦不提交（落库唯一路径是保存按钮/回车）",
    !postCalls.some((c) => c.body?.action === "rename"),
    JSON.stringify(postCalls.map((c) => c.body)));

  // 路径 B：保存按钮（mousedown 先触发 blur 的真实次序——用户假设的失效点）。
  await act(async () => { await Promise.resolve(); });
  act(() => noteAffordance().dispatchEvent(new win.MouseEvent("click", { bubbles: true })));
  typeInto(noteInput(), "second");
  act(() => saveButton().dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true })));
  const btnAfterBlur = saveButton();
  act(() => { if (btnAfterBlur) btnAfterBlur.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  const renameB = [...postCalls].reverse().find((c) => c.body?.action === "rename");
  check("note: 保存按钮路径提交 name=输入内容（blur 先行也不丢字）",
    renameB !== undefined && renameB.body.name === "second",
    JSON.stringify(postCalls.map((c) => c.body)));
  m.unmount();
}

// ── §M. sk- 前缀校验（2026-10-27 报障「粘贴 sk- 开头的 api key 没有校验」）──
// 非 sk- 输入提交 → 红字（llm.empty）+ 不发 POST；sk- 开头正常放行。
{
  const postCalls = [];
  win.fetch = (path, init) => {
    postCalls.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  const poolEmpty = { keys: [] };
  const m = mount(React.createElement(panel.components.ApiKeyForm, { pool: poolEmpty, onDone: () => {}, tt, bare: true }));
  const keyInput = [...m.host.querySelectorAll('input')].find((el) => el.placeholder === 'llm.placeholder');
  const formEl = m.host.querySelector('form');
  const submitForm = async () => {
    await act(async () => { formEl.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await Promise.resolve(); });
  };
  typeInto(keyInput, 'not-a-key');
  await submitForm();
  check('sk- 校验: 非 sk- 输入提交 → 红字 llm.empty 且无 POST',
    m.host.querySelector('p[role="alert"]')?.textContent === 'llm.empty' && postCalls.length === 0,
    "alert=" + (m.host.querySelector('p[role="alert"]')?.textContent ?? 'none') + " posts=" + postCalls.length);
  typeInto(keyInput, 'sk-abc123');
  await submitForm();
  const added = postCalls.find((c) => c.body?.action === 'add');
  check('sk- 校验: sk- 开头正常放行 add',
    added !== undefined && added.body.apiKey === 'sk-abc123',
    JSON.stringify(postCalls));
  m.unmount();
}

// ── §N. 删除确认流换宿主 Modal（2026-10-29：原生 confirm → primitives.Modal）──
// 点行内删除 → Modal 桩收到 open=true、确认文案上屏、无 POST；取消/确认两条路
// 由各自验证（确认发 POST {action:delete}，取消/遮罩不发）。-kit 缺席的回落
// 路径由 pool-route 源码级钉住（clientModal()===null 走原生 confirm）。
{
  const postCalls = [];
  win.fetch = (path, init) => {
    postCalls.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  const pool = {
    keys: [{ id: "key-2", label: "sk-cM······A9S", note: null, phase: "running", disabled: false, deleted: false }]
  };
  const m = mount(React.createElement(panel.components.ApiKeyForm, { pool, onDone: () => {}, tt, bare: true }));

  const rowDeleteButton = () => [...m.host.querySelectorAll("button")]
    .find((el) => el.textContent === "poolMng.delete" && !el.closest('[data-modal-open="true"]'));
  const modalSurface = () => m.host.querySelector('[data-modal-open="true"]');
  const inModal = (text) => [...(modalSurface()?.querySelectorAll("button") ?? [])]
    .find((el) => el.textContent === text);
  const click = (el) => act(() => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true })));

  await click(rowDeleteButton());
  check("删除确认: 点行内删除 → Modal 打开且确认文案上屏、无 POST",
    modalSurface() !== null
      && modalSurface().textContent.includes("poolMng.deleteConfirm")
      && inModal("poolMng.cancel") !== undefined && inModal("poolMng.delete") !== undefined
      && postCalls.length === 0,
    `modal=${modalSurface()?.textContent.slice(0, 80) ?? "none"} posts=${postCalls.length}`);

  // 取消路径：无 POST、弹窗收起。
  await click(inModal("poolMng.cancel"));
  check("删除确认: 取消 → 弹窗收起且无 POST",
    modalSurface() === null && postCalls.length === 0,
    `modal=${modalSurface() !== null} posts=${postCalls.length}`);

  // 确认路径：POST {action:delete, id}、弹窗收起。
  await click(rowDeleteButton());
  await click(inModal("poolMng.delete"));
  const deleted = postCalls.find((c) => c.body?.action === "delete");
  check("删除确认: 确认 → POST delete 正确 id 且弹窗收起",
    deleted !== undefined && deleted.body.id === "key-2" && modalSurface() === null,
    `posts=${JSON.stringify(postCalls.map((c) => c.body))}`);
  m.unmount();
}

finish();
// jsdom 的真计时器偶尔留活句柄（保险丝：结果已全部打印，直接退出）。
process.exit(results.some((entry) => !entry.pass) ? 1 : 0);
