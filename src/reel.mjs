// reel.mjs — turn edited teams into the scene list for template/reel.html, and inline
// every face and screenshot as a data URI so rendering needs no network or auth.

const PALETTE = ['#6b4eff', '#ff5a1f', '#c6f432', '#00b3ff', '#ff3d8b', '#ffd84d', '#18c37e'];
const UNIT = { '%': '{}%', '$': '${}', '$K': '${}K', '$M': '${}M', x: '{}x', '': '{}' };
const dp = (n) => (String(n).split('.')[1] ?? '').length;
const fmt = (n, unit) => (UNIT[unit] ?? `{} ${unit}`).replace('{}', Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));

async function dataUri(src) {
  if (!src) return null;
  const url = typeof src === 'string' ? src : src.url;
  const headers = typeof src === 'object' && src.auth === 'slack' && process.env.SLACK_BOT_TOKEN ? { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } : {};
  try {
    const r = await fetch(url, { headers, redirect: 'follow' });
    const type = (r.headers.get('content-type') ?? '').split(';')[0];
    if (!r.ok || !type.startsWith('image/')) return null; // PR "assets" can be videos; skip those for now
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 6e6) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** One person across GitHub, Jira and Slack: matched by email, then by name. */
function unify(people) {
  const canon = new Map(), out = {};
  const key = (p) => (p.email ? `e:${p.email.toLowerCase()}` : `n:${(p.name || p.id).toLowerCase().replace(/[^a-z]/g, '')}`);
  for (const p of Object.values(people)) {
    const k = key(p);
    const cur = canon.get(k);
    // prefer the Slack profile (real photo, full name), then GitHub
    if (!cur || (p.id.startsWith('slack:') && !cur.id.startsWith('slack:'))) canon.set(k, { ...cur, ...p, title: p.title ?? cur?.title });
  }
  for (const p of Object.values(people)) out[p.id] = canon.get(key(p));
  return out;
}

export async function buildReel(edited, allPeople, { company, range, accent }) {
  const people = unify(allPeople);
  const used = new Set();
  const who = (ids) => [...new Set(ids.map((id) => people[id]).filter(Boolean))].map((p) => { used.add(p); return { name: p.name, login: p.id, role: p.title || '' }; });

  const scenes = [];
  const teams = edited.filter(Boolean);
  const launches = teams.reduce((a, t) => a + t.launches.length, 0);
  scenes.push({
    type: 'hook', dur: 3.2, date: range,
    lines: ['This week at', `${company}:`, `${launches} win${launches === 1 ? '' : 's'}. ${teams.length} team${teams.length === 1 ? '' : 's'}.`],
    highlight: [String(launches), String(teams.length)],
    caption: `What every team shipped, ${range}`,
  });

  for (const [i, t] of teams.entries()) {
    const color = t.team.color || PALETTE[i % PALETTE.length];
    const base = { team: t.team.name, color };
    scenes.push({ type: 'team', dur: 1.5, ...base, sub: t.team.about || `Team ${String(i + 1).padStart(2, '0')}` });
    for (const l of t.launches) {
      scenes.push({ type: 'launch', dur: 4.2, ...base, kicker: l.kicker || 'Shipped', headline: l.headline, people: who(l.people), image: await dataUri(l.media), caption: l.why || l.headline, links: l.links });
    }
    for (const m of t.metrics) {
      scenes.push({ type: 'metric', dur: 3.4, ...base, label: m.label, from: m.from ?? 0, to: m.to, dp: dp(m.to), fmt: UNIT[m.unit] ?? '{}', delta: m.delta, note: m.note,
        series: m.from != null ? [m.from, m.from, (m.from + m.to) / 2, m.to] : [0, m.to * 0.4, m.to * 0.7, m.to], caption: `${m.label}: ${fmt(m.to, m.unit)}${m.delta ? ` (${m.delta})` : ''}` });
    }
    for (const g of t.goals) {
      scenes.push({ type: 'goal', dur: 3.2, ...base, label: 'Goal', goal: g.goal, pct: Math.min(100, g.pct), note: `${fmt(g.current, g.unit)} of ${fmt(g.target, g.unit)}${g.note ? ` · ${g.note}` : ''}`, caption: `${g.pct}% of the way to: ${g.goal}` });
    }
    const crew = who([...new Set(t.launches.flatMap((l) => l.people))]).slice(0, 4);
    if (crew.length >= 2) scenes.push({ type: 'people', dur: 2.8, ...base, title: 'Made it happen', people: crew, caption: `Thanks ${crew.map((p) => p.name.split(' ')[0]).join(', ')}` });
  }

  const next = teams.filter((t) => t.next).slice(0, 3).map((t) => ({ team: t.team.name, text: t.next }));
  scenes.push({ type: 'outro', dur: next.length ? 4 : 2.6, line: "That's the week.", next, caption: next.length ? '' : `${company}, ${range}` });

  const avatars = {};
  await Promise.all([...used].map(async (p) => { avatars[p.id] = await dataUri(p.avatarUrl); }));
  return { story: { template: 'reel.html', title: `${company} this week`, team: company, range, accent, scenes }, avatars };
}

/** The Slack message that goes with the video: one line per launch, linked. */
export function reelSummary(story) {
  const lines = [`*${story.title}* · ${story.range}`];
  let team;
  for (const s of story.scenes) {
    if (s.type === 'team') { team = s.team; lines.push(`\n*${team}*`); }
    if (s.type === 'launch') lines.push(`• ${s.links?.[0] ? `<${s.links[0]}|${s.headline}>` : s.headline}${s.people?.length ? ` (${s.people.map((p) => p.name.split(' ')[0]).join(', ')})` : ''}`);
    if (s.type === 'metric') lines.push(`• ${s.caption}`);
    if (s.type === 'goal') lines.push(`• ${s.caption}`);
  }
  return lines.join('\n');
}
