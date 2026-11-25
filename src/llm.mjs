// llm.mjs — one text call, whichever provider the team brought a key for.
//
//   ANTHROPIC_API_KEY  → Claude      (TEAMREEL_MODEL default claude-sonnet-5-5)
//   OPENAI_API_KEY     → OpenAI      (default gpt-5-mini)
//   GEMINI_API_KEY     → Gemini      (default gemini-3.8-flash)
//
// Force one with --llm anthropic|openai|gemini|none.

export function pickLlm(choice = 'auto') {
  if (choice && choice !== 'auto') return choice;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'none';
}

async function post(url, headers, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    const text = await res.text();
    if (res.status !== 429 && res.status < 500) throw new Error(`${new URL(url).host} ${res.status}: ${text.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw new Error(`${new URL(url).host} did not answer`);
}

/** Returns the model's text. `system` and `user` are plain strings. */
export async function complete(provider, { system, user, maxTokens = 4000 }) {
  const model = process.env.TEAMREEL_MODEL;
  if (provider === 'anthropic') {
    const d = await post('https://api.anthropic.com/v1/messages',
      { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model: model || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
    return d.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  if (provider === 'openai') {
    const d = await post('https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      { model: model || 'gpt-5-mini', response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    return d.choices[0].message.content;
  }
  if (provider === 'gemini') {
    const m = model || 'gemini-3.8-flash';
    const d = await post(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
      { 'x-goog-api-key': process.env.GEMINI_API_KEY },
      { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens } });
    return (d.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  }
  throw new Error(`unknown LLM provider "${provider}"`);
}

/** Pull the first JSON object out of a model answer (tolerates ```json fences). */
export function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('model did not return JSON');
  return JSON.parse(text.slice(s, e + 1));
}
