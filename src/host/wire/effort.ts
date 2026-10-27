/**
 * Anthropic wire 的 effort 出站判定——纯函数，零导入（contract 套件 peer-free
 * 闸直接驱动本模块，运行时与钉子共用同一份代码）。
 *
 * 词表不是目录/静态表的 chat 方言（那里含 off/none/minimal），而是平台 400
 * 原文枚举的 anthropic 方言（2026-10-27 真机：
 * `output_config.effort must be one of: low, medium, high, xhigh, max; got "off"`——
 * 用户勾选集里的 off 经目录 reasoning.efforts 混进了出站，方言混用即根因）。
 *
 * @module dsh-sensenova-suite/wire/effort
 */

/** Anthropic wire 接受的 effort 值（平台枚举，词表外一律不出站）。 */
export const ANTHROPIC_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** 「关闭思考」在各方言里的拼写：面板 off、chat 方言 none、静态表 minimal。 */
const THINKING_OFF_SPELLINGS: ReadonlySet<string> = new Set(['off', 'none', 'minimal']);

/**
 * 档位拼写归一：面板 off / 静态表 minimal → chat·responses 方言的 none。
 * 对话界面的可选档位 = 用户勾选集（含 off），而 chat/responses 两线的关闭
 * 判据历来只认 'none'——不归一，off 会绕过 kimi 的 thinking:disabled 特判、
 * 在 responses 上整个省略 reasoning 字段（关闭静默变成「用默认」，2026-10-27）。
 */
export function canonicalThinkingEffort(effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined;
  return THINKING_OFF_SPELLINGS.has(effort) ? 'none' : effort;
}

/**
 * 档位 → anthropic 出站字段。关闭思考的任何拼写都落
 * `thinking:{type:'disabled'}`；其余仅词表内值进 `output_config.effort`，
 * 词表外/未选一律双字段皆不发（不发未知值，不上桌让平台打 400）。
 */
export function anthropicEffortOut(effort: string | undefined): { thinkingDisabled: boolean; effortWire: string | undefined } {
  const none = canonicalThinkingEffort(effort) === 'none' && effort !== undefined;
  const effortWire = effort !== undefined && !none && ANTHROPIC_EFFORTS.has(effort)
    ? effort
    : undefined;
  return { thinkingDisabled: none, effortWire };
}
