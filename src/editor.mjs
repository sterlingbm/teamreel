// editor.mjs — read a team's week (PRs, tickets, Slack posts) and pick what the company
// should hear about: launches, a metric that moved, progress on a goal, who did it.
//
// The model chooses and phrases; code checks. Every signal it cites must exist, every
// person it credits must appear in those signals, and every number it puts on screen
// must be written in the cited source. Anything that fails is dropped, not "fixed".
import { complete, parseJson } from './llm.mjs';

const SYSTEM = `You are the editor of a short weekly video that tells a whole company what each team accomplished.
Viewers are everyone at the company: sales, finance, support, leadership, engineers on other teams. They want to know what changed for customers or the business, which numbers moved, how goals are tracking, and who made it happen.

From one team's week of signals (merged pull requests, finished Jira tickets, Slack posts), pick:
- launches: things that shipped that people outside the team would care about. Group several PRs/tickets that make up one feature into one launch. Headline in plain words from the user's or business's point of view ("Customers can now…", "Sales can now…", "Checkout now…"). Skip refactors, CI, dependency bumps, tests, internal tooling and small bug fixes unless they clearly matter to customers or the business. For pull requests, read the description and the file paths to judge what actually changed for users.
- metrics: a business or product number a signal states, with its before/after if stated.
- goals: progress toward a stated target, only if a signal gives both the current value and the target.
- people: who did it, by the ids given. Credit everyone on a launch's signals.
- next: what the team says is coming next, only if a signal says so.

Don't show the same fact twice: if a launch already carries a number (a deal size), pick a different metric or none.
A change between two percentages is in points ("+0.5 pts"), not percent, unless the source says otherwise.

Rules: use only what the signals say. Never invent numbers, customers, dates or impact. Copy numbers exactly as written in the source. No hype words (exciting, game-changing, seamless, robust, supercharge), no emoji, no exclamation marks. If the week has nothing worth company attention, return empty lists. Return JSON only.`;

function prompt(team, signals, people) {
  const name = (id) => people[id]?.name ?? id;
  const items = signals.slice(0, 120).map((s) => ({
    id: s.id, source: s.source, title: s.title, text: s.text.slice(0, 900),
    people: s.people.map((p) => `${p} (${name(p)})`),
    ...(s.media?.length ? { has_image: true } : {}),
    ...(s.source === 'github' ? { files: s.meta.files.slice(0, 25), size: `+${s.meta.additions}/-${s.meta.deletions}` } : {}),
    ...(s.source === 'slack' ? { channel: s.meta.channel, reactions: s.meta.reactions } : {}),
  }));
  return `Team: ${team.name}${team.about ? ` (${team.about})` : ''}

Signals (JSON):
${JSON.stringify(items)}

Return:
{
  "launches": [{ "kicker": "1-2 words: Shipped, Launched, Signed, Won, Hit, Opened…", "headline": "≤ 64 chars", "why": "≤ 90 chars, what it means for customers or the business", "signals": ["ids"], "people": ["person ids"], "image_from": "a signal id with has_image, or null" }],
  "metrics": [{ "label": "≤ 40 chars", "from": number or null, "to": number, "unit": "% | $ | $K | $M | x | (blank)", "delta": "≤ 28 chars, e.g. +16% or Biggest week of the year", "note": "≤ 60 chars", "signal": "id" }],
  "goals": [{ "goal": "≤ 56 chars", "current": number, "target": number, "unit": "% | $ | $K | $M | (blank)", "note": "≤ 60 chars", "signal": "id" }],
  "next": "≤ 60 chars or null",
  "next_signal": "id or null"
}
At most 2 launches, 1 metric, 1 goal. Order launches by how much the company would care.`;
}

/** Every way a number might be written in the source: 2.4 → "2.4", 14600000 → "14.6M", 81 → "81". */
function written(n, text) {
  if (n == null) return true;
  const t = text.replace(/,/g, '');
  const forms = [String(n), n.toFixed(1), n.toFixed(2)].map((f) => f.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1'));
  return forms.some((f) => new RegExp(`(^|[^\\d.])${f.replace('.', '\\.')}(?![\\d])`).test(t));
}

const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s ?? '');

export async function editTeam(team, signals, people, { llm, log = () => {} }) {
  if (!signals.length) return null;
  if (llm === 'none') return fallback(team, signals, people);
  let r;
  try {
    r = parseJson(await complete(llm, { system: SYSTEM, user: prompt(team, signals, people), maxTokens: 3000 }));
  } catch (e) {
    log(`${team.name}: editor failed (${e.message.slice(0, 140)}); using PR titles`);
    return fallback(team, signals, people);
  }
  const byId = new Map(signals.map((s) => [s.id, s]));
  const drop = (what, why) => log(`${team.name}: dropped ${what} (${why})`);

  const launches = [];
  for (const l of r.launches ?? []) {
    const src = (l.signals ?? []).map((id) => byId.get(id)).filter(Boolean);
    if (!src.length) { drop(`launch "${l.headline}"`, 'cites no real signal'); continue; }
    const allowed = new Set(src.flatMap((s) => s.people));
    const credited = (l.people ?? []).filter((p) => allowed.has(p));
    const img = byId.get(l.image_from);
    launches.push({
      kicker: short(l.kicker || 'Shipped', 18), headline: short(l.headline, 70), why: short(l.why, 96),
      people: (credited.length ? credited : [...allowed]).slice(0, 4),
      media: img?.media?.[0] ?? src.find((s) => s.media?.length)?.media[0] ?? null,
      links: src.map((s) => s.url).filter(Boolean),
    });
  }

  const metrics = [];
  for (const m of r.metrics ?? []) {
    const s = byId.get(m.signal);
    if (!s) { drop(`metric "${m.label}"`, 'cites no real signal'); continue; }
    if (!written(m.to, s.text) || !written(m.from, s.text)) { drop(`metric "${m.label}"`, `numbers ${m.from}→${m.to} not in ${s.id}`); continue; }
    metrics.push({ label: short(m.label, 44), from: m.from, to: m.to, unit: m.unit ?? '', delta: short(m.delta, 30), note: short(m.note, 64), people: s.people });
  }

  const goals = [];
  for (const g of r.goals ?? []) {
    const s = byId.get(g.signal);
    if (!s || !g.target) { drop(`goal "${g.goal}"`, 'no real signal or target'); continue; }
    if (!written(g.current, s.text) || !written(g.target, s.text)) { drop(`goal "${g.goal}"`, `numbers ${g.current}/${g.target} not in ${s.id}`); continue; }
    goals.push({ goal: short(g.goal, 60), current: g.current, target: g.target, unit: g.unit ?? '', pct: Math.round((100 * g.current) / g.target), note: short(g.note, 64) });
  }

  const next = r.next && byId.has(r.next_signal) ? short(r.next, 64) : null;
  if (!launches.length && !metrics.length && !goals.length) return null;
  return { team, launches: launches.slice(0, 2), metrics: metrics.slice(0, 1), goals: goals.slice(0, 1), next };
}

/** No model: the two biggest non-chore PRs/tickets as launches. */
function fallback(team, signals, people) {
  const chore = /^(chore|ci|docs|test|bump|revert|refactor|build)\b/i;
  const ranked = signals.filter((s) => !chore.test(s.title)).sort((a, b) => (b.meta?.additions ?? 0) - (a.meta?.additions ?? 0));
  if (!ranked.length) return null;
  return {
    team,
    launches: ranked.slice(0, 2).map((s) => ({ headline: short(s.title.replace(/^\w+(\(.+?\))?:\s*/, ''), 70), why: '', people: s.people.slice(0, 4), media: s.media?.[0] ?? null, links: [s.url].filter(Boolean) })),
    metrics: [], goals: [], next: null,
  };
}
