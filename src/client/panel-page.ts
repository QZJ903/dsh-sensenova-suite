/**
 * The `plugins.bundle.config` card: polling, the decision gate, and the whole
 * panel layout — rendered inside the Plugins page, always expanded (there is
 * no sidebar entry and no standalone `main` page).
 *
 * 面板交付面：额度 tab（池/趋势/账号）+ 接入 API tab（key/模型接入/池诊断）。
 */
import {
  AccountForm
} from "./account-form.ts";
import { ApiKeyForm, ProviderForm } from "./api-key-form.ts";
import { PANEL_ID } from "./const.ts";
import { format, when } from "./format.ts";
import { FORM_EXCLUDED_CODES, GUIDANCE_BY_CODE, viewOf } from "./snapshot.ts";
import { useSnapshotPolling } from "./use-snapshot-polling.ts";
import { h, useCallback, useEffect, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import type { PoolData } from "./wire.ts";
import { S } from "./styles.ts";
import { PoolCard, PoolExhaustionNotice, SectionCard, TrendTable } from "./cards.ts";
import { MultimodalTab } from "./multimodal-tab.ts";

/**
 * Quota-unavailable codes the user fixes by signing in.
 *
 * The Host answers `ok:true` with an in-body `quotaError` when the console is
 * unreachable; for these codes the quota tab leads with the account form
 * instead of empty sections. The set is DERIVED — every wire code the panel
 * has a guidance line for, minus the ones no login can fix
 * (`FORM_EXCLUDED_CODES`: `config_error` stays a notice, never a form).
 *
 * Derived rather than listed because the hand-written version WAS "the
 * complement of FORM_EXCLUDED_CODES" in a comment only: a code the Host adds
 * later would have kept its guidance line yet silently landed in the
 * "empty sections, no form" branch — the one outcome a reader cannot act on.
 */
const LOGIN_BLOCKED_QUOTA_CODES: ReadonlySet<string> = new Set(
  Object.keys(GUIDANCE_BY_CODE).filter((code) => !FORM_EXCLUDED_CODES.has(code))
);

/**
 * The two panel perspectives, as ONE fact.
 *
 * `PanelPage`'s own state, the `HeaderStatus` props type and its JSDoc
 * `@param` each used to spell the union out by hand, so adding a tab
 * meant three edits — and the JSDoc one would not fail the build if missed.
 * The tab bar and the header both branch on this id, so it is the one id
 * worth naming. The two tabs stay fixed: quota (the Token Plan console) and
 * api (key + provider wiring).
 */
export type TabId = "quota" | "api" | "multimodal";

export function PanelPage({ onClose, tt, localeSubscribe }: {
  onClose?: () => void;
  tt: Tt;
  localeSubscribe?: unknown;
}): unknown {
  // Polling state lives in the hook: `data`/`error`/`loadedOnce`/`updatedAt`/
  // `cadenceMs`/`load` are returned there (see ./use-snapshot-polling.ts).
  const { data, error, loadedOnce, updatedAt, load } = useSnapshotPolling();
  const [, setLocaleRevision] = useState(0);
  // The content sections start expanded — the panel opens showing
  // everything — while the account editor starts collapsed: it is a
  // maintenance action, one click away. Remounting on a page switch
  // restores these defaults.
  //
  // The API tab's provider card starts OPEN too: it is the reason someone
  // visits that tab, and a collapsed card hiding its own switch reads as
  // "this does nothing". Only the API key editor stays closed — it holds a
  // secret field, and it is a prerequisite the card above points at rather
  // than the thing being configured.
  const [openSections, setOpenSections] = useState({ pools: true, trend: true, account: false, provider: true, llm: false });
  // Three fixed perspectives: "quota" is the daily reading (pools, trend,
  // account), "api" is the Token Plan wiring (key, provider push, pool
  // management), "multimodal" is the image/vision tool settings. The tab
  // bar renders on every frame — loading, error and setup states live
  // INSIDE the quota tab, so the api/multimodal tabs (independent of the
  // Token Plan console) stay reachable before a snapshot lands.
  const [activeTab, setActiveTab] = useState<TabId>("quota");

  // The Host half registers the dictionaries, but a runtime language switch
  // only reaches this page through the locale face's subscribe: without it a
  // mounted panel keeps whatever strings it happened to render first.
  useEffect(() => {
    if (typeof localeSubscribe !== "function") return undefined;
    return (localeSubscribe as (fn: () => void) => () => void)(() => setLocaleRevision((revision) => revision + 1));
  }, [localeSubscribe]);

  const toggleSection = useCallback((key: string) => {
    setOpenSections((current) => ({ ...current, [key]: !current[key as keyof typeof current] }));
  }, []);

  const pools = data?.pools;
  const trend = data?.trend;
  // The decision is `viewOf`'s (module scope): the Node-side tests invoke
  // this exact function, so there is no second copy that could drift.
  const { failure, auth, needsSetup, guidance, shapeWarnings } = viewOf(data, error, tt);
  // The one gate that turns `panel.loading` from dead code into the real
  // first frame: until an attempt has concluded, nothing may claim the
  // user needs setup.
  const showSetupForm = needsSetup && loadedOnce;
  const authChip = auth === null
    ? null
    : auth.error || !auth.configured
      // A "needs login" chip with a blank tooltip is a dead end: the reader
      // sees "something is wrong" but cannot say what. When the Host gives no
      // reason (a fresh install, nothing configured yet), the tooltip is the
      // guidance line — the same one the setup form would show — so the chip
      // and the form never disagree about why.
      ? h("span", { style: S.chip, title: auth.error || guidance || "" }, tt("auth.needsLogin"))
      : h("span", { style: S.chip }, tt("auth.selfRenew"));
  // The right-hand cluster of the TAB ROW, owned by the ACTIVE tab.
  // Extracted into a hook-free {@link HeaderStatus} so the render suite can
  // mount it directly and pin that quota-only copy (the renewal chip, the
  // stale-data banner) never reaches the api tab.
  const headerStatus = h(HeaderStatus, {
    activeTab,
    hasData: data !== null,
    updatedAt,
    failure,
    authChip,
    tt,
    onRefreshQuota: () => void load()
  });
  const authManage = auth !== null;
  // The quota block can be empty with the console unreachable (no account, a
  // rejected token, the console down): the Host answers `ok:true` with an
  // in-body `quotaError`, keyed by the same taxonomy the failure path uses.
  // The quota tab says why and offers the fix; the api tab is INDEPENDENT of
  // the console and stays fully usable.
  const quotaError = data?.quotaError ?? null;
  const quotaGuidanceKey = quotaError?.code ? (GUIDANCE_BY_CODE[String(quotaError.code)] ?? null) : null;
  const quotaNotice = quotaError === null
    ? null
    : quotaGuidanceKey !== null
      ? h("div", { style: S.formNote, role: "status" }, tt(quotaGuidanceKey))
      : typeof quotaError.message === "string" && quotaError.message !== ""
        ? h("div", { style: S.formNote, role: "status" }, quotaError.message)
        : null;
  // A quota gap a sign-in fixes leads with the account form, not with empty
  // quota sections.
  const quotaLoginBlocked = quotaError !== null && LOGIN_BLOCKED_QUOTA_CODES.has(String(quotaError.code ?? ""));
  // The tab bar is UNCONDITIONAL. It used to render only after a snapshot
  // landed — the loading, error and setup views were full-screen and hid the
  // tabs, which locked out every user who wanted the API tab (independent of
  // the Token Plan console) before connecting the console. Each tab now owns
  // its own empty state instead.
  // Each tab renders from its own plain function (not a nested-ternary tree)
  // so a change to one tab never forces the reader to expand all of them at
  // once. Both close over the locals computed above; none holds state.

  // The quota tab owns the loading / error / setup states (no snapshot yet)
  // and, once a snapshot lands, the pools + trend sections. The shape-drift
  // banner stays in the tab bar's sibling below, not here.
  const quotaBody = () => {
    if (data === null) {
      return showSetupForm
        ? h(AccountForm, { auth, onDone: () => void load(), tt, snapshotAt: updatedAt })
        : h(
            "div",
            { style: S.empty },
            failure === null
              ? tt("panel.loading")
              : h(
                  "div",
                  null,
                  h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message }))
              )
          );
    }
    return h(
      "div",
      null,
      quotaNotice,
      quotaLoginBlocked
        ? h(AccountForm, { auth: data?.auth ?? null, onDone: () => void load(), tt, snapshotAt: updatedAt })
        : h(
            "div",
            null,
            // Both content sections are collapsible card headers, auto-expanded
            // by default: the panel opens showing everything, and the reader
            // can tuck the chart or the pools away to focus on the other.
            h(
              SectionCard,
              { title: tt("section.pools"), open: openSections.pools, onToggle: () => toggleSection("pools"), tt },
              pools?.plan?.name
                ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } }, pools.plan.name)
                : null,
              h(PoolExhaustionNotice, { pools, tt, blockedModelIds: data.llm?.quotaBlockedModelIds }),
              h(
                "div",
                { style: S.poolsGrid },
                (pools?.pools || []).map((pool: PoolData) => h(PoolCard, { key: pool.id, pool, tt, catalogAvailable: data.catalogAvailable !== false }))
              ),
              Array.isArray(data.uncountedModels) && data.uncountedModels.length > 0
                ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 4 } },
                    format(tt("pool.uncounted"), { models: data.uncountedModels.join(" · ") }))
                : null,
            ),
            h(
              SectionCard,
              // The cache age is quoted from the snapshot, not written down
              // here: a note that says 60 while the Host caches for 300 is a
              // lie the reader has no way to catch. It lives in THIS card's
              // title because the cache belongs to the data it ages. The
              // `?? 60` / `?? 24` below are backstops for a snapshot that
              // stops carrying the fields — today every Host build states
              // both, so they are unreachable; if that contract ever breaks,
              // these literals are the lies the comment above forbids, and
              // the fix is to drop the fallbacks, not retune the numbers.
              { title: format(tt("section.trend"), { hours: trend?.hours ?? 24, cache: data?.cacheSeconds ?? 60 }), open: openSections.trend, onToggle: () => toggleSection("trend"), tt },
              h(TrendTable, { trend, tt })
            ),
            // The login state stays visible while everything works — and
            // while nothing does: a collapsed section (unlike the content
            // sections) keeps the editor one click away without cluttering
            // the quota view, but the header itself is always on screen.
            // Suppressed when the quota gap is login-fixable: the form at
            // the top of the tab already carries the editor.
            authManage
              ? h(
                  SectionCard,
                  { title: tt("auth.title"), open: openSections.account, onToggle: () => toggleSection("account"), tt },
                  h(AccountForm, { auth, onDone: () => void load(), tt, bare: true, snapshotAt: updatedAt })
                )
              : null
          )
    );
  };

  // The API tab: one SectionCard per concern, ordered by what the reader came
  // for, not dependency order. The feature card leads (and opens); the key
  // editor trails as the prerequisite it points back at.
  const apiBody = () =>
    h(
      "div",
      null,
      h(
        SectionCard,
        { title: tt("llm.providerTitle"), open: openSections.provider, onToggle: () => toggleSection("provider"), tt },
        h(ProviderForm, { llm: data?.llm ?? null, pool: data?.pool ?? null, onDone: () => void load(), tt })
      ),
      h(
        SectionCard,
        { title: tt("llm.title"), open: openSections.llm, onToggle: () => toggleSection("llm"), tt },
        h(ApiKeyForm, { llm: data?.llm ?? null, pool: data?.pool ?? null, onDone: () => void load(), tt, bare: true })
      )
    );

  // The multimodal tab: per-tool image settings + vision settings. Reads the
  // snapshot's pool.settings (panel-saved values) and the catalog rows for the
  // model dropdowns; every control saves immediately.
  const multimodalBody = () =>
    h(MultimodalTab, { llm: data?.llm ?? null, pool: data?.pool ?? null, onDone: () => void load(), tt });

  const body = h(
    "div",
    null,
    // One row: the tab strip on the left, the ACTIVE tab's own status cluster
    // on the right. The strip used to be alone (its right half empty) under a
    // separate header bar that held nothing but this cluster — the bar is
    // gone, and the cluster moved here, where the row had room for it. The
    // row owns the rule under the tabs, so the cluster's 更新于 / 刷新 sit ON
    // the row rather than on a line of their own.
    h(
      "div",
      { style: S.tabRow },
      h(
        "div",
        { style: S.tabBar, role: "tablist" },
        h("button", { type: "button", role: "tab", "aria-selected": activeTab === "quota", style: { ...S.tab, ...(activeTab === "quota" ? S.tabActive : {}) }, onClick: () => setActiveTab("quota") }, tt("tab.quota")),
        h("button", { type: "button", role: "tab", "aria-selected": activeTab === "api", style: { ...S.tab, ...(activeTab === "api" ? S.tabActive : {}) }, onClick: () => setActiveTab("api") }, tt("tab.api")),
        h("button", { type: "button", role: "tab", "aria-selected": activeTab === "multimodal", style: { ...S.tab, ...(activeTab === "multimodal" ? S.tabActive : {}) }, onClick: () => setActiveTab("multimodal") }, tt("tab.multimodal"))
      ),
      h("span", { style: S.spacer }),
      // The cluster stays outside the tablist: `role="tablist"` may only
      // contain tabs, and 刷新 / 更新于 are not tabs.
      headerStatus,
      onClose ? h("button", { type: "button", style: { ...S.button, alignSelf: "center" }, onClick: () => onClose() }, tt("panel.back")) : null
    ),
    // The shape-drift banner belongs with the daily reading: it warns
    // about the numbers themselves, not about the wiring below.
    activeTab === "quota" && data && shapeWarnings.length > 0
      ? h("div", { style: S.formError, role: "status" },
          format(tt("panel.shapeDrift"), {
            detail: shapeWarnings.map((entry) => `${tt("shape.api")} ${entry.api} ${tt("shape.missing")} ${entry.missing}`).join("; ")
          }))
      : null,
    activeTab === "quota" ? quotaBody() : activeTab === "multimodal" ? multimodalBody() : apiBody()
  );


  return h(
    "div",
    { style: S.page, "data-dsh-plugin": PANEL_ID },
    // No header row and no padding of our own: the shell prints the plugin
    // name, version, package id and description 32px above this section
    // (`.detailSections`' margin-top) and closes the page with 48px, so the
    // card contributes layout only where it has something to say. The status
    // cluster rides the tab row, which had the room.
    h("div", { style: S.scroll }, body)
  );
}

/**
 * The right-hand cluster of the pinned header.
 *
 * The header is a SHELL: a plugin-identity title on the left, and this — the
 * ACTIVE tab's own status — on the right. Quota and api read the same Token
 * Plan snapshot, so both show its `updatedAt` and share the quota refresher;
 * only quota carries the renewal chip and the stale-data banner, because those
 * describe the console login token that the api (API key) tab has nothing to
 * say about.
 *
 * Hook-free on purpose: the render suite mounts it directly to pin the
 * invariant that quota-only copy (renewal chip, stale-data banner) never
 * appears for the api tab.
 *
 * Prop types are declared once, by the TypeScript annotation on the function
 * — an earlier `@param {TabId} props.activeTab` style JSDoc spelled the same
 * types a second time, where a change to one side could not fail the build.
 */
export function HeaderStatus({
  activeTab,
  hasData,
  updatedAt,
  failure,
  authChip,
  tt,
  onRefreshQuota
}: {
  activeTab: TabId;
  hasData: boolean;
  updatedAt: number;
  failure: { message: string } | null;
  authChip: unknown;
  tt: Tt;
  onRefreshQuota: () => void;
}): unknown {
  // Quota and api share the Token Plan snapshot's `updatedAt` and refresher.
  return h(
    "span",
    { style: S.cluster },
    // `when` not `clock`: the header survives across days — a panel opened
    // the next morning must not read "更新于 20:39" as "20 minutes ago".
    hasData ? h("span", { style: S.updated }, format(tt("panel.updated"), { time: when(updatedAt / 1000) })) : null,
    // The renewal chip is quota-ONLY: gated on `activeTab === "quota"`, never on
    // `hasData` alone, so the api tab (an API key, not a console grant) never
    // shows "令牌自动续期中".
    activeTab === "quota" ? authChip : null,
    // The stale-data banner is quota-specific too: the console outage that
    // produces it is unrelated to the api tab.
    activeTab === "quota" && failure !== null && hasData
      ? h("span", { style: S.error, role: "status", title: failure.message }, format(tt("panel.error"), { error: failure.message }))
      : null,
    h("button", { type: "button", style: S.button, onClick: () => onRefreshQuota() }, tt("panel.refresh"))
  );
}
