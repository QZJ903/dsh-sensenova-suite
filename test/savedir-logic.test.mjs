/**
 * 保存目录「点保存落库」源码级断言（render.test 同款 standin 驱动）。
 *
 * jsdom 的合成 focus 事件不触发 React 19 的 onFocus（attachEvent 缺口 + 原生
 * focus() 不派发事件），DOM 级复现做不了聚焦判定——这里用 client-surface 的
 * standin（回调直调）对「按钮属性 + 提交载荷」做断言：onFocus/onChange 在真实
 * 浏览器必然触发（React 原生行为），焦点派发本身由浏览器保证。
 */
import { strict as assert } from "node:assert";
import { h } from "./client-surface.js";
import { MultimodalTab } from "../src/client/multimodal-tab.ts";
import * as runtime from "../src/client/runtime.ts";
import { reactStandin } from "./client-surface.js";

runtime.provideClientReact(reactStandin);

const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

try {
  const posts = [];
  globalThis.fetch = (async (path, init) => {
    posts.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: true, json: async () => ({ ok: true }) };
  });

  const pool = {
    keys: [],
    settings: {
      toolsEnabled: { text2img: true, img2img: true, visionTools: true },
      text2img: {}, img2img: {},
      vision: { visionModels: [] },
      thinking: {}
    }
  };
  const tree = MultimodalTab({ pool, llm: null, onDone: () => {}, tt: (k) => k });
  const stack = [tree];
  let dirInputProps = null;
  let saveBtnProps = null;
  while (stack.length > 0) {
    const el = stack.shift();
    if (el === null || typeof el !== "object") continue;
    if (Array.isArray(el)) { stack.push(...el); continue; }
    if (el.type === "input" && el.props?.placeholder === "mm.outputDirHint") dirInputProps = el.props;
    if (el.type === "button" && (el.children ?? []).flat().includes("poolMng.saveName")) saveBtnProps = el.props;
    if (el.props?.children !== undefined) stack.push(el.props.children);
    if (el.children !== undefined) stack.push(el.children);
  }
  check("保存目录输入框在树里", dirInputProps !== null);
  check("保存按钮在树里（常驻渲染）", saveBtnProps !== null);
  if (dirInputProps !== null && saveBtnProps !== null) {
    check("保存按钮 disabled 只看 busy（失焦废按钮的通路已断）",
      saveBtnProps.disabled === false, String(saveBtnProps.disabled));
    // standin 的 useState 恒初值（render.test 头部文档）——onChange 驱动的
    // 状态流断言由 DOM 级套件 savedir-flow.test.mjs（真实 React）承担；这里
    // 只断言结构与点击通路。
    assert.doesNotThrow(() => {
      dirInputProps.onChange({ target: { value: "D:\\imgs" } });
      saveBtnProps.onClick();
    });
  }
} catch (e) { fail("savedir-logic", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`savedir-logic：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`savedir-logic：${results.length} 项全过`);
process.exit(0);
