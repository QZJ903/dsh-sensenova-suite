/**
 * 多模态 tab：出图两工具（sn_text2img / sn_img2img）各自一张参数卡 + 视觉卡。
 *
 * 设置纪律：**面板是主要设置**——每控件即改即存（POST /pool {section, values}），
 * 面板保存值压过 cordis.patch.yml 的部署默认；未设置的键回落配置。key 全部经池。
 *
 * 模型下拉的数据源是快照的模型清单：出图卡列 `imageGen` 行，视觉卡列 `vision` 行。
 * Hook-based（输入框草稿），render 套件不直接挂载。
 *
 * @module dsh-sensenova-suite/multimodal-tab
 */
import { POOL_PATH } from "./const.ts";
import { postJsonOrThrow } from "./http.ts";
import { h, useCallback, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import type { LlmData, ModelData, PoolDiagData } from "./wire.ts";
import { S } from "./styles.ts";
import { SectionCard } from "./cards.ts";
import { ToggleSwitch } from "./toggle-switch.ts";

/** 一个下拉/开关的通用行。 */
function Field({ label, children }: { label: string; children: unknown }): unknown {
  return h("label", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 } },
    h("span", { style: { ...S.fieldLabel, flex: "none" } }, label),
    children);
}

const IMAGE_FORMATS = ["png", "jpeg", "webp"];
const RESPONSE_FORMATS = ["b64_json", "url"];

export function MultimodalTab({ llm, pool, onDone, tt }: {
  llm?: LlmData | null;
  pool: PoolDiagData | null | undefined;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const models = Array.isArray(llm?.models) ? llm.models : [];
  const imageModels = models.filter((model: ModelData) => model?.imageGen === true);
  const visionModels = models.filter((model: ModelData) => model?.vision === true);
  const settings = pool?.settings ?? { toolsEnabled: {}, text2img: {}, img2img: {}, vision: {} };
  const [busySection, setBusySection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 文本输入的本地草稿（key = section.key）。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const saved = (section: string, key: string): string => {
    const bag = (settings as Record<string, Record<string, unknown>>)[section] ?? {};
    const value = bag[key];
    return typeof value === "string" ? value : "";
  };
  const savedBool = (section: string, key: string): boolean | undefined => {
    const bag = (settings as Record<string, Record<string, unknown>>)[section] ?? {};
    return typeof bag[key] === "boolean" ? (bag[key] as boolean) : undefined;
  };

  const save = useCallback(async (section: string, values: Record<string, unknown>) => {
    setBusySection(section);
    setError(null);
    try {
      const body = await postJsonOrThrow(POOL_PATH, { section, values });
      if (body?.ok !== true) {
        setError(typeof body?.error === "string" ? body.error : tt("auth.network"));
        return;
      }
      onDone?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // 路由不存在（旧 Host 构建）给可执行指引；其余把原始原因原样显示。
      setError(/non-JSON HTTP 4\d\d/.test(message) ? tt("poolMng.routeMissing") : (message || tt("auth.network")));
    } finally {
      setBusySection(null);
    }
  }, [onDone, tt]);

  const setKey = (section: string, key: string, value: unknown) => {
    void save(section, { [key]: value });
  };
  const draftOf = (section: string, key: string): string => {
    const compose = `${section}.${key}`;
    return drafts[compose] ?? saved(section, key);
  };
  const setDraft = (section: string, key: string, value: string) => {
    setDrafts((current) => ({ ...current, [`${section}.${key}`]: value }));
  };
  const commitDraft = (section: string, key: string) => {
    const compose = `${section}.${key}`;
    const draft = drafts[compose];
    if (draft === undefined || draft === saved(section, key)) return;
    setKey(section, key, draft);
    setDrafts((current) => {
      const next = { ...current };
      delete next[compose];
      return next;
    });
  };

  /** 开关（即改即存）。 */
  const switchRow = (section: string, key: string, label: string, fallback: boolean) => h(
    "div",
    { style: { marginBottom: 8 } },
    h(ToggleSwitch, {
      checked: savedBool(section, key) ?? fallback,
      busy: busySection === section,
      label,
      // ToggleSwitch 的回调不带参数（React 的事件对象在组件内部已被吞掉）；
      // 新值按当前显示值取反，避免把事件对象当 boolean 发出去。
      onChange: () => setKey(section, key, !(savedBool(section, key) ?? fallback))
    })
  );

  /** 模型下拉（imageGen / vision 清单）。 */
  const modelSelect = (section: string, label: string, list: ModelData[], fallback: string) => h(
    Field,
    { label },
    h("select", {
      style: { ...S.input, width: "auto" },
      value: saved(section, "model") !== "" ? saved(section, "model") : fallback,
      disabled: busySection === section,
      onChange: (event: { target: { value: string } }) => setKey(section, "model", event.target.value)
    }, list.length === 0
      ? h("option", { value: fallback }, fallback + tt("mm.catalogEmpty"))
      : list.map((model) => h("option", { key: String(model.id), value: String(model.id) }, String(model.name ?? model.id))))
  );

  /** 文本行（失焦提交）。 */
  const textRow = (section: string, key: string, label: string, placeholder: string) => h(
    Field,
    { label },
    h("input", {
      style: { ...S.input, width: "auto", flex: 1 },
      value: draftOf(section, key),
      placeholder,
      disabled: busySection === section,
      onChange: (event: { target: { value: string } }) => setDraft(section, key, event.target.value),
      onBlur: () => commitDraft(section, key)
    })
  );

  /** 单选下拉行。 */
  const selectRow = (section: string, key: string, label: string, options: string[], fallback: string,
    labelOf?: (option: string) => string) => h(
    Field,
    { label },
    h("select", {
      style: { ...S.input, width: "auto" },
      value: saved(section, key) !== "" ? saved(section, key) : fallback,
      disabled: busySection === section,
      onChange: (event: { target: { value: string } }) => setKey(section, key, event.target.value)
    }, options.map((option) => h("option", { key: option, value: option }, labelOf ? labelOf(option) : option)))
  );

  /** 出图单工具的参数卡（两工具同构，配置各自独立）。 */
  const imageCard = (tool: "text2img" | "img2img", title: string, modelFallback: string) => h(
    SectionCard,
    { title, open: true, onToggle: () => undefined, tt },
    switchRow(tool, "enabled", tt("mm.enabled"), false),
    modelSelect(tool, tt("mm.defaultModel"), imageModels, modelFallback),
    textRow(tool, "size", tt("mm.size"), "auto / 2K / 4K / 2048x2048"),
    selectRow(tool, "outputFormat", tt("mm.outputFormat"), IMAGE_FORMATS, "png"),
    selectRow(tool, "responseFormat", tt("mm.responseFormat"), RESPONSE_FORMATS, "b64_json"),
    switchRow(tool, "watermark", tt("mm.watermark"), false),
    switchRow(tool, "promptExtend", tt("mm.promptExtend"), true),
    textRow(tool, "outputDir", tt("mm.outputDir"), "")
  );

  return h(
    "div",
    null,
    error !== null ? h("p", { style: S.formError, role: "alert" }, error) : null,
    imageCard("text2img", "sn_text2img", "sensenova-u1.5-lite"),
    h("div", { style: { height: 14 } }),
    imageCard("img2img", "sn_img2img", "sensenova-u1.5-lite"),
    h("div", { style: { height: 14 } }),
    h(
      SectionCard,
      { title: tt("mm.visionTitle"), open: true, onToggle: () => undefined, tt },
      switchRow("toolsEnabled", "visionTools", tt("mm.visionTools"), false),
      modelSelect("vision", tt("mm.visionModel"), visionModels, "sensenova-6.8-flash-lite"),
      selectRow("vision", "bridgeMode", tt("mm.bridgeMode"), ["auto", "on", "off"], "auto",
        (option) => tt(option === "auto" ? "mm.bridgeModeAuto" : option === "on" ? "mm.bridgeModeOn" : "mm.bridgeModeOff")),
      textRow("vision", "bridgePrompt", tt("mm.bridgePrompt"), tt("mm.bridgePromptPlaceholder"))
    ),
    h("p", { style: { ...S.trendLegend, marginTop: 10 } }, tt("mm.hint"))
  );
}
