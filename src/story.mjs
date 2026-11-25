// story.mjs — turn the week's data into a short story with one main thread.
//
// The model only chooses and phrases. Every number on screen is computed here, and
// every PR or person it names is checked against the data, so it can't invent work.
import { complete, parseJson } from './llm.mjs';

const fmtRange = (since, until) => {
  const o = { month: 'short', day: 'numeric' };
  const o2 = { ...o, timeZone: 'UTC' };
  return `${new Date(since).toLocaleDateString('en-US', o2)} – ${new Date(until).toLocaleDateString('en-US', o2)}`;
};
const short = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');
const key = (p) => `${p.repo}#${p.number}`;

function stats(data) {
  const lines = data.prs.reduce((a, p) => a + p.additions + p.deletions, 0);
  return [
    { value: data.prs.length, label: data.prs.length === 1 ? 'pull request merged' : 'pull requests merged' },
    { value: data.people.length, label: data.people.length === 1 ? 'person shipping' : 'people shipping' },
    ...(data.issuesClosed ? [{ value: data.issuesClosed, label: data.issuesClosed === 1 ? 'issue closed' : 'issues closed' }] : []),
    { value: lines, label: 'lines changed' },
  ].slice(0, 4);
}

const SYSTEM = `You write the script for a 60-second video that tells an engineering team what they shipped this week.
Write like a good internal newsletter editor: plain words, specific, warm, a little dry. No hype words (exciting, game-changing, supercharge, seamless, robust, leverage), no emoji, no exclamation marks.
Pick ONE main story (the hero): the change that matters most to users or to the team, not the biggest diff. The rest supports it.
Use only facts in the data. Never invent numbers, results, speedups, customers or impact the PR text doesn't state; that includes the closing line.
Only say a number if it appears in "Exact numbers" below, written exactly as given.
Narration is read aloud and the whole video should run about 60 seconds: keep to the word limits, short sentences, about 2.5 words per second of screen time, refer to people by first name or handle.
Return JSON only.`;

function prompt(data, opts) {
  const prs = data.prs.slice(0, 80).map((p) => ({
    id: key(p), title: p.title, author: p.author, size: `+${p.additions}/-${p.deletions}`, labels: p.labels,
    body: p.body.slice(0, 500),
  }));
  return `Team: ${opts.team || data.scope}
Week: ${fmtRange(data.since, data.until)}
People (login → name, PRs): ${data.people.map((p) => `${p.login} → ${p.name} (${p.prs})`).join('; ')}
Exact numbers: ${stats(data).map((x) => `${x.label} = ${x.value}`).join('; ')}
Issues closed: ${data.issuesClosed}${data.issues.length ? ` (e.g. ${data.issues.slice(0, 8).map((i) => i.title).join(' | ')})` : ''}

Merged PRs (JSON):
${JSON.stringify(prs)}

Return this JSON shape:
{
  "headline": "≤ 48 chars, the week in one line, built around the hero",
  "intro_narration": "≤ 18 words",
  "stats_narration": "≤ 12 words, natural, at most two of the exact numbers (they're all on screen)",
  "hero": { "id": "owner/repo#123", "title": "≤ 56 chars plain-English name for the change", "points": ["2-3 points, ≤ 64 chars each, what changed and why it matters, from the PR text"], "narration": "≤ 40 words" },
  "also": { "items": [{ "id": "owner/repo#456", "title": "≤ 52 chars plain-English" }], "narration": "≤ 30 words" },
  "shoutouts": { "people": [{ "login": "handle", "line": "≤ 44 chars, what they did" }], "narration": "≤ 22 words" },
  "outro": { "line": "≤ 40 chars closing line", "narration": "≤ 8 words" }
}
"also" has 3-6 items (fewer if the week is small), not including the hero. "shoutouts" has 2-4 people.`;
}

/** No model: a decent default story from the numbers alone. */
function fallback(data, opts) {
  const score = (p) => Math.log1p(p.additions + p.deletions) + (p.labels.some((l) => /feat|feature|enhancement/i.test(l)) ? 2 : 0) - (/^(chore|ci|docs|test|bump|revert)/i.test(p.title) ? 3 : 0);
  const ranked = [...data.prs].sort((a, b) => score(b) - score(a));
  const hero = ranked[0];
  return {
    headline: hero ? short(hero.title, 48) : 'A quiet week',
    intro_narration: `Here's what ${opts.team || 'the team'} shipped this week.`,
    stats_narration: `${data.people.length} people merged ${data.prs.length} pull requests.`,
    hero: hero && { id: key(hero), title: short(hero.title, 56), points: [], narration: `The biggest change was ${hero.title}, from ${hero.author}.` },
    also: { items: ranked.slice(1, 6).map((p) => ({ id: key(p), title: short(p.title, 52) })), narration: 'A few more things that landed.' },
    shoutouts: { people: data.people.slice(0, 3).map((p) => ({ login: p.login, line: '' })), narration: 'Thanks to everyone who shipped.' },
    outro: { line: "That's the week.", narration: "That's the week. See you next Friday." },
  };
}

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
/** Numbers a sentence states (digits and number words, "thirty four" → 34). */
function numbersIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\d[\d,]*/g)) out.push(Number(m[0].replace(/,/g, '')));
  const toks = String(text).toLowerCase().split(/[^a-z]+/);
  let run = null;
  for (const t of toks) {
    if (t in WORDS) run = (run ?? 0) + WORDS[t];
    else if (t === 'and' && run != null) continue;
    else if (run != null) { out.push(run); run = null; }
  }
  if (run != null) out.push(run);
  return out;
}
/** Keep a narration only if every number it says is one we know is true. */
function honest(text, allowed, fallbackText) {
  const bad = numbersIn(text).filter((n) => !allowed.has(n) && n !== 1);
  return bad.length ? fallbackText : text;
}

/** Check the model's picks against the data and build the scene list. */
function assemble(data, s, opts) {
  const byId = new Map(data.prs.map((p) => [key(p), p]));
  const resolve = (id) => {
    if (byId.has(id)) return byId.get(id);
    const n = Number(String(id).split('#').pop()); // "#123" or "123": fine if only one repo has that number
    const hits = data.prs.filter((p) => p.number === n);
    return hits.length === 1 ? hits[0] : undefined;
  };
  const person = (login) => data.people.find((p) => p.login.toLowerCase() === String(login).toLowerCase());
  const pr = (p) => ({ number: p.number, repo: p.repo, author: p.author, name: person(p.author)?.name ?? p.author, additions: p.additions, deletions: p.deletions, url: p.url });

  const scenes = [];
  scenes.push({ type: 'intro', kicker: `${opts.team || data.scope} · ${fmtRange(data.since, data.until)}`, headline: short(s.headline || 'This week', 60), people: data.people.slice(0, 12).map((p) => p.login), narration: s.intro_narration });
  scenes.push({ type: 'stats', items: stats(data), narration: s.stats_narration });

  const hp = s.hero && resolve(s.hero.id);
  if (hp) {
    scenes.push({ type: 'hero', ...pr(hp), title: short(s.hero.title || hp.title, 64), original: hp.title, points: (s.hero.points ?? []).slice(0, 3).map((x) => short(x, 72)), narration: s.hero.narration });
  }
  const seen = new Set(hp ? [key(hp)] : []);
  const also = (s.also?.items ?? []).map((i) => ({ i, p: resolve(i.id) })).filter(({ p }) => p && !seen.has(key(p)) && seen.add(key(p))).slice(0, 6)
    .map(({ i, p }) => ({ ...pr(p), title: short(i.title || p.title, 56) }));
  if (also.length) scenes.push({ type: 'list', heading: 'Also shipped', items: also, narration: s.also.narration });

  const shout = (s.shoutouts?.people ?? []).map((x) => ({ x, p: person(x.login) })).filter(({ p }) => p).slice(0, 4)
    .map(({ x, p }) => ({ login: p.login, name: p.name, prs: p.prs, line: short(x.line || '', 48) }));
  if (shout.length) scenes.push({ type: 'shoutouts', people: shout, narration: s.shoutouts.narration });

  scenes.push({ type: 'outro', line: short(s.outro?.line || "That's the week.", 44), repos: data.repos, narration: s.outro?.narration || "That's the week." });
  const allowed = new Set([...stats(data).map((x) => x.value), ...data.people.map((p) => p.prs), ...data.prs.map((p) => p.number)]);
  const plain = { intro: `Here's what ${opts.team || 'the team'} shipped this week.`, stats: `${data.people.length} people merged ${data.prs.length} pull requests.`, outro: "That's the week." };
  for (const sc of scenes) sc.narration = honest((sc.narration || '').trim(), allowed, plain[sc.type] ?? '');
  return { title: s.headline, team: opts.team || data.scope, range: fmtRange(data.since, data.until), accent: opts.accent, scenes };
}

export async function writeStory(data, { llm, team, accent, log = () => {}, raw = () => {} }) {
  if (!data.prs.length) {
    return assemble(data, { headline: 'A quiet week', intro_narration: 'No pull requests merged this week.', outro: { line: 'Back next week.', narration: 'Back next week.' } }, { team, accent });
  }
  let s;
  if (llm === 'none') {
    s = fallback(data, { team });
  } else {
    try {
      const text = await complete(llm, { system: SYSTEM, user: prompt(data, { team }) });
      raw(text);
      s = parseJson(text);
    } catch (e) {
      log(`script model failed (${e.message.slice(0, 160)}); using the plain version`);
      s = fallback(data, { team });
    }
  }
  return assemble(data, s, { team, accent });
}
