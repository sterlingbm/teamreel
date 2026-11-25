#!/usr/bin/env node
// teamreel — what every team shipped this week, as a short video posted to Slack.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { githubSignals, githubToken, parseSince } from './sources/github.mjs';
import { jiraSignals } from './sources/jira.mjs';
import { slackSignals, postReel } from './sources/slack.mjs';
import { pickLlm } from './llm.mjs';
import { editTeam } from './editor.mjs';
import { buildReel, reelSummary } from './reel.mjs';
import { render, timeline } from './render.mjs';

const HELP = `teamreel — what every team shipped this week, as a short video in Slack

Usage
  teamreel --config teamreel.json [options]
  teamreel --repo owner/name [--repo …] --team "Payments"     (one team, GitHub only)

Config (teamreel.json)
  { "company": "Acme", "post_to": "#company-updates",
    "teams": [ { "name": "Payments", "about": "9 people", "color": "#6b4eff",
                 "github": ["acme/payments"], "jira": { "projects": ["PAY"] }, "slack": ["#payments"] } ] }

Options
  --since 7d            window: 7d, 2w or a date (default 7d)
  --until <date>        window end (default now)
  --out ./teamreel-out  working files and the video
  --llm auto            anthropic | openai | gemini | none
  --music bed.mp3       music bed (you supply it)
  --vertical            1080x1920
  --post                post to the config's post_to channel when done
  --dry                 collect and edit only; write story.json
  --story story.json    render an edited story.json
  --stills              review frames instead of the video
  --fixtures dir        read sources from <dir>/{github,jira,slack}.json instead of the APIs

Keys: GITHUB_TOKEN, JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN, SLACK_BOT_TOKEN,
      ANTHROPIC_API_KEY | OPENAI_API_KEY | GEMINI_API_KEY
`;

const { values: o } = parseArgs({
  options: {
    config: { type: 'string' }, repo: { type: 'string', multiple: true, default: [] }, team: { type: 'string' },
    since: { type: 'string', default: '7d' }, until: { type: 'string' }, out: { type: 'string', default: 'teamreel-out' },
    llm: { type: 'string', default: 'auto' }, music: { type: 'string' }, vertical: { type: 'boolean', default: false },
    post: { type: 'boolean', default: false }, dry: { type: 'boolean', default: false }, story: { type: 'string' },
    stills: { type: 'boolean', default: false }, fixtures: { type: 'string' }, 'no-captions': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (o.help || (!o.config && !o.repo.length && !o.story)) { process.stdout.write(HELP); process.exit(o.help ? 0 : 2); }

const log = (m) => process.stderr.write(`teamreel: ${m}\n`);
const dir = path.resolve(o.out);
fs.mkdirSync(dir, { recursive: true });
const save = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
const config = o.config ? JSON.parse(fs.readFileSync(o.config, 'utf8'))
  : { company: o.team || o.repo.join(', '), teams: [{ name: o.team || 'Engineering', github: o.repo }] };

function fixture(source, team) {
  const f = path.join(o.fixtures, `${source}.json`);
  if (!fs.existsSync(f)) return { signals: [], people: {} };
  return JSON.parse(fs.readFileSync(f, 'utf8'))[team.name] ?? { signals: [], people: {} };
}

async function gather(team, since, until) {
  const jobs = [
    ['github', team.github?.length, () => githubSignals({ repos: team.github, since, until, token: githubToken() })],
    ['jira', team.jira?.projects?.length, () => jiraSignals({ jira: team.jira, since, until })],
    ['slack', team.slack?.length, () => slackSignals({ slack: team.slack, since, until })],
  ];
  const signals = [], people = {};
  for (const [name, wanted, run] of jobs) {
    const fx = o.fixtures ? fixture(name, team) : null;
    if (!wanted && !fx?.signals.length) continue;
    try {
      const r = fx?.signals.length ? fx : await run();
      signals.push(...r.signals);
      Object.assign(people, r.people);
      log(`${team.name}: ${r.signals.length} from ${name}${fx?.signals.length ? ' (fixture)' : ''}`);
    } catch (e) {
      log(`${team.name}: skipped ${name} (${e.message.slice(0, 160)})`);
    }
  }
  return { signals, people };
}

try {
  let story, avatars;
  const until = o.until ? new Date(o.until) : new Date();
  const since = parseSince(o.since, until);
  if (o.story) {
    story = JSON.parse(fs.readFileSync(o.story, 'utf8'));
    const av = path.join(path.dirname(path.resolve(o.story)), 'avatars.json');
    avatars = fs.existsSync(av) ? JSON.parse(fs.readFileSync(av, 'utf8')) : {};
  } else {
    const llm = pickLlm(o.llm);
    const allPeople = {};
    const edited = [];
    for (const team of config.teams) {
      const { signals, people } = await gather(team, since, until);
      Object.assign(allPeople, people);
      log(`${team.name}: editing ${signals.length} signals (${llm})`);
      edited.push(await editTeam(team, signals, people, { llm, log }));
    }
    save('edited.json', edited);
    if (!edited.some(Boolean)) throw new Error('Nothing worth a video this week: no team had a launch, metric or goal.');
    const o2 = { month: 'short', day: 'numeric', timeZone: 'UTC' };
    const range = `${since.toLocaleDateString('en-US', o2)} – ${until.toLocaleDateString('en-US', o2)}`;
    ({ story, avatars } = await buildReel(edited, allPeople, { company: config.company, range, accent: config.accent }));
    save('story.json', story);
    save('avatars.json', avatars);
    log(`story: ${story.scenes.length} scenes → ${path.join(dir, 'story.json')}`);
  }
  if (o.dry) process.exit(0);

  const voSecs = story.scenes.map(() => 0);
  const opts = { story, avatars, voSecs, dir, vertical: o.vertical, captions: !o['no-captions'], mark: false, music: o.music, log };
  if (o.stills) {
    const tmp = structuredClone(story);
    timeline(tmp, voSecs);
    const { files } = await render({ ...opts, stills: tmp.scenes.map((s) => +(s.end - 0.25).toFixed(2)) });
    log(`stills: ${files.length} in ${dir}`);
  } else {
    const out = path.join(dir, 'teamreel.mp4');
    const { duration } = await render({ ...opts, out });
    log(`done: ${out} (${duration.toFixed(1)}s)`);
    if (o.post) {
      if (!config.post_to) throw new Error('--post needs "post_to" in the config');
      await postReel({ channel: config.post_to, file: out, title: story.title, summary: reelSummary(story), readFile: fs.readFileSync });
      log(`posted to ${config.post_to}`);
    }
  }
} catch (e) {
  log(`error: ${e.message}`);
  process.exit(1);
}
