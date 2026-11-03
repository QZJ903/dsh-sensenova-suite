/**
 * 出图 + 视觉单测——纯 Node、无 peer。
 *
 * 钉住的契约：
 *   - image-tools：参数校验（空 prompt / edits 无 images 抛错）、成功值形状
 *     （url 信封 → 只回 URL 不回 base64 + 面板 outputDir 落盘拉字节）、失败进 30s 冷却（冷却期直接拒绝）、
 *     key 经池解析并上报成功；
 *   - 出图工具：额度耗尽换 key（2026-11-04——只换不打格，与对话链账本无关）；
 *   - vision/bridge：contentHasImage 递归（含 tool-result 内嵌）；
 *   - host-config：模型链归一化与出图/视觉键的回落。
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callImageApi, resetImageCooldown, IMAGE_COOLDOWN_MS } from "../src/host/image-tools.ts";
import { contentHasImage, createImageSwapper } from "../src/host/vision/bridge.ts";

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
  const IMAGE_URL = "https://img.example.com/gen/abc.png";
  // 两段式桩：出图 API → 返回 url 信封；随后对 URL 的 GET → 图片字节。
  const fetchStub = (async (url) => {
    const u = String(url);
    if (u.endsWith("/images/generations") || u.endsWith("/images/edits")) {
      return new Response(JSON.stringify({
        data: [{ url: IMAGE_URL }],
        output_format: "png",
        size: "1024x1024",
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, images_count: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(Buffer.from("fake-png-bytes"), { status: 200 });
  });
  const deps = () => ({
    options: () => ({ ...imageOptions, outputFormat: "png", promptExtend: true }),
    resolveKey: async (model) => { keysResolved.push(model); return "sk-pool-1"; },
    reportSuccess: (key) => successes.push(key),
    now: () => now,
    fetchImpl: fetchStub,
  });

  resetImageCooldown();
  const okValue = await callImageApi(deps(), { prompt: "一只海豹" }, "text2img", "/images/generations");
  check("文生图只回 URL（base64 不进返回值）",
    okValue.ok === true && okValue.imageUrl === IMAGE_URL && okValue.imageDataUrl === undefined
    && okValue.usage?.total_tokens === 30, JSON.stringify(okValue).slice(0, 200));
  check("key 经池按模型解析", keysResolved[0] === "sensenova-u1.5-lite", keysResolved.join(","));
  check("成功上报池", successes[0] === "sk-pool-1");

  // 落盘只由面板「输出目录」决定：插件拉取 URL 字节存文件（savePath 参数已移除）
  const dir = mkdtempSync(join(tmpdir(), "suite-image-"));
  const dirDeps = { ...deps(), options: () => ({ ...imageOptions, outputFormat: "png", promptExtend: true, outputDir: dir }) };
  const saved = await callImageApi(dirDeps, { prompt: "落盘测试" }, "text2img", "/images/generations");
  check("面板 outputDir 落盘返回路径", typeof saved.imagePath === "string" && saved.imagePath.startsWith(dir), saved.imagePath);
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

  // 参数强制覆盖（2026-10-27）：面板配置是唯一真源——args 带上同名参数也被压掉。
  // 旧 args 优先逻辑让模型的 watermark:true 压过面板「关闭水印」，水印关不掉。
  resetImageCooldown();
  const bodies = [];
  const overrideDeps = {
    ...deps(),
    fetchImpl: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }), { status: 200 });
    }),
  };
  await callImageApi(overrideDeps, { prompt: "压参数", watermark: true, model: "sensenova-u1.5-fast", size: "512x512", prompt_extend: false }, "text2img", "/images/generations");
  check("面板配置强制覆盖 args（水印/模型/尺寸/润色/返回格式）",
    bodies[0]?.watermark === false && bodies[0]?.model === "sensenova-u1.5-lite"
    && bodies[0]?.size === "1024x1024" && bodies[0]?.prompt_extend === true
    && bodies[0]?.response_format === "url",
    JSON.stringify(bodies[0]));

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

  // 额度耗尽换 key（2026-11-04）：429 → rotateOnQuota 换一把重试一次；成功走
  // reportSuccess（新 key）。不打格不记账——与对话链耗尽账本无关（他裁定）。
  resetImageCooldown();
  const rotated = [];
  const rotateDeps = {
    ...deps(),
    fetchImpl: (async (_url, init) => {
      const auth = String(init?.headers?.Authorization ?? "");
      if (auth.includes("sk-pool-1")) {
        return new Response(JSON.stringify({ error: { code: "Throttling.AllocationQuota", message: "Workspace allocated quota exceeded" } }), { status: 429 });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("y").toString("base64") }] }), { status: 200 });
    }),
    resolveKey: async () => "sk-pool-1",
    rotateOnQuota: async (failedKey) => { rotated.push(failedKey); return "sk-pool-2"; },
  };
  const rotValue = await callImageApi(rotateDeps, { prompt: "耗尽换 key" }, "text2img", "/images/generations");
  check("429 → 换 key 重试成功（新 key 走 reportSuccess，不打格）",
    rotValue.ok === true && rotated[0] === "sk-pool-1" && successes.includes("sk-pool-2"),
    JSON.stringify(rotValue).slice(0, 140));
  // 批 H 遍历式：429 一直换到所有 key 试过（每把一次），全试完才报错收场。
  resetImageCooldown();
  const poolKeys = ["sk-1", "sk-2", "sk-3"];
  const seenKeys = [];
  const traverseDeps = {
    ...deps(),
    resolveKey: async () => "sk-1",
    fetchImpl: (async (_url, init) => {
      seenKeys.push(String(init?.headers?.Authorization ?? "").replace("Bearer ", ""));
      return new Response(JSON.stringify({ error: { code: "Throttling.AllocationQuota", message: "Workspace allocated quota exceeded" } }), { status: 429 });
    }),
    rotateOnQuota: async (_failed, _model, exclude) => poolKeys.find((k) => !exclude.has(k)),
  };
  const travValue = await callImageApi(traverseDeps, { prompt: "全池遍历" }, "text2img", "/images/generations");
  check("批 H 遍历：lastGood 起点后全池各试一次再报错收场",
    travValue.ok === false
    && seenKeys[0] === "sk-pool-2" && new Set(seenKeys).size === 4
    && seenKeys.slice(1).join(",") === "sk-1,sk-2,sk-3",
    JSON.stringify({ seenKeys, value: travValue }).slice(0, 200));
  // lastGood 优先：上次成功的 key（sk-pool-2）下一次直接用，resolveKey 不被调。
  resetImageCooldown();
  let resolveCalled = 0;
  const goodDeps = {
    ...deps(),
    resolveKey: async () => { resolveCalled += 1; return "sk-fresh"; },
    fetchImpl: (async (_url, init) => {
      const auth = String(init?.headers?.Authorization ?? "");
      if (!auth.includes("sk-pool-2")) return new Response("unexpected key", { status: 500 });
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("z").toString("base64") }] }), { status: 200 });
    }),
  };
  const goodValue = await callImageApi(goodDeps, { prompt: "lastGood 优先" }, "text2img", "/images/generations");
  check("批 H lastGood：上次成功的 key 直接复用（resolveKey 不调）",
    goodValue.ok === true && resolveCalled === 0, JSON.stringify(goodValue).slice(0, 120));
  // 换无可换：rotateOnQuota 返回 undefined → 原错误报出 + 冷却。
  resetImageCooldown();
  const noNext = {
    ...rotateDeps,
    fetchImpl: (async () => new Response(JSON.stringify({ error: { code: "Throttling.AllocationQuota", message: "quota" } }), { status: 429 })),
    rotateOnQuota: async () => undefined,
  };
  const noNextValue = await callImageApi(noNext, { prompt: "换无可换" }, "text2img", "/images/generations");
  check("换无可换 → 报错收场 + 冷却", noNextValue.ok === false && String(noNextValue.error).includes("429"), JSON.stringify(noNextValue).slice(0, 140));
} catch (e) { fail("image-tools", e); }

// ── 2. bridge.contentHasImage ───────────────────────────────────────────────
try {
  const img = [{ type: "image", attachment: { kind: "image", id: "a1" } }];
  check("顶层 image 块", contentHasImage(img) === true);
  check("纯文本为 false", contentHasImage([{ type: "text", text: "hi" }]) === false);
  check("undefined 为 false", contentHasImage(undefined) === false);
  check("tool-result 内嵌 image", contentHasImage([
    { type: "tool-result", content: [{ type: "image", attachment: { kind: "image", id: "t1" } }] },
  ]) === true);
} catch (e) { fail("bridge", e); }

// ── 3. 桥 429 换 key（2026-11-04 批 G：与 429 分类无关，只保证服务继续）────
try {
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const swapperCalls = [];
  const fetchStub = (async (_url, init) => {
    const auth = String(init?.headers?.authorization ?? init?.headers?.Authorization ?? "");
    swapperCalls.push(auth);
    if (auth.includes("sk-b1")) {
      return new Response(JSON.stringify({ error: { code: "Throttling.AllocationQuota", message: "Workspace allocated quota exceeded" } }), { status: 429 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "图里有只海豹" } }] }), { status: 200 });
  });
  const okKeys = [];
  const swapper = createImageSwapper({
    options: () => ({ apiBase: "https://token.sensenova.cn/v1", model: "sensenova-6.8-flash-lite", imageMode: "image_url", timeoutMs: 5_000, bridgePrompt: "描述图片", relayOn: true }),
    checkedIds: () => [], // 未勾选 → 走转述
    resolveKey: async () => "sk-b1",
    rotateOnQuota: async (k) => { await Promise.resolve(); return k === "sk-b1" ? "sk-b2" : undefined; },
    feedback: { on401: () => {}, onSuccess: (key) => okKeys.push(key) },
    loadImage: async () => ({ base64: pngB64, mediaType: "image/png" }),
    fetchImpl: fetchStub,
  });
  const out = await swapper(
    [{ role: "user", content: [{ type: "image", attachment: { kind: "image", id: "a1" } }, { type: "text", text: "看图" }] }],
    { model: "deepseek-flash" },
  );
  const obsText = JSON.stringify(out);
  check("桥 429 → 换 key 重试成功（转述文本进消息）",
    obsText.includes("视觉观察") && obsText.includes("图里有只海豹"), obsText.slice(0, 160));
  check("桥换 key 排除失败 key（成功上报走新 key）",
    swapperCalls[0]?.includes("sk-b1") && swapperCalls[1]?.includes("sk-b2") && okKeys.includes("sk-b2"),
    JSON.stringify({ calls: swapperCalls, okKeys }));
  // 批 H 遍历式：全池试完 → describeImage 抛 → 上层占位收场（对话继续）。
  resetImageCooldown?.();
  const bridgePool = ["sk-c1", "sk-c2"];
  const failStub = (async (_url, init) => {
    swapperCalls.push(String(init?.headers?.authorization ?? init?.headers?.Authorization ?? ""));
    return new Response(JSON.stringify({ error: { code: "Throttling.AllocationQuota", message: "quota" } }), { status: 429 });
  });
  const failingSwapper = createImageSwapper({
    options: () => ({ apiBase: "https://token.sensenova.cn/v1", model: "sensenova-6.8-flash-lite", imageMode: "image_url", timeoutMs: 5_000, bridgePrompt: "p", relayOn: true }),
    checkedIds: () => [],
    resolveKey: async () => "sk-c1",
    rotateOnQuota: async (_k, exclude) => bridgePool.find((k) => !exclude.has(k)),
    feedback: { on401: () => {}, onSuccess: () => {} },
    loadImage: async () => ({ base64: pngB64, mediaType: "image/png" }),
    fetchImpl: failStub,
  });
  const failOut = await failingSwapper(
    [{ role: "user", content: [{ type: "image", attachment: { kind: "image", id: "a2" } }] }],
    { model: "deepseek-flash" },
  );
  const failText2 = JSON.stringify(failOut);
  check("桥全池试完 → 占位收场（对话继续）",
    failText2.includes("图片转换失败") && swapperCalls.filter((c) => c.includes("sk-c")).length === 2,
    failText2.slice(0, 160));
} catch (e) { fail("bridge-rotate", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`vision-image.test.mjs：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`vision-image.test.mjs：${results.length} 项全过`);
