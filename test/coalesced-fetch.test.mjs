/**
 * coalesced-fetch 并发语义回归（peer-free）——N2「多账号切换在飞请求归属」
 * 的宿主半边，2026-10-31 起有钉。
 *
 * 起因：U5 审计的 N2（切换时在飞请求的归属）曾被认为只能真机观察，拆开
 * 之后它的宿主机制就是本模块的代际闸——切换路由清场（clearCoalescedFetch）
 * 后：①pre-clear 的在飞**不可被 join**；②pre-clear 迟到的答案落在旧代际、
 * **对一切后续读不可见**；③迟到落场不得把继任 flight 从 inflight 里逐出
 * （单飞纪律不被破坏）。这三条在此之前零钉——机制文档写得再满，没有钉就
 * 是心理安慰（U1 台账口径）。真机观察只留端到端拼线的弱确认。
 *
 * 场景全部用可手动放行的 gate producer 脚本化，无网络、无 peer。
 */
const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

const { createCoalescedFetch, clearCoalescedFetch } = await import("../src/host/coalesced-fetch.ts");

/** 手动放行的 producer：read 返回后计数，gate 放行才落答案。 */
function gatedProducer(log, tag, gate) {
  return async () => {
    log.push(`start:${tag}`);
    await gate;
    log.push(`done:${tag}`);
    return `${tag}-data`;
  };
}
const microtask = () => new Promise((r) => setTimeout(r, 0));

try {
  // 1. 单飞 join（基线纪律）：同 key 两个并发读共享一次 producer。
  {
    const cache = new Map();
    const inflight = new Map();
    const inst = createCoalescedFetch({ cache, inflight });
    const log = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const p1 = inst.read("quota", gatedProducer(log, "A", gate), 60_000);
    await microtask();
    const p2 = inst.read("quota", gatedProducer(log, "B", gate), 60_000);
    release();
    const [v1, v2] = await Promise.all([p1, p2]);
    check("并发读单飞：一次 producer、两个读同答案",
      v1 === "A-data" && v2 === "A-data" && log.join(",") === "start:A,done:A",
      JSON.stringify(log));
  }

  // 2. 清场后不 join：切换（clear）之后的新读拿新账号的数据，不搭旧 flight。
  {
    const cache = new Map();
    const inflight = new Map();
    const inst = createCoalescedFetch({ cache, inflight });
    const log = [];
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const stale = inst.read("quota", gatedProducer(log, "A", gateA), 60_000);
    await microtask();
    clearCoalescedFetch(cache, inflight);           // 切换账号 = 路由清场
    const fresh = await inst.read("quota", gatedProducer(log, "B", Promise.resolve()), 60_000);
    releaseA();
    await stale;
    check("清场后新读不 join 旧在飞（新 producer 真跑、拿到新答案）",
      fresh === "B-data" && log.join(",").includes("start:A") && log.join(",").includes("start:B"),
      JSON.stringify(log));
  }

  // 3. 迟到写不可见：pre-clear 的答案落在旧代际，后续读重拉不读它。
  {
    const cache = new Map();
    const inflight = new Map();
    const inst = createCoalescedFetch({ cache, inflight });
    const log = [];
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const stale = inst.read("quota", gatedProducer(log, "A", gateA), 60_000);
    await microtask();
    clearCoalescedFetch(cache, inflight);
    await inst.read("quota", gatedProducer(log, "B", Promise.resolve()), 60_000); // 新代际落盘
    releaseA();                                    // 旧账号的答案此刻才到
    const late = await stale;
    // 中间态在 read3 之前取：迟到写确实把缓存条目覆写成旧代际的 A-data——
    // 防线不在「写被拦」，在「读按代际拒绝」。
    const afterLate = { body: cache.get("quota")?.body, gen: cache.get("quota")?.gen };
    const log3 = [];
    const again = await inst.read("quota", gatedProducer(log3, "C", Promise.resolve()), 60_000);
    check("迟到落场的旧账号答案对后续读不可见（重拉不取）",
      late === "A-data" && again === "C-data" && log3.join(",") === "start:C,done:C",
      `late=${late} again=${again} log3=${JSON.stringify(log3)}`);
    check("缓存条目被旧代际覆写但读取端按代际拒绝（防线在读端）",
      afterLate.body === "A-data" && afterLate.gen === 0 && again === "C-data",
      `afterLate=${JSON.stringify(afterLate)}`);
  }

  // 4. 迟到落场不逐出继任 flight：旧 flight 晚到 settle 不得让第三次读
  //    对同一 key 起第二台 producer（单飞纪律不被破坏）。
  {
    const cache = new Map();
    const inflight = new Map();
    const inst = createCoalescedFetch({ cache, inflight });
    const log = [];
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    let releaseB;
    const gateB = new Promise((r) => { releaseB = r; });
    const stale = inst.read("quota", gatedProducer(log, "A", gateA), 60_000);
    await microtask();
    clearCoalescedFetch(cache, inflight);
    const fresh = inst.read("quota", gatedProducer(log, "B", gateB), 60_000); // 继任，仍 pending
    await microtask();
    releaseA();                                     // 旧 flight 在继任在飞时落场
    await stale;
    const thirdPromise = inst.read("quota", gatedProducer(log, "C", Promise.resolve()), 60_000);
    releaseB();                                     // 先放行继任，再等 join 到的同一 promise
    const third = await thirdPromise;
    const freshValue = await fresh;
    check("迟到落场不清场继任：第三次读 join 继任 flight（不二开 producer）",
      third === "B-data" && freshValue === "B-data" && !log.includes("start:C"),
      `third=${third} fresh=${freshValue} log=${JSON.stringify(log)}`);
  }

  // 5. per-key 清场：只作废一个 key，另一个的缓存条目照常服务。
  {
    const cache = new Map();
    const inflight = new Map();
    const inst = createCoalescedFetch({ cache, inflight });
    await inst.read("quota", async () => "quota-1", 60_000);
    await inst.read("catalog", async () => "catalog-1", 60_000);
    clearCoalescedFetch(cache, inflight, "quota");   // 只清 quota
    const calls = [];
    const quota = await inst.read("quota", async () => { calls.push("quota"); return "quota-2"; }, 60_000);
    const catalog = await inst.read("catalog", async () => { calls.push("catalog"); return "catalog-2"; }, 60_000);
    check("per-key 清场：被清的重拉、未清的吃缓存",
      quota === "quota-2" && catalog === "catalog-1" && calls.join(",") === "quota",
      JSON.stringify(calls));
  }
} catch (e) { fail("coalesced-fetch", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`coalesced-fetch.test.mjs：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`coalesced-fetch.test.mjs：${results.length} 项全过`);
