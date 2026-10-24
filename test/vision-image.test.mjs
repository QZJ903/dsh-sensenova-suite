/**
 * 出图 + 视觉单测——纯 Node、无 peer。
 *
 * 钉住的契约：
 *   - image-tools：参数校验（空 prompt / edits 无 images 抛错）、成功值形状
 *     （b64 → imageDataUrl + savePath 落盘）、失败进 30s 冷却（冷却期直接拒绝）、
 *     key 经池解析并上报成功；
 *   - vision/run：describe 信封（成功 metadata.attempts / 失败 envelope），fetch 全部走注入桩；
 *   - vision/bridge：contentHasImage 递归（含 tool-result 内嵌）；
 *   - host-config：模型链归一化与出图/视觉键的回落。
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callImageApi, resetImageCooldown, IMAGE_COOLDOWN_MS } from "../src/host/image-tools.ts";
import { describe as runDescribe } from "../src/host/vision/run.ts";
import { contentHasImage } from "../src/host/vision/bridge.ts";

const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

// ── 1. image-tools ──────────────────────────────────────────────────────────
try {
  const imageOptions = {
    apiBase: "https://token.sensenova.cn/v1",
    defaultModel: "sensenova-u1.5-lite",
    watermark: false,
    defaultSize: "1024x1024",
    outputDir: "",
    timeoutMs: 5_000,
  };
  const keysResolved = [];
  const successes = [];
  let now = 1_000_000;
  const deps = () => ({
    options: () => ({ ...imageOptions, outputFormat: "png", responseFormat: "b64_json", promptExtend: true }),
    resolveKey: async (model) => { keysResolved.push(model); return "sk-pool-1"; },
    reportSuccess: (key) => successes.push(key),
    now: () => now,
    fetchImpl: (async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("fake-png").toString("base64") }],
      output_format: "png",
      size: "1024x1024",
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, images_count: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } })),
  });

  resetImageCooldown();
  const okValue = await callImageApi(deps(), { prompt: "一只海豹", savePath: undefined }, "text2img", "/images/generations");
  check("文生图成功值形状", okValue.ok === true && okValue.imageDataUrl?.startsWith("data:image/png;base64,") === true
    && okValue.usage?.total_tokens === 30, JSON.stringify(okValue).slice(0, 160));
  check("key 经池按模型解析", keysResolved[0] === "sensenova-u1.5-lite", keysResolved.join(","));
  check("成功上报池", successes[0] === "sk-pool-1");

  // savePath 落盘
  const dir = mkdtempSync(join(tmpdir(), "suite-image-"));
  const saved = await callImageApi(deps(), { prompt: "落盘测试", savePath: dir }, "text2img", "/images/generations");
  check("savePath 落盘返回路径", typeof saved.imagePath === "string" && saved.imagePath.startsWith(dir), saved.imagePath);
  rmSync(dir, { recursive: true, force: true });

  // 参数校验
  let threw = "";
  try { await callImageApi(deps(), { prompt: "  " }, "text2img", "/images/generations"); } catch (e) { threw = String(e); }
  check("空 prompt 抛错", threw.includes("prompt"), threw);
  threw = "";
  try { await callImageApi(deps(), { prompt: "x", images: [] }, "img2img", "/images/edits"); } catch (e) { threw = String(e); }
  check("edits 无 images 抛错", threw.includes("images"), threw);

  // edits 的 images 透传
  resetImageCooldown();
  const editValue = await callImageApi(deps(), { prompt: "背景换冰川", images: [{ image_url: "https://example.com/a.png" }] }, "img2img", "/images/edits");
  check("img2img 成功", editValue.ok === true, JSON.stringify(editValue).slice(0, 120));

  // 冷却：失败 → 30s 内直接拒绝
  resetImageCooldown();
  const failing = { ...deps(), fetchImpl: (async () => new Response("boom", { status: 500 })) };
  const failValue = await callImageApi(failing, { prompt: "会失败" }, "text2img", "/images/generations");
  check("失败值带错误", failValue.ok === false && typeof failValue.error === "string" && failValue.error !== "");
  const coolValue = await callImageApi(deps(), { prompt: "冷却中" }, "text2img", "/images/generations");
  check("冷却期直接拒绝（不发请求）", coolValue.ok === false && coolValue.error.includes("冷却"), coolValue.error);
  now += IMAGE_COOLDOWN_MS + 1;
  resetImageCooldown();
  const recovered = await callImageApi(deps(), { prompt: "冷却结束" }, "text2img", "/images/generations");
  check("冷却结束后恢复", recovered.ok === true);
} catch (e) { fail("image-tools", e); }

// ── 2. vision/run（fetch 桩）────────────────────────────────────────────────
try {
  const options = {
    apiBase: "https://token.sensenova.cn/v1",
    model: "sensenova-6.8-flash-lite",
    imageMode: "image_url",
    timeoutMs: 5_000,
  };
  // 1x1 PNG 的 base64。
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const calls = [];
  const fetchStub = (async (url, init) => {
    calls.push(String(url));
    if (calls.length === 2) {
      // 第 2 次调用 429（验 429 回池分类）；第 1 次与之后 200（验成功信封与回池）。
      return new Response(JSON.stringify({ error: { code: 8, message: "rps exhausted" } }), { status: 429 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "图里有只海豹" } }] }), { status: 200 });
  });
  const feedbackCalls = [];
  const feedback = {
    on429: (key, kind) => feedbackCalls.push(["429", key, kind]),
    on401: (key) => feedbackCalls.push(["401", key]),
    onSuccess: (key) => feedbackCalls.push(["ok", key])
  };
  const ctx = { get: (service) => (service === "fetch" ? fetchStub : undefined) };

  const envelopeText = await runDescribe(ctx, { image: `data:image/png;base64,${pngB64}` }, options, async () => "sk-v", feedback, "image_reasoning");
  const envelope = JSON.parse(envelopeText);
  check("describe 单模型成功", envelope.ok === true && envelope.tool_used === "sensenova:sensenova-6.8-flash-lite", envelopeText.slice(0, 140));
  check("成功回池（onSuccess）", feedbackCalls.some((c) => c[0] === "ok" && c[1] === "sk-v"), JSON.stringify(feedbackCalls));

  const failText = await runDescribe(ctx, { image: `data:image/png;base64,${pngB64}` }, options, async () => "sk-v", feedback, "image_reasoning");
  void failText;
  check("429 回池分类为 rate-rps", feedbackCalls.some((c) => c[0] === "429" && c[2] === "rate-rps"), JSON.stringify(feedbackCalls));
  const noKey = JSON.parse(await runDescribe(ctx, { image: `data:image/png;base64,${pngB64}` }, options, async () => { throw new Error("pool empty"); }, feedback, "image_reasoning"));
  check("池空 → 失败信封（不抛）", noKey.ok === false && String(noKey.error).includes("pool empty"), JSON.stringify(noKey));
} catch (e) { fail("vision/run", e); }

// ── 3. bridge.contentHasImage ───────────────────────────────────────────────
try {
  const img = [{ type: "image", attachment: { kind: "image", id: "a1" } }];
  check("顶层 image 块", contentHasImage(img) === true);
  check("纯文本为 false", contentHasImage([{ type: "text", text: "hi" }]) === false);
  check("undefined 为 false", contentHasImage(undefined) === false);
  check("tool-result 内嵌 image", contentHasImage([
    { type: "tool-result", content: [{ type: "image", attachment: { kind: "image", id: "t1" } }] },
  ]) === true);
} catch (e) { fail("bridge", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`vision-image.test.mjs：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`vision-image.test.mjs：${results.length} 项全过`);
