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
/** 官方建议尺寸（值 = 直通商汤 body.size；auto 让平台自选）。 */
const IMAGE_SIZES = [
  ["auto", "auto"],
  ["2048x2048", "2048x2048（1:1 / 2K）"],
  ["2720x1536", "2720x1536（16:9 / 2K）"],
  ["1536x2720", "1536x2720（9:16 / 2K）"],
  ["1664x2496", "1664x2496（2:3 / 2K）"],
  ["2496x1664", "2496x1664（3:2 / 2K）"],
  ["4096x4096", "4096x4096（1:1 / 4K）"],
] as const;

export function MultimodalTab({ llm, pool, onDone, tt }: {
  llm?: LlmData | null;
  pool: PoolDiagData | null | undefined;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const models = Array.isArray(llm?.allModels) ? llm.allModels : (Array.isArray(llm?.models) ? llm.models : []);
  const imageModels = models.filter((model: ModelData) => model?.imageGen === true);
  // 识图模型 = 用户在接入 API tab 思考档位旁勾选的模型（vision.visionModels 数组）。
  // 不再按目录声明或全部对话模型列；用户认为可识图的，才出现在识图下拉。
  const visionSelected = Array.isArray(pool?.settings?.vision?.visionModels) ? pool.settings.vision.visionModels : [];
  const visionModels = models.filter((model: ModelData) => visionSelected.includes(String(model?.id ?? "")));
  const settings = pool?.settings ?? { toolsEnabled: {}, text2img: {}, img2img: {}, vision: {} };
  const [busySection, setBusySection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 三张参数卡各自可合拢（默认全展开）。 */
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({ text2img: true, img2img: true, vision: true });
  const toggleCard = (key: string) => setOpenCards((current) => ({ ...current, [key]: current[key] === false }));

  const saved = (section: string, key: string): string => {
    const pending = inflight[`${section}.${key}`];
    if (pending !== undefined) {
      if (Date.now() - pending.at > 30_000) {
        setInflight((current) => {
          const next = { ...current };
          delete next[`${section}.${key}`];
          return next;
        });
      } else {
        return pending.value;
      }
    }
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

  /** 模型下拉（imageGen / vision 清单）。S2（2026-11-04 拍板）：已存模型 id 暂缺于
   * 目录时补一行提示——选项来自当前目录、值来自已存设置，脱档时下拉显示不出它，
   * 而适配器仍拿旧 id 发请求（400+30s 冷却）；分叉别静默。saved 为空（走
   * fallback）不提示：fallback 缺席是另一回事（空目录分支自己有文案）。 */
  const modelSelect = (section: string, label: string, list: ModelData[], fallback: string) => {
    const savedModel = saved(section, "model");
    const staleSaved = savedModel !== "" && !list.some((model) => String(model?.id ?? "") === savedModel);
    return h(
      "div",
      null,
      h(
        Field,
        { label },
        h("select", {
          style: { ...S.input, width: "auto" },
          value: savedModel !== "" ? savedModel : fallback,
          disabled: busySection === section,
          onChange: (event: { target: { value: string } }) => setKey(section, "model", event.target.value)
        }, list.length === 0
          ? h("option", { value: fallback }, fallback + tt("mm.catalogEmpty"))
          : list.map((model) => h("option", { key: String(model.id), value: String(model.id) }, String(model.name ?? model.id))))
      ),
      staleSaved
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)", margin: "2px 0 0" } }, tt("mm.savedModelMissing"))
        : null
    );
  };

  /** 文本草稿（key = section.key；常驻输入框用）。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [focusedField, setFocusedField] = useState<string | null>(null);
  // 提交成功的乐观覆盖（POST 已确认、快照未回显的窗口里 saved() 读提交值）：
  // 显示与「再次保存」的基座都不闪旧值；快照追平或 30s 后回落（同 ModelPicker
  // 的 inflight 设计）。修「按一次保存显示空白，再按一次才正常」。
  const [inflight, setInflight] = useState<Record<string, { value: string; at: number }>>({});
  const draftOf = (section: string, key: string): string => drafts[`${section}.${key}`] ?? saved(section, key);
  const setDraft = (section: string, key: string, value: string) => {
    setDrafts((current) => ({ ...current, [`${section}.${key}`]: value }));
  };
  const clearDraft = (section: string, key: string) => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[`${section}.${key}`];
      return next;
    });
  };

  /** 剥一层成对引号（资源管理器「复制文件地址」自带引号）+ 首尾空白。 */
  const unquote = (raw: string): string => raw.trim().replace(/^"(.*)"$/, "$1").trim();

  /**
   * 「保存目录」校验：保存位置是本机文件系统路径，错误要在保存时暴露而不是
   * 等出图落盘失败才发现。空白 = 不落盘（合法）；必须是绝对路径（盘符 / UNC /
   * POSIX 根）；盘符外不得含 Windows 非法字符与控制字符。
   */
  const validateOutputDir = (raw: string): string | null => {
    const value = unquote(raw);
    if (value === "") return null;
    if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) return tt("mm.outputDirNotAbsolute");
    if (/[<>:"|?*\u0000-\u001f]/.test(value.replace(/^[a-zA-Z]:/, ""))) return tt("mm.outputDirIllegalChars");
    return null;
  };

  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const clearDirError = (tool: "text2img" | "img2img") => {
    setDirErrors((current) => {
      if (!(tool in current)) return current;
      const rest = { ...current };
      delete rest[tool];
      return rest;
    });
  };

  /** 保存目录提交：非法 = 红字 + 输入框恢复已存原值；合法 = 归一后落库并清红字。 */
  const commitOutputDir = (tool: "text2img" | "img2img", raw: string): void => {
    const verdict = validateOutputDir(raw);
    if (verdict !== null) {
      setDirErrors((current) => ({ ...current, [tool]: verdict }));
      clearDraft(tool, "outputDir");
      return;
    }
    const next = unquote(raw);
    clearDraft(tool, "outputDir");
    if (next !== saved(tool, "outputDir")) {
      setInflight((current) => ({ ...current, [`${tool}.outputDir`]: { value: next, at: Date.now() } }));
      setKey(tool, "outputDir", next);
    }
    clearDirError(tool);
  };
  const commitBridgePrompt = (raw: string): void => {
    const next = unquote(raw);
    clearDraft("vision", "bridgePrompt");
    if (next !== saved("vision", "bridgePrompt")) {
      setInflight((current) => ({ ...current, "vision.bridgePrompt": { value: next, at: Date.now() } }));
      setKey("vision", "bridgePrompt", next);
    }
  };

  /** 常驻输入框：聚焦且有改动时在最右加「保存」；失焦/回车/保存同源提交。
   * commit 无返回值——非法输入由 commit 自行恢复原值并设红字（行下方）。 */
  const inputWithSaveRow = (section: string, key: string, opts: {
    label: string;
    placeholder: string;
    busy: boolean;
    error: string | undefined;
    commit: (raw: string) => void;
  }) => {
    const target = `${section}.${key}`;
    const showSave = focusedField === target && draftOf(section, key) !== saved(section, key);
    // 横排单行（2026-10-29 用户拍板：label 与输入框同一行，不转行）；输入框
    // flex:1 吃满 label 右侧全部剩余宽度——与 sk- 框最大等宽。
    return h(
      "div",
      null,
      h(
        Field,
        { label: opts.label },
        h("span", { style: { display: "flex", gap: 4, alignItems: "center", flex: 1 } },
          h("input", {
            style: { ...S.input, flex: 1 },
            value: draftOf(section, key),
            placeholder: opts.placeholder,
            disabled: opts.busy,
            onFocus: () => setFocusedField(target),
            onChange: (event: { target: { value: string } }) => setDraft(section, key, event.target.value),
            // 失焦 = 放弃编辑：清草稿，输入框恢复成已保存真值——不提交，也不让
            // 未保存的草稿留在框里冒充已保存（2026-10-29 用户点破的假象）。
            // 落库唯一路径是「保存」按钮/回车；按钮 onMouseDown preventDefault
            // （点按钮不让输入框失焦），所以这里的恢复不会误伤按钮通路。
            onBlur: () => {
              clearDraft(section, key);
              setFocusedField(null);
            },
            onKeyDown: (event: { key: string; preventDefault?: () => void }) => {
              // 回车提交；preventDefault 防冒泡外层 form（同 key 备注的 2026-10-25 坑）。
              if (event.key === "Enter") {
                event.preventDefault?.();
                opts.commit(draftOf(section, key));
                setFocusedField(null);
                clearDraft(section, key);
              }
            }
          }),
          // 按钮常驻渲染（flex:none 占位，输入框宽度稳定不跳），聚焦 + 有改动时可见。
          h("button", {
            type: "button",
            // mousedown 阻止默认：输入框不失焦，blur 的恢复草稿不会抢在点击前发生。
            onMouseDown: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
            style: { ...S.button, flex: "none", visibility: showSave ? "visible" : "hidden" },
            disabled: opts.busy,
            onClick: () => {
              opts.commit(draftOf(section, key));
              setFocusedField(null);
              clearDraft(section, key);
            }
          }, tt("poolMng.saveName")))
      ),
      opts.error !== undefined ? h("p", { style: S.formError, role: "alert" }, opts.error) : null
    );
  };

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
  const imageCard = (tool: "text2img" | "img2img", title: string, description: string, modelFallback: string) => h(
    SectionCard,
    { title, description, open: openCards[tool] !== false, onToggle: () => toggleCard(tool), tt },
    // 开关写进 toolsEnabled 分区（宿主注册 gating 是 tri-state：存过值听面板、
    // 没存过回落 patch 默认——U12-D1 案 A 2026-11-04）。写进 text2img.enabled
    // 会被 readImage 白名单丢弃，工具永不注册 —— 2026-10-25 修的「按了开启没反应」根因。
    switchRow("toolsEnabled", tool, tt("mm.enabled"), true),
    modelSelect(tool, tt("mm.defaultModel"), imageModels, modelFallback),
    selectRow(tool, "size", tt("mm.size"), IMAGE_SIZES.map(([value]) => value), "auto",
      (option) => IMAGE_SIZES.find(([value]) => value === option)?.[1] ?? option),
    selectRow(tool, "outputFormat", tt("mm.outputFormat"), IMAGE_FORMATS, "png"),
    // 描述润色（默认开）在关闭水印（默认开）之前；两者默认都开，
    // 水印开关语义是「关闭水印」——开=不加官方水印，关=加。与宿主默认一致
    // （imageOptions: watermark ?? true / promptExtend ?? true）。
    switchRow(tool, "promptExtend", tt("mm.promptExtend"), true),
    switchRow(tool, "watermark", tt("mm.watermark"), true),
    // 保存目录：常驻输入框，聚焦且有改动时最右出现「保存」；校验（绝对路径 +
    // 非法字符）非法恢复原值 + 红字内联（每卡独立），合法归一（剥引号/空白）后提交。
    inputWithSaveRow(tool, "outputDir", {
      label: tt("mm.outputDir"),
      placeholder: tt("mm.outputDirHint"),
      busy: busySection === tool,
      error: dirErrors[tool],
      commit: (raw) => commitOutputDir(tool, raw)
    })
  );

  return h(
    "div",
    null,
    error !== null ? h("p", { style: S.formError, role: "alert" }, error) : null,
    imageCard("text2img", tt("mm.text2imgTitle"), tt("mm.text2imgHint"), "sensenova-u1.5-lite"),
    h("div", { style: { height: 14 } }),
    imageCard("img2img", tt("mm.img2imgTitle"), tt("mm.img2imgHint"), "sensenova-u1.5-lite"),
    h("div", { style: { height: 14 } }),
    h(
      SectionCard,
      { title: tt("mm.visionTitle"), description: tt("mm.visionHint"), open: openCards.vision !== false, onToggle: () => toggleCard("vision"), tt },
      // 文案是「启用转述」不是「启用工具」——视觉卡不是模型工具，是转述管道
      // （独立 i18n key，出图两卡仍用 mm.enabled「启用工具」）。
      switchRow("toolsEnabled", "visionTools", tt("mm.visionEnabled"), true),
      modelSelect("vision", tt("mm.visionModel"), visionModels, "sensenova-6.8-flash-lite"),
      inputWithSaveRow("vision", "bridgePrompt", {
        label: tt("mm.bridgePrompt"),
        placeholder: tt("mm.bridgePromptPlaceholder"),
        busy: busySection === "vision",
        error: undefined,
        commit: commitBridgePrompt
      })
    )
  );
}
