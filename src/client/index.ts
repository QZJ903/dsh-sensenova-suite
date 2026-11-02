/**
 * dsh-sensenova-suite — Client half (entry).
 *
 * Registers a config card inside the Plugins page (`plugins.bundle.config`
 * slot). The card renders the SenseNova Suite quota pools (5h / 7d
 * windows with used/limit/percent), per-model credit consumption, and the
 * quota / api tab layout. The data comes from the Host's read-only snapshot
 * route, polled only while the card is mounted — the Client folds no session
 * events of its own.
 *
 * The sources live in `src/client/*.ts` and are bundled into the root
 * `client.js` artifact by tsdown (IIFE, see `tsdown.config.mjs`); the tests
 * load the ARTIFACT, so what they exercise is what the browser runs.
 * @module dsh-sensenova-suite/client
 */

/**
 * The factory body, shared by the browser and by Node.
 *
 * It is deliberately dependency-free apart from `react` (which the loader
 * hands in): the browser module table resolves package names only. The
 * parameter is `loaderRequire`, not `require`, so no bundler mistakes the
 * call for module-system syntax — see `runtime.ts`.
 *
 * The Node-side test suites run this exact factory with a stand-in React
 * (`client-surface.js`), so the definitions it sees — the decision, the
 * tables, the style tokens, the components — are the ones the browser runs,
 * not a copy.
 *
 * @param loaderRequire - the loader's require; hands out `react`.
 * @returns {{inject: string[], apply: Function, panel: object}}
 */
import { inject, apply } from "./apply.ts";
import { NS } from "./const.ts";
import {
  errorOfStatus,
  FORM_EXCLUDED_CODES,
  GUIDANCE_BY_CODE,
  interpretSnapshot,
  REFUSAL_TEXT,
  viewOf
} from "./snapshot.ts";
import {
  allowListFor,
  bulkModelsIn,
  HIDE_ALL_MODELS,
  modelIsOn,
  setAllModelsIn,
  toggleModelIn
} from "./models.ts";
import { clockLong, count, format, statedCadenceMs, tokenSize, when } from "./format.ts";
import { provideClientPrimitives, provideClientReact } from "./runtime.ts";
import { en, zh } from "./i18n.ts";
import { S } from "./styles.ts";
import {
  AccountForm
} from "./account-form.ts";
import {
  PoolCard,
  PoolExhaustionNotice,
  QuotaCard,
  SectionCard,
  TrendTable
} from "./cards.ts";
import { ProviderStatus, ProviderRegStatus, ProviderSwitch } from "./provider-controls.ts";
import { ToggleSwitch } from "./toggle-switch.ts";
import { ApiKeyForm, ProviderForm } from "./api-key-form.ts";
import { ModelPicker, ModelRoster } from "./model-picker.ts";
import { HeaderStatus, PanelPage } from "./panel-page.ts";
import { ComposerUsagePill } from "./composer-usage-pill.ts";

/**
 * 浏览器实际加载的客户端构建戳（DevTools 控制台可见）。
 *
 * 存在理由：面板上的「无法连接本机 Host」曾把「Host 跑旧构建 / 浏览器缓存了
 * 旧 bundle / 真网络故障」说成同一句话，排查只能靠猜。每次改客户端**改这一行**
 * 并重新构建，控制台就能回答「浏览器到底加载了哪一版」。
 */
const CLIENT_BUILD = "2026-11-02T22:05";

function clientFactory(loaderRequire: (specifier: string) => unknown): {
  inject: string[];
  apply: typeof apply;
  panel: object;
} {
  provideClientReact(loaderRequire("react"));
  // 宿主 UI 套件（平台 seed 表九键之一）：删除确认的 Modal 从这来。旧宿主的
  // 模块表没有它时 require 会抛——接住记为 null，消费端回落自带通路。
  try {
    provideClientPrimitives(loaderRequire("@deepseek-ai/dsh-client-ui-primitives"));
  } catch {
    provideClientPrimitives(null);
  }
  console.info(`[dsh-sensenova-suite] client build ${CLIENT_BUILD}`);

  /**
   * The module's test surface.
   *
   * The Host only ever reads `inject`/`apply`; this object exists so the
   * Node-side suites can load the shipped bundle as a module and exercise
   * these REAL definitions — the decision, the dictionaries, the style
   * tokens, the components — instead of scraping the source text for them.
   * Everything here is what the browser itself uses; nothing is defined for
   * the tests' benefit.
   */
  const panel = Object.freeze({
    interpretSnapshot,
    viewOf,
    errorOfStatus,
    dictionaries: Object.freeze({ zh, en }),
    tables: Object.freeze({ GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES, REFUSAL_TEXT }),
    styles: S,
    helpers: Object.freeze({
      clockLong,
      when,
      count,
      format,
      tokenSize,
      statedCadenceMs,
      HIDE_ALL_MODELS,
      modelIsOn,
      allowListFor,
      toggleModelIn,
      setAllModelsIn,
      bulkModelsIn
    }),
    components: Object.freeze({
      QuotaCard,
      PoolCard,
      PoolExhaustionNotice,
      TrendTable,
      SectionCard,
      AccountForm,
      ApiKeyForm,
      ProviderForm,
      ProviderStatus,
      ProviderRegStatus,
      ProviderSwitch,
      ToggleSwitch,
      ModelRoster,
      ModelPicker,
      PanelPage,
      HeaderStatus,
      ComposerUsagePill
    })
  });

  return { inject, apply, panel };
}

/** The registration the Host loads: id plus the factory the Host materializes. */
const REGISTRATION = { id: NS, factory: clientFactory };

// The bundle must load in three module worlds (the IIFE wrapper keeps the
// top level free of import/export, so all three see the same statements):
//
// - BROWSER: the DSH client loader calls `window.__ModuleLoader__.load(...)`
//   with this file's text; the registry it gets back is the one the Host
//   materializes with the browser's own module table (real React).
// - NODE CJS: a `require("./client.ts")` gets the same registration object on
//   `module.exports`, so the suite can hand a stand-in React to `factory`.
// - NODE ESM: `import("./client.ts")` — the artifact carries no `import`/
//   `export` statements, so it is legal ESM; `module` is undefined there, and
//   `client-surface.js` installs a capturing `window.__ModuleLoader__` BEFORE
//   the import, which is what runs this branch.
//
// In every world the SAME `clientFactory` is what the panel runs, so the Node
// suites exercise the browser's own decision, tables, and components — never a
// copy and never a scrape of this source text.
if (typeof window !== "undefined") {
  // The module table is shell-attached, so the DOM lib does not declare it.
  // Asserted once here — the same face `client-surface.js` installs before it
  // imports this bundle in Node.
  const loader = (window as Window & typeof globalThis & { __ModuleLoader__?: { load: (registration: object) => void } }).__ModuleLoader__;
  if (loader !== undefined) loader.load(REGISTRATION);
}
if (typeof module !== "undefined" && module !== null && module.exports !== undefined) {
  module.exports = REGISTRATION;
}
