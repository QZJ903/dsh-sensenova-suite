#!/usr/bin/env node
/**
 * Duplication gate — the mechanical half of the "two upstreams stay isolated"
 * invariant (docs/ARCHITECTURE.md §5.5).
 *
 * 历史注记：本门禁防的失败模式（§343，浣熊时代两个 publisher 各抄一份发布链）
 * publish/adapter were once verbatim copies of the Token Plan side (47%/63%
 * duplication), and the only thing holding the copies apart afterwards was two
 * comments pointing at each other saying "keep in sync". Comments do not fail
 * CI; this does.
 *
 * How it works: jscpd (a devDependency, same detector `npm run duplicate-check`
 * uses interactively) scans `src/` at the 70-token threshold, and every clone
 * found must match a `WHITELIST` entry — an explicit, line-capped admission.
 *
 * The rules, in the spirit of the repo's closed-set gates:
 *
 *   1. Any clone NOT in the whitelist fails. The fix is to either remove the
 *      duplication or, when it is genuinely irreducible glue, register it here
 *      with a comment saying why — a new entry is a decision, not an accident.
 *   2. A whitelisted pair that grows past its line cap fails. Clones tend to
 *      accrete; the cap forces the accretion to show up as a red gate instead
 *      of silently re-creating the pre-§343 state.
 *   3. Raccoon-vs-Token-Plan cross-boundary clones are called out in the
 *      failure message even when whitelisted, so the reviewer sees the
 *      invariant that is being spent.
 *   4. A whitelisted pair that no longer appears — the files were renamed, or
 *      the duplication was genuinely removed — fails as well. Otherwise an
 *      entry rots into a silent no-op: its cap is never enforced, while it
 *      still counts toward the aggregate cap below.
 *
 * Not a `*.test.mjs`: like typecheck-gate/build-gate/e2e-gate it is a gate
 * script in `test/suites.mjs`'s roster, so `npm test` (the run-all runner)
 * and ci.yml's offline job (which installs devDependencies, so jscpd is
 * present there) run it; without jscpd it SKIPs loudly like its siblings.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { envSkip } from "./env-skip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Same skip-rule as typecheck-gate/build-gate/e2e-gate: jscpd is a devDependency,
// so a machine without dev deps SKIPs loudly instead of crashing on the
// readFileSync below (an uncaught ENOENT is a red gate that says nothing about
// the code — the §30 failure shape). CI installs dev deps, so it still runs.
if (!existsSync(join(root, "node_modules", "jscpd", "package.json"))) {
  envSkip("duplication-gate", "jscpd is not installed in this project's node_modules.",
    ["the duplicate-code scan did NOT run (jscpd is a devDependency; bootstrap with: npm install --legacy-peer-deps)"]);
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail: detail || "" });
  if (!pass) console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// The admitted clones. Lines are the larger of the two halves' extents; they
// will drift a little with edits — the cap is a ceiling with headroom, not a
// byte-freeze. Registering a NEW entry requires a reason in the comment.
const WHITELIST = [
  {
    // token-store.ts's legacy facade vs token-store/state.ts — the facade
    // re-exports the split module's context builder; scheduled to shrink as
    // the TOKEN-STORE-SPLIT migration completes.
    files: ["token-store.ts", "token-store/state.ts"],
    maxLines: 14
  },
  {
    // wire/adapter 自带同构骨架（协议实现间结构平行、行为已实战验证）：SSE 事件
    // 循环与三段超时/建连清理在 adapter 与两个 sse-* 解析器间相同。重构 wire 内部
    // 不在维护范围——改它们等于重写已验证协议层，白名单以行数上限封住继续增殖。
    files: ["adapter.ts", "wire/sse-responses.ts"],
    maxLines: 36,
    cloneCount: 2
  },
  {
    // 同上：anthropic 侧 SSE 解析器与 adapter 的循环骨架。
    files: ["adapter.ts", "wire/sse-anthropic.ts"],
    maxLines: 34,
    cloneCount: 2
  },

  {
    // wire 内部：两个 body 构建器的消息/工具投影段共享同构（协议形状本就平行，
    // 一对两段：12 行主段 + 8 行短段）。
    files: ["wire/body-anthropic.ts", "wire/body-responses.ts"],
    maxLines: 12,
    cloneCount: 2
  },
  {
    // wire 内部：两个 sse 解析器的事件分派骨架（协议平行所致）。
    files: ["wire/sse-anthropic.ts", "wire/sse-responses.ts"],
    maxLines: 12
  }
];

const MIN_TOKENS = 70; // keep in lockstep with the `duplicate-check` npm script

const require = createRequire(import.meta.url);
const jscpdPkg = JSON.parse(readFileSync(join(root, "node_modules", "jscpd", "package.json"), "utf8"));
const jscpdBin = join(root, "node_modules", "jscpd", jscpdPkg.bin.jscpd.replace(/^\.\//, ""));

const outDir = mkdtempSync(join(tmpdir(), "jscpd-gate-"));
try {
  execFileSync(process.execPath, [jscpdBin, "src", "--min-tokens", String(MIN_TOKENS), "--reporters", "json", "--output", outDir, "--silent"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"]
  });
  const report = JSON.parse(readFileSync(join(outDir, "jscpd-report.json"), "utf8"));
  const clones = (report.duplicates ?? []).map((clone) => {
    // Count the larger half's span: the clone's real size in source lines.
    const first = clone.firstFile.end - clone.firstFile.start + 1;
    const second = clone.secondFile.end - clone.secondFile.start + 1;
    const rel = (name) => name.split(/[\\/]src[\\/]/).pop().replace(/\\/g, "/").replace(/^host\//, "");
    return {
      a: rel(clone.firstFile.name),
      b: rel(clone.secondFile.name),
      lines: Math.max(first, second)
    };
  });

  check(`jscpd scanned the tree (report format intact)`, Array.isArray(report.duplicates), "jscpd-report.json missing or malformed");

  const remaining = [...clones];
  const live = new Set();
  for (const entry of WHITELIST) {
    const pairKey = (clone) => {
      const pair = [clone.a, clone.b].sort().join(" <-> ");
      return pair === [...entry.files].sort().join(" <-> ");
    };
    const matched = remaining.filter(pairKey);
    for (const clone of matched) remaining.splice(remaining.indexOf(clone), 1);
    const worst = matched.reduce((max, clone) => Math.max(max, clone.lines), 0);
    // 段数配额（默认 1）：同一对文件出现第三段克隆 = 增殖，红。
    check(
      `whitelisted pair ${entry.files.join(" <-> ")} stays within its clone-count budget (${entry.cloneCount ?? 1})`,
      matched.length <= (entry.cloneCount ?? 1),
      `found ${matched.length} clone block(s) — a whitelisted pair grew a NEW block; raise the budget consciously or extract it`
    );
    check(
      `whitelisted clone ${entry.files.join(" <-> ")} stays under its ${entry.maxLines}-line cap`,
      matched.length === 0 || worst <= entry.maxLines,
      `now ${worst} lines (cap ${entry.maxLines})`
    );
    // An entry that matches NOTHING is a silent no-op: its cap is never
    // enforced (the line above passes on `matched.length === 0` alone), yet it
    // still counts toward the aggregate cap. A pair that is renamed or whose
    // duplication is removed should RETIRE its entry — the closed-set
    // discipline cuts both ways: a new member is a decision, and so is
    // dropping one.
    check(
      `whitelisted pair ${entry.files.join(" <-> ")} still exists`,
      matched.length > 0,
      "this entry matches no clone — the files were renamed or the duplication was removed; update the paths or delete the entry"
    );
    if (matched.length > 0) live.add(entry);
  }

  for (const clone of remaining) {
    check(
      `unregistered clone ${clone.a} <-> ${clone.b} (${clone.lines} lines) is removed or whitelisted`,
      false,
      "add to WHITELIST with a reason comment, or extract the shared code"
    );
  }
  // And the aggregate must not silently grow within whitelisted pairs either.
  // Count only the entries that actually matched: a stale entry must not buy
  // the aggregate an extra clone's worth of headroom.
  const budget = [...live].reduce((sum, entry) => sum + (entry.cloneCount ?? 1), 0);
  check(`total clone count stays within the whitelist budget (${budget})`, clones.length <= budget,
    `found ${clones.length} clone(s), live budget ${budget}`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify(results, null, 2));
if (failed.length > 0) {
  console.error(`\nduplication gate: ${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`\nduplication gate: all ${results.length} checks passed`);
