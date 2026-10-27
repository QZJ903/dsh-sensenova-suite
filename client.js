var dsh_connect_sensenova_token_plan_client = (function() {

//#region \0rolldown/runtime.js
	var __esmMin = (fn, res, err) => () => {
		if (err) throw err[0];
		try {
			return fn && (res = fn(fn = 0)), res;
		} catch (e) {
			throw err = [e], e;
		}
	};
	var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod, mod.exports), cb = null), mod.exports);

//#endregion
//#region src/client/const.ts
	var NS, PANEL_ID, SNAPSHOT_PATH, ACCOUNT_PATH, PROVIDER_PATH, MODELS_PATH, POOL_PATH, SENSENOVA_SIGNUP_URL;
	var init_const = __esmMin((() => {
		NS = "dsh-sensenova-suite";
		PANEL_ID = NS;
		SNAPSHOT_PATH = `/api/${NS}/snapshot`;
		ACCOUNT_PATH = `/api/${NS}/account`;
		PROVIDER_PATH = `/api/${NS}/provider`;
		MODELS_PATH = `/api/${NS}/models`;
		POOL_PATH = `/api/${NS}/pool`;
		SENSENOVA_SIGNUP_URL = "https://www.sensenova.cn/token-plan";
	}));

//#endregion
//#region src/client/i18n.ts
	var zh, en;
	var init_i18n = __esmMin((() => {
		zh = {
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
			"composer.pool7d": "每周",
			"composer.stale": "上次数据",
			"composer.noPool": "该模型不在任何积分池覆盖内（额度归零或池耗尽）",
			"composer.quotaUnknown": "额度未知（未能读到控制台数据）",
			"composer.resetAt": "重置于",
			"composer.planPrefix": "商汤",
			"composer.poolHit": "本模型计入此池",
			"composer.poolFallback": "本模型未列入任何池，此处按平台顺序取第一个池",
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
			"pool.grantNearest": "{balance} 积分会在{time}到期",
			"pool.grantExpiry": "最近返赠到期 {time}（{balance} 分）",
			"pool.dedicated": "专属池",
			"pool.default": "通用池",
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
			"llm.ephemeral": "注意：当前 Host 没有凭据服务，Key 只保存在内存中，重启后失效。",
			"llm.noKey": "尚未配置——在上方粘贴 sk- Key 并保存。",
			"llm.off": "未向 DSH 注册——勾选上方开关即可开启（id：{id}）。",
			"llm.registeredPending": "开关已开但注册尚未生效（id：{id}）——等待下一次自动刷新；若持续未注册，检查 Host 日志。",
			"llm.noService": "registerProvider 已开启，但当前 Host 没有提供 LLM 注册服务。",
			"llm.error": "提供方注册失败：{error}",
			"llm.switch": "向 DSH 注册",
			"llm.switchTitle": "开启后立刻向 DSH 注册 SenseNova 提供方（无需重启）；关闭则从模型下拉框移除，已保存的设置保留。",
			"llm.switchBusy": "切换中…",
			"llm.switchError": "切换失败：{error}",
			"llm.roster": "推送到 DSH 的模型",
			"llm.rosterHint": "勾选 / 选择只改本地草稿：需要按「保存」才会推到 DSH；「撤销」回到上次保存值。目录新增的模型默认不推送。",
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
			"mm.visionEnabled": "启用转述",
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
			"poolMng.concurrentHint": "全局在途上限",
			"poolMng.empty": "池为空：在 cordis.patch.yml 配置 accounts，或保存一把 Key",
			"poolMng.phaseRunning": "运行",
			"poolMng.phaseBlocked": "阻塞",
			"poolMng.phaseAbsent": "未入池",
			"poolMng.deleted": "已删除",
			"poolMng.disable": "停用",
			"poolMng.restore": "恢复",
			"poolMng.delete": "删除"
		};
		en = {
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
			"pool.grantNearest": "{balance} credits expire at {time}",
			"pool.grantExpiry": "Next grant expiry {time} ({balance} cr)",
			"pool.dedicated": "dedicated",
			"pool.default": "default",
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
			"llm.ephemeral": "Note: this Host has no credentials service, so the key lives in memory only and is lost on restart.",
			"llm.noKey": "Not configured — paste an sk- key above and save.",
			"llm.off": "Not registered with DSH — tick the switch above (id: {id}).",
			"llm.registeredPending": "Switch is on but registration has not landed yet (id: {id}) — wait for the next automatic refresh; if it persists, check the Host logs.",
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
			"mm.visionEnabled": "Enable relay",
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
			"poolMng.concurrentHint": "global in-flight cap",
			"poolMng.empty": "Pool is empty: configure accounts in cordis.patch.yml or save a key",
			"poolMng.phaseRunning": "running",
			"poolMng.phaseBlocked": "blocked",
			"poolMng.phaseAbsent": "out of pool",
			"poolMng.deleted": "deleted",
			"poolMng.disable": "disable",
			"poolMng.restore": "restore",
			"poolMng.delete": "delete"
		};
	}));

//#endregion
//#region src/client/format.ts
/** Time and number formatters. */
	/**
	* A Host-STATED cadence in seconds, as the milliseconds `setInterval` wants,
	* or `fallbackMs` when the answer carried no usable number.
	*
	* The stated value is passed through as-is once it is a usable number: the
	* Host owns the number, it knows the gateway budget behind it (its own scan
	* poll is 2 s) and it knows its cache windows, so a second opinion here would
	* be the very drift this helper exists to prevent. The one shape kept away
	* from the timer is a value that would become a busy loop or a nonsense
	* interval — a non-number (`NaN`, a string, a missing or non-positive field)
	* falls back, and a sub-second value rounds up to a whole 1 s rather than
	* flooring to `0` (which `setInterval` reads as "as fast as possible").
	*/
	function statedCadenceMs(seconds, fallbackMs) {
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
		return Math.max(1, Math.floor(seconds)) * 1e3;
	}
	/** `HH:MM` for one epoch second. Internal: a building block for {@link when}. */
	function clock(epoch) {
		if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
		const pad = (value) => String(value).padStart(2, "0");
		return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
	/** `MM-DD HH:mm` for one epoch second. */
	function clockLong(epoch) {
		if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
		const pad = (value) => String(value).padStart(2, "0");
		return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
	/**
	* A date-aware reset clock: `HH:MM` when the instant lands on today's local
	* date, `MM-DD HH:mm` once it crosses into another day.
	*
	* Why this exists: `clock` was the one shared formatter, so the weekly
	* (`window_7d`) reset — an absolute instant days away — read as "重置 18:10"
	* and looked like it fired later TODAY. A bare time is honest only for the
	* 5-hour window; a reset that crosses midnight must carry its day.
	*/
	function when(epoch) {
		if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
		const now = /* @__PURE__ */ new Date();
		return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate() ? clock(epoch) : clockLong(epoch);
	}
	/**
	* A credit figure as text: 2-decimal precision under 10 000, whole with
	* thousands separators at or above it. The switch is deliberate — a pool
	* limit of 60 000 reads as "60,000", a live balance of 47.5 as "47.5".
	*/
	function count(value) {
		const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
		if (number >= 1e4) return Math.round(number).toLocaleString();
		return String(Math.round(number * 100) / 100);
	}
	/** Fill a `{token}` template from a dictionary entry. */
	function format(template, vars) {
		let text = template;
		for (const [key, value] of Object.entries(vars || {})) text = text.split(`{${key}}`).join(String(value));
		return text;
	}
	/**
	* A caught value as the one error string the panel shows.
	*
	* Every mutation surface (`ModelPicker`, `ProviderControls`, `RaccoonTab`)
	* ends a `catch` with the same `why instanceof Error ? why.message : String(why)`
	* template, and there were eight copies of it. That is the same drift the HTTP
	* seam in `http.ts` was extracted to stop: a copy that handles a thrown string
	* but not a rejected `{code}` object prints `[object Object]` in the panel's
	* one error line, and no test catches it because each copy is trivial. One
	* definition, so a fix lands everywhere at once.
	* @param why - whatever the `catch` received.
	* @returns {string} the Error's message, the string itself, or a JSON-ish
	*   rendering of a thrown object (never `[object Object]`).
	*/
	function errorText(why) {
		if (why instanceof Error) return why.message;
		if (typeof why === "string") return why;
		if (why === null || why === void 0) return String(why);
		try {
			return JSON.stringify(why) ?? String(why);
		} catch {
			return String(why);
		}
	}
	/**
	* A token count the way the platform names it: 1048576 → "1M", 65536 → "64K",
	* 128000 → "128K". Returns "" for a figure that is not a positive number, so
	* an unknown value draws no segment instead of a zero.
	*
	* Why two bases: the catalogue mixes them — windows and ceilings arrive as
	* powers of two (1048576), while the plugin's own 128k fallback is the round
	* decimal 128 000. A flat /1000 rounding once printed "1049k" for the 1M
	* window and it read like a placeholder bug; so figures divisible by 1000 keep
	* the decimal reading they were written with, binary-only figures (262144 →
	* 256K, 65536 → 64K) get the binary one, and anything ≥ 1M goes to M.
	*/
	function tokenSize(value) {
		const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
		if (number <= 0) return "";
		if (number >= 1e6) return `${Math.round(number / 1e5) / 10}M`;
		if (number % 1e3 === 0) return `${number / 1e3}K`;
		if (number % 1024 === 0) return `${number / 1024}K`;
		return `${Math.round(number / 1e3)}K`;
	}
	var init_format = __esmMin((() => {}));

//#endregion
//#region src/client/http.ts
/** One POST with the panel's fixed request shape; the parsed body or null. */
	async function postRaw(path, payload) {
		let bodyText;
		try {
			bodyText = JSON.stringify(payload);
		} catch (error) {
			throw new Error(`POST ${path}: the request payload is not serializable (client bug, not a network fault): ${error instanceof Error ? error.message : String(error)}`);
		}
		let response;
		try {
			response = await fetch(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				cache: "no-store",
				body: bodyText
			});
		} catch (error) {
			const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			throw new Error(`POST ${path} failed at the network layer (${reason})`);
		}
		const body = await response.json().catch(() => null);
		if (body === null) throw new Error(`POST ${path} returned non-JSON HTTP ${response.status}`);
		return {
			status: response.status,
			body
		};
	}
	/**
	* POST and return the parsed body. Network-layer failures and non-JSON answers
	* THROW with the path and status (see {@link postRaw}): a caller that renders
	* "cannot reach the Host" without them cannot be debugged from the screen.
	*/
	function postJson(path, payload) {
		return postRaw(path, payload).then(({ body }) => body);
	}
	/** POST and demand `ok:true`; refuse by throwing the Host's own wording. */
	async function postJsonOrThrow(path, payload) {
		const { status, body } = await postRaw(path, payload);
		if (body === null || body.ok !== true) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${status}`);
		return body;
	}
	var init_http = __esmMin((() => {}));

//#endregion
//#region src/client/runtime.ts
/**
	* A dictionary key built from a HOST-enumerated value.
	*
	* The families this builds (`llm.level.…`, `llm.src.…`) cannot be listed in
	* `zh` — the Host enumerates them — so the lookup has to widen past
	* compile-time sight. This is the ONE place that does it, so the escape is a
	* named helper rather than three scattered `as DictionaryKey` casts, and any
	* new family the Host adds has one obvious place to extend.
	*/
	function dictKey(family, value) {
		return `${family}.${value}`;
	}
	/** Hand the loader-provided React to the rest of the client. One-shot. */
	function provideClientReact(value) {
		if (typeof value !== "object" || value === null) throw new Error("client: the loader did not hand over a react module");
		api = value;
	}
	function reactApi() {
		if (api === null) throw new Error("client: react used before clientFactory ran");
		return api;
	}
	var api, h, useState, useEffect, useCallback, useMemo, useRef;
	var init_runtime = __esmMin((() => {
		api = null;
		h = (type, props, ...children) => reactApi().createElement(type, props, ...children);
		useState = (initial) => reactApi().useState(initial);
		useEffect = (effect, deps) => reactApi().useEffect(effect, deps);
		useCallback = (callback, deps) => reactApi().useCallback(callback, deps);
		useMemo = (factory, deps) => reactApi().useMemo(factory, deps);
		useRef = (initial) => reactApi().useRef(initial);
	}));

//#endregion
//#region src/client/snapshot.ts
/**
	* Read one snapshot response into the (data, error) pair the panel renders.
	*
	* The Host answers HTTP 200 for every expected outcome and signals the
	* difference in the body: `ok:true` carries the numbers, `ok:false` carries
	* a code and — crucially — the `auth` block, so a panel that cannot reach
	* the console can still say whether its token will renew by itself.
	*
	* A named function at module scope, not inline branching, so the
	* Node-side tests can drive the panel's REAL reading of a response by
	* loading this bundle as a module (`client-surface.js`) — instead of a
	* hand-written copy that would drift the moment either side is edited.
	*/
	function interpretSnapshot(body) {
		const payload = body;
		if (payload && payload.ok === false) return {
			data: null,
			error: {
				message: payload.error || "unexpected payload",
				code: payload.code,
				auth: payload.auth ?? null
			}
		};
		if (!payload || payload.ok !== true) return {
			data: null,
			error: "unexpected payload"
		};
		return {
			data: payload,
			error: null
		};
	}
	/**
	* The failure a non-2xx snapshot response becomes.
	*
	* A non-2xx carries no body, so the status is the only clue. 401/403 mean
	* the token is gone — the same story as the Host's own `jwt_expired`, and
	* the only reading that keeps the sign-in form on screen instead of leaving
	* the reader with a bare status code. Anything else is a plain transport
	* string, which keeps the form reachable too.
	*
	* Named and module-scoped for the same reason as `interpretSnapshot`: the
	* Node-side tests drive this mapping instead of a copy of it.
	*/
	function errorOfStatus(status) {
		if (status === 401 || status === 403) return {
			message: `HTTP ${status}`,
			code: "jwt_expired",
			auth: null
		};
		return `HTTP ${status}`;
	}
	/**
	* The panel's decision: what this snapshot means for what to show.
	*
	* Deliberately a module-scope pure function in `(data, error, tt)`.
	* `PanelPage` calls it in the browser, and the Node-side tests call the
	* very same function after loading this bundle as a module (see
	* `client-surface.js`): no source text is copied or scraped, so the
	* tested logic and the running logic cannot drift apart.
	*/
	function viewOf(data, error, tt) {
		const failure = error === null || error === void 0 ? null : typeof error === "string" ? {
			message: error,
			code: null,
			auth: null
		} : error;
		const auth = data?.auth ?? failure?.auth ?? null;
		const needsSetup = data === null && !FORM_EXCLUDED_CODES.has(failure?.code ?? null);
		const guidanceKey = failure === null ? null : GUIDANCE_BY_CODE[failure.code] ?? null;
		return {
			failure,
			auth,
			needsSetup,
			guidanceKey,
			guidance: guidanceKey === null ? null : guidanceKey === "panel.configError" ? format(tt(guidanceKey), { error: failure?.message }) : tt(guidanceKey),
			shapeWarnings: Array.isArray(data?.shapeWarnings) ? data.shapeWarnings : []
		};
	}
	var GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES, REFUSAL_TEXT;
	var init_snapshot = __esmMin((() => {
		init_format();
		GUIDANCE_BY_CODE = Object.freeze({
			auth_error: "panel.jwtExpired",
			jwt_expired: "panel.jwtExpired",
			not_configured: "panel.jwtMissing",
			config_error: "panel.configError",
			console_error: "panel.consoleTransient"
		});
		FORM_EXCLUDED_CODES = Object.freeze(/* @__PURE__ */ new Set(["config_error", "console_error"]));
		REFUSAL_TEXT = Object.freeze({
			login_rejected: "auth.badCredentials",
			account_locked: "auth.locked",
			rate_limited: "auth.rateLimited",
			verification_required: "auth.verification",
			login_failed: "auth.failed"
		});
	}));

//#endregion
//#region src/client/styles.ts
	var BRAND, BUTTON, S;
	var init_styles = __esmMin((() => {
		BRAND = "var(--sensenova-brand, #6C5CE7)";
		BUTTON = {
			height: 30,
			padding: "0 12px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			cursor: "pointer"
		};
		S = {
			page: {
				flex: "1 1 auto",
				height: "100%",
				minHeight: 0,
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
				color: "var(--dsw-alias-label-primary)",
				fontSize: 14,
				lineHeight: "22px"
			},
			scroll: {
				flex: 1,
				minHeight: 0,
				overflowY: "auto",
				overflowX: "hidden"
			},
			tabRow: {
				display: "flex",
				alignItems: "stretch",
				gap: 12,
				borderBottom: "1px solid var(--dsw-alias-border-l1)",
				marginBottom: 4
			},
			tabBar: {
				display: "flex",
				gap: 4
			},
			tab: {
				appearance: "none",
				background: "none",
				border: "none",
				borderBottom: "2px solid transparent",
				padding: "8px 12px",
				fontSize: 13,
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
				outline: "none",
				display: "flex",
				alignItems: "center"
			},
			tabActive: {
				color: "var(--dsw-alias-label-primary)",
				fontWeight: 600,
				borderBottom: `2px solid ${BRAND}`
			},
			updated: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12
			},
			spacer: { flex: 1 },
			cluster: {
				display: "inline-flex",
				alignItems: "center",
				gap: 12,
				flexWrap: "wrap",
				justifyContent: "flex-end",
				alignSelf: "center"
			},
			button: BUTTON,
			sectionTitle: {
				margin: "22px 0 10px",
				fontSize: 13,
				fontWeight: 600,
				color: "var(--dsw-alias-label-secondary)"
			},
			sectionCard: {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-1)",
				overflow: "hidden",
				marginTop: 22
			},
			sectionHead: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				width: "100%",
				padding: "12px 16px",
				background: "none",
				border: "none",
				cursor: "pointer",
				textAlign: "left"
			},
			sectionHeadTitle: {
				flex: 1,
				minWidth: 0,
				fontSize: 15,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			chevron: {
				display: "inline-flex",
				flex: "none",
				transition: "transform 0.15s ease",
				color: "var(--dsw-alias-label-secondary)"
			},
			chevronOpen: { transform: "rotate(180deg)" },
			sectionBody: {
				borderTop: "1px solid var(--dsw-alias-border-l1)",
				margin: "0 16px",
				padding: "12px 0 16px"
			},
			card: {
				background: "var(--dsw-alias-bg-layer-1)",
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				padding: 16
			},
			poolsGrid: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
				gap: 12,
				alignItems: "start"
			},
			cardHead: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flexWrap: "wrap"
			},
			poolName: {
				fontSize: 15,
				fontWeight: 600
			},
			chip: {
				display: "inline-flex",
				alignItems: "center",
				height: 22,
				padding: "0 8px",
				borderRadius: 999,
				fontSize: 12,
				border: "1px solid var(--dsw-alias-border-l1)",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)"
			},
			grantChip: {
				display: "inline-flex",
				alignItems: "center",
				fontSize: 13,
				color: "var(--dsw-alias-label-primary)",
				fontVariantNumeric: "tabular-nums"
			},
			quotas: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))",
				gap: 10,
				marginTop: 14
			},
			quota: {
				display: "flex",
				flexDirection: "column",
				gap: 8,
				minWidth: 0,
				padding: "12px 14px",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-2)"
			},
			quotaTop: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 8,
				flexWrap: "wrap"
			},
			quotaLabel: {
				fontSize: 12,
				fontWeight: 500,
				color: "var(--dsw-alias-label-secondary)"
			},
			statHeadline: {
				fontSize: 18,
				lineHeight: "22px",
				fontWeight: 650,
				letterSpacing: "-0.02em",
				fontVariantNumeric: "tabular-nums"
			},
			statCaption: {
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			statError: { color: "var(--dsw-alias-state-error-primary)" },
			statGrid: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 110px), 1fr))",
				gap: 10,
				marginTop: 12
			},
			statCard: {
				display: "flex",
				flexDirection: "column",
				gap: 4,
				minWidth: 0,
				padding: "10px 12px",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-2)"
			},
			statValue: {
				fontSize: 16,
				fontWeight: 600,
				lineHeight: "20px",
				fontVariantNumeric: "tabular-nums"
			},
			quotaReset: {
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)"
			},
			quotaRemaining: {
				fontSize: 18,
				lineHeight: "22px",
				fontWeight: 650,
				letterSpacing: "-0.02em",
				fontVariantNumeric: "tabular-nums"
			},
			quotaUsed: {
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			bar: {
				height: 6,
				borderRadius: 3,
				background: "var(--dsw-alias-bg-layer-1)",
				overflow: "hidden"
			},
			barFill: {
				height: "100%",
				borderRadius: 3,
				background: BRAND
			},
			barFillWarn: { background: "var(--dsw-alias-state-warn-primary)" },
			barFillError: { background: "var(--dsw-alias-state-error-primary)" },
			details: {
				marginTop: 12,
				paddingTop: 10,
				borderTop: "1px solid var(--dsw-alias-border-l1)"
			},
			detailsSummary: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
				userSelect: "none"
			},
			detailsBody: {
				display: "flex",
				flexDirection: "column",
				gap: 10,
				marginTop: 10
			},
			grant: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			models: {
				display: "flex",
				flexWrap: "wrap",
				gap: 6
			},
			modelTag: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 11,
				padding: "2px 6px",
				borderRadius: 6,
				background: "var(--dsw-alias-bg-layer-2)",
				border: "1px solid var(--dsw-alias-border-l1)"
			},
			trendHead: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: 12,
				paddingBottom: 6,
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			trendHeadLabel: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				fontWeight: 500
			},
			trendRow: {
				display: "flex",
				flexDirection: "column",
				gap: 8,
				padding: "10px 0",
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			trendRowHead: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: 12,
				minWidth: 0
			},
			trendModel: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			trendCredits: {
				fontSize: 13,
				fontWeight: 600,
				fontVariantNumeric: "tabular-nums"
			},
			trendBar: {
				height: 6,
				borderRadius: 3,
				background: "var(--dsw-alias-bg-layer-2)",
				overflow: "hidden"
			},
			trendLegend: {
				marginTop: 10,
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-secondary)"
			},
			muted: { color: "var(--dsw-alias-label-secondary)" },
			error: { color: "var(--dsw-alias-state-error-primary)" },
			empty: {
				color: "var(--dsw-alias-label-secondary)",
				padding: "18px 0"
			},
			field: {
				display: "flex",
				flexDirection: "column",
				gap: 6,
				marginBottom: 12
			},
			fieldLabel: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			input: {
				height: 32,
				padding: "0 10px",
				borderRadius: 8,
				fontSize: 13,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)"
			},
			/** Real shell tokens — replaces the color-mix hack that faked "on-primary". */
			primary: {
				height: 32,
				padding: "0 16px",
				borderRadius: 8,
				fontSize: 13,
				fontWeight: 500,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-button-primary-fill)",
				color: "var(--dsw-alias-label-primary-foreground)",
				cursor: "pointer"
			},
			primaryBusy: {
				opacity: .6,
				cursor: "default"
			},
			formError: {
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: 12,
				margin: "10px 0 0"
			},
			formNote: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12,
				margin: "10px 0 0"
			},
			rosterTools: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				flexWrap: "wrap",
				marginBottom: 10
			},
			rosterCount: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums",
				marginLeft: "auto"
			},
			rosterBulk: {
				...BUTTON,
				height: 32
			},
			modelList: {
				display: "flex",
				flexDirection: "column",
				margin: 0,
				padding: 0,
				listStyle: "none"
			},
			modelRow: {
				display: "flex",
				flexDirection: "column",
				gap: 2,
				padding: "8px 4px",
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			modelRowHead: {
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			modelRowLabel: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flex: "1 1 auto",
				minWidth: 0
			},
			modelRowOff: { opacity: .55 },
			externalLink: {
				color: "var(--dsw-alias-label-primary)",
				fontSize: 12,
				marginTop: 10,
				display: "inline-block",
				textDecoration: "underline",
				cursor: "pointer"
			},
			modelCheck: {
				flex: "none",
				width: 15,
				height: 15,
				cursor: "pointer",
				accentColor: BRAND,
				margin: 0
			},
			modelName: {
				flex: "0 1 auto",
				minWidth: 0,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			modelRate: {
				flex: "none",
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			modelBadge: {
				flex: "none",
				fontSize: 11,
				padding: "1px 7px",
				borderRadius: 999,
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)"
			},
			modelMeta: {
				paddingLeft: 25,
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)"
			},
			rosterFoot: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				marginTop: 10
			},
			modelPanel: {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-1)",
				padding: "12px 14px"
			},
			pillTrigger: {
				appearance: "none",
				display: "inline-flex",
				alignItems: "center",
				gap: 5,
				height: 28,
				padding: "0 6px",
				flexShrink: 0,
				background: "none",
				borderStyle: "none",
				color: "inherit",
				fontFamily: "inherit",
				fontSize: 12,
				lineHeight: "20px",
				whiteSpace: "nowrap",
				userSelect: "none",
				cursor: "pointer"
			},
			pillDot: {
				width: 7,
				height: 7,
				borderRadius: 999,
				flexShrink: 0
			},
			pillReading: { fontVariantNumeric: "tabular-nums" },
			pillPlan: {
				color: "var(--dsw-alias-label-secondary)",
				flexShrink: 0
			},
			pillStale: { color: "var(--dsw-alias-label-tertiary)" },
			pillNewTag: {
				color: "var(--dsw-alias-label-secondary)",
				flexShrink: 0
			},
			pillTierOk: "var(--dsw-alias-state-success-primary, #22c55e)",
			pillTierWarn: "var(--dsw-alias-state-warn-primary, #eab308)",
			pillTierExhausted: "var(--dsw-alias-state-error-primary, #ef4444)",
			pillTierUnknown: "var(--dsw-alias-label-tertiary, #9ca3af)",
			pillTierExhaustedText: { color: "var(--dsw-alias-state-error-primary)" },
			pillPopover: {
				position: "absolute",
				bottom: "100%",
				right: 0,
				zIndex: 100,
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-1)",
				boxShadow: "0 6px 24px rgba(0, 0, 0, 0.18)",
				width: "min(320px, calc(100vw - 32px))",
				padding: "10px 12px",
				marginBottom: 8,
				textAlign: "left",
				color: "var(--dsw-alias-label-primary)",
				fontSize: 12,
				lineHeight: "18px",
				fontFamily: "inherit",
				boxSizing: "border-box"
			},
			pillPopoverAnchor: {
				position: "relative",
				display: "inline-flex"
			},
			pillPopoverHead: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				flexWrap: "wrap",
				marginBottom: 8
			},
			pillPopoverTitle: {
				fontSize: 12,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			pillPopoverPool: { color: "var(--dsw-alias-label-secondary)" },
			pillPopoverStale: { color: "var(--dsw-alias-label-tertiary)" },
			pillPopoverRow: { padding: "6px 0" },
			pillPopoverRowLine: {
				display: "flex",
				alignItems: "baseline",
				gap: 8
			},
			pillPopoverLabel: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			pillPopoverFigure: {
				marginLeft: "auto",
				fontVariantNumeric: "tabular-nums",
				color: "var(--dsw-alias-label-primary)"
			},
			pillPopoverBar: {
				height: 4,
				borderRadius: 2,
				margin: "2px 0 4px",
				overflow: "hidden",
				background: "var(--dsw-alias-bg-layer-2)"
			},
			pillPopoverFill: {
				height: "100%",
				borderRadius: 2
			},
			pillPopoverFoot: {
				display: "flex",
				alignItems: "baseline",
				gap: 8,
				color: "var(--dsw-alias-label-tertiary)"
			},
			pillPopoverReset: {
				marginLeft: "auto",
				fontVariantNumeric: "tabular-nums"
			},
			pillPopoverParts: {
				borderTop: "1px solid var(--dsw-alias-border-l1)",
				marginTop: 6,
				paddingTop: 6
			},
			pillPopoverPartsLabel: {
				color: "var(--dsw-alias-label-tertiary)",
				marginBottom: 2
			},
			pillPopoverNote: {
				marginTop: 8,
				color: "var(--dsw-alias-label-tertiary)"
			}
		};
	}));

//#endregion
//#region src/client/account-form.ts
	function AccountForm({ auth, onDone, tt, bare, snapshotAt }) {
		const [username, setUsername] = useState("");
		const [password, setPassword] = useState("");
		const [showPassword, setShowPassword] = useState(false);
		const [busy, setBusy] = useState(false);
		const [formError, setFormError] = useState(null);
		const [formDetail, setFormDetail] = useState(null);
		const [saved, setSaved] = useState(false);
		const [forgotten, setForgotten] = useState(false);
		const outcomeAt = useRef(0);
		const [cooldownUntil, setCooldownUntil] = useState(0);
		const [now, setNow] = useState(() => Date.now());
		useEffect(() => {
			if (cooldownUntil <= Date.now()) return void 0;
			const timer = setInterval(() => {
				setNow(Date.now());
				if (Date.now() >= cooldownUntil) clearInterval(timer);
			}, 1e3);
			return () => clearInterval(timer);
		}, [cooldownUntil]);
		useEffect(() => {
			if (typeof snapshotAt === "number" && snapshotAt > outcomeAt.current) {
				setSaved(false);
				setForgotten(false);
			}
		}, [snapshotAt]);
		const cooling = now < cooldownUntil;
		const coolingMinutes = Math.max(1, Math.ceil((cooldownUntil - now) / 6e4));
		const setCooldown = useCallback((ms) => {
			setCooldownUntil(Date.now() + ms);
			setNow(Date.now());
		}, []);
		const submit = useCallback(async (event) => {
			event?.preventDefault?.();
			if (cooling) return;
			if (username.trim() === "" || password === "") {
				setFormError(tt("auth.empty"));
				return;
			}
			setBusy(true);
			setFormError(null);
			setFormDetail(null);
			try {
				const body = await postJson(ACCOUNT_PATH, {
					username: username.trim(),
					password
				});
				if (body && body.ok === true) {
					setPassword("");
					setSaved(true);
					setForgotten(false);
					outcomeAt.current = Date.now();
					onDone?.();
					return;
				}
				const code = body?.code;
				const waitMs = typeof body?.retryAfterMs === "number" ? body.retryAfterMs : null;
				if (waitMs !== null && waitMs > 0) {
					setCooldown(waitMs);
					setFormError(tt(REFUSAL_TEXT[typeof code === "string" ? code : ""] ?? "auth.rateLimited"));
					return;
				}
				if (typeof code === "string" && typeof REFUSAL_TEXT[code] === "string") {
					const refusalKey = REFUSAL_TEXT[code];
					setFormError(refusalKey.includes("{") ? format(tt(refusalKey), { reason: body?.error ?? "" }) : tt(refusalKey));
					setFormDetail(typeof body?.detail === "string" && body.detail !== "" ? body.detail : null);
					return;
				}
				setFormError(body?.error ?? tt("auth.network"));
			} catch {
				setFormError(tt("auth.network"));
			} finally {
				setBusy(false);
			}
		}, [
			username,
			password,
			onDone,
			tt,
			cooling,
			setCooldown
		]);
		const forget = useCallback(async () => {
			setBusy(true);
			setFormError(null);
			setFormDetail(null);
			try {
				const body = await postJson(ACCOUNT_PATH, { forget: true });
				if (body?.ok !== true) {
					setFormError(body?.error ?? tt("auth.network"));
					return;
				}
				setForgotten(true);
				setSaved(false);
				setUsername("");
				setPassword("");
				outcomeAt.current = Date.now();
				onDone?.();
			} catch {
				setFormError(tt("auth.network"));
			} finally {
				setBusy(false);
			}
		}, [onDone, tt]);
		return h("div", { style: bare ? {} : {
			...S.card,
			maxWidth: 420
		} }, bare ? null : h("div", { style: S.sectionTitle }, tt("auth.title")), h("a", {
			href: SENSENOVA_SIGNUP_URL,
			target: "_blank",
			rel: "noreferrer",
			style: S.externalLink
		}, tt(auth?.hasAccount ? "auth.portalHint" : "auth.registerHint")), h("form", { onSubmit: submit }, h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("auth.username")), h("input", {
			style: S.input,
			value: username,
			autoComplete: "username",
			placeholder: tt("auth.placeholderUser"),
			disabled: busy,
			onChange: (event) => setUsername(event.target.value)
		})), h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("auth.password")), h("div", { style: {
			display: "flex",
			gap: 6,
			alignItems: "center"
		} }, h("input", {
			style: {
				...S.input,
				flex: 1
			},
			type: showPassword ? "text" : "password",
			value: password,
			autoComplete: "current-password",
			disabled: busy,
			onChange: (event) => setPassword(event.target.value)
		}), h("button", {
			type: "button",
			style: {
				...S.button,
				flex: "none"
			},
			disabled: busy,
			onClick: () => setShowPassword((shown) => !shown)
		}, showPassword ? tt("auth.hide") : tt("auth.show")))), h("div", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			marginTop: 4
		} }, h("button", {
			type: "submit",
			style: {
				...S.primary,
				...busy || cooling ? S.primaryBusy : {}
			},
			disabled: busy || cooling
		}, busy ? tt("auth.submitting") : tt("auth.submit")), auth?.hasAccount ? h("button", {
			type: "button",
			style: S.button,
			disabled: busy,
			onClick: forget
		}, tt("auth.forget")) : null), forgotten ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("auth.forgotten")) : saved ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("auth.working")) : null, formError ? h("p", {
			style: S.formError,
			role: "alert"
		}, formError) : null, formError && formDetail ? h("p", { style: S.formNote }, formDetail) : null, cooling ? h("p", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, format(tt("auth.retryAfter"), { minutes: coolingMinutes })) : null, h("p", { style: S.formNote }, auth?.ephemeral === true ? tt("auth.ephemeral") : auth?.autoRecoverArmed === true ? tt("auth.autoRecoverOn") : tt("auth.saved"))));
	}
	var init_account_form = __esmMin((() => {
		init_const();
		init_format();
		init_http();
		init_runtime();
		init_snapshot();
		init_styles();
	}));

//#endregion
//#region src/client/toggle-switch.ts
/**
	* A sliding toggle with a short label and a tooltip.
	* @param props - see {@link ToggleSwitchProps}.
	* @returns the `<label>` tree wrapping the real checkbox input.
	*/
	function ToggleSwitch({ checked, onChange, label, busyLabel, busy = false, title }) {
		const on = checked === true;
		const text = busy && busyLabel !== void 0 ? busyLabel : label;
		return h("label", {
			style: {
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				position: "relative",
				cursor: busy ? "wait" : "pointer",
				opacity: busy ? .55 : 1,
				verticalAlign: "middle"
			},
			...title !== void 0 && title !== "" ? { title } : {}
		}, h("span", { style: {
			position: "relative",
			display: "inline-block",
			width: TRACK_W,
			height: TRACK_H,
			flex: "none"
		} }, h("input", {
			type: "checkbox",
			checked: on,
			disabled: busy,
			onChange: () => onChange(),
			style: {
				position: "absolute",
				inset: 0,
				width: TRACK_W,
				height: TRACK_H,
				margin: 0,
				opacity: 0,
				cursor: busy ? "wait" : "pointer"
			}
		}), h("span", {
			"aria-hidden": "true",
			style: {
				position: "absolute",
				inset: 0,
				borderRadius: 999,
				pointerEvents: "none",
				border: `1px solid ${on ? "var(--sensenova-brand, #6C5CE7)" : "var(--dsw-alias-border-l2, #36373b)"}`,
				background: on ? "var(--sensenova-brand, #6C5CE7)" : "var(--dsw-alias-bg-layer-2, #2a2b31)",
				transition: "background .15s, border-color .15s"
			}
		}, h("span", { style: {
			position: "absolute",
			top: 1.5,
			left: 1.5,
			width: THUMB,
			height: THUMB,
			borderRadius: "50%",
			background: on ? "#fff" : "var(--dsw-alias-label-tertiary, #999)",
			transform: on ? `translateX(${TRAVEL}px)` : "translateX(0)",
			transition: "transform .15s, background .15s"
		} }))), h("span", { style: {
			fontSize: 13,
			color: "var(--dsw-alias-label-primary, #e6e6e6)"
		} }, text));
	}
	var TRACK_W, TRACK_H, THUMB, TRAVEL;
	var init_toggle_switch = __esmMin((() => {
		init_runtime();
		TRACK_W = 30;
		TRACK_H = 17;
		THUMB = 12;
		TRAVEL = 13;
	}));

//#endregion
//#region src/client/provider-controls.ts
/**
	* The API-key card's status: ONLY a missing-key nudge (+ the ephemeral-host
	* warning). A stored key is silent — the form's own 显示 button and the save
	* note say it (2026-10-27; the provenance line was noise). Registration
	* state lives in `ProviderRegStatus` on the provider card — after the panel
	* split into one card per concern, a line about registration inside the key
	* card was information flying across card boundaries, repeating what the
	* provider card's own switch and status already say.
	*
	* Hook-free on purpose: like the pool cards, it is exercised by the Node
	* render suite, so a reworded or dropped status line fails a check. It
	* renders ONLY from the snapshot's `llm` block, which never carries the
	* key itself — booleans only.
	*/
	function ProviderStatus({ llm, tt }) {
		if (!llm || typeof llm !== "object") return null;
		const rows = [];
		if (llm.hasApiKey !== true) rows.push(h("div", {
			style: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			role: "status"
		}, tt("llm.noKey")));
		if (llm.ephemeral === true) rows.push(h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("llm.ephemeral")));
		return rows.length === 0 ? null : h("div", { style: {
			display: "flex",
			flexDirection: "column",
			gap: 6,
			marginBottom: 12
		} }, ...rows);
	}
	/**
	* The provider card's registration status, hook-free like `ProviderStatus`
	* so the render suite pins every branch. The card title and the switch
	* below say "registration" already, so this is pure state. The happy path
	* (registered) is SILENT since 2026-10-27 — the counts said nothing the
	* 接入 API tab's own model list didn't, and a status that only speaks when
	* something is wrong keeps the panel scannable. The id shows only in the
	* pending/off lines.
	*/
	function ProviderRegStatus({ llm, tt }) {
		if (!llm || typeof llm !== "object") return null;
		if (llm.registerProvider === true && llm.providerRegistered === true) return null;
		if (llm.registerProvider === true && typeof llm.providerError === "string" && llm.providerError !== "") return h("div", {
			style: S.formError,
			role: "alert"
		}, format(tt("llm.error"), { error: llm.providerError }));
		if (llm.registerProvider === true && llm.llmAvailable !== true) return h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("llm.noService"));
		if (llm.registerProvider === true) return h("div", {
			style: {
				...S.muted,
				fontSize: 12
			},
			role: "status"
		}, format(tt("llm.registeredPending"), { id: String(llm.providerId ?? "") }));
		return h("div", { style: {
			...S.muted,
			fontSize: 12
		} }, format(tt("llm.off"), { id: String(llm.providerId ?? "") }));
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
	function ProviderSwitch({ llm, onDone, tt }) {
		const [busy, setBusy] = useState(false);
		const [switchError, setSwitchError] = useState(null);
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
		}, [
			enabled,
			onDone,
			tt
		]);
		return h("div", { style: {
			display: "flex",
			gap: 10,
			alignItems: "center",
			margin: "0 0 12px",
			flexWrap: "wrap"
		} }, h(ToggleSwitch, {
			checked: enabled,
			onChange: toggle,
			busy,
			label: tt("llm.switch"),
			busyLabel: tt("llm.switchBusy"),
			title: tt("llm.switchTitle")
		}), switchError ? h("span", {
			style: S.formError,
			role: "alert"
		}, switchError) : null);
	}
	var init_provider_controls = __esmMin((() => {
		init_const();
		init_format();
		init_http();
		init_runtime();
		init_styles();
		init_toggle_switch();
	}));

//#endregion
//#region src/client/model-row.ts
/**
	* One row of a model roster.
	* @param {object} props - the row's content, already decided by the caller.
	* @param {string} props.id - the model id; also the name's hover title.
	* @param {string} props.label - the name on screen (falls back to the id).
	* @param {boolean} props.on - whether the model is pushed; off dims the row.
	* @param {boolean} [props.busy] - disables the checkbox while a save or the
	*   login walk is in flight, and drops the pointer cursor to match.
	* @param {string|null} [props.rateText] - the rate chip's text (`×0.75`, or a
	*   provider-specific "free"); `null`/absent draws no chip.
	* @param {string} [props.rateTitle] - the chip's tooltip. It is the caller's
	*   because the two rates are NOT the same fact (see the module note).
	* @param {unknown[]} [props.badges] - badge nodes for the head line's right
	*   edge; the caller decides which states are worth quoting.
	* @param {string|null} [props.meta] - the parameter line's text; empty/absent
	*   draws no line rather than an empty one.
	* @param {(id: string) => void} [props.onToggle] - absent (render suite), the
	*   checkbox is display-only.
	* @param {unknown} [props.children] - optional content below the parameter
	*   line; the row itself stays a bare two-line block unless a caller has
	*   something extra to say (the thinking dropdown panel).
	* @returns {unknown} the `<li>` for this row.
	*/
	function ModelRow({ id, label, on, busy, rateText, rateTitle, badges, meta, onToggle, children }) {
		const badgeList = Array.isArray(badges) ? badges.filter((badge) => badge !== null && badge !== void 0) : [];
		return h("li", { style: {
			...S.modelRow,
			...on ? {} : S.modelRowOff
		} }, h("div", { style: S.modelRowHead }, h("label", { style: busy ? {
			...S.modelRowLabel,
			cursor: "default"
		} : {
			...S.modelRowLabel,
			cursor: "pointer"
		} }, h("input", {
			type: "checkbox",
			checked: on,
			disabled: busy === true,
			style: S.modelCheck,
			"aria-label": label,
			onChange: onToggle ? () => onToggle(id) : void 0
		}), h("span", {
			style: S.modelName,
			title: id
		}, label), rateText === null || rateText === void 0 ? null : h("span", {
			style: S.modelRate,
			title: rateTitle
		}, rateText)), ...badgeList), meta === null || meta === void 0 || meta === "" ? null : h("div", { style: S.modelMeta }, meta), children);
	}
	var init_model_row = __esmMin((() => {
		init_runtime();
		init_styles();
	}));

//#endregion
//#region src/client/models.ts
/** The model ids a roster advertises, junk entries dropped. Internal. */
	function rosterIds(roster) {
		return (Array.isArray(roster) ? roster : []).filter((model) => typeof model === "string" && model !== "");
	}
	/**
	* Whether one model id is offered by an allow-list.
	*
	* Mirrors the Host's `filterByEnabled`: an empty list offers everything,
	* a non-empty one is a strict allow-list, and `HIDE_ALL_MODELS` alone
	* offers nothing.
	*/
	function modelIsOn(enabledIds, id) {
		const list = Array.isArray(enabledIds) ? enabledIds : [];
		return list.length === 0 ? true : list.includes(id);
	}
	/**
	* The allow-list that offers exactly the ids in `on`.
	*
	* Every mutation funnels through here, so the two extreme spellings are
	* emitted consistently: an empty list (nothing curated, every model
	* offered) and `HIDE_ALL_MODELS` alone (nothing offered). No caller can
	* post a list the Host would read differently than the picker shows.
	*/
	function allowListFor(on, roster) {
		const all = rosterIds(roster);
		const kept = all.filter((model) => on.has(model));
		if (kept.length === 0) return [HIDE_ALL_MODELS];
		if (kept.length === all.length) return [];
		return kept;
	}
	/**
	* The next allow-list after ticking or unticking one model.
	*
	* The result is computed against the WHOLE roster, not the current
	* list: the saved value is a complete allow-list rather than a diff, so
	* a curated catalogue stays curated when the catalogue later grows —
	* new models start unticked instead of slipping into DSH on their own.
	*/
	function toggleModelIn(enabledIds, roster, id) {
		const on = new Set(rosterIds(roster).filter((model) => modelIsOn(enabledIds, model)));
		if (on.has(id)) on.delete(id);
		else on.add(id);
		return allowListFor(on, roster);
	}
	/** The allow-list for a bulk "tick all" / "untick all". */
	function setAllModelsIn(roster, allOn) {
		return allowListFor(new Set(allOn ? rosterIds(roster) : []), roster);
	}
	/**
	* The next allow-list after a bulk "tick all" / "untick all" over one set
	* of targets, computed against the WHOLE roster.
	*
	* The targets are the ids the reader is looking at right now (a filtered
	* view); the rows outside them keep whatever the Host already offers, so
	* the result stays a complete allow-list rather than a diff. Both id lists
	* must be STRINGS — `rosterIds` drops anything that is not one, so a roster
	* of `{id}` rows would filter to nothing and the whole call would collapse
	* to the hide-all sentinel no matter which way the button was pressed.
	*/
	function bulkModelsIn(enabledIds, roster, targets, allOn) {
		const on = new Set(rosterIds(roster).filter((model) => modelIsOn(enabledIds, model)));
		for (const id of targets) if (allOn) on.add(id);
		else on.delete(id);
		return allowListFor(on, roster);
	}
	var HIDE_ALL_MODELS;
	var init_models = __esmMin((() => {
		HIDE_ALL_MODELS = "__hide_all__";
	}));

//#endregion
//#region src/client/model-picker.ts
/**
	* The model picker's row list - hook-free, so the Node render suite
	* drives the very rows the browser draws.
	*
	* This component owns only what is SPECIFIC to the Token Plan catalogue; the
	* two-line row itself is drawn by {@link ModelRow}.
	* roster (see that module for why the skeleton has one definition). What is
	* specific here: the allow-list decides `on` (`modelIsOn` — an id absent from
	* the list is OFF), the pseudo rate is always rendered `×N` because the Host
	* matched it through the operator's own config, and the parameter line quotes
	* window, output ceiling, and the thinking levels DSH's selector will really
	* offer for THIS model.
	*
	* A provider-wide constant (the default effort) never repeats per row - it is
	* stated once in the header, because a fact that never varies between rows is
	* noise, not information. The rows come only from the Host's roster, so a
	* curated id that no longer exists can never become a checkbox: curation is a
	* filter over the catalogue, never a catalogue of its own. A default ("text
	* only") earns no badge, and a figure the catalogue does not declare draws no
	* segment - the list quotes facts, never guesses.
	*/
	function ModelRoster({ models, enabledIds, busy, tt, onToggle, modelProtocols, onProtocolChange, visionIds, onVisionToggle, thinkingById, onThinkingToggle, openThinkingId, onThinkingOpen }) {
		const list = Array.isArray(models) ? models : [];
		const visionSet = Array.isArray(visionIds) ? new Set(visionIds) : null;
		const THINKING_CHOICES = [
			"off",
			"low",
			"medium",
			"high",
			"max"
		];
		return h("ul", {
			style: S.modelList,
			role: "list"
		}, list.map((model) => {
			const id = String(model?.id ?? "");
			const label = String(model?.name ?? id);
			const on = modelIsOn(enabledIds, id);
			const meta = [typeof model?.contextWindow === "number" && model.contextWindow > 0 ? format(tt("llm.contextBadge"), { ctx: tokenSize(model.contextWindow) }) : null, typeof model?.maxOutputLength === "number" && model.maxOutputLength > 0 ? format(tt("llm.metaOutput"), { out: tokenSize(model.maxOutputLength) }) : null].filter(Boolean).join(" · ");
			const rate = typeof model?.multiplier === "number" ? model.multiplier : null;
			const visionOn = visionSet !== null && visionSet.has(id);
			return h(ModelRow, {
				key: id,
				id,
				label,
				on,
				busy,
				rateText: rate === null ? null : `×${rate}`,
				rateTitle: tt("llm.rosterRateTitle"),
				badges: [model?.quotaExhausted === true ? h("span", {
					key: "exhausted",
					style: {
						...S.modelBadge,
						color: "var(--dsw-alias-state-error-primary)"
					}
				}, tt("llm.rosterExhausted")) : null, onThinkingOpen !== void 0 && onThinkingToggle !== void 0 ? h("button", {
					key: "thinking",
					type: "button",
					style: {
						...S.modelBadge,
						cursor: busy ? "default" : "pointer",
						border: "none",
						fontFamily: "inherit",
						marginLeft: 8
					},
					disabled: busy === true,
					"aria-expanded": openThinkingId === id,
					title: tt("llm.rosterThinking"),
					onClick: () => onThinkingOpen(openThinkingId === id ? null : id)
				}, tt("llm.rosterThinking"), openThinkingId === id ? " ▾" : " ▸") : null],
				meta,
				onToggle,
				children: openThinkingId === id ? h("div", {
					key: "thinking-panel",
					style: {
						marginTop: 8,
						padding: "8px 10px",
						borderRadius: 8,
						border: "1px solid var(--dsw-alias-border-l2)",
						background: "var(--dsw-alias-bg-layer-2)",
						display: "flex",
						flexDirection: "column",
						gap: 6
					}
				}, h("div", { style: {
					fontSize: 11,
					fontWeight: 600,
					color: "var(--dsw-alias-label-secondary)"
				} }, tt("llm.rosterThinking")), h("div", { style: {
					display: "flex",
					flexWrap: "wrap",
					gap: "2px 10px",
					alignItems: "center",
					justifyContent: "space-between"
				} }, h("span", { style: {
					display: "flex",
					flexWrap: "wrap",
					gap: "2px 10px",
					alignItems: "center"
				} }, h("span", { style: {
					fontSize: 12,
					color: "var(--dsw-alias-label-secondary)"
				} }, tt("llm.rosterThinkingLevels") + "："), ...THINKING_CHOICES.map((level) => {
					const picking = Array.isArray(thinkingById?.[id]) && thinkingById[id].includes(level);
					return h("label", {
						key: level,
						style: {
							display: "inline-flex",
							gap: 4,
							alignItems: "center",
							cursor: busy ? "default" : "pointer",
							fontSize: 12
						}
					}, h("input", {
						type: "checkbox",
						checked: picking,
						disabled: busy === true,
						style: S.modelCheck,
						"aria-label": `${label} 档位 ${level}`,
						onChange: () => {
							if (onThinkingToggle) onThinkingToggle(id, level, !picking);
						}
					}), tt(dictKey("llm.level", level)));
				})), visionSet !== null ? h("label", { style: {
					display: "inline-flex",
					gap: 4,
					alignItems: "center",
					cursor: busy ? "default" : "pointer",
					fontSize: 12,
					marginLeft: "auto"
				} }, h("input", {
					type: "checkbox",
					checked: visionOn,
					disabled: busy === true,
					style: S.modelCheck,
					"aria-label": `${label} 识图`,
					onChange: onVisionToggle ? () => onVisionToggle(id, !visionOn) : void 0
				}), tt("llm.rosterVision")) : null), h("div", { style: {
					borderTop: "1px solid var(--dsw-alias-border-l1)",
					margin: "2px 0"
				} }), onProtocolChange !== void 0 ? h("label", { style: {
					display: "flex",
					gap: 8,
					alignItems: "center",
					fontSize: 12,
					cursor: busy ? "default" : "pointer"
				} }, h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, tt("llm.protocol")), h("select", {
					style: {
						...S.input,
						width: "auto",
						height: 26,
						fontSize: 12,
						padding: "0 6px"
					},
					value: String(modelProtocols?.[id] ?? "auto"),
					disabled: busy === true,
					"aria-label": `${label} 协议`,
					onChange: (event) => onProtocolChange(id, event.target.value)
				}, PROTOCOLS.map((option) => h("option", {
					key: option,
					value: option
				}, option === "auto" ? tt("llm.protocolAuto") : option)))) : null) : null
			});
		}));
	}
	/**
	* The curated model allow-list: which of this key's models get pushed to
	* DSH's model list.
	*
	* Hook-based like `ApiKeyForm`, so the render suite exercises the secret-
	* free half it draws - `ModelRoster` and the counts - instead of this
	* state machine. The edit is local until saved: the picker holds a draft
	* of the allow-list, the "unsaved" state is DERIVED by comparing it with
	* the Host's current value, and the "saved" state is the same comparison
	* after a poll echoes the write. Both therefore cannot lie: a save that
	* never reached the Host keeps showing the edits, and an edit that ends
	* up identical to the Host's value shows neither button.
	*/
	function ModelPicker({ llm, pool, onDone, tt }) {
		const hostProtocols = llm?.modelProtocols ?? {};
		const models = Array.isArray(llm?.models) ? llm.models : NO_MODELS;
		const hostIds = Array.isArray(llm?.enabledModelIds) ? llm.enabledModelIds : NO_IDS;
		const visionHost = Array.isArray(pool?.settings?.vision?.visionModels) ? pool.settings.vision.visionModels : [];
		const [ids, setIds] = useState(() => hostIds.slice());
		const thinkingHost = typeof pool?.settings?.thinking === "object" && pool.settings.thinking !== null ? pool.settings.thinking : {};
		const [busy, setBusy] = useState(false);
		const [query, setQuery] = useState("");
		const [justSaved, setJustSaved] = useState(false);
		const [notice, setNotice] = useState(null);
		const [openThinkingId, setOpenThinkingId] = useState(null);
		const [draftProtocols, setDraftProtocols] = useState({});
		const [draftThinking, setDraftThinking] = useState({});
		const [draftVision, setDraftVision] = useState({});
		const touchedRef = useRef(false);
		const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
		const dirty = useMemo(() => JSON.stringify(ids), [ids]) !== hostKey;
		const effectiveProtocols = {
			...hostProtocols,
			...draftProtocols
		};
		const effectiveThinking = {
			...thinkingHost,
			...draftThinking
		};
		const effectiveVision = (() => {
			const out = new Set(visionHost);
			for (const [id, on] of Object.entries(draftVision)) if (on) out.add(id);
			else out.delete(id);
			return [...out];
		})();
		const protocolsDirty = JSON.stringify(effectiveProtocols) !== JSON.stringify(hostProtocols);
		const thinkingDirty = JSON.stringify(effectiveThinking) !== JSON.stringify(thinkingHost);
		const visionDirty = JSON.stringify(effectiveVision.sort()) !== JSON.stringify([...visionHost].sort());
		const anyDirty = dirty || protocolsDirty || thinkingDirty || visionDirty;
		useEffect(() => {
			if (!touchedRef.current) setIds(hostIds);
		}, [hostKey]);
		useEffect(() => {
			if (dirty === true) setJustSaved(false);
		}, [dirty]);
		const save = useCallback(async () => {
			if (busy) return;
			setBusy(true);
			setNotice(null);
			try {
				const visionNext = [.../* @__PURE__ */ new Set([...visionHost.filter((id) => !(id in draftVision)), ...Object.keys(draftVision).filter((id) => draftVision[id] === true)])];
				const thinkingNext = Object.fromEntries(Object.entries({
					...thinkingHost,
					...draftThinking
				}).filter(([, levels]) => Array.isArray(levels) && levels.length > 0));
				const protocolsNext = {
					...hostProtocols,
					...draftProtocols
				};
				const posts = [];
				if (dirty) posts.push(postJsonOrThrow(MODELS_PATH, { enabledModelIds: ids }).then(() => {
					touchedRef.current = false;
				}));
				if (visionDirty) posts.push(postJsonOrThrow(POOL_PATH, {
					section: "vision",
					values: { visionModels: visionNext }
				}).then(() => {
					setDraftVision({});
				}));
				if (thinkingDirty) posts.push(postJsonOrThrow(POOL_PATH, {
					section: "thinking",
					values: thinkingNext
				}).then(() => {
					setDraftThinking({});
				}));
				if (protocolsDirty) posts.push(postJsonOrThrow(MODELS_PATH, { modelProtocols: protocolsNext }).then(() => {
					setDraftProtocols({});
				}));
				await Promise.all(posts);
				setJustSaved(true);
				onDone?.();
			} catch (error) {
				setNotice(format(tt("llm.rosterError"), { error: errorText(error) }));
			} finally {
				setBusy(false);
			}
		}, [
			busy,
			ids,
			dirty,
			visionDirty,
			thinkingDirty,
			protocolsDirty,
			visionHost,
			hostProtocols,
			draftVision,
			draftThinking,
			thinkingHost,
			onDone,
			tt
		]);
		const needle = query.trim().toLowerCase();
		const visible = useMemo(() => models.filter((model) => {
			if (needle === "") return true;
			return String(model?.id ?? "").toLowerCase().includes(needle) || String(model?.name ?? "").toLowerCase().includes(needle);
		}), [needle, models]);
		const tickedCount = visible.filter((model) => modelIsOn(ids, String(model?.id ?? ""))).length;
		/** Apply "tick all" / "untick all" to the VISIBLE rows only. */
		const bulk = useCallback((allOn) => {
			const roster = models.map((model) => String(model?.id ?? ""));
			const targets = visible.map((model) => String(model?.id ?? ""));
			touchedRef.current = true;
			setIds(bulkModelsIn(ids, roster, targets, allOn));
			setNotice(null);
		}, [
			models,
			visible,
			ids
		]);
		return h("div", { style: { marginBottom: 14 } }, h("p", { style: { margin: "0 0 10px" } }, h("span", { style: S.sectionTitle }, tt("llm.roster")), typeof llm?.thinkingDefault === "string" && llm.thinkingDefault !== "" ? h("span", { style: {
			...S.muted,
			fontSize: 12
		} }, ` — ${format(tt("llm.rosterThinkingDefault"), { level: tt(dictKey("llm.level", llm.thinkingDefault)) })}`) : null), models.length === 0 ? h("p", { style: S.empty }, tt("llm.rosterEmpty")) : h("div", null, h("div", { style: S.rosterTools }, h("input", {
			type: "search",
			style: {
				...S.input,
				flex: "1 1 200px",
				width: "auto"
			},
			value: query,
			placeholder: tt("llm.rosterSearchPlaceholder"),
			"aria-label": tt("llm.rosterSearchPlaceholder"),
			disabled: busy,
			onChange: (event) => setQuery(event.target.value)
		}), h("span", {
			style: S.rosterCount,
			title: format(tt("llm.rosterCount"), {
				selected: tickedCount,
				total: visible.length
			})
		}, format(tt("llm.rosterCount"), {
			selected: tickedCount,
			total: visible.length
		})), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busy === true || visible.length === 0,
			onClick: () => bulk(true)
		}, tt("llm.rosterAll")), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busy === true || visible.length === 0,
			onClick: () => bulk(false)
		}, tt("llm.rosterNone"))), visible.length === 0 ? h("p", { style: S.empty }, tt("llm.rosterNoMatch")) : h("div", { style: S.modelPanel }, h(ModelRoster, {
			models: visible,
			enabledIds: ids,
			busy,
			tt,
			openThinkingId,
			onThinkingOpen: (id) => setOpenThinkingId(id),
			modelProtocols: {
				...hostProtocols,
				...draftProtocols
			},
			onProtocolChange: (id, protocol) => {
				setDraftProtocols((current) => ({
					...current,
					[id]: protocol
				}));
				setNotice(null);
			},
			onToggle: (id) => {
				touchedRef.current = true;
				setIds(toggleModelIn(ids, models.map((model) => String(model?.id ?? "")), id));
				setNotice(null);
			},
			visionIds: (() => {
				const out = new Set(visionHost);
				for (const [id, on] of Object.entries(draftVision)) if (on) out.add(id);
				else out.delete(id);
				return [...out];
			})(),
			onVisionToggle: (id, on) => {
				setDraftVision((current) => ({
					...current,
					[id]: on
				}));
				setNotice(null);
			},
			thinkingById: (() => {
				const out = { ...thinkingHost };
				for (const [id, levels] of Object.entries(draftThinking)) out[id] = levels;
				return out;
			})(),
			onThinkingToggle: (id, level, onValue) => {
				setDraftThinking((current) => {
					const list = (current[id] ?? thinkingHost[id] ?? []).slice();
					const next = onValue ? list.includes(level) ? list : [...list, level] : list.filter((l) => l !== level);
					return {
						...current,
						[id]: next
					};
				});
				setNotice(null);
			}
		})), anyDirty ? h("div", { style: S.rosterFoot }, h("button", {
			type: "button",
			style: S.primary,
			disabled: busy === true,
			onClick: () => void save()
		}, busy ? tt("llm.rosterSaving") : tt("llm.rosterSave")), h("button", {
			type: "button",
			style: S.button,
			disabled: busy === true,
			onClick: () => {
				touchedRef.current = false;
				setIds(hostIds);
				setDraftProtocols({});
				setDraftThinking({});
				setDraftVision({});
				setNotice(null);
			}
		}, tt("llm.rosterDiscard")), h("span", { style: {
			...S.muted,
			fontSize: 12
		} }, tt("llm.rosterUnsaved"))) : justSaved ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("llm.rosterSaved")) : null, h("p", { style: {
			...S.trendLegend,
			marginTop: 10
		} }, tt("llm.rosterHint")), notice !== null ? h("p", {
			style: S.formError,
			role: "alert"
		}, notice) : null));
	}
	var PROTOCOLS, NO_MODELS, NO_IDS;
	var init_model_picker = __esmMin((() => {
		init_const();
		init_format();
		init_http();
		init_model_row();
		init_models();
		init_runtime();
		init_styles();
		PROTOCOLS = [
			"auto",
			"anthropic",
			"responses",
			"chat-completions"
		];
		NO_MODELS = [];
		NO_IDS = [];
	}));

//#endregion
//#region src/client/api-key-form.ts
	function ApiKeyForm({ llm, pool, onDone, tt }) {
		const [apiKey, setApiKey] = useState("");
		const [showKey, setShowKey] = useState(false);
		const [busy, setBusy] = useState(false);
		const [formError, setFormError] = useState(null);
		const [saved, setSaved] = useState(false);
		const [forgotten, setForgotten] = useState(false);
		const post = useCallback((payload) => postJson(POOL_PATH, payload), []);
		const submit = useCallback(async (event) => {
			event?.preventDefault?.();
			if (apiKey.trim() === "") {
				setFormError(tt("llm.empty"));
				return;
			}
			setBusy(true);
			setFormError(null);
			try {
				const body = await post({
					action: "add",
					apiKey: apiKey.trim()
				});
				if (body && body.ok === true) {
					setApiKey("");
					setSaved(true);
					setForgotten(false);
					onDone?.();
					return;
				}
				setFormError(body?.error ?? tt("auth.network"));
			} catch (caught) {
				setFormError(caught instanceof Error && caught.message !== "" ? caught.message : tt("auth.network"));
			} finally {
				setBusy(false);
			}
		}, [
			apiKey,
			post,
			onDone,
			tt
		]);
		const forget = useCallback(async () => {
			setBusy(true);
			setFormError(null);
			try {
				const body = await post({ forget: true });
				if (body?.ok !== true) {
					setFormError(body?.error ?? tt("auth.network"));
					return;
				}
				setForgotten(true);
				setSaved(false);
				setApiKey("");
				onDone?.();
			} catch (caught) {
				setFormError(caught instanceof Error && caught.message !== "" ? caught.message : tt("auth.network"));
			} finally {
				setBusy(false);
			}
		}, [
			post,
			onDone,
			tt
		]);
		const canForget = llm?.hasApiKey === true && llm?.keySource === "credentials";
		const keyEditor = h("div", null, h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("llm.keyField")), h("div", { style: {
			display: "flex",
			gap: 6,
			alignItems: "center"
		} }, h("input", {
			style: {
				...S.input,
				flex: 1
			},
			type: showKey ? "text" : "password",
			value: apiKey,
			autoComplete: "off",
			placeholder: tt("llm.placeholder"),
			disabled: busy,
			onChange: (event) => setApiKey(event.target.value)
		}), h("button", {
			type: "button",
			style: {
				...S.button,
				flex: "none"
			},
			disabled: busy,
			onClick: () => setShowKey((shown) => !shown)
		}, showKey ? tt("auth.hide") : tt("auth.show")))), h("div", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			marginTop: 4
		} }, h("button", {
			type: "submit",
			style: {
				...S.primary,
				...busy ? S.primaryBusy : {}
			},
			disabled: busy
		}, busy ? tt("llm.saving") : tt("llm.save")), canForget ? h("button", {
			type: "button",
			style: S.button,
			disabled: busy,
			onClick: forget
		}, tt("llm.forget")) : null), forgotten ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("llm.forgotten")) : saved ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("llm.saved")) : null, formError ? h("p", {
			style: S.formError,
			role: "alert"
		}, formError) : null, h("p", { style: S.formNote }, tt("llm.footnote")), llm?.hasApiKey === true ? null : h("a", {
			href: SENSENOVA_SIGNUP_URL,
			target: "_blank",
			rel: "noreferrer",
			style: S.externalLink
		}, tt("llm.keyRegisterHint")));
		return h("form", { onSubmit: submit }, keyEditor, h(ProviderStatus, {
			llm,
			tt
		}), h(PoolManager, {
			pool: pool ?? null,
			onDone,
			tt
		}));
	}
	/**
	* The provider-registration half — the live switch plus its "which models
	* get pushed" roster — as ONE card body. Split from `ApiKeyForm` when the
	* panel grew one SectionCard per concern: key, provider+push are
	* three different functions and no longer share a card.
	*/
	function ProviderForm({ llm, pool, onDone, tt }) {
		return h("div", null, h(ProviderSwitch, {
			llm,
			onDone,
			tt
		}), h(ModelPicker, {
			llm,
			pool,
			onDone,
			tt
		}), h(ProviderRegStatus, {
			llm,
			tt
		}));
	}
	/**
	* Key 池管理面（并入 API Key 卡）：账号列表（停用/恢复/删除）+ 全局并发数。
	*
	* key 本身不出池——面板按账号 id 操作，动作 POST 到 `/pool`，成功后 onDone()
	* 触发快照轮询刷新。并发数本地草稿 + 显式保存（与允许清单同一交互纪律）。
	*/
	function PoolManager({ pool, onDone, tt }) {
		const [busyId, setBusyId] = useState(null);
		const [error, setError] = useState(null);
		const savedConcurrency = pool?.globalConcurrency ?? 2;
		const [concurrency, setConcurrency] = useState(null);
		const concurrencyValue = concurrency ?? savedConcurrency;
		const concurrencyDirty = concurrency !== null && concurrency !== savedConcurrency;
		const act = useCallback(async (payload, busyTag) => {
			setBusyId(busyTag);
			setError(null);
			try {
				const body = await postJson(POOL_PATH, payload);
				if (body === null) {
					setError(tt("auth.network"));
					return false;
				}
				if (body.ok !== true) {
					setError(typeof body.error === "string" ? body.error : tt("auth.network"));
					return false;
				}
				onDone?.();
				return true;
			} catch (caught) {
				const message = caught instanceof Error ? caught.message : "";
				setError(/non-JSON HTTP 4\d\d/.test(message) ? tt("poolMng.routeMissing") : message || tt("auth.network"));
				return false;
			} finally {
				setBusyId(null);
			}
		}, [onDone, tt]);
		/** 行内改备注：编辑中的 id + 草稿（注释 = 备注字段，可为空）。 */
		const [editingId, setEditingId] = useState(null);
		const [noteDraft, setNoteDraft] = useState("");
		const setNote = useCallback(async (id, name) => {
			if (await act({
				action: "rename",
				id,
				name
			}, id)) {
				setEditingId(null);
				setNoteDraft("");
			}
		}, [act]);
		const saveConcurrency = useCallback(async () => {
			setError(null);
			try {
				const body = await postJsonOrThrow(POOL_PATH, { globalConcurrency: concurrencyValue });
				if (body?.ok !== true) {
					setError(body?.error ?? tt("auth.network"));
					return;
				}
				setConcurrency(null);
				onDone?.();
			} catch {
				setError(tt("auth.network"));
			}
		}, [
			concurrencyValue,
			onDone,
			tt
		]);
		const keys = Array.isArray(pool?.keys) ? pool.keys : [];
		const phaseLabel = {
			running: tt("poolMng.phaseRunning"),
			blocked: tt("poolMng.phaseBlocked"),
			absent: tt("poolMng.phaseAbsent")
		};
		return h("div", { style: { marginTop: 10 } }, h("div", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			marginBottom: 8
		} }, h("span", { style: {
			...S.fieldLabel,
			flex: "none"
		} }, tt("poolMng.concurrent")), h("input", {
			type: "number",
			min: 0,
			style: {
				...S.input,
				width: 90
			},
			value: String(concurrencyValue),
			disabled: busyId !== null,
			onChange: (event) => setConcurrency(Math.max(0, Math.floor(Number(event.target.value) || 0)))
		}), concurrencyDirty ? h("button", {
			type: "button",
			style: S.button,
			onClick: () => void saveConcurrency()
		}, tt("llm.save")) : null, h("span", { style: {
			...S.muted,
			fontSize: 12
		} }, tt("poolMng.concurrentHint"))), keys.length === 0 ? h("p", { style: {
			...S.muted,
			fontSize: 12
		} }, tt("poolMng.empty")) : h("ul", {
			style: S.modelList,
			role: "list"
		}, keys.map((entry) => h("li", {
			key: entry.id,
			style: {
				...S.modelRow,
				...entry.disabled || entry.deleted ? S.modelRowOff : {}
			}
		}, h("div", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center"
		} }, h("span", {
			style: {
				...S.modelName,
				flex: "0 1 auto"
			},
			title: entry.id
		}, entry.label ?? entry.id), entry.note !== null && entry.note !== "" ? h("span", { style: {
			...S.muted,
			fontSize: 12
		} }, entry.note) : null, h("span", { style: {
			...S.modelBadge,
			marginLeft: "auto"
		} }, entry.deleted ? tt("poolMng.deleted") : phaseLabel[entry.phase] ?? entry.phase), editingId === entry.id ? h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busyId !== null,
			onClick: () => void setNote(entry.id, noteDraft)
		}, tt("poolMng.saveName")) : h("span", {
			style: {
				...S.muted,
				fontSize: 12,
				cursor: "pointer"
			},
			onClick: () => {
				setEditingId(entry.id);
				setNoteDraft(entry.note ?? "");
			}
		}, tt("poolMng.note")), entry.deleted ? h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busyId !== null,
			onClick: () => void act({
				action: "restore",
				id: entry.id
			}, entry.id)
		}, tt("poolMng.restore")) : h("span", { style: {
			display: "flex",
			gap: 4
		} }, entry.disabled ? h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busyId !== null,
			onClick: () => void act({
				action: "restore",
				id: entry.id
			}, entry.id)
		}, tt("poolMng.restore")) : h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busyId !== null,
			onClick: () => void act({
				action: "disable",
				id: entry.id
			}, entry.id)
		}, tt("poolMng.disable")), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busyId !== null,
			onClick: () => void act({
				action: "delete",
				id: entry.id
			}, entry.id)
		}, tt("poolMng.delete")))), editingId === entry.id ? h("input", {
			style: {
				...S.input,
				width: "100%",
				boxSizing: "border-box",
				marginTop: 6
			},
			value: noteDraft,
			autoFocus: true,
			placeholder: tt("poolMng.note"),
			disabled: busyId !== null,
			onChange: (event) => setNoteDraft(event.target.value),
			onBlur: () => {
				if (editingId === entry.id) setNote(entry.id, noteDraft);
			},
			onKeyDown: (event) => {
				if (event.key === "Enter") {
					event.preventDefault?.();
					setNote(entry.id, noteDraft);
				}
			}
		}) : null))), error !== null ? h("p", {
			style: S.formError,
			role: "alert"
		}, error) : null);
	}
	var init_api_key_form = __esmMin((() => {
		init_const();
		init_http();
		init_runtime();
		init_provider_controls();
		init_model_picker();
		init_styles();
	}));

//#endregion
//#region src/client/use-polling-interval.ts
/**
	* Run `run()` on an interval that stops while the page is hidden, and slows
	* down while `failed` is true.
	*
	* @param run - the poll body; must be stable (wrap it in `useCallback`), since
	*   it is an effect dependency and a fresh identity would restart the loop on
	*   every render.
	* @param intervalMs - the healthy cadence, in milliseconds.
	* @param options - loop control.
	* @param options.failed - when true the loop backs off to
	*   {@link ERROR_BACKOFF_MS}, never faster than `intervalMs`.
	*/
	function usePollingInterval(run, intervalMs, options = {}) {
		const { failed = false } = options;
		const healthy = Math.max(1, Math.floor(intervalMs));
		const effective = failed ? Math.max(healthy, ERROR_BACKOFF_MS) : healthy;
		const runRef = useRef(run);
		runRef.current = run;
		useEffect(() => {
			let alive = true;
			let timer = null;
			const fire = () => {
				if (alive) runRef.current();
			};
			const start = () => {
				if (timer === null) timer = setInterval(fire, effective);
			};
			const stop = () => {
				if (timer !== null) {
					clearInterval(timer);
					timer = null;
				}
			};
			const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
			if (!hidden()) {
				fire();
				start();
			}
			const onVisibility = () => {
				if (!alive) return;
				if (hidden()) stop();
				else {
					fire();
					start();
				}
			};
			if (typeof document !== "undefined" && "addEventListener" in document) document.addEventListener("visibilitychange", onVisibility);
			return () => {
				alive = false;
				stop();
				if (typeof document !== "undefined" && "addEventListener" in document) document.removeEventListener("visibilitychange", onVisibility);
			};
		}, [effective]);
	}
	var ERROR_BACKOFF_MS;
	var init_use_polling_interval = __esmMin((() => {
		init_runtime();
		ERROR_BACKOFF_MS = 6e4;
	}));

//#endregion
//#region src/client/use-remote-read.ts
/**
	* Poll one Host route on the cadence its own answers state.
	*
	* @param route - The route to read and how to read it. MUST be stable across
	*   renders — module scope or a `useMemo`, never a fresh literal, because the
	*   loop is built from `load` and a rebuilt `load` restarts the interval.
	* @param defaultCadenceMs - The interval before any body has stated one.
	*/
	function useRemoteRead(route, defaultCadenceMs) {
		const [data, setData] = useState(null);
		const [error, setError] = useState(null);
		const [loadedOnce, setLoadedOnce] = useState(false);
		const [updatedAt, setUpdatedAt] = useState(0);
		const [cadenceMs, setCadenceMs] = useState(defaultCadenceMs);
		const generation = useRef(0);
		const inFlight = useRef(null);
		const load = useCallback(async () => {
			generation.current += 1;
			const mine = generation.current;
			const isCurrent = () => generation.current === mine;
			inFlight.current?.abort?.();
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			inFlight.current = controller;
			try {
				const response = await fetch(route.path, {
					headers: { accept: "application/json" },
					cache: "no-store",
					...controller ? { signal: controller.signal } : null
				});
				if (!isCurrent()) return;
				const body = response.ok ? await response.json().catch(() => null) : null;
				if (!isCurrent()) return;
				const outcome = route.parse(body, response.status);
				if (outcome.value !== null) setData(outcome.value);
				setError(outcome.failure);
				if (outcome.failure === null && outcome.value !== null) setUpdatedAt(Date.now());
				if (typeof outcome.cadenceSeconds === "number" && Number.isFinite(outcome.cadenceSeconds)) setCadenceMs(statedCadenceMs(outcome.cadenceSeconds, cadenceMs));
			} catch (reason) {
				if (!isCurrent()) return;
				setError(errorText(reason));
			} finally {
				if (isCurrent()) setLoadedOnce(true);
				if (inFlight.current === controller) inFlight.current = null;
			}
		}, [route, cadenceMs]);
		usePollingInterval(load, cadenceMs, { failed: error !== null });
		useEffect(() => () => {
			generation.current += 1;
			inFlight.current?.abort?.();
		}, []);
		return {
			data,
			error,
			loadedOnce,
			updatedAt,
			cadenceMs,
			load
		};
	}
	var init_use_remote_read = __esmMin((() => {
		init_runtime();
		init_use_polling_interval();
		init_format();
	}));

//#endregion
//#region src/client/use-snapshot-polling.ts
/**
	* Poll the Host snapshot, following its stated cadence and pausing when hidden.
	* @param {number} [defaultCadenceMs] - poll interval before the first answer arrives.
	* @returns {{ data: SnapshotData | null, error: SnapshotFailure | string | null, loadedOnce: boolean, updatedAt: number, cadenceMs: number, load: () => Promise<void> }}
	*   `data`/`error` are the latest interpreted snapshot; `loadedOnce` gates the
	*   first-frame "loading" vs "needs setup" decision; `updatedAt` stamps the
	*   last successful read; `cadenceMs` is the live poll interval; `load` is the
	*   manual refresher (also wired to the header's 刷新 button).
	*/
	function useSnapshotPolling(defaultCadenceMs = 3e4) {
		const { data, error, loadedOnce, updatedAt, cadenceMs, load } = useRemoteRead(SNAPSHOT_ROUTE, defaultCadenceMs);
		return {
			data,
			error,
			loadedOnce,
			updatedAt,
			cadenceMs,
			load
		};
	}
	var SNAPSHOT_ROUTE;
	var init_use_snapshot_polling = __esmMin((() => {
		init_snapshot();
		init_use_remote_read();
		init_const();
		SNAPSHOT_ROUTE = {
			path: SNAPSHOT_PATH,
			parse: (body, status) => {
				if (status < 200 || status >= 300) return {
					value: null,
					failure: errorOfStatus(status)
				};
				const read = interpretSnapshot(body);
				if (read.data === null) return {
					value: null,
					failure: read.error
				};
				return {
					value: read.data,
					failure: null,
					cadenceSeconds: read.data.pollSeconds
				};
			}
		};
	}));

//#endregion
//#region src/client/quota-bar.ts
/**
	* A progress bar: a track, an optional fill, and the ARIA triple.
	*
	* @param props.track - the track style (the full-width background).
	* @param props.fill - the fill style, or `null` to draw NO fill child at all.
	*   A caller with an unknown share passes `null` rather than a 0-width child,
	*   which a stray `min-width` in some engine could paint as a nub (the pill's
	*   comment owns that reasoning; the card passes a style and keeps its shape).
	* @param props.widthPct - the fill width percentage; ignored when `fill` is null.
	* @param props.valueNow - the value assistive tech reads: ALWAYS a number.
	* @param props.label - the accessible label.
	*/
	function QuotaBar(props) {
		return h("div", {
			style: props.track,
			role: "progressbar",
			"aria-label": props.label,
			"aria-valuenow": props.valueNow,
			"aria-valuemin": 0,
			"aria-valuemax": 100
		}, props.fill === null ? null : h("div", { style: {
			...props.fill,
			width: `${props.widthPct}%`
		} }));
	}
	var init_quota_bar = __esmMin((() => {
		init_runtime();
	}));

//#endregion
//#region src/client/cards.ts
/**
	* The bar fill and figure tone for a usage percentage: 70 warn / 90 danger.
	*
	* These are the QUOTA TAB's numbers, and they differ from the composer pill's
	* ON PURPOSE — the pill uses 0.8 warn / 1.0 exhausted (`composer-usage-pill.ts`
	* `tierOf`), and `render-dom.test.mjs` pins both because two tiers disagreeing
	* inside one screenshot is worse than either number. Do not "unify" this one.
	*/
	function usageTone(pct) {
		if (pct >= 90) return {
			fill: S.barFillError,
			color: "var(--dsw-alias-state-error-primary)"
		};
		if (pct >= 70) return {
			fill: S.barFillWarn,
			color: "var(--dsw-alias-state-warn-primary)"
		};
		return {
			fill: S.barFill,
			color: "var(--dsw-alias-label-secondary)"
		};
	}
	/**
	* One quota window as a compact sub-card. The headline and the bar point the
	* SAME way — both read "已用", from 0 to 100 — so a filled bar and a big
	* percentage can never contradict each other the way the old "remaining %"
	* headline over a usage bar did (100.0% remaining next to a full-looking bar
	* read as "drained"). The product semantics: a free-tier quota FILLS as you
	* spend (encouragement), and the warn/error tones ride that same usage
	* percentage (70 warn / 90 error). The only absolute figures left are the
	* used/limit caption under the bar.
	*
	* A window that is not an object at all (a pool row the Host flagged as
	* shape-drifted, or a window field simply absent) renders NOTHING instead
	* of throwing: one malformed pool must not blank the whole panel — the
	* shape warning above already says what is wrong.
	*/
	function QuotaCard({ label, window, tt }) {
		if (window === null || typeof window !== "object") return null;
		const { limit = 0, used = 0, remaining, resetAt } = window;
		const pct = limit > 0 ? Math.min(100, used / limit * 100) : null;
		const tone = usageTone(pct ?? 0);
		const pctColor = tone.color;
		const headline = pct === null ? "—" : `${pct.toFixed(1)}%`;
		return h("div", { style: S.quota }, h("div", { style: S.quotaTop }, h("span", { style: S.quotaLabel }, label), typeof remaining === "number" && remaining <= 0 ? h("span", { style: {
			...S.chip,
			color: "var(--dsw-alias-state-error-primary)",
			borderColor: "var(--dsw-alias-state-error-primary)"
		} }, tt("pool.exhausted")) : null), h("div", { style: {
			...S.quotaRemaining,
			color: pctColor
		} }, headline), QuotaBar({
			track: S.bar,
			fill: tone.fill,
			widthPct: pct ?? 0,
			valueNow: pct === null ? 0 : Number(pct.toFixed(1)),
			label: `${label} ${tt("pool.used")} ${pct === null ? "—" : `${pct.toFixed(1)}%`}`
		}), h("div", { style: S.quotaTop }, h("span", { style: S.quotaUsed }, limit > 0 ? `${tt("pool.used")} ${count(used)} / ${count(limit)}` : `—`), typeof remaining === "number" && remaining > 0 && resetAt ? h("span", { style: S.quotaReset }, format(tt("pool.reset"), { time: when(resetAt) })) : null));
	}
	/**
	* One pool card. The open state is intentionally tiny: name, type chip,
	* spendable grant balance (hover = the nearest expiring grant), and the twin
	* quota sub-cards. The former 模型与返赠详情 fold (callable/locked coverage
	* lists, uncounted models, the grant-expiry line) was removed 2026-10-27:
	* every callable model is configurable in the 接入 API tab, the composer pill
	* footnote still carries the grant expiry, and the lists read as noise.
	*/
	function PoolCard({ pool, tt }) {
		return h("div", { style: S.card }, h("div", { style: S.cardHead }, h("span", { style: S.poolName }, pool.name), h("span", { style: S.chip }, pool.poolType === "dedicated" ? tt("pool.dedicated") : tt("pool.default")), h("span", { style: S.spacer }), (pool.grantBalance ?? 0) > 0 ? h("span", {
			style: S.grantChip,
			title: pool.nearestGrantExpiry !== null && (pool.nearestGrantExpiringBalance ?? 0) > 0 ? format(tt("pool.grantNearest"), {
				balance: count(pool.nearestGrantExpiringBalance),
				time: clockLong(pool.nearestGrantExpiry)
			}) : format(tt("pool.grant"), { balance: count(pool.grantBalance) })
		}, format(tt("pool.grant"), { balance: count(pool.grantBalance) })) : null), h("div", { style: S.quotas }, h(QuotaCard, {
			label: tt("pool.window5h"),
			window: pool.window5h,
			tt
		}), h(QuotaCard, {
			label: tt("pool.window7d"),
			window: pool.window7d,
			tt
		})));
	}
	/**
	* A top-of-section notice for the "transient exhaustion" case: when one or
	* more credit pools have hit zero AND some model has no other pool left to
	* draw on, the picker (host side) drops that model, so the reader sees it
	* vanish with no explanation. This line says WHY it vanished and WHEN it is
	* expected back — the earliest `resetAt` among the pools that actually block
	* something — so a zeroed pool reads as "recovers at HH:MM", never as a
	* mystery.
	*
	* Hook-free: it reads two plain snapshot fields — the `pools` array and, when
	* the Host publishes it, `llm.quotaBlockedModelIds` — so the render suite drives
	* the exact component the browser draws. Returns null when nothing is
	* exhausted (the common case stays silent), and also when the Host says the
	* drained pools block no model. It does not guess whether a zero came from a
	* true quota drain or a rate-limit blip — the panel never sees the 429 class —
	* it only reports the pool's own reset clock, which is the one honest recovery
	* signal available here.
	*/
	function PoolExhaustionNotice({ pools, tt, blockedModelIds }) {
		const list = Array.isArray(pools?.pools) ? pools.pools : [];
		const blocked = Array.isArray(blockedModelIds) ? new Set(blockedModelIds.map(String)) : null;
		let earliest = 0;
		let anyBlocked = false;
		for (const pool of list) {
			let drained = false;
			let poolEarliest = 0;
			for (const key of ["window5h", "window7d"]) {
				const win = pool?.[key];
				if (win && Number(win.limit) > 0 && Number(win.remaining) <= 0) {
					drained = true;
					const reset = Number(win.resetAt) || 0;
					if (reset > 0 && (poolEarliest === 0 || reset < poolEarliest)) poolEarliest = reset;
				}
			}
			if (!drained) continue;
			if (blocked !== null) {
				if (!(Array.isArray(pool?.modelIds) ? pool.modelIds : []).some((id) => blocked.has(String(id)))) continue;
			}
			anyBlocked = true;
			if (poolEarliest > 0 && (earliest === 0 || poolEarliest < earliest)) earliest = poolEarliest;
		}
		if (!anyBlocked) return null;
		const time = earliest > 0 ? when(earliest) : "—";
		return h("div", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-error-primary)",
				marginTop: 4,
				marginBottom: 10
			},
			role: "status"
		}, format(tt("pool.exhaustedNotice"), { time }));
	}
	/**
	* Per-model credit consumption, drawn as a mini bar chart so the eye
	* lands on WHICH model is burning credits: each row carries a bar
	* relative to the largest consumer (the top model fills the track), with
	* the absolute number right-aligned beside the model name. The whole
	* block sits in a card like the quota cards instead of floating as a
	* bare table.
	*/
	function TrendTable({ trend, tt }) {
		if (!trend || !Array.isArray(trend.models) || trend.models.length === 0) return h("div", { style: S.card }, h("div", { style: S.empty }, tt("trend.none")));
		const max = Math.max(0, ...trend.models.map((row) => Math.max(0, Number(row.credits) || 0)));
		const anyMultiplier = trend.models.some((row) => typeof row.multiplier === "number");
		return h("div", { style: S.card }, h("div", { style: S.trendHead }, h("span", { style: S.trendHeadLabel }, tt("trend.model")), h("span", { style: {
			...S.trendHeadLabel,
			textAlign: "right"
		} }, tt("trend.credits"))), trend.models.map((row) => {
			const credits = Math.max(0, Number(row.credits) || 0);
			const pct = max > 0 ? credits / max * 100 : 0;
			const drawsBar = pct >= 1;
			return h("div", {
				key: row.model,
				style: S.trendRow
			}, h("div", { style: S.trendRowHead }, h("span", {
				style: S.trendModel,
				title: row.model
			}, row.model, typeof row.multiplier === "number" && row.multiplier !== 1 ? h("span", {
				style: S.chip,
				title: tt("trend.multiplierLegend")
			}, `×${row.multiplier}`) : null), h("span", { style: S.trendCredits }, count(credits))), drawsBar ? QuotaBar({
				track: S.trendBar,
				fill: S.barFill,
				widthPct: pct,
				valueNow: Math.round(pct),
				label: `${row.model} ${Math.round(pct)}%`
			}) : null);
		}), h("div", { style: S.trendLegend }, tt("trend.legend")), anyMultiplier ? h("div", { style: S.trendLegend }, tt("trend.multiplierLegend")) : null);
	}
	/**
	* One content section as a workbuddy-style collapsible card: a full-width
	* header button (title + rotating chevron) over a bordered card body.
	* Auto-expanded by default in `PanelPage`; the reader can tuck a section
	* away to focus on the other. Hook-free on purpose — `open` and `onToggle`
	* arrive as props, so the render tests exercise the toggle without faking
	* React state (children travel as a regular `children` prop, as in React).
	*/
	function SectionCard({ title, open, onToggle, children, tt }) {
		return h("div", { style: S.sectionCard }, h("button", {
			type: "button",
			style: S.sectionHead,
			"aria-expanded": open,
			"aria-label": `${tt(open ? "section.collapse" : "section.expand")}: ${title}`,
			onClick: onToggle
		}, h("span", { style: S.sectionHeadTitle }, title), h("svg", {
			viewBox: "0 0 16 16",
			width: 14,
			height: 14,
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "1.5",
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			style: open ? {
				...S.chevron,
				...S.chevronOpen
			} : S.chevron
		}, h("path", { d: "M3 6l5 5 5-5" }))), h("div", {
			style: S.sectionBody,
			hidden: !open
		}, open ? children : null));
	}
	var init_cards = __esmMin((() => {
		init_format();
		init_quota_bar();
		init_runtime();
		init_styles();
	}));

//#endregion
//#region src/client/multimodal-tab.ts
/** 一个下拉/开关的通用行。 */
	function Field({ label, children }) {
		return h("label", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			marginBottom: 8
		} }, h("span", { style: {
			...S.fieldLabel,
			flex: "none"
		} }, label), children);
	}
	function MultimodalTab({ llm, pool, onDone, tt }) {
		const models = Array.isArray(llm?.allModels) ? llm.allModels : Array.isArray(llm?.models) ? llm.models : [];
		const imageModels = models.filter((model) => model?.imageGen === true);
		const visionSelected = Array.isArray(pool?.settings?.vision?.visionModels) ? pool.settings.vision.visionModels : [];
		const visionModels = models.filter((model) => visionSelected.includes(String(model?.id ?? "")));
		const settings = pool?.settings ?? {
			toolsEnabled: {},
			text2img: {},
			img2img: {},
			vision: {}
		};
		const [busySection, setBusySection] = useState(null);
		const [error, setError] = useState(null);
		/** 文本输入的本地草稿（key = section.key）。 */
		const [drafts, setDrafts] = useState({});
		/** 三张参数卡各自可合拢（默认全展开）。 */
		const [openCards, setOpenCards] = useState({
			text2img: true,
			img2img: true,
			vision: true
		});
		const toggleCard = (key) => setOpenCards((current) => ({
			...current,
			[key]: current[key] === false
		}));
		const saved = (section, key) => {
			const value = (settings[section] ?? {})[key];
			return typeof value === "string" ? value : "";
		};
		const savedBool = (section, key) => {
			const bag = settings[section] ?? {};
			return typeof bag[key] === "boolean" ? bag[key] : void 0;
		};
		const save = useCallback(async (section, values) => {
			setBusySection(section);
			setError(null);
			try {
				const body = await postJsonOrThrow(POOL_PATH, {
					section,
					values
				});
				if (body?.ok !== true) {
					setError(typeof body?.error === "string" ? body.error : tt("auth.network"));
					return;
				}
				onDone?.();
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				setError(/non-JSON HTTP 4\d\d/.test(message) ? tt("poolMng.routeMissing") : message || tt("auth.network"));
			} finally {
				setBusySection(null);
			}
		}, [onDone, tt]);
		const setKey = (section, key, value) => {
			save(section, { [key]: value });
		};
		const draftOf = (section, key) => {
			const compose = `${section}.${key}`;
			return drafts[compose] ?? saved(section, key);
		};
		const setDraft = (section, key, value) => {
			setDrafts((current) => ({
				...current,
				[`${section}.${key}`]: value
			}));
		};
		const commitDraft = (section, key) => {
			const compose = `${section}.${key}`;
			const draft = drafts[compose];
			if (draft === void 0 || draft === saved(section, key)) return;
			setKey(section, key, draft);
			setDrafts((current) => {
				const next = { ...current };
				delete next[compose];
				return next;
			});
		};
		/** 开关（即改即存）。 */
		const switchRow = (section, key, label, fallback) => h("div", { style: { marginBottom: 8 } }, h(ToggleSwitch, {
			checked: savedBool(section, key) ?? fallback,
			busy: busySection === section,
			label,
			onChange: () => setKey(section, key, !(savedBool(section, key) ?? fallback))
		}));
		/** 模型下拉（imageGen / vision 清单）。 */
		const modelSelect = (section, label, list, fallback) => h(Field, { label }, h("select", {
			style: {
				...S.input,
				width: "auto"
			},
			value: saved(section, "model") !== "" ? saved(section, "model") : fallback,
			disabled: busySection === section,
			onChange: (event) => setKey(section, "model", event.target.value)
		}, list.length === 0 ? h("option", { value: fallback }, fallback + tt("mm.catalogEmpty")) : list.map((model) => h("option", {
			key: String(model.id),
			value: String(model.id)
		}, String(model.name ?? model.id)))));
		/** 文本行（失焦提交）。 */
		const textRow = (section, key, label, placeholder) => h(Field, { label }, h("input", {
			style: {
				...S.input,
				width: "auto",
				flex: 1
			},
			value: draftOf(section, key),
			placeholder,
			disabled: busySection === section,
			onChange: (event) => setDraft(section, key, event.target.value),
			onBlur: () => commitDraft(section, key)
		}));
		/** 单选下拉行。 */
		const selectRow = (section, key, label, options, fallback, labelOf) => h(Field, { label }, h("select", {
			style: {
				...S.input,
				width: "auto"
			},
			value: saved(section, key) !== "" ? saved(section, key) : fallback,
			disabled: busySection === section,
			onChange: (event) => setKey(section, key, event.target.value)
		}, options.map((option) => h("option", {
			key: option,
			value: option
		}, labelOf ? labelOf(option) : option))));
		/** 出图单工具的参数卡（两工具同构，配置各自独立）。 */
		const imageCard = (tool, title, modelFallback) => h(SectionCard, {
			title,
			open: openCards[tool] !== false,
			onToggle: () => toggleCard(tool),
			tt
		}, switchRow("toolsEnabled", tool, tt("mm.enabled"), false), modelSelect(tool, tt("mm.defaultModel"), imageModels, modelFallback), selectRow(tool, "size", tt("mm.size"), IMAGE_SIZES.map(([value]) => value), "auto", (option) => IMAGE_SIZES.find(([value]) => value === option)?.[1] ?? option), selectRow(tool, "outputFormat", tt("mm.outputFormat"), IMAGE_FORMATS, "png"), selectRow(tool, "responseFormat", tt("mm.responseFormat"), RESPONSE_FORMATS, "b64_json"), switchRow(tool, "promptExtend", tt("mm.promptExtend"), true), switchRow(tool, "watermark", tt("mm.watermark"), true), textRow(tool, "outputDir", tt("mm.outputDir"), tt("mm.outputDirHint")));
		return h("div", null, error !== null ? h("p", {
			style: S.formError,
			role: "alert"
		}, error) : null, imageCard("text2img", tt("mm.text2imgTitle"), "sensenova-u1.5-lite"), h("div", { style: { height: 14 } }), imageCard("img2img", tt("mm.img2imgTitle"), "sensenova-u1.5-lite"), h("div", { style: { height: 14 } }), h(SectionCard, {
			title: tt("mm.visionTitle"),
			open: openCards.vision !== false,
			onToggle: () => toggleCard("vision"),
			tt
		}, switchRow("toolsEnabled", "visionTools", tt("mm.visionEnabled"), false), modelSelect("vision", tt("mm.visionModel"), visionModels, "sensenova-6.8-flash-lite"), selectRow("vision", "bridgeMode", tt("mm.bridgeMode"), [
			"auto",
			"on",
			"off"
		], "auto", (option) => tt(option === "auto" ? "mm.bridgeModeAuto" : option === "on" ? "mm.bridgeModeOn" : "mm.bridgeModeOff")), textRow("vision", "bridgePrompt", tt("mm.bridgePrompt"), tt("mm.bridgePromptPlaceholder"))), h("p", { style: {
			...S.trendLegend,
			marginTop: 10
		} }, tt("mm.hint")));
	}
	var IMAGE_FORMATS, RESPONSE_FORMATS, IMAGE_SIZES;
	var init_multimodal_tab = __esmMin((() => {
		init_const();
		init_http();
		init_runtime();
		init_styles();
		init_cards();
		init_toggle_switch();
		IMAGE_FORMATS = [
			"png",
			"jpeg",
			"webp"
		];
		RESPONSE_FORMATS = ["b64_json", "url"];
		IMAGE_SIZES = [
			["auto", "auto"],
			["2048x2048", "2048x2048（1:1 / 2K）"],
			["2720x1536", "2720x1536（16:9 / 2K）"],
			["1536x2720", "1536x2720（9:16 / 2K）"],
			["1664x2496", "1664x2496（2:3 / 2K）"],
			["2496x1664", "2496x1664（3:2 / 2K）"],
			["4096x4096", "4096x4096（1:1 / 4K）"]
		];
	}));

//#endregion
//#region src/client/panel-page.ts
	function PanelPage({ onClose, tt, localeSubscribe }) {
		const { data, error, loadedOnce, updatedAt, load } = useSnapshotPolling();
		const [, setLocaleRevision] = useState(0);
		const [openSections, setOpenSections] = useState({
			pools: true,
			trend: true,
			account: false,
			provider: true,
			llm: false
		});
		const [activeTab, setActiveTab] = useState("quota");
		useEffect(() => {
			if (typeof localeSubscribe !== "function") return void 0;
			return localeSubscribe(() => setLocaleRevision((revision) => revision + 1));
		}, [localeSubscribe]);
		const toggleSection = useCallback((key) => {
			setOpenSections((current) => ({
				...current,
				[key]: !current[key]
			}));
		}, []);
		const pools = data?.pools;
		const trend = data?.trend;
		const { failure, auth, needsSetup, guidance, shapeWarnings } = viewOf(data, error, tt);
		const showSetupForm = needsSetup && loadedOnce;
		const authChip = auth === null ? null : auth.error || !auth.configured ? h("span", {
			style: S.chip,
			title: auth.error || guidance || ""
		}, tt("auth.needsLogin")) : h("span", { style: S.chip }, tt("auth.selfRenew"));
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
		const quotaError = data?.quotaError ?? null;
		const quotaGuidanceKey = quotaError?.code ? GUIDANCE_BY_CODE[String(quotaError.code)] ?? null : null;
		const quotaNotice = quotaError === null ? null : quotaGuidanceKey !== null ? h("div", {
			style: S.formNote,
			role: "status"
		}, tt(quotaGuidanceKey)) : typeof quotaError.message === "string" && quotaError.message !== "" ? h("div", {
			style: S.formNote,
			role: "status"
		}, quotaError.message) : null;
		const quotaLoginBlocked = quotaError !== null && LOGIN_BLOCKED_QUOTA_CODES.has(String(quotaError.code ?? ""));
		const quotaBody = () => {
			if (data === null) return showSetupForm ? h(AccountForm, {
				auth,
				onDone: () => void load(),
				tt,
				snapshotAt: updatedAt
			}) : h("div", { style: S.empty }, failure === null ? tt("panel.loading") : h("div", null, h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message }))));
			return h("div", null, quotaNotice, quotaLoginBlocked ? h(AccountForm, {
				auth: data?.auth ?? null,
				onDone: () => void load(),
				tt,
				snapshotAt: updatedAt
			}) : h("div", null, h(SectionCard, {
				title: tt("section.pools"),
				open: openSections.pools,
				onToggle: () => toggleSection("pools"),
				tt
			}, pools?.plan?.name ? h("div", { style: {
				...S.muted,
				fontSize: 12,
				marginBottom: 10
			} }, pools.plan.name) : null, h(PoolExhaustionNotice, {
				pools,
				tt,
				blockedModelIds: data.llm?.quotaBlockedModelIds
			}), h("div", { style: S.poolsGrid }, (pools?.pools || []).map((pool) => h(PoolCard, {
				key: pool.id,
				pool,
				tt
			})))), h(SectionCard, {
				title: format(tt("section.trend"), {
					hours: trend?.hours ?? 24,
					cache: data?.cacheSeconds ?? 60
				}),
				open: openSections.trend,
				onToggle: () => toggleSection("trend"),
				tt
			}, h(TrendTable, {
				trend,
				tt
			})), authManage ? h(SectionCard, {
				title: tt("auth.title"),
				open: openSections.account,
				onToggle: () => toggleSection("account"),
				tt
			}, h(AccountForm, {
				auth,
				onDone: () => void load(),
				tt,
				bare: true,
				snapshotAt: updatedAt
			})) : null));
		};
		const apiBody = () => h("div", null, h(SectionCard, {
			title: tt("llm.providerTitle"),
			open: openSections.provider,
			onToggle: () => toggleSection("provider"),
			tt
		}, h(ProviderForm, {
			llm: data?.llm ?? null,
			pool: data?.pool ?? null,
			onDone: () => void load(),
			tt
		})), h(SectionCard, {
			title: tt("llm.title"),
			open: openSections.llm,
			onToggle: () => toggleSection("llm"),
			tt
		}, h(ApiKeyForm, {
			llm: data?.llm ?? null,
			pool: data?.pool ?? null,
			onDone: () => void load(),
			tt,
			bare: true
		})));
		const multimodalBody = () => h(MultimodalTab, {
			llm: data?.llm ?? null,
			pool: data?.pool ?? null,
			onDone: () => void load(),
			tt
		});
		const body = h("div", null, h("div", { style: S.tabRow }, h("div", {
			style: S.tabBar,
			role: "tablist"
		}, h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "quota",
			style: {
				...S.tab,
				...activeTab === "quota" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("quota")
		}, tt("tab.quota")), h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "api",
			style: {
				...S.tab,
				...activeTab === "api" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("api")
		}, tt("tab.api")), h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "multimodal",
			style: {
				...S.tab,
				...activeTab === "multimodal" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("multimodal")
		}, tt("tab.multimodal"))), h("span", { style: S.spacer }), headerStatus, onClose ? h("button", {
			type: "button",
			style: {
				...S.button,
				alignSelf: "center"
			},
			onClick: () => onClose()
		}, tt("panel.back")) : null), activeTab === "quota" && data && shapeWarnings.length > 0 ? h("div", {
			style: S.formError,
			role: "status"
		}, format(tt("panel.shapeDrift"), { detail: shapeWarnings.map((entry) => `${tt("shape.api")} ${entry.api} ${tt("shape.missing")} ${entry.missing}`).join("; ") })) : null, activeTab === "quota" ? quotaBody() : activeTab === "multimodal" ? multimodalBody() : apiBody());
		return h("div", {
			style: S.page,
			"data-dsh-plugin": PANEL_ID
		}, h("div", { style: S.scroll }, body));
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
	function HeaderStatus({ activeTab, hasData, updatedAt, failure, authChip, tt, onRefreshQuota }) {
		return h("span", { style: S.cluster }, hasData ? h("span", { style: S.updated }, format(tt("panel.updated"), { time: when(updatedAt / 1e3) })) : null, activeTab === "quota" ? authChip : null, activeTab === "quota" && failure !== null && hasData ? h("span", {
			style: S.error,
			role: "status",
			title: failure.message
		}, format(tt("panel.error"), { error: failure.message })) : null, h("button", {
			type: "button",
			style: S.button,
			onClick: () => onRefreshQuota()
		}, tt("panel.refresh")));
	}
	var LOGIN_BLOCKED_QUOTA_CODES;
	var init_panel_page = __esmMin((() => {
		init_account_form();
		init_api_key_form();
		init_const();
		init_format();
		init_snapshot();
		init_use_snapshot_polling();
		init_runtime();
		init_styles();
		init_cards();
		init_multimodal_tab();
		LOGIN_BLOCKED_QUOTA_CODES = new Set(Object.keys(GUIDANCE_BY_CODE).filter((code) => !FORM_EXCLUDED_CODES.has(code)));
	}));

//#endregion
//#region src/client/composer-usage-pill.ts
/**
	* The candidate selection: `next` wins over `lastUsed` — BUT an empty `next`
	* object (the transient state right after a picker switch, before it carries
	* the new selection) must not shadow a still-usable `lastUsed`. The old
	* `next ?? lastUsed` read a provider off `{}` and returned `undefined`,
	* hiding the pill for OWNED models on exactly the frames a switch produces.
	*/
	function candidateOf(projection) {
		const p = projection ?? {};
		const usable = (c) => c !== null && c !== void 0 && (typeof c.provider === "string" || typeof c.model === "string");
		if (usable(p.next)) return p.next;
		if (usable(p.lastUsed)) return p.lastUsed;
	}
	/**
	* The provider the session is currently pointed at.
	*
	* `next` wins over `lastUsed`: a switch that has landed but not yet been sent is
	* still the selection the composer displays — the same precedence the shell uses.
	*/
	function selectedProviderOf(projection) {
		const provider = candidateOf(projection)?.provider;
		return typeof provider === "string" && provider !== "" ? provider : void 0;
	}
	/** The selected model id, `next` winning as above. */
	function selectedModelOf(projection) {
		const model = candidateOf(projection)?.model;
		return typeof model === "string" && model !== "" ? model : void 0;
	}
	/**
	* Which pool's windows this model draws from.
	*
	* A pool is model-scoped when it declares `modelIds`. When SEVERAL pools name
	* the same model, the dedicated pool wins over the general one: the console
	* lists `sensenova-6.8-flash-lite` in both, yet its spend lands in the
	* Flash-Lite pool only (live check 2026-10-18 00:00: the dedicated 5h window
	* had 3,129 credits consumed while the general 5h window stayed at 0, both
	* sharing one `resetAt`). Taking the first hit would attribute the model — and
	* its exhaustion — to the general pool, i.e. show a full meter for a model that
	* still has an untouched quota behind it.
	*
	* That observation does not prove the platform charges the dedicated pool
	* FIRST: a "general pool until it runs dry, then the dedicated one" rule would
	* have produced the same numbers. The pill can therefore read healthy while a
	* request still comes back 429. That is the same bet the Host's all-pools rule
	* makes (`exhaustedModelIds`), so the pill and the picker never disagree — only
	* the inference about the console's billing order stays unverified.
	*
	* A Token Plan model that names no pool falls back to the first pool — never to
	* an invented aggregate.
	*
	* A covering pool that is ALREADY DRAINED loses to a covering pool that still
	* has credit: the Host keeps the model selectable while ANY covering pool has
	* credit (the all-pools rule), so pointing the pill at the spent one would show
	* a full meter for a model the picker still offers — a disagreement between two
	* panels about one fact. Dedicated-first decides only among pools that can still
	* serve, and still decides by itself when every covering pool is spent (then the
	* earliest reset clock is what the reader needs).
	*/
	function poolFor(pools, modelId, provider) {
		const covering = modelId !== void 0 ? (pools ?? []).filter((p) => Array.isArray(p.modelIds) && p.modelIds.includes(modelId)) : [];
		const live = covering.filter((pool) => !poolSpent(pool));
		const preferred = live.find((p) => p.poolType === "dedicated") ?? live[0];
		if (preferred !== void 0) return preferred;
		const dedicated = covering.find((p) => p.poolType === "dedicated");
		if (dedicated !== void 0) return dedicated;
		if (covering.length > 0) return covering[0];
		return provider === TOKEN_PLAN ? pools?.[0] : void 0;
	}
	/**
	* Whether either window of a pool reads as fully spent.
	*
	* Deliberately `tierOf` (the pill's one colour rule) rather than a second
	* `remaining <= 0` comparison: `limit` unknown must stay "unknown", never
	* "spent", and the pill already owns exactly one implementation of that.
	*/
	function poolSpent(pool) {
		return tierOf(pool.window5h) === "exhausted" || tierOf(pool.window7d) === "exhausted";
	}
	/** The colour for a window, by share of its limit already spent. */
	function tierOf(window) {
		const limit = typeof window?.limit === "number" ? window.limit : NaN;
		const used = typeof window?.used === "number" ? window.used : NaN;
		if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) return "unknown";
		const share = used / limit;
		if (share >= 1) return "exhausted";
		if (share >= .8) return "warn";
		return "ok";
	}
	/** The worse of two tiers, for the pill's single colour. */
	function worseTier(a, b) {
		const rank = {
			exhausted: 4,
			warn: 3,
			ok: 2,
			unknown: 1
		};
		return rank[a] >= rank[b] ? a : b;
	}
	/** The used share of a window as a rounded percent, or `null` when unknowable. */
	function percentOf(window) {
		const limit = typeof window?.limit === "number" ? window.limit : NaN;
		const used = typeof window?.used === "number" ? window.used : NaN;
		if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) return null;
		return Math.round(used / limit * 100);
	}
	/**
	* The reset instant to WORD, in the same epoch SECONDS the wire uses — or `null`
	* when none should be worded.
	*
	* The units are the whole point of this helper. `window_5h.reset_at` arrives as
	* decimal epoch seconds (`epochSeconds()` in `parsers.ts`), so a seconds value
	* compared against `Date.now()`'s milliseconds is ALWAYS in the past — which
	* silently deleted the reset clock from the panel and the tooltip for every real
	* reading, while `cards.ts` (which skips this helper and formats straight)
	* kept showing it. So the comparison converts, and the return value stays in
	* SECONDS: both `when()` and `new Date(x * 1000)` take seconds, so no caller has
	* to remember which unit a "resetAt" is in.
	*
	* A reset that has already passed (the window is mid-reset, or the snapshot
	* lagged it) is dropped rather than worded "重置中" — the stale mark, when
	* present, carries that reading instead.
	* @param resetAtSeconds - epoch seconds, exactly as the wire carries it.
	* @param nowMs - epoch ms (injectable for tests).
	*/
	function resetFor(resetAtSeconds, nowMs) {
		if (typeof resetAtSeconds !== "number" || !Number.isFinite(resetAtSeconds)) return null;
		return resetAtSeconds * 1e3 > nowMs ? resetAtSeconds : null;
	}
	/**
	* The SOONEST reset still ahead among several windows' — or `null` if none is.
	*
	* `window_5h.resetAt ?? window_7d.resetAt` picks the first non-null, not the
	* first LIVE one, and the two are not the same window: the 5h deadline elapses
	* four times a day (so it is mid-reset or lagged by the snapshot's own cadence),
	* while the weekly one is still ahead — and the tooltip, having taken the dead
	* 5h value, then worded no deadline at all. That deleted the reset clock exactly
	* when the reader had the most reason to look at it. Choosing the soonest future
	* instant makes each window contribute what it knows and a spent deadline
	* contribute nothing, instead of shadowing the other window.
	*
	* Ties and equal values are harmless: the first minimum wins, and both callers
	* only ever word the one instant.
	* @param resets - every window's `resetAt`, epoch seconds, in any order.
	* @param nowMs - epoch ms (injectable for tests).
	*/
	function nextResetOf(resets, nowMs) {
		let soonest = null;
		for (const at of resets) {
			const live = resetFor(at, nowMs);
			if (live === null) continue;
			if (soonest === null || live < soonest) soonest = live;
		}
		return soonest;
	}
	/**
	* One window as a panel row: the label, a bar that carries the same share the
	* pill's percentage rounds, the RAW figures, and the reset clock.
	*
	* Why the bar and the raw figures but no percentage: the pill already shows the
	* rounded percentage, and a second rounded percentage beside it would be the
	* same number twice. What the pill cannot show is the question that opens this
	* panel — "1%" cannot say whether a long-context request still fits — so the
	* row spends its width on used/limit instead.
	*
	* `aria` mirrors `cards.ts`'s progressbar: same role, same value triple, so a
	* screen reader is told the same thing by both surfaces.
	*/
	function QuotaRow({ label, window, tt }) {
		const limit = typeof window?.limit === "number" ? window.limit : 0;
		const used = typeof window?.used === "number" ? window.used : 0;
		const share = limit > 0 ? Math.min(100, used / limit * 100) : null;
		const tier = tierOf(window);
		const resetAt = resetFor(window?.resetAt ?? null, Date.now());
		return h("div", { style: S.pillPopoverRow }, h("div", { style: S.pillPopoverRowLine }, h("span", { style: S.pillPopoverLabel }, label), h("span", { style: S.pillPopoverFigure }, Number.isFinite(limit) && limit > 0 ? `${count(used)} / ${count(limit)}` : "—")), QuotaBar({
			track: S.pillPopoverBar,
			fill: share === null ? null : {
				...S.pillPopoverFill,
				background: TIER_INK[tier]
			},
			widthPct: share ?? 0,
			valueNow: share === null ? 0 : Math.round(share),
			label: `${label} ${tt("pool.used")}`
		}), resetAt === null ? null : h("div", { style: S.pillPopoverFoot }, h("span", { style: S.pillPopoverReset }, format(tt("pool.reset"), { time: when(resetAt) }))));
	}
	/**
	* The dismissal listeners for an open panel: click-away and Escape.
	*
	* Both are ordinary document listeners guarded the way `use-polling-interval.ts`
	* guards its `visibilitychange` one, and both are torn down the moment the panel
	* closes — a closed panel must not keep the document on a listener that exists
	* only to close it.
	*
	* The containment test reads the anchor's DOM node rather than the panel's: a
	* click on the trigger itself is a TOGGLE (the button's own `click` handler), so
	* treating it as "inside" is what keeps the outside-click path from racing it.
	* `anchorRef` is a ref, not state, so attaching it costs no render and no hook
	* order risk.
	*
	* `pointerdown` and not `click`: by `click` time the trigger's own handler has
	* already run, so a `click` listener that treated the trigger as "inside" would
	* close and the toggle would immediately reopen — a panel that cannot be closed
	* by clicking away. See the module doc for the drag-back caveat.
	*/
	function useDismissOn(open, close, anchorRef) {
		useEffect(() => {
			if (!open) return;
			if (typeof document === "undefined" || !("addEventListener" in document)) return;
			const nodeLike = (value) => typeof value === "object" && value !== null && typeof value.nodeType === "number";
			const anchorLike = anchorRef.current;
			const insideAnchor = (target) => nodeLike(target) && typeof anchorLike?.contains === "function" && anchorLike.contains(target);
			const onPointerDown = (event) => {
				if (insideAnchor(event.target)) return;
				close();
			};
			const onKeyDown = (event) => {
				if (event.key !== "Escape") return;
				close();
			};
			document.addEventListener("pointerdown", onPointerDown, true);
			document.addEventListener("keydown", onKeyDown);
			return () => {
				document.removeEventListener("pointerdown", onPointerDown, true);
				document.removeEventListener("keydown", onKeyDown);
			};
		}, [
			open,
			close,
			anchorRef
		]);
	}
	/**
	* The popover itself: a `<div role="dialog">` sibling of the trigger rather than
	* its child: a dialog inside a `<button>` is invalid nesting (a button's content
	* model is phrasing content, and interactive content inside it is worse), and the
	* panel has its own rows. The anchor wrapper is a plain `<span>` for the same
	* reason.
	*
	* The `id` lives HERE rather than on an extra wrapper: `aria-controls` has to
	* resolve to the node that actually carries the panel, and one wrapper between
	* the id and the panel would make the reference point at a bare wrapper.
	*/
	function QuotaPopover(props) {
		const { tt, title, stale, poolLine, note, footnote = null, children } = props;
		return h("div", {
			className: "dsh-sensenova-composer-pill-popover",
			id: POPOVER_ID,
			role: "dialog",
			"aria-label": title,
			style: S.pillPopover
		}, h("div", { style: S.pillPopoverHead }, h("span", { style: S.pillPopoverTitle }, title), poolLine === null ? null : h("span", { style: S.pillPopoverPool }, poolLine), stale ? h("span", { style: S.pillPopoverStale }, tt("composer.stale")) : null), children, note === null ? null : h("div", { style: S.pillPopoverNote }, note), footnote === null ? null : h("div", { style: S.pillPopoverNote }, footnote));
	}
	/** The shared shell: the tier dot, the reading, the plan prefix, the panel anchor. */
	function PillBody(props) {
		const { tt, planLabel, tier, children, stale = false, title, open = false, onToggle, onClose, panel = null } = props;
		const anchorRef = useRef(null);
		useDismissOn(open, onClose, anchorRef);
		return h("span", {
			className: "dsh-sensenova-composer-pill-anchor",
			style: S.pillPopoverAnchor,
			ref: anchorRef
		}, h("button", {
			type: "button",
			className: "dsh-sensenova-composer-pill",
			title,
			"aria-label": title,
			"aria-expanded": open,
			"aria-haspopup": "dialog",
			"aria-controls": open ? POPOVER_ID : void 0,
			onClick: onToggle,
			style: S.pillTrigger
		}, h("span", {
			className: "dsh-sensenova-composer-pill-dot",
			"aria-hidden": "true",
			style: {
				...S.pillDot,
				background: TIER_INK[tier]
			}
		}), h("span", {
			className: "dsh-sensenova-composer-pill-plan",
			style: S.pillPlan
		}, `${planLabel} · `), h("span", {
			className: "dsh-sensenova-composer-pill-text",
			style: tier === "exhausted" ? S.pillTierExhaustedText : void 0
		}, children, stale ? h("span", { style: S.pillStale }, ` · ${tt("composer.stale")}`) : null)), open && panel !== null ? panel : null);
	}
	/**
	* The composer pill. Renders nothing unless the session's model belongs to this
	* plugin — so no other provider's conversations carry a foreign credit readout,
	* and no fetch loop runs while it is absent (the inner poller is not mounted).
	* The inner TokenPlanPill reads the snapshot; it is mounted only for this
	* plugin's provider.
	*/
	function ComposerUsagePill(props) {
		const { tt, useProjection } = props;
		const projection = (useProjection ?? (() => void 0))("modelSelection");
		const provider = selectedProviderOf(projection);
		const model = selectedModelOf(projection);
		if (provider === TOKEN_PLAN) return h(TokenPlanPill, {
			tt,
			model
		});
		return null;
	}
	/**
	* The Token Plan reading: the snapshot poller (unconditionally, first hook) and
	* the two-window percentage pair. Unmounted wholesale when the session leaves
	* the Token Plan provider, which is also what stops its fetch loop.
	*/
	function TokenPlanPill({ tt, model }) {
		const { data, error, loadedOnce, updatedAt } = useSnapshotPolling();
		const [open, setOpen] = useState(false);
		const toggle = useCallback(() => setOpen((wasOpen) => !wasOpen), []);
		const close = useCallback(() => setOpen(false), []);
		const pool = poolFor(data?.pools?.pools ?? [], model, TOKEN_PLAN);
		const w5 = pool?.window5h ?? null;
		const w7 = pool?.window7d ?? null;
		const tier = worseTier(tierOf(w5), tierOf(w7));
		const p5 = percentOf(w5);
		const p7 = percentOf(w7);
		const now = Date.now();
		const stale = error !== null || updatedAt > 0 && now - updatedAt > 9e4;
		const resetTime = nextResetOf([w5?.resetAt, w7?.resetAt], now);
		const label = (prefix, pct) => `${prefix} ${pct === null ? "—" : `${pct}%`}`;
		const noPoolReason = data !== null ? tt("composer.noPool") : tt("composer.quotaUnknown");
		const poolTitle = pool !== void 0 ? pool.name ? String(pool.name) : null : loadedOnce ? noPoolReason : null;
		const title = [
			tt("composer.pillTitle"),
			poolTitle,
			resetTime !== null ? `${tt("composer.resetAt")} ${when(resetTime)}` : null,
			stale ? tt("composer.stale") : null
		].filter(Boolean).join(" · ");
		const matched = model !== void 0 && pool !== void 0 ? Array.isArray(pool.modelIds) && pool.modelIds.includes(model) : false;
		const poolKind = pool !== void 0 && pool.poolType === "dedicated" ? tt("pool.dedicated") : tt("pool.default");
		const poolLine = pool === void 0 ? null : `${String(pool.name ?? "")} · ${poolKind} · ${matched ? tt("composer.poolHit") : tt("composer.poolFallback")}`;
		const grant = pool === void 0 ? 0 : pool.grantBalance ?? 0;
		const grantExpiry = pool?.nearestGrantExpiry ?? null;
		const footnote = grant > 0 ? [format(tt("pool.grant"), { balance: count(grant) }), grantExpiry !== null && resetFor(grantExpiry, now) !== null ? format(tt("pool.grantExpiry"), {
			time: when(grantExpiry),
			balance: count(pool?.nearestGrantExpiringBalance ?? 0)
		}) : null].filter((part) => part !== null).join(" · ") : null;
		const panel = pool === void 0 ? h(QuotaPopover, {
			tt,
			title: tt("composer.pillTitle"),
			stale,
			poolLine: null,
			note: loadedOnce ? noPoolReason : "…",
			children: null
		}) : h(QuotaPopover, {
			tt,
			title: tt("composer.pillTitle"),
			stale,
			poolLine,
			note: null,
			footnote,
			children: [h(QuotaRow, {
				key: "w5",
				label: tt("pool.window5h"),
				window: w5,
				tt
			}), h(QuotaRow, {
				key: "w7",
				label: tt("pool.window7d"),
				window: w7,
				tt
			})]
		});
		return h(PillBody, {
			tt,
			planLabel: tt("composer.planPrefix"),
			tier,
			stale,
			title,
			open,
			onToggle: toggle,
			onClose: close,
			panel,
			children: [
				h("span", {
					key: "r5",
					style: S.pillReading
				}, label(tt("composer.pool5h"), p5)),
				" · ",
				h("span", {
					key: "r7",
					style: S.pillReading
				}, label(tt("composer.pool7d"), p7))
			]
		});
	}
	var TOKEN_PLAN, POPOVER_ID, TIER_INK, STALE_AFTER_MS;
	var init_composer_usage_pill = __esmMin((() => {
		init_runtime();
		init_styles();
		init_format();
		init_use_snapshot_polling();
		init_quota_bar();
		TOKEN_PLAN = "sensenova-token-plan";
		POPOVER_ID = "dsh-sensenova-composer-pill-popover";
		TIER_INK = {
			ok: S.pillTierOk,
			warn: S.pillTierWarn,
			exhausted: S.pillTierExhausted,
			unknown: S.pillTierUnknown
		};
		STALE_AFTER_MS = 9e4;
	}));

//#endregion
//#region src/client/apply.ts
/**
	* Register the dictionaries and the plugin config card.
	*
	* The card is rendered inside the Plugins page by the Host's
	* `renderSlot("plugins.bundle.config", …)` call. No `onClose` is passed —
	* the Plugins page owns navigation; the card has no close button.
	*/
	function apply(ctx) {
		ctx.effect(() => {
			try {
				return ctx.locale.register(NS, {
					zh,
					en
				});
			} catch {
				return () => {};
			}
		}, `${NS}: dictionaries`);
		let translate = (key) => key;
		try {
			translate = ctx.locale.bind(NS);
		} catch {}
		const tt = (key) => {
			try {
				return translate(key);
			} catch {
				return key;
			}
		};
		const disposers = [];
		try {
			disposers.push(ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: NS,
				locale: NS,
				inject: () => ({
					tt,
					localeSubscribe: ctx.locale.subscribe.bind(ctx.locale)
				})
			}, PanelPage)));
		} catch (error) {
			console.warn(`[${NS}] config card registration failed:`, error);
		}
		try {
			disposers.push(ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: `${NS}-composer-pill`,
				locale: NS,
				order: 4,
				inject: () => ({ tt })
			}, ComposerUsagePill)));
		} catch (error) {
			console.warn(`[${NS}] composer pill registration failed:`, error);
		}
		ctx.effect(() => () => {
			for (const dispose of disposers.splice(0)) try {
				dispose();
			} catch {}
		}, `${NS}: ui mounts`);
	}
	var inject;
	var init_apply = __esmMin((() => {
		init_const();
		init_i18n();
		init_panel_page();
		init_composer_usage_pill();
		inject = ["slots", "locale"];
	}));

//#endregion
//#region src/client/index.ts
	var require_client = /* @__PURE__ */ __commonJSMin(((exports, module) => {
		init_apply();
		init_const();
		init_snapshot();
		init_models();
		init_format();
		init_runtime();
		init_i18n();
		init_styles();
		init_account_form();
		init_cards();
		init_provider_controls();
		init_toggle_switch();
		init_api_key_form();
		init_model_picker();
		init_panel_page();
		init_composer_usage_pill();
		/**
		* 浏览器实际加载的客户端构建戳（DevTools 控制台可见）。
		*
		* 存在理由：面板上的「无法连接本机 Host」曾把「Host 跑旧构建 / 浏览器缓存了
		* 旧 bundle / 真网络故障」说成同一句话，排查只能靠猜。每次改客户端**改这一行**
		* 并重新构建，控制台就能回答「浏览器到底加载了哪一版」。
		*/
		const CLIENT_BUILD = "2026-10-27T11:40";
		function clientFactory(loaderRequire) {
			provideClientReact(loaderRequire("react"));
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
				dictionaries: Object.freeze({
					zh,
					en
				}),
				tables: Object.freeze({
					GUIDANCE_BY_CODE,
					FORM_EXCLUDED_CODES,
					REFUSAL_TEXT
				}),
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
			return {
				inject,
				apply,
				panel
			};
		}
		/** The registration the Host loads: id plus the factory the Host materializes. */
		const REGISTRATION = {
			id: NS,
			factory: clientFactory
		};
		if (typeof window !== "undefined") {
			const loader = window.__ModuleLoader__;
			if (loader !== void 0) loader.load(REGISTRATION);
		}
		if (typeof module !== "undefined" && module !== null && module.exports !== void 0) module.exports = REGISTRATION;
	}));

//#endregion
return require_client();

})();