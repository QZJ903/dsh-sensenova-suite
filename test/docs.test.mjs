// docs.test.mjs —— 文档与引用一致性钉子（纯文件读取：无网络、无 peer 依赖、干净检出即可跑）
//
// 2026-11-03 改写为 suite 自有版。docs/ 现在只有三样：
//   - retry-policy.md                本仓自有（429 教义）
//   - sensenova-api-reference/       商汤官方文档逐字副本（vendor 参考件）
//   - upstream/                      token-plan v0.8.3 逐字原文（上游参考件）
// upstream/ 是参考件不是本仓现状，collectMd 整目录豁免、不参与本套件；vendor 副本
// 同样豁免考古扫描（那是别人的文字，不是本仓的自述面）。
// 原 17 项检查里凡是读「现行文档」的——DSH-PLUGIN 教学快照 / API 契约 / PITFALLS 计数 /
// ADR 闭合 / TESTING↔名册 / SETUP 数值 / docs 顶层索引——随文档退役，自有文档回补到
// docs/ 顶层时从 git 历史逐项接回。现在守的 8 项：
//   结构（1/3）：内部链接可解析、根 README 行数上限
//   引用闭合（8）：src/ 注释里的模块名引用完整（含伪文件名扫描）
//   自述面与实际一致（9/10）：README 覆盖每个 tab、声明的 UI 位置与 client 槽位注册一致
//                    ——这两类验的是「文档有没有说实话」，形式全绿而语义已漂是本仓
//                    踩过两次的坑（原 PITFALLS §25，档在 docs/upstream/PITFALLS.md）
//   考古纪律（12）：现行文档与 src/ 注释无内联考古补丁/搬家叙述
//   数值副本看守（17'）：retry-policy.md 复述的退避梯 / 踢出阈值 / 轮询轮次 / 抖动窗
//                    必须等于源码常量，且每个落点引用在被引文件里真实存在——
//                    副本不可怕，没有看守的副本才可怕。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const note = (m) => console.log(`  ok - ${m}`);
const bad = (m) => fails.push(m);

function collectMd(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    // `upstream/` 是上游文档的逐字参考件（token-plan 原文）：它的断链/上游叙事只对
    // 上游仓库负责，扫它只会产出假红——与 `tmp/` 同理。
    if (name === "upstream" || name === ".git" || name === "node_modules") continue;
    // `tmp/` 是 scratch（gitignored），工作会话临时落在里面的文件不该进门禁。
    if (name === "tmp") continue;
    if (statSync(p).isDirectory()) out.push(...collectMd(p));
    else if (extname(p) === ".md") out.push(p);
  }
  return out;
}

const mdFiles = collectMd(ROOT).sort();
console.log(`docs.test.mjs —— 检查 ${mdFiles.length} 个 markdown 文件`);

// 1) 内部链接全部可解析
{
  let checked = 0;
  for (const f of mdFiles) {
    const text = readFileSync(f, "utf8");
    const re = /\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim();
      if (/^(https?:|#)/.test(raw)) continue;
      const pathPart = raw.split("#")[0];
      if (!pathPart) continue;
      checked++;
      if (!existsSync(resolve(dirname(f), pathPart))) bad(`断链：${f} -> ${raw}`);
    }
  }
  note(`内部链接 ${checked} 条全部可解析`);
}

// 3) 根 README 行数上限
{
  const lines = readFileSync(join(ROOT, "README.md"), "utf8").split(/\r?\n/).length;
  if (lines > 200) {
    bad(`README.md ${lines} 行，超过 200 行上限——根 README 是索引与快速上手，细节下沉到 docs/ 与 docs/upstream/`);
  } else {
    note(`README.md ${lines} 行（上限 200）`);
  }
}

// 8) src/ 注释里的模块名引用完整性
// 事故教训：注释里 `indexts`（少了点的 index.ts）这种伪文件名曾在 21 个文件里繁殖 66 处，
// 修完 42 处又长回来——注释里的引用没人校验就不会红。这里钉两条：
//   a) 反引号里的 `Xts` / `dir/Xts` 伪文件名，若 `X.ts`/`X.js` 在 src 里真实存在，直接报错
//      （候选存在判定天然放过 hosts / attempts 这类正常英文词）；
//   b) 反引号里的 `X.ts` 式正引用必须能解析到真实文件，否则断链。
// 两个白名单名词是架构事实而非源码引用，跳过但留痕：
//   - `client.js`        根构建产物（tsdown 从 src/client 构建，gitignore，干净检出不在）
//   - `client-surface.js` loader 的模块面（仓库外约定名，见 src/client/runtime.ts 头注释）
{
  const tsFiles = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); }
      else if (name.endsWith(".ts")) tsFiles.push(p);
    }
  };
  walk(join(ROOT, "src"));
  const rel = (p) => p.replace(ROOT + "\\", "").replace(/\\/g, "/");
  const KNOWN_ARTIFACTS = new Set(["client.js", "client-surface.js"]);
  const srcCandidate = (ref) => {
    // 引用可能是 `X.ts`（同目录或 src 根）、`dir/X.ts`（src 内相对）或 `src/host/X.ts`
    // （仓库根相对，wire/ 家族就这么写）；按惯例的基准全部枚举一遍
    const plain = ref.startsWith("./") ? ref.slice(2) : ref;
    const bases = [join(ROOT, "src"), join(ROOT, "src", "host"), join(ROOT, "src", "client"), ROOT];
    return bases.map((b) => join(b, plain)).filter((c) => existsSync(c));
  };
  const fileCandidates = (ref, baseDir) => [join(baseDir, ref), ...srcCandidate(ref)].filter((c) => existsSync(c));
  let pseudo = 0, checked = 0, known = 0;
  for (const f of tsFiles) {
    const text = readFileSync(f, "utf8");
    // a) 伪文件名 `Xts` / `dir/Xts`：候选真实文件存在才算数
    for (const m of text.matchAll(/`([\w-]+(?:\/[\w-]+)*)ts`/g)) {
      const x = m[1];
      const asTs = srcCandidate(`${x}.ts`);
      const asJs = srcCandidate(`${x}.js`);
      if (asTs.length || asJs.length) {
        pseudo++;
        bad(`${rel(f)} 注释伪文件名 \`${x}ts\`（应为 \`${x}.ts\`）`);
      }
    }
    // b) 正引用 `X.ts` / `dir/X.ts`（含 ./ 前缀）必须存在；两个架构名词白名单跳过但留痕
    for (const m of text.matchAll(/`((?:\.\/)?[\w-]+(?:\/[\w-]+)*\.(?:ts|js))`/g)) {
      const ref = m[1];
      checked++;
      if (KNOWN_ARTIFACTS.has(ref)) { known++; continue; }
      if (fileCandidates(ref, dirname(f)).length === 0) {
        bad(`注释引用断链：${rel(f)} -> \`${ref}\``);
      }
    }
  }
  if (pseudo === 0) note(`注释伪文件名 0 处（${tsFiles.length} 个 src 文件）`);
  else note(`注释伪文件名 ${pseudo} 处（已在上方逐条列出）`);
  note(`注释模块引用 ${checked} 条全部可解析${known ? `（含 ${known} 条架构名词白名单）` : ""}`);
}

// 9) README 必须覆盖面板的每一个 tab
// 形式校验对「README 说的事是不是真的」一无所知。事故：上游 0.4.3 新增第三个 tab，
// README 零处提及，而 README 进 npm 的 files 白名单——装完的用户不知道这个能力存在。
// 这里从两个真源派生「README 必须出现的文案」，不写死任何名字：
//   a) panel-page.ts 的 `TabId` 联合类型（activeTab 用它） -> tab id 集合
//   b) i18n.ts 里 `tab.<id>` 的中文文案（zh 字典在前，同键只取首次）
// 于是「加一个 tab 而忘了告诉用户」必然红，「改 tab 名而 README 不跟」也必然红。
{
  const panelSrc = readFileSync(join(ROOT, "src", "client", "panel-page.ts"), "utf8");
  const i18nSrc = readFileSync(join(ROOT, "src", "client", "i18n.ts"), "utf8");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  // 必须钉到 activeTab 的联合类型：本文件第一个 useState 是 useState<SnapshotData | null>，
  // 泛配会抓到它，反而漏掉真正的 tab 联合类型。真源跟随 `export type TabId`；
  // `useState<TabId>` 仍被断言到，防止 activeTab 悄悄换回字面量联而这里还在读别名。
  const union = panelSrc.match(/activeTab,\s*setActiveTab\]\s*=\s*useState<TabId>/);
  const tabIdDecl = panelSrc.match(/export\s+type\s+TabId\s*=\s*([^;]+);/);
  if (!union) bad("src/client/panel-page.ts 找不到 activeTab 的 useState<TabId>，检查 9 本身可能已失效");
  else if (!tabIdDecl) bad("src/client/panel-page.ts 找不到 export type TabId 声明，tab id 真源断了");
  else {
    const tabIds = [...tabIdDecl[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    if (tabIds.length === 0) bad("activeTab 联合类型里没有解析出任何 tab id");
    else {
      const zh = new Map();
      for (const m of i18nSrc.matchAll(/"tab\.([A-Za-z]+)"\s*:\s*"([^"]+)"/g)) {
        if (!zh.has(m[1])) zh.set(m[1], m[2]); // zh 字典在 en 之前
      }
      const missingName = tabIds.filter((id) => !zh.has(id));
      const missingInReadme = tabIds.filter((id) => zh.has(id) && !readme.includes(zh.get(id)));
      if (missingName.length) bad(`i18n 里缺 tab 文案：${missingName.join(", ")}`);
      if (missingInReadme.length) {
        bad(`README 没提到这些 tab（${tabIds.length} 个 tab 必须全覆盖）：` +
          missingInReadme.map((id) => `${id}（面板文案「${zh.get(id)}」）`).join("、"));
      }
      if (!missingName.length && !missingInReadme.length) {
        note(`README 覆盖全部 ${tabIds.length} 个 tab：${tabIds.map((id) => zh.get(id)).join(" / ")}`);
      }
    }
  }
}

// 10) 自述面声明的 UI 位置必须与 client 实际注册的槽位一致
// 事故：面板从 sidebar 迁到 plugins.bundle.config 后，自述文档多处仍写「侧边栏」，
// 用户照着找入口找不到——操作级失效。双向校验：哪一侧单独改都会红。
//
// 受检面：根 README / docs 顶层现行文档 / cordis.patch.yml。CHANGELOG **整file豁免**：
// 它记录的是历史动作本身，写旧位置是如实叙述。docs/upstream/ 已被 collectMd 豁免
// （那是上游原文，本来就写上游的位置）。
{
  const clientDir = join(ROOT, "src", "client");
  // 只剥「整行都是注释」的行（`//`、`*`、`/*` 开头），不动行内 `//`——URL 里的
  // `https://` 若被当注释削掉，一条路由字符串会被截成半个，误判成「没有注册」。
  const stripCommentLines = (src) =>
    src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  let code = "";
  for (const name of readdirSync(clientDir)) {
    if (name.endsWith(".ts")) code += stripCommentLines(readFileSync(join(clientDir, name), "utf8")) + "\n";
  }
  const has = (needle) => code.includes(needle);
  const HISTORY_FILES = new Set(["CHANGELOG.md"]);
  const surfaces = [
    ...readdirSync(ROOT)
      .filter((n) => n.endsWith(".md") && !HISTORY_FILES.has(n)),
    ...readdirSync(join(ROOT, "docs"))
      .filter((n) => n.endsWith(".md") && !HISTORY_FILES.has(n))
      .map((n) => join("docs", n)),
    "cordis.patch.yml",
  ];
  const claims = [
    { words: ["侧边栏", "sidebar panel"], requires: "sidebar", via: "sidebar" },
    { words: ["Plugins 页", "plugins.bundle.config"], requires: "plugins.bundle.config", via: "plugins.bundle.config" },
  ];
  // 「不在侧边栏」这类否定句是在帮用户纠偏，不该被当成位置声明——只在肯
  // 定行上找槽位词。当初事故那句「打开侧边栏「积分面板」」不含否定词，照样红。
  //
  // 第二类豁免：**谈论「旧 / 原文 / 已过期」的句子**。文档里必须能引用一句失效的
  // 原文来说明它错在哪。这类句子是在描述「别处那份旧文本」，不是声明当前位置。
  // 判据词刻意收窄，免得把「打开侧边栏…」这种真事故也一并豁免掉。
  const NEGATIONS = [
    "不在", "不是", "并非", "不再", "已从", "迁移出", "移出", "归位",
    "仍含", "原文", "引述", "旧版", "已过期",
    "no longer", "not in the",
  ];
  const affirmative = (text) =>
    text.split(/\r?\n/).filter((l) => !NEGATIONS.some((n) => l.toLowerCase().includes(n))).join("\n");
  let wrong = 0;
  for (const file of surfaces) {
    const text = affirmative(readFileSync(join(ROOT, file), "utf8"));
    for (const claim of claims) {
      if (!claim.words.some((w) => text.toLowerCase().includes(w.toLowerCase()))) continue;
      if (!has(claim.requires)) {
        wrong++;
        bad(`${file} 声称面板在 ${claim.words[0]}，但 src/client/*.ts 里没有 ${claim.via} 槽位注册（"${claim.requires}"）——自述与实际已分头走路`);
      }
    }
  }
  if (wrong === 0) note(`自述面的面板位置与 client 槽位注册一致（受检 ${surfaces.length} 个文件）`);
}

// 12) 考古纪律：现行文档不许盖「修订（日期）」式内联补丁——裁定沿革只进决策账本
// （账本现为 docs/upstream/ADR.md 的上游版；自有账本回补后，账本形状检查在此接回）。
{
  const archeo = /(?:\d{4}-\d{2}-\d{2}\s*修订|修订（[一二三四五六七八九]|本节裁定已失效)/;
  // vendor 副本（sensenova-api-reference/）是商汤官方文字，不做本仓考古扫描。
  const currentDocs = mdFiles.filter((f) => !f.includes("sensenova-api-reference"));
  let scanned = 0;
  for (const f of currentDocs) {
    scanned++;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const hit = line.match(archeo);
      if (hit) bad(`${f}:${i + 1} 内联考古层「${hit[0]}」——现行正文只写现状，裁定沿革进决策账本`);
    });
  }
  // src/ 代码注释同一条纪律：红的是「搬家叙述」——「某日从前一个文件拆出／移到某处」
  // 式沿革句；模块头部该留的只是当下的职责与邻接。实测/probe/复核日期**不在**此列：
  // 证据不是考古——只列本仓真实出现过的形态，不搞「凡带日期的行都红」。
  const SRC = join(ROOT, "src");
  const srcArcheo = [
    [/Split out of the former/, "搬家叙述「Split out of the former …」"],
    [/Extracted 20\d\d/, "搬家叙述「Extracted <年份>」"],
    [/（20\d\d-\d\d-\d\d\s*(?:落地|修)）/, "日期内联补丁「（YYYY-MM-DD 落地/修）」"],
    [/\*\* \(20\d\d-\d\d-\d\d\)/, "标题后的日期内联补丁「**…** (YYYY-MM-DD)」"],
  ];
  const tsFiles = [];
  (function collect(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (e.name.endsWith(".ts")) tsFiles.push(p);
    }
  })(SRC);
  for (const f of tsFiles) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [re, what] of srcArcheo) {
        if (re.test(line)) {
          bad(`${f.slice(ROOT.length + 1)}:${i + 1} ${what}——注释只写当下的形状，何时搬去过哪写进决策账本`);
        }
      }
    });
  }
  note(`考古纪律：受检 ${scanned} 篇现行文档与 src/ 的 ${tsFiles.length} 个 .ts 零搬家叙述`);
}

// 17') retry-policy.md 数值副本 ↔ 源码常量（原检查 17 的生态位由它接手）
// retry-policy 是顶层唯一教「429 怎么处置」的现行档；它复述的每个数字必须等于源码
// 常量，且每个落点引用（`xxx.ts` 的符号）必须在被引文件里真实存在。副本不可怕，
// **没有看守的副本**才可怕。
{
  const doc = readFileSync(join(ROOT, "docs", "retry-policy.md"), "utf8");
  const classify = readFileSync(join(ROOT, "src", "host", "rate-classify.ts"), "utf8");
  const adapter = readFileSync(join(ROOT, "src", "host", "adapter.ts"), "utf8");
  const orchestrator = readFileSync(join(ROOT, "src", "host", "key-orchestrator.ts"), "utf8");

  // a) 退避梯：文档「3 / 5 / 10 / 15 / 30s」 ↔ PROBE_BACKOFF_STEPS_MS
  const srcSteps = (classify.match(/PROBE_BACKOFF_STEPS_MS[^=]*=\s*\[([^\]]+)\]/)?.[1] ?? "")
    .match(/\d[\d_]*/g)?.map((s) => Number(s.replace(/_/g, "")));
  const docSteps = doc.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)s/)?.slice(1).map(Number);
  if (!srcSteps || srcSteps.length !== 5) {
    bad("src/host/rate-classify.ts 取不到 PROBE_BACKOFF_STEPS_MS 五档——retry-policy 退避梯失去看守对象");
  } else if (!docSteps) {
    bad("docs/retry-policy.md 取不到「N / N / N / N / N s」退避梯——数值副本失去文档一侧");
  } else if (docSteps.map((n) => n * 1000).join(",") !== srcSteps.join(",")) {
    bad(`retry-policy 退避梯漂移：src=[${srcSteps.join(",")}]ms doc=[${docSteps.join(",")}]s`);
  } else {
    note(`retry-policy 退避梯 ↔ PROBE_BACKOFF_STEPS_MS：${docSteps.join(" / ")}s`);
  }

  // b) 踢出阈值：文档「连续 3 次」 ↔ kickThreshold（值在 key-orchestrator 默认参数里）
  const srcKick = orchestrator.match(/kickThreshold:\s*(\d+)/)?.[1];
  const docKick = [...doc.matchAll(/连续\s*(\d+)\s*次/g)].map((m) => Number(m[1]));
  if (srcKick === undefined) {
    bad("src/host/key-orchestrator.ts 取不到 kickThreshold——retry-policy 踢出阈值失去看守对象");
  } else if (docKick.length === 0) {
    bad("docs/retry-policy.md 取不到「连续 N 次」——踢出阈值失去文档一侧");
  } else if (!docKick.every((n) => n === Number(srcKick))) {
    bad(`retry-policy 踢出阈值漂移：src=${srcKick} doc=[${docKick.join(",")}]`);
  } else {
    note(`retry-policy 踢出阈值 ↔ kickThreshold：连续 ${srcKick} 次`);
  }

  // c) 轮询轮次：文档「3 轮 + 抖动等待 + 第 4 轮」 ↔ MAX_POLL_ROUNDS / FINAL_ROUND
  const maxRounds = adapter.match(/MAX_POLL_ROUNDS\s*=\s*(\d+)/)?.[1];
  const finalDelta = adapter.match(/FINAL_ROUND\s*=\s*MAX_POLL_ROUNDS\s*\+\s*(\d+)/)?.[1];
  if (maxRounds === undefined || finalDelta === undefined) {
    bad("src/host/adapter.ts 取不到 MAX_POLL_ROUNDS / FINAL_ROUND——retry-policy 轮询轮次失去看守对象");
  } else {
    const finalRound = Number(maxRounds) + Number(finalDelta);
    const docRounds = doc.match(/「(\d+)\s*轮\s*\+\s*抖动等待\s*\+\s*第\s*(\d+)\s*轮」/);
    if (!docRounds) {
      bad("docs/retry-policy.md 取不到「N 轮 + 抖动等待 + 第 N 轮」结构句——轮询轮次失去文档一侧");
    } else if (Number(docRounds[1]) !== Number(maxRounds) || Number(docRounds[2]) !== finalRound) {
      bad(`retry-policy 轮询轮次漂移：src=${maxRounds} 轮 + 第 ${finalRound} 轮，doc=「${docRounds[1]} 轮 + 第 ${docRounds[2]} 轮」`);
    } else {
      note(`retry-policy 轮询轮次 ↔ MAX_POLL_ROUNDS/FINAL_ROUND：${maxRounds} 轮 + 第 ${finalRound} 轮`);
    }
  }

  // d) 抖动等待：文档「5-10s」 ↔ JITTER_WAIT_MIN_MS / JITTER_WAIT_MAX_MS
  const jitterMin = Number((adapter.match(/JITTER_WAIT_MIN_MS\s*=\s*([\d_]+)/)?.[1] ?? "").replace(/_/g, ""));
  const jitterMax = Number((adapter.match(/JITTER_WAIT_MAX_MS\s*=\s*([\d_]+)/)?.[1] ?? "").replace(/_/g, ""));
  if (!jitterMin || !jitterMax) {
    bad("src/host/adapter.ts 取不到 JITTER_WAIT_MIN_MS / JITTER_WAIT_MAX_MS——retry-policy 抖动窗失去看守对象");
  } else {
    // 锚在「抖动等待」那一行：全篇其他 N-Ns 形状（如 20-40s）不是抖动窗。
    const docJitter = doc.match(/抖动等待[^\n]*?(\d+)\s*-\s*(\d+)s/)?.slice(1).map(Number);
    if (!docJitter) {
      bad("docs/retry-policy.md 取不到「N-Ns」抖动窗——失去文档一侧");
    } else if (docJitter[0] !== jitterMin / 1000 || docJitter[1] !== jitterMax / 1000) {
      bad(`retry-policy 抖动窗漂移：src=${jitterMin / 1000}-${jitterMax / 1000}s doc=${docJitter[0]}-${docJitter[1]}s`);
    } else {
      note(`retry-policy 抖动窗 ↔ JITTER_WAIT_MIN/MAX_MS：${jitterMin / 1000}-${jitterMax / 1000}s`);
    }
  }

  // e) 落点闭合：文档里引用的每个 `xxx.ts` 符号必须在被引文件里真实存在——
  //    引用写错住所（值搬家了文档还指旧地址）和数字漂移是同一种腐烂。
  const HOMES = [
    ["rate-classify.ts", "src/host/rate-classify.ts", "PROBE_BACKOFF_STEPS_MS", /PROBE_BACKOFF_STEPS_MS\s*[:=]/],
    ["adapter.ts", "src/host/adapter.ts", "MAX_POLL_ROUNDS", /MAX_POLL_ROUNDS\s*=\s*\d/],
    ["adapter.ts", "src/host/adapter.ts", "JITTER_WAIT_MIN_MS", /JITTER_WAIT_MIN_MS\s*=\s*[\d_]+/],
    ["key-orchestrator.ts", "src/host/key-orchestrator.ts", "DEFAULT_ORCHESTRATOR_PARAMS.kickThreshold",
      /DEFAULT_ORCHESTRATOR_PARAMS[\s\S]{0,160}kickThreshold:\s*\d/],
  ];
  let homesOk = 0;
  for (const [cite, path, symbol, symRe] of HOMES) {
    if (!doc.includes(`\`${cite}\``)) {
      bad(`docs/retry-policy.md 不再引用 \`${cite}\`——数值落点闭合失去文档一侧，请同步本检查的 HOMES 表`);
    } else if (!symRe.test(readFileSync(join(ROOT, path), "utf8"))) {
      bad(`retry-policy 落点失效：\`${symbol}\` 在 ${path} 里不存在——文档指错了住所或符号已改名`);
    } else {
      homesOk++;
    }
  }
  if (homesOk === HOMES.length) note(`retry-policy 落点闭合：${HOMES.length} 个 ${"`.ts`"} 引用全部真实存在`);
}

// 6') 索引最小闭合：根 README 必须引用 retry-policy.md——顶层自有文档现在只有这一篇，
// 根 README 的「文档」节是它的唯一入口；改了名字没跟 README，文档就成了孤儿。
{
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  if (!existsSync(join(ROOT, "docs", "retry-policy.md"))) {
    bad("docs/retry-policy.md 不存在——根 README「文档」节的引用失去对象");
  } else if (!readme.includes("docs/retry-policy.md")) {
    bad("根 README 没有引用 docs/retry-policy.md——顶层自有文档的唯一入口断了");
  } else {
    note("根 README ↔ retry-policy.md：索引闭合");
  }
}

if (fails.length) {
  console.error(`\n❌ docs.test.mjs 失败 ${fails.length} 项：`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✅ docs.test.mjs 全部通过\n");
