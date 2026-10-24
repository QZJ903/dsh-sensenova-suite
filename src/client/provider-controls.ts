/**
 * The secret-free provider registration controls: the status lines and the
 * live provider switch.
 */
import { PROVIDER_PATH } from "./const.ts";
import { count, errorText, format } from "./format.ts";
import { postJsonOrThrow } from "./http.ts";
import { dictKey, h, useCallback, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import type { LlmData } from "./wire.ts";
import { S } from "./styles.ts";
import { ToggleSwitch } from "./toggle-switch.ts";

/**
 * The API-key card's status: ONLY key provenance (+ the ephemeral-host
 * warning). Registration state lives in `ProviderRegStatus` on the
 * provider card — after the panel split into one card per concern, a
 * line about registration inside the key card was information flying
 * across card boundaries, repeating what the provider card's own switch
 * and status already say.
 *
 * Hook-free on purpose: like the pool cards, it is exercised by the Node
 * render suite, so a reworded or dropped status line fails a check. It
 * renders ONLY from the snapshot's `llm` block, which never carries the
 * key itself — booleans and a source tag.
 */
export function ProviderStatus({ llm, tt }: { llm?: LlmData | null; tt: Tt }): unknown {
  if (!llm || typeof llm !== "object") return null;
  const rows: unknown[] = [];
  // Where the key came from. `memory` and `env` are both real answers;
  // an unknown source degrades to the raw tag rather than a blank line.
  const sourceText = llm.hasApiKey === true
    ? format(tt("llm.keyPresent"), { source: tt(dictKey("llm.src", String(llm.keySource ?? ""))) || String(llm.keySource ?? "") })
    : tt("llm.noKey");
  rows.push(h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" }, sourceText));
  if (llm.ephemeral === true) {
    rows.push(h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("llm.ephemeral")));
  }
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 } }, ...rows);
}

/**
 * The provider card's registration status, hook-free like `ProviderStatus`
 * so the render suite pins every branch. The card title and the switch
 * below say "registration" already, so this is pure state + counts: the
 * id rides inside whichever line is showing, never as its own row.
 */
export function ProviderRegStatus({ llm, tt }: { llm?: LlmData | null; tt: Tt }): unknown {
  if (!llm || typeof llm !== "object") return null;
  // Order matters: a specific failure outranks a capability gap, which
  // outranks "the switch is ticked but registration has not landed yet".
  // The old fall-through told the reader "tick the switch above" when the
  // switch was ALREADY ticked and the registration silently failed — a lie
  // pointing at the wrong fix.
  if (llm.registerProvider === true && llm.providerRegistered === true) {
    return h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" },
      format(tt("llm.registered"), {
        id: String(llm.providerId ?? ""),
        models: count(llm.modelCount),
        vision: count(llm.visionCount)
      }));
  }
  if (llm.registerProvider === true && typeof llm.providerError === "string" && llm.providerError !== "") {
    return h("div", { style: S.formError, role: "alert" }, format(tt("llm.error"), { error: llm.providerError }));
  }
  if (llm.registerProvider === true && llm.llmAvailable !== true) {
    return h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("llm.noService"));
  }
  if (llm.registerProvider === true) {
    // Ticked on, no error, service present, but the register call has not
    // landed yet: say so instead of claiming the switch is off.
    return h("div", { style: { ...S.muted, fontSize: 12 }, role: "status" },
      format(tt("llm.registeredPending"), { id: String(llm.providerId ?? "") }));
  }
  return h("div", { style: { ...S.muted, fontSize: 12 } },
    format(tt("llm.off"), { id: String(llm.providerId ?? "") }));
}

/**
 * The live provider-registration switch (docs/PROVIDER-HOT-RELOAD.md).
 *
 * Posts `{ enabled }` to the plugin's own `/provider` route; the Host
 * persists the value in its state file and republishes the adapter pair
 * on the same request, so the flip lands without a config edit or a
 * restart. Hook-based like `ApiKeyForm`, so the render suite (which
 * cannot mount hooks) exercises the secret-free status lines instead;
 * the route itself is covered by `routes.test.mjs`. The state shown is
 * the SNAPSHOT's effective value, never local optimism — the poll after
 * `onDone` repaints whatever the Host actually reports.
 */
export function ProviderSwitch({ llm, onDone, tt }: {
  llm?: LlmData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const [busy, setBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const enabled = llm?.registerProvider === true;
  const toggle = useCallback(async () => {
    setBusy(true);
    setSwitchError(null);
    try {
      await postJsonOrThrow(PROVIDER_PATH, { enabled: !enabled });
      onDone?.();
    } catch (error) {
      setSwitchError(format(tt("llm.switchError"), { error: errorText(error) }));
    } finally {
      setBusy(false);
    }
  }, [enabled, onDone, tt]);
  return h(
    "div",
    { style: { display: "flex", gap: 10, alignItems: "center", margin: "0 0 12px", flexWrap: "wrap" } },
    h(ToggleSwitch, {
      checked: enabled,
      onChange: toggle,
      busy,
      label: tt("llm.switch"),
      busyLabel: tt("llm.switchBusy"),
      title: tt("llm.switchTitle")
    }),
    switchError ? h("span", { style: S.formError, role: "alert" }, switchError) : null
  );
}
