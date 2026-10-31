/**
 * 未分类失败的兜底换 key —— 回归测试（纯 Node、无 peer）。
 *
 * 背景：适配器只对「认识的理由」换 key（401 / 配额类 429 / 池类 429）。旧实现里，
 * 分类器认不出的 429 落到「不轮换」，宿主拿同一把 key 重试到预算耗尽才报错——
 * `RateLimitExceeded.EndpointTPMExceeded` 在补分类前就是这种形态（2026-10-31
 * 真 key 实测：同一时刻 A/C 200、B 429，换 key 明明有用）。402/403 同理：账号态
 * 拒绝不在宿主可重试清单里，不换就直接上屏。
 *
 * 钉住的是一个**窄**判据：只有未知 429 与 402/403 触发兜底；400/404/5xx/超时/
 * 传输一律不换（换 key 不会变好，且 5xx 换 key 会把一次平台故障放大成整池风暴）。
 */
import { shouldRotateUnclassified } from "../src/host/key-health.ts";
import { results, check, fail } from "./harness.mjs";

try {
  // 会触发：未知 429（分类器没认出的形状）、402 欠费、403 禁用。
  check("未知 429 → 兜底换 key", shouldRotateUnclassified(429, false) === true);
  check("402（欠费）→ 兜底换 key", shouldRotateUnclassified(402, false) === true);
  check("403（禁用）→ 兜底换 key", shouldRotateUnclassified(403, false) === true);

  // 已由 401/配额 429/池 429 轮换过的失败，不重复触发。
  check("已参与轮换的 429 不重复触发", shouldRotateUnclassified(429, true) === false);
  check("已参与轮换的 403 不重复触发", shouldRotateUnclassified(403, true) === false);

  // 不触发：请求/路由问题（换 key 也不变好）。
  check("400 请求错误不换 key", shouldRotateUnclassified(400, false) === false);
  check("404 模型不可路由不换 key", shouldRotateUnclassified(404, false) === false);
  check("413 请求过大不换 key", shouldRotateUnclassified(413, false) === false);
  check("422 参数错误不换 key", shouldRotateUnclassified(422, false) === false);

  // 不触发：平台/网络问题（换 key 会把一次故障放大成整池风暴）。
  check("500 不换 key", shouldRotateUnclassified(500, false) === false);
  check("502 不换 key", shouldRotateUnclassified(502, false) === false);
  check("503 不换 key", shouldRotateUnclassified(503, false) === false);
  check("连接级失败（status 0）不换 key", shouldRotateUnclassified(0, false) === false);

  // 401 由自己的路径处理，不走兜底。
  check("401 不重复触发（有自己的 permanent-remove 路径）", shouldRotateUnclassified(401, false) === false);
} catch (error) {
  fail("key-health.shouldRotateUnclassified", error);
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
