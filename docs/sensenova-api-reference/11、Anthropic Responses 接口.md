Anthropic 兼容 Messages API
SenseNova 同时提供 Anthropic Messages API 兼容端点，适用于使用 Anthropic SDK 或 Claude 生态工具的场景。

请求地址：

复制
POST https://token.sensenova.cn/v1/messages
鉴权：

与 Chat Completions接口、Responses接口 共用同一 API Key，通过 Authorization: Bearer Header 传递：

复制
Authorization: Bearer $SENSENOVA_API_KEY
基础对话
单轮对话：

使用 authToken 会以 Authorization: Bearer 方式发送密钥。若 SDK 版本不支持，可用 apiKey 参数替代。

复制
curl https://token.sensenova.cn/v1/messages \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "max_tokens": 1024,
    "system": "你是一个智能助手",
    "messages": [
      { "role": "user", "content": "介绍一下商汤科技" }
    ]
  }'
流式输出：

复制
curl https://token.sensenova.cn/v1/messages \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "max_tokens": 1024,
    "system": "你是一个智能助手",
    "messages": [
      { "role": "user", "content": "介绍一下商汤科技" }
    ],
    "stream": true
  }'
图像输入
除了上面的 OpenAI 兼容端点，你也可以通过 Anthropic 兼容的 /messages 端点发送图片，区别主要在于图片内容块的结构：Anthropic 不使用 image_url，而是使用 image 内容块，其中 source.type 可设置为 base64 或 url。

公网 URL：传入可公开访问的图像链接
Base64 Data URL：支持将本地图像编码为 Base64，并以 Data URL 格式传入
支持的格式： 支持 JPG、JPEG、PNG 和 WebP 图像（image/jpg、image/jpeg、image/png、image/webp）

复制
curl https://token.sensenova.cn/v1/messages \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "messages": [
      {"content": "你是图像识别专家","role": "system"},
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "描述一下图片内容"},
          {"type": "image", "source": {"type": "url","url": "https://www.sensenova.cn/marketing-home/showcase-hero.png"}}
        ]
      }
    ],
    "max_tokens": 1000
  }'
Base64 方式：（python 示例）

支持将本地图片转换为 Base64 数据后传入。Base64 数据须包含完整前缀，格式为 data:image/*;base64,{Base64data}。

复制
import os
import base64
from anthropic import Anthropic

client = Anthropic(
    base_url="https://token.sensenova.cn",
    # 若没有配置环境变量，请将下行替换为：auth_token="sk-xxx"
    auth_token=os.getenv("SENSENOVA_API_KEY"),
)

with open("local-image.png", "rb") as image:
    image_base64 = base64.b64encode(image.read()).decode()

response = client.messages.create(
    model="sensenova-6.8-flash-lite",
    system="你是图像识别专家",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "图片里面有什么？"},
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": image_base64
                }
            }
        ]
    }],
    max_tokens=1000,
    extra_body={"reasoning_effort": "none"}
)

print(response.content[0].text)
流式输出：

复制
curl https://token.sensenova.cn/v1/messages \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "messages": [
      {"content": "你是图像识别专家","role": "system"},
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "描述一下图片内容"},
          {"type": "image", "source": {"type": "url","url": "https://www.sensenova.cn/marketing-home/showcase-hero.png"}}
        ]
      }
    ],
    "max_tokens": 1000,
    "stream": true
  }'
思考模式
模型默认开启思考模式。可通过 thinking.type 参数控制思考模式的开启与关闭，并使用 output_config.effort 参数控制模型的思考程度。例如，设置 "output_config": {"effort": "high"}。如需关闭思考模式，也可直接设置 "thinking": {"type": "disabled"}。

参数说明：

字段	类型	必填	默认值	说明
thinking.type	string	—	enabled	控制思考模式的开关，可选值为 "enabled" 或 "disabled"
output_config.effort	string	—	high	推理力度，可选值为 low、medium、high、xhigh、max，取值越大思考强度越高；
设为 none 可关闭思考模式
思考强度：

取值	说明
low	轻度推理。适合简单任务及对响应速度要求较高的场景，延迟和 Token 消耗较低
medium	中等推理。在响应速度与推理效果之间取得平衡，适合一般分析、内容生成及中等复杂度任务
high	增强推理（默认值）。适合常规推理、代码生成和复杂问题分析等场景
max	深度推理。适合复杂推理、长程任务及深度代码分析等场景，通常需要更长的响应时间并消耗更多 Token
请求示例：

复制
curl https://token.sensenova.cn/v1/messages \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "max_tokens": 1024,
    "system": "你是一个智能助手",
    "messages": [
      { "role": "user", "content": "介绍一下商汤科技" }
    ],
    "thinking": {"type": "disabled"}
  }'
响应说明：

thinking：返回模型生成过程中的思考内容；当开启思考输出时，该字段会返回对应的推理过程
text：返回模型最终生成的回复内容
复制
{
  "id": "msg_d394ab38-…",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "thinking",
      "thinking": "好的，用户让我介绍一下商汤科技。首先，我需要…"
    },
    {
      "type": "text",
      "text": "商汤科技（SenseTime）是由徐立、汤晓鸥等科学家于2014年创立的全球领先人工智能公司，总部位于中国上海。…"
    }
  ],
  "model": "sensenova-6.8-flash-lite",
  "stop_reason": "end_turn",
  "usage": {
    "cache_read_input_tokens": 0,
    "input_tokens": 90,
    "output_tokens": 758,
    "server_tool_use": {
      "web_search_requests": 0
    },
    "service_tier": "standard"
  }
}
请求参数
messages 格式说明：

role 支持 system 或 user 或 assistant
首条消息允许 role:system 或 role:user；assistant 消息不可作为第一条消息
content 支持字符串或内容块数组两种格式
复制
[
  { "type": "text", "text": "请描述这张图片" },
  { "type": "image", "source": { "type": "url", "url": "https://..." } }
]
图片输入（仅 sensenova-6.8-flash-lite 支持）：base64 或 URL 均可，支持 image/png、image/jpeg、image/gif、image/webp 格式
参数	类型	必填	默认值	说明
model	string	✅	—	模型 ID，如 sensenova-6.8-flash-lite
messages	array	✅	—	对话消息列表，role ∈ {system, user, assistant, tool}；content 可为字符串或内容块数组（图像输入时使用）
max_tokens	integer	—	—	最大输出 Token 数
system	string / array	—	—	系统提示词，可为字符串或 [{"type":"text","text":"..."}] 数组；与 messages 内 system 二选一，冲突时以 messages 内 system 为准
temperature	number	—	1	采样温度，范围 [0, 2]，值越高输出越随机，值越低越确定。一般只调此参数或 top_p 之一
top_p	number	—	1	核采样概率，范围 (0, 1.0]
stop_sequences	array	—	—	自定义停止序列，字符串数组，如 ["\n", "END"]
stream	boolean	—	false	是否开启流式输出（SSE）
metadata	object	—	—	请求元数据，如 {"user_id": "xxx"}，透传不影响推理
tools	array	—	—	工具定义列表，用于函数调用
tool_choice.type	object	—	"auto"	工具选择策略：auto / any / {"type":"tool","name":"..."}
thinking.type	string	—	enabled	控制思考模式的开关，可选值为 "enabled" 或 "disabled"
output_config.effort	object	—	"high"	输出配置。effort 子字段控制推理力度，可选值：low / medium / high / max
响应结构
复制
{
  "id": "msg_d394ab38-1aa5-46f5-bccb-90bdfa73c02c",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "thinking",
      "thinking": "好的，用户让我介绍一下商汤科技。首先，我需要"
    },
    {
      "type": "text",
      "text": "商汤科技（SenseTime）是由徐立、汤晓鸥等科学家于2014年创立的全球领先人工智能公司，总部位于中国上海。"
    }
  ],
  "model": "sensenova-6.8-flash-lite",
  "stop_reason": "end_turn",
  "usage": {
    "cache_read_input_tokens": 0,
    "input_tokens": 90,
    "output_tokens": 758,
    "server_tool_use": {
      "web_search_requests": 0
    },
    "service_tier": "standard"
  }
}
字段	说明
id	本次请求的唯一 ID，格式为 msg_<uuid>
type	固定为 "message"
role	固定为 "assistant"
content	内容块数组，包含 thinking（推理过程）和 text（回复文本）类型
model	实际使用的模型 ID
stop_reason	停止原因：
end_turn（自然结束）
max_tokens（达到最大 Token）
stop_sequence（命中停止序列）
tool_use（请求函数调用）
usage.input_tokens	输入消耗的 Token 数
usage.output_tokens	输出消耗的 Token 数（含思考部分）
参数推荐
参数 / 实践	建议	说明
max_tokens	普通任务 2048～4096；思考模式建议 ≥ 4096	思考内容和回答共享 token 配额
stream	长文本生成建议开启	避免请求超时，提升响应体验
temperature	一般无需修改，使用默认值 1	创意写作可调高至 1.3-1.5；代码生成可调低至 0.2-0.5
多轮对话	只将 content 回传，不回传 reasoning_content	减少 token 消耗
使用限制
限制项	说明
思考模式与 JSON 模式	不建议同时开启 thinking.type=enabled 和 response_format.type=json_object
超时风险	思考模式开启时响应时间较长，建议配合 stream=true 使用，避免超时
Responses 兼容 API
SenseNova 提供 OpenAI Responses API 兼容端点（POST /v1/responses），适用于 OpenAI SDK、Codex 及其他依赖该协议的工具与应用。

当前支持的模型：

模型名称	模型 ID
SenseNova 6.8 Flash Lite	sensenova-6.8-flash-lite
DeepSeek V4 Flash	deepseek-v4-flash
DeepSeek V4.1 Flash	deepseek-flash
GLM 5.2	glm-5.2
Kimi K3	kimi-k3
请求地址

复制
POST https://token.sensenova.cn/v1/responses
鉴权

与 Chat Completions接口、Anthropic Messages接口共用同一 API Key，通过 Authorization: Bearer Header 传递：

复制
Authorization: Bearer $SENSENOVA_API_KEY
使用限制
本期为实现 Codex 等工具接入的无状态兼容，以下能力暂不支持：

限制项	说明
无状态模式	不支持响应存储、previous_response_id 续写、Conversations、后台任务、Webhook、上下文压缩
有状态接口	不提供响应查询、删除、取消及 Input Items 查询
内置工具	仅支持 function；Web Search、File Search、Code Interpreter、MCP 等不支持
输入类型	不支持视频、input_file
超时风险	思考模式耗时较长，建议配合 stream=true
基础对话
单轮对话：

复制
curl https://token.sensenova.cn/v1/responses \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "input": [
      {"role":"system", "content":"你是一个智能助手"},
      {"role":"user", "content":"介绍一下商汤科技"}
    ]
  }'
input 也可直接传字符串，等价于一条 role 为 user 的文本消息。

读取回复时，可使用返回对象的 output_text（便捷字段），或遍历 output 中 type 为 message 的 output_text 内容块。

流式输出：

设置 "stream": true 后以 SSE 返回语义事件。流以 response.completed / response.incomplete / response.failed 结束，没有 data: [DONE]。

复制
curl https://token.sensenova.cn/v1/responses \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "input": "介绍一下商汤科技",
    "stream": true
  }'
多轮对话：

不支持 previous_response_id，请在 input 中按时间线携带完整历史。

复制
curl https://token.sensenova.cn/v1/responses \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "input": [
      {"role": "user", "content": "我叫小明。"},
      {"role": "assistant", "content": "你好，小明！"},
      {"role": "user", "content": "我刚才说我叫什么？"}
    ]
  }'
图像输入
Responses 使用 input_image 内容块，通过 image_url 传入公网 URL 或 Base64 Data URI。

公网 URL：可公开访问的图像链接
Base64 Data URI：格式为 data:image/*;base64,{Base64data}
支持的格式： image/png、image/jpeg、image/gif、image/webp

复制
curl https://token.sensenova.cn/v1/responses \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "图片里面有什么" },
          {
            "type": "input_image",
            "image_url": "https://www.sensenova.cn/marketing-home/showcase-hero.png"
          }
        ]
      }
    ]
  }'
Base64 示例：

复制
{
  "type": "input_image",
  "image_url": "data:image/png;base64,<base64编码的图片数据>"
}
图片理解成功后仍返回 message → output_text，不新增输出类型。本期不支持 input_file 及依赖 Files API 的 file_id 图片引用。

工具调用
本期仅支持 type 为 function 的自定义函数工具。模型需要调用时在 output 中返回 function_call；本地执行后，将相关项追加进 input，再追加对应的 function_call_output（call_id 必须一致），发起下一次请求。

支持的工具类型

工具类型	type 取值	说明
自定义函数工具	function	name、description、parameters、strict 均可用
Function 工具字段：

字段	类型	必填	默认值	说明
type	string	✅	—	固定为 function
name	string	✅	—	函数名，1～64 字符，仅字母、数字、_、-；同一请求不可重名
description	string | null	—	null	描述何时以及如何调用
parameters	object | null	—	{"type":"object","properties":{}}	参数 JSON Schema，根节点须为 object
strict	boolean | null	—	false	是否要求参数严格符合 parameters
不支持的工具类型（请勿依赖）：file_search、web_search / web_search_preview、code_interpreter、mcp、computer / computer_use_preview、image_generation、shell、apply_patch。

第一轮：定义工具并发起请求

复制
curl https://token.sensenova.cn/v1/responses \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "input": "北京今天天气怎么样？",
    "tools": [
      {
        "type": "function",
        "name": "get_weather",
        "description": "查询指定城市天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string" }
          },
          "required": ["city"]
        }
      }
    ],
    "tool_choice": "auto"
  }'
模型返回示例（arguments 为 JSON 字符串）：

复制
{
  "id": "fc_123",
  "type": "function_call",
  "status": "completed",
  "call_id": "call_123",
  "name": "get_weather",
  "arguments": "{\"city\":\"北京\"}"
}
第二轮：回传工具结果

复制
curl https://token.sensenova.cn/v1/responses \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "input": [
      { "type": "message", "role": "user", "content": "北京今天天气怎么样？" },
      {
        "type": "function_call",
        "call_id": "call_123",
        "name": "get_weather",
        "arguments": "{\"city\":\"北京\"}"
      },
      {
        "type": "function_call_output",
        "call_id": "call_123",
        "output": "{\"temp\":22,\"desc\":\"多云\"}"
      }
    ],
    "tools": [
      {
        "type": "function",
        "name": "get_weather",
        "description": "查询指定城市天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string" }
          },
          "required": ["city"]
        }
      }
    ]
  }'
思考模式
模型默认开启思考模式。当前模型暂不支持自定义思考等级。开启思考模式时，后台默认使用 reasoning.effort: "high"；如需关闭思考模式，可设置 "reasoning": { "effort": "none" }。

支持推理的模型可通过 reasoning 控制思考行为。平台将推理内容统一映射为 reasoning 输出条目，只返回供应商允许公开的摘要，不返回原始私有思维链。

参数说明：

字段	类型	必填	默认值	说明
reasoning.effort	string | null	—	见下表	推理力度，兼容 low、medium、high、xhigh 选值传入，但传入无效；设为 none 可关闭思考模式
reasoning.summary	string | null	—	—	是否返回推理摘要：auto / concise / detailed
各模型默认 effort：

模型 ID	默认
sensenova-6.8-flash-lite、deepseek-v4-flash、deepseek-flash	high
glm-5.2、kimi-k3	max
请求示例：

复制
curl https://token.sensenova.cn/v1/responses \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "input": "介绍一下商汤科技",
    "reasoning": { "effort": "none" }
  }'
响应说明： output 中可能先出现 type=reasoning（summary 为摘要），最终回复在 type=message 的 output_text 中。推理 Token 计入 usage.output_tokens 与 output_tokens_details.reasoning_tokens。

结构化输出
通过 text.format 控制输出格式。json_object 保证合法 JSON 对象；json_schema 可按 Schema 约束。结构化结果仍以字符串形式位于 output[].content[].text 中，其中对应内容块的 type 为 output_text。

模型 ID	支持的 format.type
deepseek-flash（DeepSeek V4.1 Flash）、kimi-k3	text、json_object、json_schema
sensenova-6.8-flash-lite、deepseek-v4-flash、glm-5.2	text、json_object
复制
curl https://token.sensenova.cn/v1/responses \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "input": "提取姓名和年龄：张三，18岁。",
    "text": {
      "format": {
        "type": "json_schema",
        "name": "person",
        "schema": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "age": { "type": "integer" }
          },
          "required": ["name", "age"],
          "additionalProperties": false
        },
        "strict": true
      }
    }
  }'
json_schema 仅 deepseek-flash（DeepSeek V4.1 Flash）、kimi-k3 支持；其余模型使用 text 或 json_object。使用 json_schema 时建议包含 "additionalProperties": false。

请求参数说明
字段	类型	必填	默认值	说明
model	string	✅	—	模型 ID，必须显式指定
input	string | array	✅	—	输入内容。字符串等价于一条 role 为 user 的文本消息；数组按时间线携带完整历史
instructions	string | null	—	null	系统 / 开发者指令，优先级最高
stream	boolean	—	false	true 时返回 Responses 标准 SSE 事件
max_output_tokens	integer | null	—	模型默认	最大输出 Token 数（含可见输出及推理 Token），须 > 0；超限时 status=incomplete，incomplete_details.reason=max_output_tokens
temperature	number | null	—	1	采样温度
top_p	number | null	—	模型默认，同 chat 接口	核采样，范围 (0, 1]
tools	array	—	[]	工具列表，仅支持 type=function
tool_choice	string | object	—	"auto"	"auto" / "none" / "required"，或 {"type":"function","name":"..."}
parallel_tool_calls	boolean	—	true	是否允许并行工具调用；模型不支持时若传 true，静默忽略
text	object	—	{"format":{"type":"text"}}	文本输出配置，见 结构化输出
reasoning	object | null	—	模型默认	推理配置，见 思考模式
max_output_tokens 范围值（按模型）：

模型 ID	范围
sensenova-6.8-flash-lite	[1, 65536]
deepseek-v4-flash	[1, 384000]
deepseek-flash（DeepSeek V4.1 Flash）	[1, 393216]
glm-5.2	[1, 131072]
kimi-k3	[1, 1048576]
temperature 范围值（按模型）：

模型 ID	范围
sensenova-6.8-flash-lite、deepseek-flash	[0, 2]
deepseek-v4-flash、glm-5.2	[0, 2)
store 和 background 参数仅接受 false；省略时按 false 处理，传入 true 将返回错误。

响应结构
Response 对象

非流式请求返回 Response 对象；流式事件中的 response.created / response.completed 等也包含该对象。

复制
{
  "id": "resp_123",
  "object": "response",
  "created_at": 1787700000,
  "status": "completed",
  "error": null,
  "incomplete_details": null,
  "model": "sensenova-6.8-flash-lite",
  "output": [
    {
      "id": "msg_123",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "你好！有什么可以帮助你？",
          "annotations": []
        }
      ]
    }
  ],
  "parallel_tool_calls": true,
  "previous_response_id": null,
  "usage": {
    "input_tokens": 8,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens": 8,
    "output_tokens_details": { "reasoning_tokens": 0 },
    "total_tokens": 16
  }
}
字段	说明
id	本次响应唯一 ID
object	固定为 "response"
status	completed / incomplete / failed
output	输出条目数组，见下文
model	实际使用的模型 ID
usage	Token 用量
error	错误信息；正常完成时为 null
incomplete_details	不完整时的详情；reason 可为 max_output_tokens 或 content_filter
previous_response_id	本期固定为 null
输出条目类型

output 按推理、消息、函数调用的实际产生顺序排列。

推理条目：

复制
{
  "type": "reasoning",
  "id": "rs_xxx",
  "status": "completed",
  "summary": [{ "type": "summary_text", "text": "推理过程摘要" }]
}
消息条目：

复制
{
  "type": "message",
  "id": "msg_xxx",
  "status": "completed",
  "role": "assistant",
  "content": [
    { "type": "output_text", "text": "模型生成的回复文本", "annotations": [] }
  ]
}
content 支持 output_text（最终回复；JSON 结果仍在 text 字符串中）与 refusal（模型明确拒答，不含 text）。

函数调用条目：

复制
{
  "type": "function_call",
  "id": "fc_xxx",
  "status": "completed",
  "call_id": "call_xxx",
  "name": "get_weather",
  "arguments": "{\"city\":\"北京\"}"
}
arguments 始终为 JSON 字符串。回传结果时须使用相同 call_id。

Usage 用量统计

字段	说明
input_tokens	输入 Token 数
output_tokens	输出 Token 数，包含推理 Token
total_tokens	输入与输出合计
input_tokens_details.cached_tokens	缓存命中的输入 Token；无命中为 0
output_tokens_details.reasoning_tokens	推理消耗的 Token；无推理为 0
流式响应 (SSE)
设置 stream: true 后，以 Server-Sent Events 返回。每条事件带 event 类型与递增的 sequence_number。

事件序列

复制
response.created
response.in_progress
  [reasoning，可选]
    response.output_item.added
    response.reasoning_summary_part.added
    response.reasoning_summary_text.delta   （可多次）
    response.reasoning_summary_text.done
    response.reasoning_summary_part.done
    response.output_item.done
  [message，可选]
    response.output_item.added
    response.content_part.added
    response.output_text.delta              （可多次）
    response.output_text.done
    response.content_part.done
    response.output_item.done
  [function_call，可多个]
    response.output_item.added
    response.function_call_arguments.delta  （可多次）
    response.function_call_arguments.done
    response.output_item.done
response.completed                          （或 incomplete / failed）
并行工具调用时，每个 function_call 使用独立的 output_index、item_id、call_id；delta 可能交错到达，客户端须分别拼接。

事件类型说明

事件类型	说明
response.created	响应已创建
response.in_progress	响应进行中
response.output_item.added / done	输出条目开始 / 完成
response.content_part.added / done	内容块开始 / 完成
response.output_text.delta / done	文本增量 / 完成
response.reasoning_summary_part.added / done	推理摘要部分开始 / 完成
response.reasoning_summary_text.delta / done	推理摘要文本增量 / 完成
response.function_call_arguments.delta / done	函数参数增量 / 完成
response.completed	完成，含完整 usage
response.incomplete	未完成（输出上限或内容审核等）
response.failed	失败，含 error
文本流式示例

复制
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_stream_123","object":"response","status":"in_progress","model":"sensenova-6.8-flash-lite","output":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_stream_123","output_index":0,"content_index":0,"delta":"你好"}

event: response.completed
data: {"type":"response.completed","sequence_number":9,"response":{"id":"resp_stream_123","status":"completed","usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11}}}