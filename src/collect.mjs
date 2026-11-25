// collect.mjs — pull a week of merged PRs and closed issues from GitHub.
//
// Uses the GraphQL search API, so one token covers any mix of repos and orgs the
// token can read. Avatars are inlined as data URIs so the render needs no network.
import { execFileSync } from 'node:child_process';

const BOTS = /(\[bot\]$|[-_]bot$|^bot[-_]|^dependabot|^renovate|^github-actions|^codecov|^pre-commit-ci|^copilot|^mergify|^allcontributors)/i;

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
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'shipreel' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw new Error(`GitHub API: ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return body.data;
}

const PR_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url body mergedAt additions deletions changedFiles
      repository { nameWithOwner }
      author { login avatarUrl(size: 160) ... on User { name } }
      labels(first: 8) { nodes { name } }
    } }
  }
}`;

const ISSUE_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    issueCount
    nodes { ... on Issue { number title url closedAt repository { nameWithOwner } } }
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

async function inline(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const type = r.headers.get('content-type') ?? 'image/png';
    return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * @param {{repos?: string[], org?: string, since: Date, until: Date, token: string}} o
 */
export async function collect({ repos = [], org, since, until, token }) {
  if (!repos.length && !org) throw new Error('Pass --repo owner/name (one or more) or --org name.');
  const scope = [...repos.map((r) => `repo:${r}`), ...(org ? [`org:${org}`] : [])].join(' ');
  const range = `${day(since)}..${day(until)}`;

  const prs = [];
  let after = null;
  for (let page = 0; page < 6; page++) { // 300 PRs is plenty for one video
    const d = await gql(token, PR_QUERY, { q: `${scope} is:pr is:merged merged:${range} sort:updated-desc`, after });
    prs.push(...d.search.nodes.filter((n) => n && n.number));
    if (!d.search.pageInfo.hasNextPage) break;
    after = d.search.pageInfo.endCursor;
  }
  const issues = await gql(token, ISSUE_QUERY, { q: `${scope} is:issue is:closed reason:completed closed:${range}` });

  const humans = prs.filter((p) => p.author && !BOTS.test(p.author.login));
  const people = new Map();
  for (const p of humans) {
    const k = p.author.login;
    const cur = people.get(k) ?? { login: k, name: p.author.name || k, avatarUrl: p.author.avatarUrl, prs: 0, additions: 0, deletions: 0 };
    cur.prs++; cur.additions += p.additions; cur.deletions += p.deletions;
    people.set(k, cur);
  }
  const avatars = {};
  await Promise.all([...people.values()].map(async (p) => { avatars[p.login] = await inline(p.avatarUrl); }));

  return {
    scope: org ? org : repos.join(', '),
    repos: [...new Set(prs.map((p) => p.repository.nameWithOwner))],
    since: since.toISOString(),
    until: until.toISOString(),
    prs: humans.map((p) => ({
      number: p.number,
      repo: p.repository.nameWithOwner,
      title: p.title,
      url: p.url,
      author: p.author.login,
      mergedAt: p.mergedAt,
      additions: p.additions,
      deletions: p.deletions,
      files: p.changedFiles,
      labels: p.labels.nodes.map((l) => l.name),
      body: (p.body ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+\n/g, '\n').trim().slice(0, 1200),
    })),
    botPrs: prs.length - humans.length,
    issuesClosed: issues.search.issueCount,
    issues: issues.search.nodes.filter(Boolean).map((i) => ({ number: i.number, title: i.title, repo: i.repository.nameWithOwner })),
    people: [...people.values()].sort((a, b) => b.prs - a.prs).map(({ avatarUrl, ...p }) => p),
    avatars,
  };
}
