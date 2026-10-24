#!/usr/bin/env node
/**
 * wire 验证探测 2：/v1/messages 流式 + 工具调用端到端（验证清单第 2 项）。
 * 打印收到的事件类型序列与 content_block 种类、usage 合并结果、stop_reason。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const key = process.env.SENSENOVA_API_KEY
  ?? (/^\s*SENSENOVA_API_KEY:\s*"?([^\s"]+)"?/m.exec(readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')))[1];

const res = await fetch('https://token.sensenova.cn/v1/messages', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'sensenova-6.8-flash-lite',
    max_tokens: 300,
    stream: true,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: '上海今天天气怎么样？必须调用工具查。' }],
    tools: [{ name: 'get_weather', description: '查询城市天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    tool_choice: { type: 'auto' },
  }),
});

console.log('HTTP', res.status);
if (!res.ok) { console.log((await res.text()).slice(0, 300)); process.exit(1); }

const events = [];
const blockTypes = [];
let buf = '';
for await (const chunk of res.body) {
  buf += new TextDecoder().decode(chunk);
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
    const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    try {
      const ev = JSON.parse(dataLine.slice(5));
      if (ev.type) events.push(ev.type);
      if (ev.type === 'content_block_start') blockTypes.push(`${ev.index}:${ev.content_block?.type}`);
      if (ev.type === 'message_delta') console.log('message_delta:', JSON.stringify(ev.delta), 'usage:', JSON.stringify(ev.usage));
      if (ev.type === 'error') console.log('ERROR EVENT:', JSON.stringify(ev).slice(0, 200));
    } catch { /* 非 JSON 帧忽略 */ }
  }
}
console.log('事件序列:', events.join(' → '));
console.log('内容块:', blockTypes.join(', '));
