// sources/github.mjs — merged PRs for a team's repos, as signals the editor can read.
//
// Each PR carries its description, the files it touched (so the editor can tell a
// product change from plumbing) and any screenshots or recordings in its description.
import { execFileSync } from 'node:child_process';

const BOTS = /(\[bot\]$|[-_]bot$|^bot[-_]|^dependabot|^renovate|^github-actions|^codecov|^pre-commit-ci|^copilot|^mergify|^allcontributors)/i;
const MEDIA = /https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+|https:\/\/[^\s)"'<>]+\.(?:png|jpe?g|gif|webp)/gi;

export function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('No GitHub token. Set GITHUB_TOKEN (or log in with `gh auth login`).');
  }
}

async function gql(token, query, variables) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'teamreel' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status >= 500) { await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); continue; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors) throw new Error(`GitHub API: ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
    return body.data;
  }
  throw new Error('GitHub API kept failing (5xx)');
}

const PR_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 25, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url body mergedAt additions deletions
      repository { nameWithOwner }
      author { login avatarUrl(size: 200) ... on User { name } }
      labels(first: 8) { nodes { name } }
      files(first: 40) { nodes { path } }
    } }
  }
}`;

const day = (d) => d.toISOString().slice(0, 10);

/** Parse "7d", "14d", "2w" or an ISO date into a Date. */
export function parseSince(s, now = new Date()) {
  const m = /^(\d+)\s*([dw])$/.exec(s ?? '7d');
  if (m) return new Date(now.getTime() - Number(m[1]) * (m[2] === 'w' ? 7 : 1) * 86400e3);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Can't read --since "${s}". Use 7d, 2w or a date like 2026-11-16.`);
  return d;
}

/** Signals for one team: [{source:'github', id, title, text, people, url, date, media, meta}] + people map. */
export async function githubSignals({ repos, since, until, token, max = 150 }) {
  if (!repos?.length) return { signals: [], people: {} };
  const scope = repos.map((r) => `repo:${r}`).join(' ');
  const prs = [];
  let after = null;
  while (prs.length < max) {
    const d = await gql(token, PR_QUERY, { q: `${scope} is:pr is:merged merged:${day(since)}..${day(until)} sort:updated-desc`, after });
    prs.push(...d.search.nodes.filter((n) => n && n.number));
    if (!d.search.pageInfo.hasNextPage) break;
    after = d.search.pageInfo.endCursor;
  }
  const people = {};
  const signals = [];
  for (const p of prs) {
    if (!p.author || BOTS.test(p.author.login)) continue;
    const login = p.author.login;
    people[login] ??= { id: login, name: p.author.name || login, avatarUrl: p.author.avatarUrl };
    const body = (p.body ?? '').replace(/<!--[\s\S]*?-->/g, '');
    signals.push({
      source: 'github',
      id: `${p.repository.nameWithOwner}#${p.number}`,
      title: p.title,
      text: body.replace(MEDIA, '[image]').replace(/<img[^>]*>/g, '[image]').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500),
      people: [login],
      url: p.url,
      date: p.mergedAt,
      media: [...new Set(body.match(MEDIA) ?? [])].slice(0, 4),
      meta: { additions: p.additions, deletions: p.deletions, labels: p.labels.nodes.map((l) => l.name), files: p.files.nodes.map((f) => f.path) },
    });
  }
  return { signals, people };
}
