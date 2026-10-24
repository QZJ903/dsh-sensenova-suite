//#region src/host/vision/direct.ts
/**
* 直连路径：用 `fetch` 调用商汤 OpenAI 兼容 `chat/completions`。
*
* `redirect: 'error'`（凭据请求拒重定向）；超时用 `AbortSignal.timeout`。
* 单模型（用户选择）；HTTP 失败抛出的错误带 `status` 与 `body`，供上层把
* 429/401 按套件教义回池（run.ts 的 VisionFeedback）。
*
* 纯函数 + 可注入 `fetchImpl`。
*
* @module dsh-sensenova-suite/vision/direct
*/
/** chat-completions base URL 幂等追加。 */
function chatUrl(baseUrl) {
	const base = baseUrl.replace(/\/+$/, "");
	if (base.endsWith("/chat/completions") || base.endsWith("/llm/chat-completions")) return base;
	return `${base}/chat/completions`;
}
/** 构造一个图片内容部件。 */
function imagePart(imageRef, mode) {
	if (mode === "image_base64") {
		let raw = imageRef;
		if (raw.startsWith("data:") && raw.includes(";base64,")) raw = raw.slice(raw.indexOf(";base64,") + 8);
		if (raw.startsWith("http://") || raw.startsWith("https://")) throw new Error("image_base64 mode needs base64 bytes or a local file path, not an http URL");
		return {
			type: "image_base64",
			image_base64: raw
		};
	}
	return {
		type: "image_url",
		image_url: { url: imageRef }
	};
}
/** 从响应 JSON 提取文本。 */
function extractText(data) {
	const choices = data["choices"];
	if (Array.isArray(choices) && choices.length > 0) {
		const first = choices[0];
		if (typeof first === "object" && first !== null) {
			const message = first["message"];
			if (typeof message === "object" && message !== null) {
				const content = message["content"];
				if (typeof content === "string") return content;
			}
		}
	}
	throw new Error(`SenseNova API response had no choices[0].message.content; raw response: ${JSON.stringify(data).slice(0, 800)}`);
}
/**
* 一次 POST（server.py `_post_chat` 的 fetch 版）。HTTP 错误带状态码与响应体摘要；
* 网络/超时错误带原因。**凭据请求拒重定向**（`redirect: 'error'`）。
*/
async function postChat(options) {
	const url = chatUrl(options.apiBase);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`SenseNova request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${options.apiKey}`
			},
			body: JSON.stringify({
				model: options.model,
				messages: [{
					role: "user",
					content: options.content
				}]
			}),
			redirect: "error",
			signal: controller.signal
		});
		if (!response.ok) {
			const body = (await response.text()).slice(0, 800);
			const error = /* @__PURE__ */ new Error(`SenseNova API returned HTTP ${response.status} for ${url}: ${body}`);
			error.status = response.status;
			error.body = body;
			throw error;
		}
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}
/** 失败信封（MCP 兼容）。 */
function envelopeFail(taskType, error) {
	return {
		ok: false,
		task_type: taskType,
		error
	};
}

//#endregion
export { postChat as i, extractText as n, imagePart as r, envelopeFail as t };