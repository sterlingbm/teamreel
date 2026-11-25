// sources/slack.mjs — read a team's public channels, and post the finished reel.
//
//   SLACK_BOT_TOKEN with channels:history, channels:read, users:read, files:read, files:write.
//   Invite the bot to each channel it should read or post in.
// Team config: { "slack": ["#payments", "#payments-launches"] }

async function api(token, method, params = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1000 * Number(res.headers.get('retry-after') || 2))); continue; }
    const d = await res.json();
    if (!d.ok) throw new Error(`Slack ${method}: ${d.error}`);
    return d;
  }
  throw new Error(`Slack ${method}: rate limited`);
}

let channelIndex;
async function channelId(token, name) {
  if (/^[CG][A-Z0-9]+$/.test(name)) return name;
  if (!channelIndex) {
    channelIndex = new Map();
    let cursor;
    do {
      const d = await api(token, 'conversations.list', { limit: 1000, exclude_archived: true, types: 'public_channel', ...(cursor ? { cursor } : {}) });
      for (const c of d.channels) channelIndex.set(c.name, c.id);
      cursor = d.response_metadata?.next_cursor;
    } while (cursor);
  }
  const id = channelIndex.get(name.replace(/^#/, ''));
  if (!id) throw new Error(`Slack channel ${name} not found (is it public?)`);
  return id;
}

const users = new Map();
async function user(token, id) {
  if (!users.has(id)) {
    const u = (await api(token, 'users.info', { user: id })).user;
    users.set(id, { id: `slack:${id}`, name: u.profile.real_name || u.real_name || u.name, avatarUrl: u.profile.image_192, email: u.profile.email, title: u.profile.title, bot: u.is_bot });
  }
  return users.get(id);
}

/** Replace <@U123> mentions with names so the editor reads plain text. */
async function plain(token, text, mentioned) {
  const ids = [...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1]);
  for (const id of ids) {
    const u = await user(token, id).catch(() => null);
    if (u) { text = text.replaceAll(`<@${id}>`, `@${u.name}`); mentioned.push(u); }
  }
  return text.replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2').replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1').replace(/<(https?:[^>]+)>/g, '$1');
}

export async function slackSignals({ slack, since, until, token = process.env.SLACK_BOT_TOKEN }) {
  if (!slack?.length) return { signals: [], people: {} };
  if (!token) throw new Error('Reading Slack needs SLACK_BOT_TOKEN');
  const people = {}, signals = [];
  for (const name of slack) {
    const channel = await channelId(token, name);
    let cursor;
    do {
      const d = await api(token, 'conversations.history', { channel, oldest: since.getTime() / 1000, latest: until.getTime() / 1000, limit: 200, ...(cursor ? { cursor } : {}) });
      for (const m of d.messages) {
        if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'file_share') continue;
        if (!m.user || (m.text ?? '').length < 25) continue;
        const author = await user(token, m.user);
        if (author.bot) continue;
        const mentioned = [];
        const text = await plain(token, m.text, mentioned);
        for (const p of [author, ...mentioned]) people[p.id] ??= p;
        const reactions = (m.reactions ?? []).reduce((a, r) => a + r.count, 0);
        signals.push({
          source: 'slack',
          id: `${name}/${m.ts}`,
          title: `${author.name} in ${name}`,
          text: text.slice(0, 1500),
          people: [author.id, ...mentioned.map((p) => p.id)],
          url: null,
          date: new Date(Number(m.ts) * 1000).toISOString(),
          media: (m.files ?? []).filter((f) => /^image\//.test(f.mimetype)).map((f) => ({ url: f.url_private, auth: 'slack' })).slice(0, 3),
          meta: { channel: name, reactions, replies: m.reply_count ?? 0 },
        });
      }
      cursor = d.response_metadata?.next_cursor;
    } while (cursor);
  }
  return { signals, people };
}

/** Upload the finished video to a channel with a short text summary. */
export async function postReel({ channel, file, title, summary, token = process.env.SLACK_BOT_TOKEN, readFile }) {
  const bytes = readFile(file);
  const id = await channelId(token, channel);
  const up = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: new URLSearchParams({ filename: 'teamreel.mp4', length: String(bytes.length) }),
  }).then((r) => r.json());
  if (!up.ok) throw new Error(`Slack upload: ${up.error}`);
  const put = await fetch(up.upload_url, { method: 'POST', body: bytes });
  if (!put.ok) throw new Error(`Slack upload failed: ${put.status}`);
  const done = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ files: [{ id: up.file_id, title }], channel_id: id, initial_comment: summary }),
  }).then((r) => r.json());
  if (!done.ok) throw new Error(`Slack post: ${done.error}`);
}
