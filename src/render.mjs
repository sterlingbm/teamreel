// render.mjs — lay the scenes on a timeline, seek the template frame by frame in
// headless Chromium, and pipe the frames plus the voice-over into ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'template', 'index.html');

// Minimum time each scene needs for its animation to finish, in seconds.
const MIN = {
  intro: () => 4.2, stats: () => 4.6, hero: (s) => 4 + 1.1 * s.points.length, outro: () => 3.6,
  list: (s) => 2.6 + 0.4 * s.items.length, shoutouts: (s) => 2.6 + 0.6 * s.people.length,
};
const LEAD = 0.45, TAIL = 0.7;

/** Give every scene start/end, and voStart/voLen for captions. */
export function timeline(story, voSecs) {
  let t = 0;
  for (const [i, s] of story.scenes.entries()) {
    const words = s.narration ? s.narration.split(/\s+/).length : 0;
    const speech = voSecs[i] || (words ? words / 2.6 : 0); // no voice: pace captions at reading speed
    const len = Math.max(MIN[s.type](s), speech ? LEAD + speech + TAIL : 0);
    Object.assign(s, { start: +t.toFixed(3), end: +(t + len).toFixed(3), voStart: speech ? +(t + LEAD).toFixed(3) : null, voLen: +speech.toFixed(3) });
    t += len;
  }
  return t;
}

function launchArgs() {
  const exe = process.env.TEAMREEL_CHROME;
  return { headless: true, ...(exe ? { executablePath: exe } : {}), args: ['--font-render-hinting=none', '--disable-lcd-text'] };
}

/** One JPEG per time in `times` (for review), or the full video when `times` is null. */
export async function render({ story, avatars, voSecs, dir, out, vertical = false, fps = 30, captions = true, mark = true, music, stills = null, log = () => {} }) {
  const duration = timeline(story, voSecs);
  const [W, H] = vertical ? [1080, 1920] : [1920, 1080];
  let browser;
  try {
    browser = await chromium.launch(launchArgs());
  } catch {
    try { browser = await chromium.launch({ ...launchArgs(), channel: 'chrome' }); } catch (e) { // fall back to an installed Google Chrome
    throw new Error(`Couldn't start Chromium (${e.message.split('\n')[0]}). Run \`npx playwright install chromium\` once, or set TEAMREEL_CHROME to a Chrome binary.`);
  } }
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + TEMPLATE, { waitUntil: 'load' });
  await page.evaluate(([s, a, o]) => window.__build(s, a, o), [story, avatars, { vertical, captions, mark }]);
  if (errors.length) throw new Error('template error: ' + errors.join('; '));

  if (stills) {
    const files = [];
    for (const t of stills) {
      await page.evaluate((x) => window.__seek(x), t);
      const f = path.join(dir, `still-${String(t).replace('.', '_')}.jpg`);
      await page.screenshot({ path: f, type: 'jpeg', quality: 85 });
      files.push(f);
    }
    await browser.close();
    return { duration, files };
  }

  const silent = path.join(dir, 'silent.mp4');
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((res, rej) => ff.on('close', (c) => (c ? rej(new Error('ffmpeg failed')) : res())));
  const frames = Math.ceil(duration * fps);
  const t0 = Date.now();
  for (let f = 0; f < frames; f++) {
    await page.evaluate((x) => window.__seek(x), f / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % (fps * 10) === 0) log(`frames ${f}/${frames}`);
  }
  ff.stdin.end();
  await ffDone;
  await browser.close();
  log(`rendered ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // voice-over: each scene's clip placed at its voStart, optional music bed underneath
  const clips = story.scenes.map((s, i) => ({ s, f: path.join(dir, `vo-${i}.wav`) })).filter(({ s, f }) => voSecs[story.scenes.indexOf(s)] && fs.existsSync(f));
  if (!clips.length && !music) { fs.renameSync(silent, out); return { duration, out }; }
  const inputs = ['-i', silent], filters = [], labels = [];
  clips.forEach(({ s, f }, k) => {
    inputs.push('-i', f);
    filters.push(`[${k + 1}:a]adelay=${Math.round(s.voStart * 1000)}|${Math.round(s.voStart * 1000)},aformat=channel_layouts=stereo[v${k}]`);
    labels.push(`[v${k}]`);
  });
  if (music) {
    const m = clips.length + 1;
    inputs.push('-stream_loop', '-1', '-i', music);
    filters.push(`[${m}:a]volume=${clips.length ? 0.14 : 0.5},afade=t=out:st=${Math.max(0, duration - 2.5).toFixed(2)}:d=2.5,aformat=channel_layouts=stereo[mu]`);
    labels.push('[mu]');
  }
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,atrim=0:${duration.toFixed(3)},loudnorm=I=-16:TP=-1.5[aout]`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', duration.toFixed(3), '-movflags', '+faststart', out]);
  fs.unlinkSync(silent);
  return { duration, out };
}
