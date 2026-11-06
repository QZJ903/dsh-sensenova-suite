/**
 * Negative guard for `publish-core.ts#swapRegistration`: the rollback path.
 *
 * PITFALLS §19 says "a registration that throws AFTER the old pair was released
 * must put the previous one back, or a bad publish takes down models that were
 * already serving." The two publishers share this function precisely because it
 * is the worst place to find a divergence — it only runs once something has
 * already gone wrong. A regression that silently drops the rollback would let
 * `test/provider.test.mjs` stay green (it drives the happy path and the
 * `disposed` gate, but not the failure-after-release branch).
 *
 * What this test asserts (negative: broken behavior = red):
 *   1. Before swap: state.registered=true, state.built=A.
 *   2. Swap is called with built=B, previousBuilt=A.
 *   3. registerPair throws (simulating Host-side rejection after release(A)).
 *   4. After catch: state.registered === true, state.built === A, state.error !== null.
 *
 * If the rollback is missing: step 4 fails (registered=false, built=null).
 */
import {
  createPairReleaser,
  registerProviderPair,
  swapRegistration,
  createAdapterFactoryResolver,
  resolveRegistrationService,
  unregister,
  NO_LLM_SERVICE_ERROR
} from "../src/host/publish-core.ts";

const PROVIDER_ID = "test-rollback-guard";
const DISPLAY_NAME = "Test Rollback Guard";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL: ${name}`);
    if (detail) console.error(`  detail: ${detail}`);
  }
}

// --- Swap Registration Rollback ---
{
  let activeAdapter = null;
  let callCount = 0;
  
  // Fake llm service
  const llm = {
    registerAdapter: (providerIds, adapter) => {
      callCount += 1;
      
      if (callCount === 1) {
        // First call: register B (the new one we're trying) — throw
        throw new Error("Host rejected adapter registration");
      }
      // Second+ calls succeed (rollback to A)
      activeAdapter = adapter;
      return () => { activeAdapter = null; };
    },
    registerConfigurableProviders: () => () => {}
  };
  
  const builtA = { adapter: { id: "adapter-A" }, providerIds: [PROVIDER_ID] };
  const builtB = { adapter: { id: "adapter-B" }, providerIds: [PROVIDER_ID] };
  const identity = { providerId: PROVIDER_ID, displayName: DISPLAY_NAME };
  
  // Create a wrapper registerPair that includes identity
  const wrappedRegisterPair = (llmSvc, builtObj, target) => {
    return registerProviderPair(llmSvc, builtObj, target, identity);
  };
  
  const state = {
    registered: false,
    built: null,
    error: null,
    llmAvailable: true,
    releaseAdapter: null,
    releaseDirectory: null
  };
  
  const release = createPairReleaser(state);
  const emit = () => {};
  
  // Pre-set: adapter A was previously published
  state.registered = true;
  state.built = builtA;
  state.releaseAdapter = () => { activeAdapter = null; };
  activeAdapter = builtA.adapter;
  
  check("before swap: registered=true, built=A",
    state.registered === true && state.built === builtA,
    `registered=${state.registered}, built.id=${state.built?.adapter?.id ?? "null"}`);
  
  try {
    const result = swapRegistration({
      llm,
      built: builtB,
      previousBuilt: builtA,
      state,
      release,
      registerPair: wrappedRegisterPair,
      emit,
      onRollback: () => {}
    });
    
    check("result.ok is false", result.ok === false, JSON.stringify(result));
    check("state.error set", state.error !== null, `error=${state.error}`);
    check("rollback: registered restored", state.registered === true, `registered=${state.registered}`);
    check("rollback: built restored to A", state.built === builtA, `built.id=${state.built?.adapter?.id ?? "null"}`);
    check("rollback: llm serves A", activeAdapter?.id === "adapter-A", `active=${activeAdapter?.id ?? "null"}`);
    check("2 registerAdapter calls (B fails, then A rollback succeeds)",
      callCount === 2,
      `calls=${callCount}`);
  } catch (error) {
    check("no external throw", false, String(error));
  }
  
  release();
  check("release safe", true, "");
}

// --- Adapter factory resolver: memoize the SUCCESS, never the failure ------
// The resolver exists so a Host whose peers resolve slowly pays the `import()`
// once instead of per publish. It used to memoize the PROMISE rather than its
// result, which pinned a rejection in the slot for the life of the process:
// every later publish rethrew that one error, and the provider could never
// register again — even after the operator fixed the missing peer, which is
// exactly the remedy `describeBuildFailure` prints for ERR_MODULE_NOT_FOUND.
// A recoverable install problem cost a Host restart.
{
  let attempts = 0;
  const resolver = createAdapterFactoryResolver(async () => {
    attempts += 1;
    if (attempts < 2) throw new Error("Cannot find module '@earendil-works/pi-ai'");
    return { createSensenovaAdapter: "factory" };
  }, "createSensenovaAdapter");

  let firstError = null;
  try { await resolver(); } catch (error) { firstError = error; }
  check("the resolver surfaces the first load failure", firstError !== null, String(firstError));

  let second = null;
  let secondError = null;
  try { second = await resolver(); } catch (error) { secondError = error; }
  check("the resolver retries after a failure (a rejection is not memoized)",
    second === "factory" && secondError === null,
    `value=${String(second)} error=${String(secondError)}`);

  // And the happy path still loads once — that is the resolver's whole reason
  // to exist, so the retry above must not have cost it.
  const third = await resolver();
  check("the resolver still loads the module once on the happy path",
    attempts === 2 && third === "factory", `attempts=${attempts} third=${String(third)}`);
}

// --- The `!llmAvailable` branch must clear `state.built` too ----------------
// A stale `built` survives into the NEXT publish as its rollback target
// (`previousBuilt = state.built`), so a later failed publish would re-register
// an adapter whose release has already been called — the rollback only runs
// once something else has already gone wrong, which is the worst moment to
// find out. This branch used to hand-roll `release(); registered = false`
// instead of routing through `unregister`, and `unregister` is the one place
// that clears it.
{
  let releasedCount = 0;
  let disposedCount = 0;
  const state = {
    registered: true,
    built: { adapter: { id: "adapter-A", dispose: () => { disposedCount += 1; } }, providerIds: [PROVIDER_ID] },
    error: null,
    llmAvailable: true,
    releaseAdapter: () => { releasedCount += 1; },
    releaseDirectory: null
  };
  const service = resolveRegistrationService({
    state,
    getLlm: () => null,
    release: createPairReleaser(state)
  });
  check("no llm service resolves to null", service === null, String(service));
  check("the pair was released rather than left registered",
    releasedCount === 1 && state.registered === false,
    `released=${releasedCount} registered=${state.registered}`);
  check("the reason is the shared constant",
    state.error === NO_LLM_SERVICE_ERROR, String(state.error));
  check("the stale built adapter was cleared (no dead rollback target)",
    state.built === null, JSON.stringify(state.built));
  check("the retired adapter's dispose ran (unregister is a permanent retirement: retry timer cleared)",
    disposedCount === 1, `disposed=${disposedCount}`);
}

// --- `unregister` 直接钉（switch-off 路径的退役清场）------------------------
// switch-off（面板关掉接入/registerProvider 翻 false）不经 registerPair 的
// 退役钩子——unregister 是那条路径上唯一能清被撤 adapter 时钟的点
// （2026-11-07 复查缺陷 1 残余面）。dispose 只清时钟；在途流不碰。
{
  let disposedCount = 0;
  const state = {
    registered: true,
    built: { adapter: { dispose: () => { disposedCount += 1; } }, providerIds: [PROVIDER_ID] },
    error: null,
    llmAvailable: true,
    releaseAdapter: null,
    releaseDirectory: null
  };
  const outcome = unregister({ state, release: createPairReleaser(state) });
  check("unregister reports a deliberate skip",
    outcome.ok === true && outcome.skipped === true && state.error === null,
    JSON.stringify(outcome));
  check("unregister disposes the displaced adapter exactly once and clears built",
    disposedCount === 1 && state.built === null && state.registered === false,
    `disposed=${disposedCount} built=${JSON.stringify(state.built)}`);
  // 幂等/空态：built 已空时不得误抛（no-llm 首装也会走到这里）。
  const second = unregister({ state, release: createPairReleaser(state) });
  check("unregister on an already-empty state is a safe no-op",
    second.ok === true && disposedCount === 1,
    `disposed=${disposedCount} ok=${second.ok}`);
}

console.log(`\nprovider-rollback-guard: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
