// music.mjs — an upbeat instrumental bed for the reel, made on the team's Gemini key.
// Skipped without GEMINI_API_KEY; pass --music file.mp3 to use your own track instead.
import fs from 'node:fs';
import path from 'node:path';

const PROMPT = (secs) => [
  'Instrumental only, no vocals.',
  `Music bed about ${Math.round(secs)} seconds long for a fast-cut company update video.`,
  'Style: confident modern electronic pop, punchy drums, driving bass, bright synth stabs, around 122 BPM, upbeat and clean.',
  'Consistent energy from the first second, no long intro, no breakdowns or silences. End on a clean final hit.',
].join(' ');

export async function makeMusic(seconds, dir, log = () => {}) {
  if (!process.env.GEMINI_API_KEY) return null;
  const models = (process.env.TEAMREEL_MUSIC_MODEL || 'lyria-3.5,lyria-3-clip-preview').split(',');
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: PROMPT(seconds), response_format: { type: 'audio' } }),
      }).catch(() => null);
      if (res?.ok) {
        const d = await res.json();
        const data = (d.steps ?? []).flatMap((s) => s.content ?? []).find((c) => c.data);
        if (!data) break;
        const ext = /mp3|mpeg/.test(data.mime_type ?? '') ? 'mp3' : 'wav';
        const f = path.join(dir, `music.${ext}`);
        fs.writeFileSync(f, Buffer.from(data.data, 'base64'));
        return f;
      }
      if (res && res.status !== 429 && res.status < 500) { log(`music: ${model} ${res.status}, trying the next one`); break; }
      await new Promise((r) => setTimeout(r, 4000 * 2 ** attempt));
    }
  }
  log('music: no track this time (the reel renders without one)');
  return null;
}
