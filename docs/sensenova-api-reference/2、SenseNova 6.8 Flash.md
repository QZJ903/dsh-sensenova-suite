SenseNova 6.8 Flash
日日新推出的新一代多模态智能体模型，面向办公智能与持续任务，支持跨会话协作与动态创作场景

重点强化长期记忆与主动交互能力，支持在跨任务、跨会话场景中持续理解用户目标，主动跟进并灵活调整规划

提升复杂任务执行能力，协同信息检索、浏览器操作与工具调用，可持续完成跨系统的长程任务

拓展从代码生成到视觉设计与动态内容创作的多模态能力，覆盖网页、演示、3D 等多种创作形态，生成可编辑、可演示的动态内容

model_id：sensenova-6.8-flash

请求地址：

复制
POST https://token.sensenova.cn/v1/chat/completions
基础对话
单轮对话： 模型默认为非流式输出

复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash",
    "messages": [
      { "role": "system", "content": "你是一个智能助手" },
      { "role": "user",   "content": "一句话介绍下商汤科技" }
    ]
  }'
流式输出：

复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash",
    "messages": [
      { "role": "system", "content": "你是一个智能助手" },
      { "role": "user","content": "一句话介绍下商汤科技" }
    ],
    "stream": true
  }'
图像输入
当 content 为内容块数组时，可通过 image_url 类型传入图像，并与文本内容组合输入。image_url.url 支持以下两种图像传入方式：

公网 URL： 传入可公开访问的图像链接

Base64 Data URL： 支持将本地图像编码为 Base64，并以 Data URL 格式传入

支持的格式： 支持 JPG、JPEG、PNG 和 WebP 图像（image/jpg、image/jpeg、image/png、image/webp）

请求示例：

复制
curl  https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash",
    "messages": [
      {"content": "你是图像识别专家","role": "system"},
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "请简单描述下图片内容"},
          {"type": "image_url", "image_url": {"url": "https://www.sensenova.cn/marketing-home/showcase-hero.png"}}
        ]
      }
    ],
    "n": 1,
    "max_tokens": 2048
  }'
Base64 方式：（python示例）

支持将本地图片转换为 Base64 数据后传入。Base64 数据须包含完整前缀，格式为 data:image/*;base64,{Base64data}。

复制
import os
import base64
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["SENSENOVA_API_KEY"],
    base_url="https://token.sensenova.cn/v1"
)

with open("local-image.png", "rb") as image:
    image_base64 = base64.b64encode(image.read()).decode()

response = client.chat.completions.create(
    model="sensenova-6.8-flash",
    messages=[
        {"role": "system","content": "你是图像识别专家"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "请简单描述下图片内容"},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_base64}"}
               }
            ]
        }
    ],
    max_tokens=2048
)

print(response.choices[0].message.content)
流式输出：

复制
curl  https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash",
    "messages": [
      {"content": "你是图像识别专家", "role": "system"},
      {
        "role": "user",
        "content": [
          {"type": "text","text": "请简单描述下图片内容"},
          {"type": "image_url","image_url": {"url": "https://www.sensenova.cn/marketing-home/showcase-hero.png"}}
        ]
      }
    ],
    "n": 1,
    "stream": true,
    "max_tokens": 2048
  }'
工具调用
Function Calling 允许模型通过调用外部工具获取实时数据或执行特定操作。模型不会直接执行函数，而是返回待调用的函数名称及参数；用户代码完成调用后，将执行结果传回模型，由模型生成最终的自然语言回答。

调用流程：

用户提问 → 模型返回 tool_calls（包含函数名称和参数）

用户代码执行函数 → 以 role: tool 消息传回执

模型根据结果生成最终回答

完整闭环流程：模型调用 → 模型返回 → 本地执行 → 工具回传 → 最终模型返回

模型调用：

复制
{
  "model": "sensenova-6.8-flash",
  "messages": [
    {"role": "user", "content": "今天上海天气怎么样？"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的天气信息",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string", "description": "城市名称"}},
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "stream": false
}
模型返回： 模型决定调用工具时，会在 choices[].message.tool_calls 中返回工具调用信息。业务侧根据 function.name 确定要执行的函数，将 function.arguments 从 JSON 字符串解析为参数，并读取该次调用的 id。执行完成后，将此 id 填入工具结果消息的 tool_call_id，以关联调用与结果。

本地执行： 业务侧根据模型返回的 function.name 和 function.arguments，调用对应的本地函数或外部 API

例如：

复制
//本地执行：
get_weather(city="上海")

//获取结果
{
  "city": "上海",
  "weather": "晴",
  "temperature": "19°C"
}
Function Calling 仅负责生成工具调用请求，不会自动执行实际函数。

工具回传：

工具执行完成后，将原始对话、模型返回的 tool_calls 以及工具执行结果一并发送给模型。

工具结果通过 role: "tool" 回传，并使用 tool_call_id 与对应的工具调用进行关联。

复制
{
  "model": "sensenova-6.8-flash",
  "messages": [
    {"role": "user", "content": "今天上海天气怎么样？"},
    {
      "role": "assistant",
      "content": "\n\n",
      "reasoning": "用户问的是上海今天的天气，我需要使用get_weather工具来查询上海的城市天气信息。参数只需要city，值为\"上海\"。\n",
      "tool_calls": [
        {
          "id": "call_4a…", "type": "function",
          "function": {"name": "get_weather", "arguments": "{\"city\":\"上海\"}"}
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_4a…", 
      "content": "{\"city\":\"上海\",\"weather\":\"晴\",\"temperature\":\"19°C\"}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的天气信息",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},"required": ["city"]
          }
      }
    }
  ]
}
模型最终返回： 模型根据工具执行结果生成最终回答。

复制
{
    "id": "b9333……",
    "created": 1793162786,
    "model": "sensenova-6.8-flash",
    "object": "chat.completion",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "上海今天天气是**晴**，气温 **19°C**。天气不错，适合出行，不过气温较高，记得注意防晒补水哦！",
                "reasoning": "查询结果显示上海今天的天气是晴天，气温19°C。我可以直接根据这个结果给用户答复。"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 420,
        "completion_tokens": 58,
        "total_tokens": 478,
        "completion_tokens_details": {
            "reasoning_tokens": 22
        },
        "prompt_tokens_details": {
            "cached_tokens": 0,
            "audio_tokens": 0
        }
    },
    "request_id": "b9333……"
}
思考模式
模型默认开启思考模式，且不支持关闭思考。可通过 reasoning_effort 参数设置思考程度，例如"reasoning_effort": "max"。

参数说明：

字段	类型	必填	默认值	说明
thinking.type	string	—	enabled	模型默认开启思考，thinking.type 仅支持 enabled，不支持关闭思考
reasoning_effort	string	—	high	推理力度，可选值为minimal、low、medium、high、xhigh、max，取值越大思考强度越高
请求示例：

复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash",
    "messages": [
      { "role": "system", "content": "你是一个智能助手" },
      { "role": "user",   "content": "一句话介绍下商汤科技" }
    ],
    "reasoning_effort": "high"
  }'
响应说明：

content：返回模型最终生成的回复内容。

reasoning：返回模型生成过程中的思考内容；当开启思考输出时，该字段会返回对应的推理过程。

复制
{
  "id": "c3589e2f-...",
  "created": 1787822182,
  "model": "sensenova-6.8-flash",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "商汤科技（SenseTime）是一家全球领先的人工智能（AI）软件公司...",
        "reasoning": "用户让我介绍一下商汤科技。首先得确认..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 1606,
    "total_tokens": 1630,
    "completion_tokens_details": {"reasoning_tokens": 236},
    "prompt_tokens_details": {"cached_tokens": 0,"audio_tokens": 0}
  },
  "request_id": "c3589e2f-..."
}
请求参数
字段	类型	必填	默认值	说明
model	string	✅	—	模型标识。本表固定为 sensenova-6.8-flash
messages	array	✅	—	对话消息列表。支持1 M 上下文窗口
messages[].role	string	✅	—	消息角色。支持 system、user、assistant、tool，分别表示系统指令、用户消息、助手消息和工具结果。
messages[].content	string | array	—	—	消息内容。纯文本可使用字符串；图文混合输入使用内容块数组。
messages[].content[].type	string	—	—	内容块类型：文本填写 text，图片填写 image_url。使用内容块时必填
messages[].content[].text	string	—	—	文本块的具体内容。type=text 时必填
messages[].content[].image_url	object	—	—	图片内容对象，通过 url 指定图片数据。type=image_url 时必填
messages[].content[].image_url.url	string	—	—	图片的完整公网 URL，或 Base64 Data URL，例如 data:image/png;base64,{Base64data}。type=image_url 时必填
stream	boolean	—	false	是否通过 SSE 流式返回生成结果。
stream_options	object	—		流式返回配置，仅在 stream=true 时生效。
stream_options.include_usage	boolean	—	true	是否在流式返回中包含 Token 用量统计
temperature	float	—	1	采样温度，值越高通常越随机，值越低通常越确定。一般只调整此参数或 top_p 之一。取值范围[0,1]
top_p	float	—	0.95	核采样概率阈值。范围为 (0,1]
max_tokens	integer	—	64K	单次响应最大生成 Token 数。取值范围为 [1,128K]
n	integer	—	1	单次请求生成的候选回复数量。取值范围[1,7]
stop	string | array	—	—	停止序列，生成时遇到匹配序列即停止
presence_penalty	float	—	—	存在惩罚，依据 Token 是否已出现调整生成倾向，通常用于减少重复话题。取值范围[0,2]
frequency_penalty	float	—	—	频率惩罚，依据 Token 已出现的次数调整其再次出现的倾向。取值范围[0,2]
repetition_penalty	float	—	—	重复惩罚，用于抑制重复生成；取值范围[1,2]
seed	integer	—	—	随机种子，用于提高相同请求的可复现性，通常不保证结果完全一致。范围[0, 9999999)
thinking	object	—	—	思考模式配置对象，使用嵌套字段 type 设置模式。
thinking.type	string	—	enabled	模型默认开启思考，thinking.type 仅支持 enabled，不支持关闭思考
reasoning_effort	string	—	high	推理力度。可选值为 minimal、low、medium、high、xhigh、max，依次提高思考强度
response_format	object	—	—	输出格式约束，例如 JSON 输出
tools	array	—	—	可供模型调用的工具定义列表
tools[].type	string	—	—	工具类型；函数工具填写 function。定义工具时必填
tools[].function	object	—	—	函数定义，包含名称、描述及入参结构。type=function 时必填
tools[].function.name	string	—	—	函数名称，用于识别和指定调用的工具。定义函数时必填
tools[].function.description	string	—	—	函数用途与适用场景，帮助模型判断是否调用
tools[].function.parameters	object	—	—	使用 JSON Schema 描述函数入参，包括属性、类型及必填项；其中的 required 指函数入参中的必填字段
tool_choice	string | object	—	auto	工具选择策略：auto 由模型决定；none 禁止调用；required 要求调用工具；也可使用对象指定函数
tool_choice.type	string	—	—	指定函数调用时填写 function。使用对象指定函数时必填
tool_choice.function.name	string	—	—	指定调用的函数名称，应与 tools[].function.name 一致。使用对象指定函数时必填
messages[].tool_calls	array	—	—	回传对话历史时，保存助手发起的工具调用信息，用于衔接工具执行结果
messages[].tool_calls[].id	string	—	—	工具调用唯一标识，用于关联工具结果。回传工具调用时必填
messages[].tool_calls[].type	string	—	—	函数调用填写 function。回传工具调用时必填
messages[].tool_calls[].function.name	string	—	—	助手请求调用的函数名称。回传函数调用时必填
messages[].tool_calls[].function.arguments	string	—	—	函数入参，类型为 JSON 格式字符串，而非直接传入 JSON 对象。回传函数调用时必填
messages[].tool_call_id	string	—	—	对应助手消息中的 tool_calls[].id；工具执行结果放在同条消息的 content 中。role=tool 时必填
响应结构
复制
{
  "id": "6b3ed703473……",
  "created": 1793279456,
  "model": "sensenova-6.8-flash",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "商汤科技（SenseTime）是中国领先的人工智能软件公司之一，…",
        "reasoning": "好的，用户现在要求我介绍商汤科技，首先我需要确认…"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 64,
    "completion_tokens": 196,
    "total_tokens": 260,
    "completion_tokens_details": {
      "reasoning_tokens": 193
    },
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "audio_tokens": 0
    }
  },
  "request_id": "6b3ed703473……"
}
响应说明：

字段	类型	说明
id	string	本次生成结果的标识，用于记录和关联响应
created	integer	响应创建时间，Unix 时间戳，单位为秒
model	string	模型标识，示例为 sensenova-6.8-flash
object	string	响应对象类型。此非流式响应为 chat.completion
choices	array	模型生成的候选回复列表。请求参数 n 用于指定候选数量
choices[].index	integer	当前候选在列表中的序号，从 0 开始
choices[].message	object	当前候选的完整助手消息
choices[].message.role	string	消息角色，模型回复为 assistant
choices[].message.content	string	模型生成的回答正文。仅产生工具调用或 Token 额度耗尽于推理阶段时，可能不返回正文；客户端应兼容缺失或空值
choices[].message.reasoning	string	模型返回的推理内容，与回答正文分开存放。是否存在取决于模型行为及推理配置，客户端应兼容字段缺失
choices[].finish_reason	string	当前候选结束生成的原因。已实测值包括：stop：正常结束或命中停止序列；length：达到生成长度限制；tool_calls：生成工具调用，等待客户端执行
usage	object	本次请求的 Token 用量统计
usage.prompt_tokens	integer	输入 Token 总数，包括系统指令、用户消息、历史消息等经服务端编码后的输入
usage.completion_tokens	integer	生成 Token 总数，包含推理 Token，不能理解为仅回答正文的 Token 数
usage.total_tokens	integer	本次请求的 Token 总数，等于 prompt_tokens + completion_tokens
usage.completion_tokens_details	object	生成 Token 的细分统计
usage.completion_tokens_details.reasoning_tokens	integer	用于推理的 Token 数，是 completion_tokens 的组成部分，不应再额外加到总量中
usage.prompt_tokens_details	object	输入 Token 的细分统计
usage.prompt_tokens_details.cached_tokens	integer	输入中命中缓存的 Token 数，是输入统计的细分项。示例为 0，表示本次未报告缓存命中
usage.prompt_tokens_details.audio_tokens	integer	输入中的音频 Token 数。示例为 0；字段存在本身不代表该模型支持音频输入
request_id	string	请求追踪标识，用于日志关联、问题排查或提交工单。示例中与 id 相同，但客户端不宜假定两者始终相同
finish_reason 枚举：

value	含义
stop	正常结束
length	达到 max_tokens 或上下文上限
tool_calls	模型选择调用工具
content_filter	内容被合规审核拦截
结构化输出
当业务需要对模型输出进行结构化解析时，可以设置response_format参数为 {'type': 'json_object'}，使模型按照指定的 JSON 格式返回内容。

注意事项：

在 system 或 user 提示词中明确包含 json 关键字，并提供期望的 JSON 格式示例，以引导模型生成合法且符合预期结构的 JSON

合理设置 max_tokens，避免输出内容因长度限制被截断，导致内容不完整

复制
{
  "model": "sensenova-6.8-flash",
  "messages": [
    { "role": "system", "content": "你是一个智能助手，回答内容需要以JSON格式输出。" },
    { "role": "user", "content": "介绍一下商汤科技" }
  ],
  "response_format": { "type": "json_object" }
}
参数推荐
参数 / 实践	建议	说明
max_tokens	普通任务 2048~4096；思考模式建议 ≥ 4096	思考内容和输出共享 max_tokens配额
stream	长文本生成建议开启	避免请求超时，提升响应体验
多轮对话	按时间顺序回传必要的对话历史，保留每条消息的 role 和 content；通常无需回传 reasoning。涉及工具调用时，还需保留助手消息中的 tool_calls，以及工具结果消息中的 tool_call_id 和 content	保持上下文及工具调用关联完整。历史过长时可进行摘要或裁剪，但应保留配套的工具调用与结果，避免关联断裂
模型选择	日常任务推荐使用轻量高效的 sensenova-6.8-flash-lite，复杂长链路及专业交付任务推荐使用性能更强、端到端执行能力更优的 sensenova-6.8-flash	sensenova-6.8-flash 在复杂任务规划、长链路自主执行、深度信息分析及多工具协同方面能力更强，能够稳定完成更高质量的端到端专业交付