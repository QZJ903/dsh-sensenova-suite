/**
 * The catalog modality judgment — the ONE place both model lists read from.
 *
 * Before this module existed, the two directions of "is this entry an image
 * model" lived in two files with two shapes:
 *
 *   - `llm-models.ts` `isChatModel` (PERMISSIVE): a missing `output_modalities`
 *     reads as chat, so a field the platform never sent does not vanish from
 *     the picker;
 *   - the draw-side predicate `isImageGenModel` (STRICT): a missing `output_modalities` reads
 *     as "not a draw model", so a wrong guess never sends the agent's request
 *     to a model that cannot answer.
 *
 * They are complements, and a missing field makes them drift in OPPOSITE
 * directions — the "two lists can never disagree" claim was maintained by
 * convention (each side re-implemented the same field probe), not by
 * construction. This module folds the probe into one function: both predicates
 * read the same modality decision, so a contradiction between the chat roster
 * and the draw list becomes impossible rather than merely undiscovered.
 *
 * For SenseNova the platform ALWAYS declares `output_modalities` on every
 * catalog entry (verified 2026-09-29), so the name-segment fallback Agnes
 * needs (its gateway declares no modality field at all) does not exist here;
 * the strict/permissive split on a MISSING field is the only nuance, and it is
 * preserved exactly as the two historical predicates behaved.
 *
 * @module dsh-sensenova-suite/modality
 */

/**
 * The image-modality decision of one catalog entry.
 *
 * The single probe both predicates read. Returns one of:
 *
 *   - `"declared-image"` — `output_modalities` is an array containing "image";
 *   - `"declared-other"`  — the field is an array without "image";
 *   - `"unknown"`         — the field is absent or not an array.
 *
 * A caller wanting the raw list can read `entry?.output_modalities` itself;
 * this function is the judgment, not the data.
 * @param {object} entry - one normalized catalog entry.
 * @returns {"declared-image"|"declared-other"|"unknown"}
 */
export function outputModalityOf(entry: { output_modalities?: unknown }) {
  const out = entry?.output_modalities;
  if (!Array.isArray(out)) return "unknown";
  return out.includes("image") ? "declared-image" : "declared-other";
}

/**
 * Whether a catalog entry can be addressed as a CHAT model on this provider's
 * OpenAI-compatible endpoint.
 *
 * PERMISSIVE direction: a missing/unknown field reads as chat, so an entry
 * the platform did not annotate does not vanish from the picker. Only an
 * explicit image-GENERATION declaration keeps it out (such models answer 404
 * on `/v1/chat/completions`, verified 2026-09-29).
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean} whether the entry is usable as a chat model.
 */
export function isChatModel(entry: { output_modalities?: unknown }) {
  return outputModalityOf(entry) !== "declared-image";
}

/**
 * Whether one catalog entry is an image-GENERATION model.
 *
 * STRICT direction: a model is a draw model only when its OUTPUT modalities are
 * exactly `["image"]` — the model answers by producing an image and nothing
 * else. Anything broader (`["text","image"]`, or a missing field) is NOT a
 * draw model: a wrong draw guess sends the agent's request to a model that
 * cannot answer on `/v1/images/*`.
 *
 * This is deliberately stricter than the old "contains image" probe: a
 * multi-modal CHAT model like `sensenova-6.8-flash-lite` declares
 * `output_modalities: ["text"]` (its image input goes in `input_modalities`,
 * judged separately by {@link identifyVisionModel}), so it must never appear
 * in the image-GENERATION dropdown — those lists answer `/v1/images/*`, which
 * only the pure-output-image family (`sensenova-u1.5-*`) serves.
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean}
 */
export function isImageGenModel(entry: { output_modalities?: unknown }) {
  const out = entry?.output_modalities;
  return Array.isArray(out) && out.length === 1 && out[0] === "image";
}

/** 视觉模型的输入模态申报值（listModels/resolveModel 边界与请求期注记共用同一份）。 */
export const IMAGE_INPUT_MODALITIES: readonly ("text" | "image")[] = Object.freeze(["text", "image"]);

/**
 * The INPUT-modality declaration one catalog entry contributes, or `undefined`
 * to declare no modality metadata at all.
 *
 * 宿主 LlmRuntime 见 descriptor 申报了 inputModalities 而其中没有 "image" 时，
 * 会把请求里的图片块剥成 `[image omitted because this model accepts text only;
 * attachment sha256:…]` 纯文本占位再派发（projectImagesForTextModel）；申报
 * undefined 时原样放行。图像能力以**用户「可看图」勾选集为唯一真源**
 * （2026-10-27 二次事故定版：静态表/平台目录都只是依据，不是真源——新模型
 * 目录未报 image 而实测可看图时，勾选即生效），`checked` 三态决定申报：
 *
 *   - `true`（勾选）→ `["text","image"]`：宿主放行并按视觉模型对待；
 *   - `false`（未勾选）→ `undefined`：宿主仍放行图片，读图桥转述兜底才有米下锅；
 *     也绝不申报 `['text']`——那是宿主剥图的扳机；
 *   - `undefined`（目录条目本义，无配置可读的层）→ 平台 `input_modalities`
 *     去重保留 text/image；不含 image 一律 undefined，绝不申报纯文本。
 *
 * @param {object} raw - one raw catalog entry.
 * @param {boolean|undefined} checked - the user's 可看图 verdict for this model.
 * @returns {readonly ("text"|"image")[]|undefined}
 */
export function inputModalitiesFor(
  raw: { input_modalities?: unknown },
  checked?: boolean,
): readonly ("text" | "image")[] | undefined {
  if (checked === true) return IMAGE_INPUT_MODALITIES;
  if (checked === false) return undefined;
  const declared: ("text" | "image")[] = [];
  const platform = raw?.input_modalities;
  if (Array.isArray(platform)) {
    for (const item of platform) {
      if ((item === "text" || item === "image") && !declared.includes(item)) declared.push(item);
    }
  }
  return declared.includes("image") ? declared : undefined;
}
