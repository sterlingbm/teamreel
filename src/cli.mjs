#!/usr/bin/env node
// teamreel — a week of merged PRs → a 60-second video update.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { collect, githubToken, parseSince } from './collect.mjs';
import { pickLlm } from './llm.mjs';
import { writeStory } from './story.mjs';
import { pickVoice, voiceScenes } from './voice.mjs';
import { render } from './render.mjs';
import { postToSlack } from './slack.mjs';

const HELP = `teamreel — turn a week of merged PRs into a short video update

Usage
  teamreel --repo owner/name [--repo owner/other] [options]
  teamreel --org acme [options]

Options
  --since 7d            window start: 7d, 2w or a date (default 7d)
  --until <date>        window end (default now)
  --team "Payments"     name shown in the video (default: the repos)
  --out ./teamreel-out  where the video and its working files go
  --llm auto            anthropic | openai | gemini | none  (auto = first key found)
  --voice auto          gemini | openai | none              (auto = first key found)
  --vertical            1080x1920 instead of 1920x1080
  --accent "#ff7a45"    accent colour
  --music bed.mp3       optional music bed (you supply the file)
  --no-captions         hide the on-screen captions
  --no-mark             hide "made with teamreel" on the last frame
  --story story.json    skip collecting and writing; render an edited story
  --stills              write review frames instead of the full video
  --slack <channel-id>  post the video to Slack (needs SLACK_BOT_TOKEN)
  --dry                 collect and write the story, don't render

Keys (bring your own; nothing is sent anywhere else)
  GITHUB_TOKEN (or gh auth login), ANTHROPIC_API_KEY | OPENAI_API_KEY | GEMINI_API_KEY, SLACK_BOT_TOKEN
`;

const { values: o } = parseArgs({
  options: {
    repo: { type: 'string', multiple: true, default: [] }, org: { type: 'string' },
    since: { type: 'string', default: '7d' }, until: { type: 'string' }, team: { type: 'string' },
    out: { type: 'string', default: 'teamreel-out' }, llm: { type: 'string', default: 'auto' }, voice: { type: 'string', default: 'auto' },
    vertical: { type: 'boolean', default: false }, accent: { type: 'string' }, music: { type: 'string' },
    'no-captions': { type: 'boolean', default: false }, 'no-mark': { type: 'boolean', default: false },
    story: { type: 'string' }, stills: { type: 'boolean', default: false }, slack: { type: 'string' }, dry: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (o.help || (!o.repo.length && !o.org && !o.story)) { process.stdout.write(HELP); process.exit(o.help ? 0 : 2); }

const log = (m) => process.stderr.write(`teamreel: ${m}\n`);
const dir = path.resolve(o.out);
fs.mkdirSync(dir, { recursive: true });
const save = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));

try {
  let story, avatars;
  if (o.story) {
    story = JSON.parse(fs.readFileSync(o.story, 'utf8'));
    avatars = JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(o.story)), 'data.json'), 'utf8')).avatars ?? {};
  } else {
    const until = o.until ? new Date(o.until) : new Date();
    const since = parseSince(o.since, until);
    log(`collecting ${o.org ? `org ${o.org}` : o.repo.join(', ')}, ${since.toISOString().slice(0, 10)} → ${until.toISOString().slice(0, 10)}`);
    const data = await collect({ repos: o.repo, org: o.org, since, until, token: githubToken() });
    avatars = data.avatars;
    save('data.json', data);
    log(`${data.prs.length} PRs from ${data.people.length} people, ${data.issuesClosed} issues closed`);
    const llm = pickLlm(o.llm);
    log(`writing the story (${llm === 'none' ? 'no model, plain version' : llm})`);
    story = await writeStory(data, { llm, team: o.team, accent: o.accent, log, raw: (t) => fs.writeFileSync(path.join(dir, 'model.txt'), t) });
    save('story.json', story);
  }
  if (o.accent) story.accent = o.accent;
  if (o.dry) { log(`story written to ${path.join(dir, 'story.json')}`); process.exit(0); }

  const voice = o.stills ? 'none' : pickVoice(o.voice);
  if (voice !== 'none') log(`recording the voice-over (${voice})`);
  const voSecs = await voiceScenes(story.scenes, dir, voice, log);

  const opts = { story, avatars, voSecs, dir, vertical: o.vertical, captions: !o['no-captions'], mark: !o['no-mark'], music: o.music, log };
  if (o.stills) {
    // one frame near the end of each scene, where everything has animated in
    const tmp = structuredClone(story);
    const { timeline } = await import('./render.mjs');
    timeline(tmp, voSecs);
    const { files } = await render({ ...opts, stills: tmp.scenes.map((s) => +(s.end - 0.5).toFixed(2)) });
    log(`stills: ${files.join(', ')}`);
  } else {
    const out = path.join(dir, 'teamreel.mp4');
    const { duration } = await render({ ...opts, out });
    save('story.json', story);
    log(`done: ${out} (${duration.toFixed(1)}s)`);
    if (o.slack) {
      if (!process.env.SLACK_BOT_TOKEN) throw new Error('--slack needs SLACK_BOT_TOKEN');
      await postToSlack({ token: process.env.SLACK_BOT_TOKEN, channel: o.slack, file: out, story });
      log(`posted to Slack channel ${o.slack}`);
    }
  }
} catch (e) {
  log(`error: ${e.message}`);
  process.exit(1);
}
