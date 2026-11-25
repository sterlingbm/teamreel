// sources/jira.mjs — work a team finished in Jira Cloud this week.
//
//   JIRA_BASE_URL=https://acme.atlassian.net  JIRA_EMAIL=you@acme.com  JIRA_API_TOKEN=...
// Team config: { "jira": { "projects": ["PAY"], "jql": "optional extra filter" } }

const auth = () => {
  const { JIRA_BASE_URL: base, JIRA_EMAIL: email, JIRA_API_TOKEN: token } = process.env;
  if (!base || !email || !token) throw new Error('Jira needs JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN');
  return { base: base.replace(/\/$/, ''), header: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64') };
};

/** Atlassian Document Format → plain text. */
function adf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'mention') return node.attrs?.text ?? '';
  const inner = (node.content ?? []).map(adf).join(node.type === 'doc' || node.type === 'bulletList' ? '\n' : '');
  return ['paragraph', 'heading', 'listItem'].includes(node.type) ? inner + '\n' : inner;
}

const day = (d) => d.toISOString().slice(0, 10);

export async function jiraSignals({ jira, since, until }) {
  if (!jira?.projects?.length) return { signals: [], people: {} };
  const { base, header } = auth();
  const scope = `project in (${jira.projects.map((p) => `"${p}"`).join(',')}) AND statusCategory = Done`;
  const extra = jira.jql ? ` AND (${jira.jql})` : '';
  const window = (field) => ` AND ${field} >= "${day(since)}" AND ${field} <= "${day(until)} 23:59"`;
  const run = async (jql) => {
    const issues = [], seen = new Set();
    let next;
    do {
      const res = await fetch(`${base}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { authorization: header, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ jql, maxResults: 100, ...(next ? { nextPageToken: next } : {}), fields: ['summary', 'description', 'issuetype', 'assignee', 'parent', 'labels', 'statuscategorychangedate', 'resolutiondate'] }),
      });
      if (!res.ok) { const e = new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`); e.status = res.status; throw e; }
      const d = await res.json();
      issues.push(...d.issues);
      next = d.isLast === false || d.nextPageToken ? d.nextPageToken : null;
      if (next && seen.has(next)) break; // some sites hand back the same token forever
      if (next) seen.add(next);
    } while (next && issues.length < 300);
    return issues;
  };
  let issues;
  try {
    issues = await run(`${scope}${window('statusCategoryChangedDate')}${extra} ORDER BY priority DESC`);
  } catch (e) {
    if (e.status !== 400) throw e;
    issues = await run(`${scope}${window('resolved')}${extra} ORDER BY priority DESC`); // older sites: resolution date
  }

  const people = {};
  const signals = issues.map((i) => {
    const f = i.fields, a = f.assignee;
    if (a) people[`jira:${a.accountId}`] ??= { id: `jira:${a.accountId}`, name: a.displayName, avatarUrl: a.avatarUrls?.['48x48'], email: a.emailAddress };
    return {
      source: 'jira',
      id: i.key,
      title: `${f.issuetype?.name ?? 'Issue'}: ${f.summary}`,
      text: [f.parent ? `Part of: ${f.parent.fields?.summary ?? f.parent.key}` : '', adf(f.description).trim()].filter(Boolean).join('\n').slice(0, 1200),
      people: a ? [`jira:${a.accountId}`] : [],
      url: `${base}/browse/${i.key}`,
      date: f.statuscategorychangedate ?? f.resolutiondate,
      media: [], // Jira attachments need auth to fetch; screenshots usually live in the PR anyway
      meta: { type: f.issuetype?.name, labels: f.labels, epic: f.parent?.fields?.summary },
    };
  });
  return { signals, people };
}
