#!/usr/bin/env node
/**
 * wire 验证探测：两端点的 effort 枚举实测（验证清单第 1 项）。
 *
 * - Anthropic 端点：POST /v1/messages，effort 走 output_config.effort，
 *   none 走 thinking:{type:'disabled'}；anthropic-version 头照 proxy 配置。
 * - OpenAI 端点：POST /v1/chat/completions，effort 走 reasoning_effort（none 直接传）。
 * - key 从 ~/.dsh/.credentials.yaml 的 SENSENOVA_API_KEY ref 读（env 兜底），不打印。
 * - 每请求 max_tokens=1（省积分），请求间隔 3s（护 RPM）。
 * 输出：每档的 HTTP 状态 + 错误码/首行摘要，供 PLAN 验证清单填数。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = 'https://token.sensenova.cn';
const MODEL = 'sensenova-6.8-flash-lite';
const GAP_MS = 3000;

function loadKey() {
  if (process.env.SENSENOVA_API_KEY) return process.env.SENSENOVA_API_KEY;
  const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  const m = /^\s*SENSENOVA_API_KEY:\s*"?([^\s"]+)"?/m.exec(raw);
  if (!m) throw new Error('credentials.yaml 里找不到 SENSENOVA_API_KEY ref');
  return m[1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(label, url, headers, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let note = '';
    try {
      const j = JSON.parse(text);
      note = j.error?.message ?? j.error?.type ?? j.message ?? j.type ?? JSON.stringify(j).slice(0, 90);
    } catch { note = text.slice(0, 90); }
    console.log(`${res.status === 200 ? '✅' : '❌'} ${label.padEnd(38)} ${String(res.status).padEnd(4)} ${res.status === 200 ? 'OK' : note.slice(0, 110)}`);
  } catch (e) {
    console.log(`💥 ${label.padEnd(38)} NET ${e.message}`);
  }
  await sleep(GAP_MS);
}

const key = loadKey();
const bearer = { Authorization: `Bearer ${key}` };
const anthropicHeaders = { ...bearer, 'anthropic-version': '2023-06-01' };

console.log(`model=${MODEL}  每档 max_tokens=1  间隔=${GAP_MS}ms\n`);
console.log('— Anthropic /v1/messages（output_config.effort）—');
for (const eff of ['low', 'medium', 'high', 'xhigh', 'max']) {
  await probe(`anthropic effort=${eff}`, `${BASE}/v1/messages`, anthropicHeaders, {
    model: MODEL, max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: eff },
  });
}
await probe('anthropic thinking=disabled(none)', `${BASE}/v1/messages`, anthropicHeaders, {
  model: MODEL, max_tokens: 1,
  messages: [{ role: 'user', content: 'hi' }],
  thinking: { type: 'disabled' },
});

console.log('\n— OpenAI /v1/chat/completions（reasoning_effort）—');
for (const eff of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
  await probe(`openai reasoning_effort=${eff}`, `${BASE}/v1/chat/completions`, bearer, {
    model: MODEL, max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
    ...(eff !== 'high' ? { reasoning_effort: eff } : {}),
  });
}
