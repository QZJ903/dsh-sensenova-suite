/**
 * 保存目录「点保存落库」DOM 级端到端——真实产物 client.js + 真实 React + jsdom。
 *
 * 上一轮 DOM 复现卡在 React 19 的两个 jsdom 缺口：
 *   1. onFocus 需要 attachEvent polyfill（input-event polyfill 依赖）；
 *   2. 原生 focus() 在 jsdom 不派发 focus 事件 → 手动派发 focusin（冒泡）。
 * 补齐两者后完整驱动：切 tab → 聚焦 → 输入 → 点保存 → 抓 POST；再验失焦不提交。
 * 根因背景：点保存的 mousedown 让输入框先 blur，旧实现 onBlur 收按钮
 * （visibility+disabled），click 落在已禁用按钮上——「按了保存没反应」。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromHere = createRequire(join(root, "test", "x.mjs"));
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  runScripts: "outside-only", pretendToBeVisual: true, url: "http://127.0.0.1/"
});
const win = dom.window;
win.setInterval = () => 0;
win.clearInterval = () => {};
// React 19 的 input-event polyfill 在 jsdom 上的两个缺口。
win.HTMLElement.prototype.attachEvent = win.HTMLElement.prototype.attachEvent || function () {};
win.HTMLElement.prototype.detachEvent = win.HTMLElement.prototype.detachEvent || function () {};
globalThis.window = win;
globalThis.document = win.document;

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const act = React.act;

const registrations = [];
win.__ModuleLoader__ = { load: (r) => registrations.push(r) };
win.eval(readFileSync(join(root, "client.js"), "utf8"));
const registration = registrations.find((e) => e.id === "dsh-sensenova-suite");
const materialized = registration.factory((spec) => {
  if (spec === "react") return React;
  throw new Error("loader lacks " + spec);
});
const panel = materialized.panel;
const tt = (k) => k;

const posts = [];
win.fetch = (path, init) => {
  posts.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null });
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};

const pool = {
  keys: [],
  settings: {
    toolsEnabled: { text2img: true, img2img: true, visionTools: true },
    text2img: {}, img2img: {},
    vision: { visionModels: [] },
    thinking: {}
  }
};
const host = win.document.createElement("div");
win.document.body.append(host);
const r = createRoot(host);
await act(async () => r.render(React.createElement(panel.components.PanelPage, { pool, llm: { models: [], enabledModelIds: [] }, tt })));

const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

try {
  const tabBtn = [...host.querySelectorAll("button")].find((el) => el.textContent === "tab.multimodal");
  await act(async () => { if (tabBtn) tabBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  const dirInput = [...host.querySelectorAll("input")].find((el) => el.placeholder === "mm.outputDirHint");
  check("多模态 tab 里找到保存目录输入框", dirInput !== undefined);

  if (dirInput) {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
    // 聚焦：React onFocus = focusin（冒泡）。派发前先把输入框设为 activeElement，
    // 再冒泡 focusin —— 双保险。
    await act(async () => {
      Object.defineProperty(dirInput, "ownerDocument", { value: win.document });
      dirInput.dispatchEvent(new win.FocusEvent("focus", { bubbles: false }));
      dirInput.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
    });
    await act(async () => {
      setter.call(dirInput, "D:\\imgs");
      dirInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    const visibleSave = [...host.querySelectorAll("button")]
      .find((el) => el.textContent === "poolMng.saveName" && el.style.visibility !== "hidden");
    check("聚焦 + 有改动 → 保存按钮可见", visibleSave !== undefined,
      JSON.stringify([...host.querySelectorAll("button")]
        .filter((el) => el.textContent === "poolMng.saveName").map((el) => el.style.visibility)));
    await act(async () => { if (visibleSave) visibleSave.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    const sectionPost = posts.find((p) => p.body?.section === "text2img");
    check("点保存 → POST {section:'text2img', values:{outputDir}}",
      sectionPost !== undefined && sectionPost.body.values.outputDir === "D:\\imgs",
      JSON.stringify(posts));
    const count = posts.length;
    await act(async () => { dirInput.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    check("失焦不再产生 POST", posts.length === count);
  }
} catch (e) { fail("savedir-dom", e); }

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`savedir-dom：${failed.length}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`savedir-dom：${results.length} 项全过`);
process.exit(0);
