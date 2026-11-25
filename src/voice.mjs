// voice.mjs — read each scene's narration aloud, on the team's own key.
//
//   GEMINI_API_KEY → Gemini TTS   (SHIPREEL_VOICE default "Charon")
//   OPENAI_API_KEY → OpenAI TTS   (default "alloy")
//   none           → silent video with captions
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function pickVoice(choice = 'auto') {
  if (choice && choice !== 'auto') return choice;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

const STYLE = 'Warm, relaxed and clear, like a colleague giving a quick Friday recap. Unhurried.';

async function gemini(text) {
  // The style rides in a speech_metadata annotation; anything in the text itself gets read aloud.
  const voice = process.env.SHIPREEL_VOICE || 'Charon';
  const models = (process.env.SHIPREEL_TTS_MODEL || 'gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts').split(',');
  let last;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, stream: false,
          input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: STYLE }] }] }],
          response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 24000 },
          generation_config: { speech_config: [{ voice: voice.toLowerCase() }] },
        }),
      });
      if (res.ok) {
        const d = await res.json();
        const data = (d.steps ?? []).flatMap((st) => st.content ?? []).find((c) => c.data)?.data;
        if (!data) { last = new Error('no audio in answer'); break; }
        return { wav: Buffer.from(data, 'base64') };
      }
      last = new Error(`gemini tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
    }
  }
  throw last;
}

async function openai(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.SHIPREEL_TTS_MODEL || 'gpt-4o-mini-tts', voice: process.env.SHIPREEL_VOICE || 'alloy',
      input: text, instructions: STYLE, response_format: 'pcm' }),
  });
  if (!res.ok) throw new Error(`openai tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { pcm: Buffer.from(await res.arrayBuffer()), rate: 24000 };
}

/** Write <dir>/vo-<i>.wav for each scene with narration; returns seconds per scene (0 = none). */
export async function voiceScenes(scenes, dir, provider, log = () => {}) {
  if (provider === 'none') return scenes.map(() => 0);
  const say = provider === 'gemini' ? gemini : provider === 'openai' ? openai : null;
  if (!say) throw new Error(`unknown voice provider "${provider}"`);
  return Promise.all(scenes.map(async (s, i) => {
    if (!s.narration) return 0;
    try {
      const r = await say(s.narration);
      const raw = path.join(dir, `vo-${i}.raw`), wav = path.join(dir, `vo-${i}.wav`);
      fs.writeFileSync(raw, r.wav ?? r.pcm);
      const input = r.wav ? ['-i', raw] : ['-f', 's16le', '-ar', String(r.rate), '-ac', '1', '-i', raw];
      // trim leading/trailing silence so scenes stay tight
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse', '-ar', '48000', '-ac', '1', wav]);
      fs.unlinkSync(raw);
      return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], { encoding: 'utf8' }));
    } catch (e) {
      log(`voice for scene ${i + 1} failed (${e.message.slice(0, 120)}); that scene will be captions only`);
      return 0;
    }
  }));
}
