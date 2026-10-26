/**
 * The two dictionaries, kept in parity across locales.
 *
 * `en` is typed as `typeof zh`, so a key added to one and not the other is a
 * compile error — the same parity `test/panel.test.mjs` asserts at runtime,
 * now also pinned at build time.
 */
import type { Tt } from "./runtime.ts";

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  // NOTE: there is deliberately NO `entry.label` key here, and no
  // `panel.title` either. Both used to carry the plugin's name inside the
  // card; neither was the right home for it. The Plugins page names the card
  // from `locale/<lang>.json`'s `meta.title` (PITFALLS §27) and prints it
  // directly above the plugin's own section — 32px above, per the shell's
  // `.detailSections`. An in-card heading therefore printed the SAME string
  // twice on one screen, which read as one header split in half. The name has
  // exactly one source now: `locale/<lang>.json`'s `meta.title`.
  //
  // `test/render.test.mjs` pins the absence (the rendered card must not
  // contain `panel.title`), because a name that lives in two places drifts
  // the moment either side is edited — the pair used to be kept equal by a
  // test, which kept the duplication alive rather than questioning it.
  "panel.back": "返回会话",
  "panel.refresh": "刷新",
  "panel.updated": "更新于 {time}",
  "panel.loading": "加载中…",
  "panel.error": "读取失败：{error}",
  "panel.jwtMissing": "还没有配置控制台账号。",
  "panel.jwtExpired": "控制台令牌已失效，且无法用已保存的 refresh_token 续期。请重新登录一次。",
  "panel.configError": "插件配置有误：{error}",
  "panel.consoleTransient": "商汤控制台暂时无法读取，通常下一次自动刷新即可恢复；若持续出现，请检查网络后稍再重试。",
  "panel.shapeDrift": "上游返回的结构可能有变：{detail}",
  "composer.pillTitle": "商汤 Token Plan 额度",
  "composer.pool5h": "5 小时",
  // 「每周」 not 「本周」: the window ROLLS, so 「本周」 (this week) names a
  // calendar week the platform never promised. One word for one window — this
  // key used to say 本周 while the panel's `pool.window7d` said 每周, and the
  // pill plus its own panel disagreeing about which week they mean is a question
  // nobody should have to ask. Same length, so the pill's density is unchanged.
  "composer.pool7d": "每周",
  "composer.stale": "上次数据",
  "composer.noPool": "该模型不在任何积分池覆盖内（额度归零或池耗尽）",
  // The OTHER way a pool can be missing: the console was never read. It has to
  // be a different sentence from `composer.noPool`, because that one is a fact
  // about the app while this one is a fact about us — and the pill said the
  // former on a 401's evidence. `use-remote-read.ts` sets `loadedOnce` in a
  // `finally`, failed attempts included, so "asked and got nothing" is not
  // "asked and was told no"; the panel's head still carries 「上次数据」 for the
  // age of the miss.
  "composer.quotaUnknown": "额度未知（未能读到控制台数据）",
  "composer.resetAt": "重置于",
  // The pill's leading word: which QUOTA PLAN the session is spending, read
  // off the selected provider. Without it a session that has both Token Plan
  // and Raccoon models on offer shows the same two percentages either way, and
  // the reader has to guess whose quota is draining. It is a prefix, not a
  // decoration — and it follows the UI language, so the English UI does not
  // wear Chinese characters the model picker would never show.
  "composer.planPrefix": "商汤",
  // The unit rides the number rather than standing alone: "浣熊 · 4,215 分"
  // reads as a quantity, "浣熊 · 4,215" as an id.
  // The heading over the gateway's own split of the total. It exists so the
  // parts read as a composition OF the balance above them, not as three more
  // unrelated figures.
  "composer.poolHit": "本模型计入此池",
  // Says HOW the pool was chosen, never WHAT KIND it is. The previous wording
  // ("按通用池计") asserted a general pool, which `poolFor` cannot know: it falls
  // back to `pools[0]`, and the console returns sibling pools in its own order,
  // so a fallback legitimately lands on a 专属池 — where the old sentence then
  // read 「Flash-Lite 专属池 · 专属池 · 本模型无专属池，按通用池计」, contradicting
  // itself inside one line. The pool's declared type is already said by
  // `pool.dedicated` / `pool.default` beside the name; this part is about the
  // selection, and `docs/ROADMAP.md` §6.3 already ruled the fallback is "not a
  // confirmed attribution, the sentence describes the selection".
  "composer.poolFallback": "本模型未列入任何池，此处按平台顺序取第一个池",
  // The roster's "something appeared" marker. It rides BESIDE the balance
  // because a new model is a fact about what the gateway offers, not about
  // what is left — and it is the only surface that can say it without the user
  // having to open the Raccoon tab on the day it happens (the 1017 addition
  // went unseen for weeks). Wording is a count noun, so the number in front
  // composes in both languages: "1 新模型" / "2 新模型", "1 new" / "2 new".
  //
  // The tooltip says 本机首次见到, NOT 网关新增: the plugin has no gateway
  // "listed since" field (ADR-017 复核条件), so what it actually knows is the
  // moment THIS profile first saw the id. Claiming "网关新增" would state a
  // gateway fact on the plugin's behalf — the same overclaim ADR-016 exists to
  // stop. A second profile legitimately shows its own first-sightings, which
  // "本机" makes true and "网关" would make a lie.
  "auth.title": "连接商汤控制台",
  "auth.registerHint": "还没有账号？前往官网注册，免费开通 Token Plan 额度 →",
  "auth.portalHint": "前往官网管理额度 / 获取 API Key →",
  "auth.username": "账号",
  "auth.password": "密码",
  "auth.show": "显示",
  "auth.hide": "隐藏",
  "auth.placeholderUser": "登录 platform.sensenova.cn 的账号",
  "auth.submit": "登录",
  "auth.submitting": "登录中…",
  "auth.working": "已保存并登录，正在读取额度…",
  "auth.forget": "清除已保存的账号",
  "auth.forgotten": "已清除账号（当前令牌仍可用）",
  "auth.saved": "账号与登录令牌已保存在 DSH 凭据中；密码不落盘，refresh 令牌失效后需重新输入一次。",
  "auth.ephemeral": "注意：当前 Host 没有凭据服务，账号只保存在内存中，重启后需要重新登录。",
  "auth.autoRecoverOn": "账号与登录令牌已保存在 DSH 凭据中；自动恢复已开启（环境已备密码 SENSENOVA_PASSWORD），令牌失效后会自动重登，无需手动输入。",
  "auth.badCredentials": "账号或密码不正确",
  "auth.locked": "账号已被锁定，请在商汤控制台用手机号验证或联系客服解锁。",
  "auth.retryAfter": "平台要求等待约 {minutes} 分钟后再试；等待期间面板不会自动重试，避免再次触发锁定。",
  "auth.rateLimited": "尝试过于频繁，请稍后再试。",
  "auth.verification": "需要额外验证（短信/图形验证码），自动化登录无法完成，请先在浏览器登录一次。",
  "auth.failed": "登录未完成：{reason}",
  "auth.empty": "请填写账号和密码",
  "auth.network": "无法连接本机 Host",
  "section.pools": "积分池",
  "pool.window5h": "5 小时",
  "pool.window7d": "每周",
  "pool.used": "已用",
  "pool.exhausted": "已耗尽",
  "pool.exhaustedNotice": "部分积分池已耗尽（剩余 0），最早于 {time} 重置；只有在别处没有额度来源的模型才会在此之前暂不可选。",
  "pool.reset": "重置 {time}",
  "pool.grant": "返赠余额 {balance}",
  "pool.grantExpiry": "最近返赠到期 {time}（{balance} 分）",
  "pool.dedicated": "专属池",
  "pool.default": "通用池",
  "pool.callable": "可调用",
  "pool.coverageUnverified": "覆盖（未核实）",
  "pool.details": "模型与返赠详情",
  "pool.locked": "需开通 +{count} 个",
  "pool.uncounted": "不计入积分池：{models}",
  "shape.api": "接口",
  "shape.missing": "缺少字段",
  "section.trend": "每模型消耗（近 {hours} 小时 · 缓存 {cache} 秒）",
  "section.collapse": "收起",
  "section.expand": "展开",
  "trend.model": "模型",
  "trend.credits": "积分",
  "trend.none": "该区间内没有消耗记录。",
  "trend.legend": "柱长按最高消耗相对显示，非占总额度比例；消耗不足最高值 1% 的行不画柱。",
  "trend.multiplierLegend": "×N 为插件配置的自定义倍率（非官方数据），仅供跨模型对比；未标注的模型没有配置倍率。",
  "llm.contextBadge": "{ctx} 上下文",
  "auth.selfRenew": "令牌自动续期中",
  "auth.needsLogin": "需要重新登录",
  "llm.title": "API Key",
  "llm.providerTitle": "语言模型",
  "llm.keyField": "API Key",
  "llm.placeholder": "粘贴 sk- 开头的 API Key",
  "llm.save": "保存 API Key",
  "llm.saving": "保存中…",
  "llm.forget": "清除已保存的 API Key",
  "llm.saved": "API Key 已保存在 DSH 凭据中；下次轮询自动拉取模型目录。",
  "llm.forgotten": "已清除面板保存的 API Key（环境变量 SENSENOVA_API_KEY 不受影响）。",
  "llm.empty": "请输入 sk- 开头的 API Key",
  "llm.footnote": "Key 只保存在 DSH 凭据中，不会写入插件目录或日志；请求时按次读取。",
  "llm.keyRegisterHint": "还没有 API Key？前往官网免费获取 →",
  "llm.keyManageHint": "前往官网管理额度 →",
  "llm.ephemeral": "注意：当前 Host 没有凭据服务，Key 只保存在内存中，重启后失效。",
  "llm.keyPresent": "已配置（来源：{source}）",
  "llm.noKey": "尚未配置——在上方粘贴 sk- Key 并保存。",
  "llm.src.credentials": "DSH 凭据",
  "llm.src.env": "环境变量 SENSENOVA_API_KEY",
  "llm.src.memory": "本机内存",
  "llm.off": "未向 DSH 注册——勾选上方开关即可开启（id：{id}）。",
  "llm.registeredPending": "开关已开但注册尚未生效（id：{id}）——等待下一次自动刷新；若持续未注册，检查 Host 日志。",
  "llm.registered": "已注册 {id}：{models} 个模型，{vision} 个支持图片输入。",
  "llm.noService": "registerProvider 已开启，但当前 Host 没有提供 LLM 注册服务。",
  "llm.error": "提供方注册失败：{error}",
  "llm.switch": "向 DSH 注册",
  "llm.switchTitle": "开启后立刻向 DSH 注册 SenseNova 提供方（无需重启）；关闭则从模型下拉框移除，已保存的设置保留。",
  "llm.switchBusy": "切换中…",
  "llm.switchError": "切换失败：{error}",
  "llm.roster": "推送到 DSH 的模型",
  "llm.rosterHint": "勾选 / 选择只改本地草稿：需要按「保存」才会推到 DSH；「撤销」回到上次保存值。目录新增的模型默认不推送。",
  // 指向卡片名而非「上方/下方」：本卡片与 API Key 卡片的先后已经换过一次，
  // 方向词指错过一次就不该再写方向词。
  "llm.rosterEmpty": "还没有可推送的模型——先在「API Key」卡片保存一次 Key 再回来。",
  "llm.rosterSearchPlaceholder": "搜索模型名或 ID",
  "llm.rosterCount": "已勾选 {selected} / 共 {total}",
  "llm.rosterAll": "全部勾选",
  "llm.rosterNone": "全部取消",
  "llm.rosterSave": "保存",
  "llm.rosterSaving": "保存中…",
  "llm.rosterDiscard": "撤销",
  "llm.rosterSaved": "已保存，模型列表已更新。",
  "llm.rosterUnsaved": "有未保存的改动",
  "llm.rosterError": "保存失败：{error}",
  "llm.rosterNoMatch": "没有匹配的模型。",
  "llm.rosterVision": "可看图",
  "llm.rosterThinking": "模型设置",
  "llm.rosterThinkingLevels": "思考档位",
  "llm.rosterExhausted": "额度耗尽",
  "llm.rosterRateTitle": "积分消耗伪倍率（自定义对比用，非官方）",
  "llm.metaOutput": "最大输出 {out}",
  "llm.rosterThinkingDefault": "思考强度默认 {level}",
  "llm.level.off": "关闭",
  "llm.level.minimal": "微量",
  "llm.level.low": "低",
  "llm.level.medium": "中",
  "llm.level.high": "高",
  "llm.level.xhigh": "极高",
  "llm.level.max": "最高",
  "tab.quota": "积分额度",
  "tab.api": "接入 API",
  "tab.multimodal": "多模态",
  "mm.enabled": "启用工具",
  "mm.text2imgTitle": "文生图",
  "mm.img2imgTitle": "图生图",
  "mm.defaultModel": "模型",
  "mm.size": "尺寸",
  "mm.outputFormat": "输出格式",
  "mm.responseFormat": "返回方式",
  "mm.watermark": "关闭水印",
  "mm.promptExtend": "描述润色",
  "mm.outputDir": "保存位置",
  "mm.outputDirHint": "留空默认不自动保存",
  "mm.visionTitle": "图片转述",
  "mm.visionModel": "视觉模型",
  "mm.bridgeMode": "读图桥",
  "mm.bridgeModeAuto": "自动（主模型支持图片时不接管）",
  "mm.bridgeModeOn": "开（恒接管）",
  "mm.bridgeModeOff": "关",
  "mm.bridgePrompt": "桥提示词",
  "mm.bridgePromptPlaceholder": "留空用内置默认（事实性转录、不猜测）",
  "mm.catalogEmpty": "（目录暂无此模型）",
  "mm.hint": "这里的设置是主要设置（存插件状态文件）；cordis.patch.yml 的同名键只在未设置时生效。改动即保存。",
  "llm.protocol": "协议",
  "llm.protocolAuto": "自动",
  "poolMng.concurrent": "并发",
  "poolMng.note": "备注",
  "poolMng.saveName": "保存",
  "poolMng.routeMissing": "Host 未加载本插件的池路由：正在运行的是旧构建。请完全退出 DSH（含托盘图标）后重新启动。",
  "poolMng.concurrentHint": "全局在途上限；0 = 跟随 key 数",
  "poolMng.empty": "池为空：在 cordis.patch.yml 配置 accounts，或保存一把 Key",
  "poolMng.phaseRunning": "运行",
  "poolMng.phaseBlocked": "阻塞",
  "poolMng.phaseAbsent": "未入池",
  "poolMng.deleted": "已删除",
  "poolMng.disable": "停用",
  "poolMng.restore": "恢复",
  "poolMng.delete": "删除",
  // Zero multiplier: a statement about the model, not a rate of zero.
  // NOT `llm.rosterRateTitle`: that one says the rate is the operator's own
  // pseudo figure ("非官方"). This one IS the gateway catalogue's own field,
  // and quoting the other tooltip here would libel real data as invented.
  // Promotion states the gateway declares (`billing_status`): the row's
  // multiplier is already the EFFECTIVE price, and the list price + the
  // gateway's note ride along so the chip can say what the strike-through
  // would, in one tooltip. `{note}` may be empty — the format tolerates it.
  // The three terminal outcomes of a QR walk. They are EVENTS the tab reports
  // once (the route clears them as it hands them over), not a persistent state:
  // "signed in" is `loggedIn`, which the credential answers on every poll.
  // The number of minutes used to be spelled here ("5 分钟内未确认") while the
  // Host held `RACCOON_LOGIN_TIMEOUT_MS` as the real deadline: the text is a
  // copy nobody pins, so a tuned deadline would have made the panel lie. The
  // sentence now states the outcome without restating the Host's number.
} satisfies Record<string, string>;

/** English dictionary, mirroring every zh key. */
export const en: typeof zh = {
  "panel.back": "Back to conversation",
  "panel.refresh": "Refresh",
  "panel.updated": "Updated {time}",
  "panel.loading": "Loading…",
  "panel.error": "Could not read: {error}",
  "panel.jwtMissing": "No SenseNova console account is configured yet.",
  "panel.jwtExpired": "The console token is no longer valid and could not be renewed from the stored refresh_token. Sign in again.",
  "panel.configError": "The plugin is misconfigured: {error}",
  "panel.consoleTransient": "The SenseNova console could not be read just now. This usually clears on the next automatic refresh; if it persists, check your network and try again shortly.",
  "panel.shapeDrift": "The upstream payload shape may have changed: {detail}",
  "composer.pillTitle": "SenseNova Token Plan quota",
  "composer.pool5h": "5h",
  "composer.pool7d": "weekly",
  "composer.stale": "stale data",
  "composer.noPool": "not covered by any credit pool (drained or pool-exhausted)",
  "composer.quotaUnknown": "quota unknown (the console could not be read)",
  "composer.resetAt": "resets at",
  "composer.planPrefix": "SenseNova",
  "composer.poolHit": "this model draws from this pool",
  "composer.poolFallback": "no pool lists this model — showing the first pool the platform returned",
  // "1 new" / "2 new" reads as a toolbar chip; the tooltip and the popover row
  // carry the names, so the pill itself stays a count. The tooltip says "first
  // seen on this device", not "new in the gateway" — there is no gateway
  // "listed since" field, and stating a gateway fact the plugin cannot know is
  // the overclaim ADR-016 exists to stop (see the zh note for the same rule).
  "auth.title": "Connect the SenseNova console",
  "auth.registerHint": "No account yet? Register on the official site for a free Token Plan quota →",
  "auth.portalHint": "Manage quota / get API keys on the official site →",
  "auth.username": "Username",
  "auth.password": "Password",
  "auth.show": "Show",
  "auth.hide": "Hide",
  "auth.placeholderUser": "Your platform.sensenova.cn account",
  "auth.submit": "Sign in",
  "auth.submitting": "Signing in…",
  "auth.working": "Saved and signed in; reading quota…",
  "auth.forget": "Forget the saved account",
  "auth.forgotten": "Account cleared (the current token still works)",
  "auth.saved": "Account and login token stored in the DSH credentials; the password is never written to disk — you'll be asked to sign in again once the refresh token dies.",
  "auth.ephemeral": "Note: this Host has no credentials service, so the account lives in memory only and must be entered again after a restart.",
  "auth.autoRecoverOn": "Account and login token saved in DSH credentials; auto-recovery is on (an environment password SENSENOVA_PASSWORD is present), so a dead token re-signs in automatically.",
  "auth.badCredentials": "That username or password is not right",
  "auth.locked": "This account is locked. Verify by phone in the SenseNova console or contact support to unlock it.",
  "auth.retryAfter": "The platform asks to wait about {minutes} more minutes. The panel will not retry on its own during that window, so the lock is not extended.",
  "auth.rateLimited": "Too many attempts. Wait a moment and try again.",
  "auth.verification": "This sign-in needs an extra step (SMS or captcha) that automation cannot complete. Sign in once in a browser first.",
  "auth.failed": "Sign-in did not complete: {reason}",
  "auth.empty": "Enter a username and a password",
  "auth.network": "Could not reach the local Host",
  "section.pools": "Credit pools",
  "pool.window5h": "5 hours",
  "pool.window7d": "Weekly",
  "pool.used": "Used",
  "pool.exhausted": "Exhausted",
  "pool.exhaustedNotice": "Some credit pools are exhausted (0 remaining); the earliest resets at {time}. Only models with no other pool left to draw on become unselectable until then.",
  "pool.reset": "resets {time}",
  "pool.grant": "Grant balance {balance}",
  "pool.grantExpiry": "Next grant expiry {time} ({balance} cr)",
  "pool.dedicated": "dedicated",
  "pool.default": "default",
  "pool.callable": "Callable",
  "pool.coverageUnverified": "Covered (unverified)",
  "pool.details": "Models & grant details",
  "pool.locked": "+{count} need activation",
  "pool.uncounted": "Not billed to credit pools: {models}",
  "shape.api": "endpoint",
  "shape.missing": "missing field",
  "section.trend": "Per-model consumption (last {hours} h · cached {cache} s)",
  "section.collapse": "Collapse",
  "section.expand": "Expand",
  "trend.model": "Model",
  "trend.credits": "Credits",
  "trend.none": "No consumption in this range.",
  "trend.legend": "Bars are scaled relative to the top consumer, not to the total quota; rows below 1% of the top figure draw no bar.",
  "trend.multiplierLegend": "×N marks a custom multiplier configured in the plugin (not official data), for cross-model comparison only; unlabelled models have no configured multiplier.",
  "llm.contextBadge": "{ctx} context",
  "auth.selfRenew": "Token renews itself",
  "auth.needsLogin": "Sign-in required",
  "llm.title": "API key",
  "llm.providerTitle": "Language models",
  "llm.keyField": "API key",
  "llm.placeholder": "Paste your sk- API key",
  "llm.save": "Save API key",
  "llm.saving": "Saving…",
  "llm.forget": "Forget the saved API key",
  "llm.saved": "API key stored in the DSH credentials; the next poll fetches the model catalog.",
  "llm.forgotten": "Panel-saved API key cleared (an SENSENOVA_API_KEY environment value is left untouched).",
  "llm.empty": "Enter an API key starting with sk-",
  "llm.footnote": "The key is kept only in the DSH credentials, never in this plugin's folder or logs; it is read per request.",
  "llm.keyRegisterHint": "No API key yet? Get a free one on the official site →",
  "llm.keyManageHint": "Manage quota on the official site →",
  "llm.ephemeral": "Note: this Host has no credentials service, so the key lives in memory only and is lost on restart.",
  "llm.keyPresent": "Configured (source: {source})",
  "llm.noKey": "Not configured — paste an sk- key above and save.",
  "llm.src.credentials": "DSH credentials",
  "llm.src.env": "environment SENSENOVA_API_KEY",
  "llm.src.memory": "memory",
  "llm.off": "Not registered with DSH — tick the switch above (id: {id}).",
  "llm.registeredPending": "Switch is on but registration has not landed yet (id: {id}) — wait for the next automatic refresh; if it persists, check the Host logs.",
  "llm.registered": "Registered {id}: {models} model(s), {vision} with image input.",
  "llm.noService": "registerProvider is on, but this Host exposes no LLM registration service.",
  "llm.error": "Provider registration failed: {error}",
  "llm.switch": "Register with DSH",
  "llm.switchTitle": "On registers the SenseNova provider with DSH at once (no restart); off removes it from the model picker while saved settings stay.",
  "llm.switchBusy": "Switching…",
  "llm.switchError": "Switch failed: {error}",
  "llm.roster": "Models pushed to DSH",
  "llm.rosterHint": "Ticking or picking edits a local draft only: nothing reaches DSH until you hit Save; Discard returns to the last saved values. Models the catalogue gains later are not pushed by default.",
  "llm.rosterEmpty": "No models to push yet — save a key in the API key card first.",
  "llm.rosterSearchPlaceholder": "Search a model name or id",
  "llm.rosterCount": "{selected} ticked / {total} total",
  "llm.rosterAll": "Tick all",
  "llm.rosterNone": "Untick all",
  "llm.rosterSave": "Save",
  "llm.rosterSaving": "Saving…",
  "llm.rosterDiscard": "Discard",
  "llm.rosterSaved": "Saved — the model list has been updated.",
  "llm.rosterUnsaved": "Unsaved changes",
  "llm.rosterError": "Save failed: {error}",
  "llm.rosterNoMatch": "No model matches.",
  "llm.rosterVision": "vision",
  "llm.rosterThinking": "model settings",
  "llm.rosterThinkingLevels": "thinking levels",
  "llm.rosterExhausted": "quota exhausted",
  "llm.rosterRateTitle": "Pseudo credit multiplier (custom comparison aid, not official)",
  "llm.metaOutput": "max output {out}",
  "llm.rosterThinkingDefault": "thinking default {level}",
  "llm.level.off": "off",
  "llm.level.minimal": "minimal",
  "llm.level.low": "low",
  "llm.level.medium": "medium",
  "llm.level.high": "high",
  "llm.level.xhigh": "xhigh",
  "llm.level.max": "max",
  "tab.quota": "Quota & Usage",
  "tab.api": "API Integration",
  "tab.multimodal": "Multimodal",
  "mm.enabled": "Enable tool",
  "mm.text2imgTitle": "Text to image",
  "mm.img2imgTitle": "Image to image",
  "mm.defaultModel": "Model",
  "mm.size": "Size",
  "mm.outputFormat": "Output format",
  "mm.responseFormat": "Response format",
  "mm.watermark": "Disable watermark",
  "mm.promptExtend": "Polish prompt",
  "mm.outputDir": "Save location",
  "mm.outputDirHint": "leave empty to skip auto-saving",
  "mm.visionTitle": "Image description",
  "mm.visionModel": "Vision model",
  "mm.bridgeMode": "Image bridge",
  "mm.bridgeModeAuto": "auto (skip when the main model sees images)",
  "mm.bridgeModeOn": "on (always take over)",
  "mm.bridgeModeOff": "off",
  "mm.bridgePrompt": "Bridge prompt",
  "mm.bridgePromptPlaceholder": "empty = built-in default (factual, no guessing)",
  "mm.catalogEmpty": " (no such model in the catalogue yet)",
  "mm.hint": "Panel values here are PRIMARY (stored in the plugin state file); cordis.patch.yml defaults apply only to unset keys. Every change saves immediately.",
  "llm.protocol": "Protocol",
  "llm.protocolAuto": "auto",
  "poolMng.concurrent": "Concurrency",
  "poolMng.note": "note",
  "poolMng.saveName": "save",
  "poolMng.routeMissing": "The Host is not serving this plugin's pool route: an older build is running. Fully quit DSH (including the tray icon) and start it again.",
  "poolMng.concurrentHint": "global in-flight cap; 0 = follow key count",
  "poolMng.empty": "Pool is empty: configure accounts in cordis.patch.yml or save a key",
  "poolMng.phaseRunning": "running",
  "poolMng.phaseBlocked": "blocked",
  "poolMng.phaseAbsent": "out of pool",
  "poolMng.deleted": "deleted",
  "poolMng.disable": "disable",
  "poolMng.restore": "restore",
  "poolMng.delete": "delete",
};

export type { Tt };
