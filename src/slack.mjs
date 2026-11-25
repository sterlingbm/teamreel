// slack.mjs — upload the video to a channel with a short summary.
// Needs a bot token (SLACK_BOT_TOKEN) with files:write, invited to the channel.
import fs from 'node:fs';
import path from 'node:path';

async function api(token, method, body, form = false) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...(form ? {} : { 'content-type': 'application/json; charset=utf-8' }) },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(`Slack ${method}: ${d.error}`);
  return d;
}

export function summary(story) {
  const hero = story.scenes.find((s) => s.type === 'hero');
  const also = story.scenes.find((s) => s.type === 'list');
  const lines = [`*${story.title}* · ${story.team}, ${story.range}`];
  if (hero) lines.push(`• <${hero.url}|${hero.title}> (${hero.name})`);
  for (const it of also?.items ?? []) lines.push(`• <${it.url}|${it.title}> (${it.name})`);
  return lines.join('\n');
}

export async function postToSlack({ token, channel, file, story }) {
  const bytes = fs.readFileSync(file);
  const name = path.basename(file);
  const up = await api(token, 'files.getUploadURLExternal', { filename: name, length: String(bytes.length) }, true);
  const put = await fetch(up.upload_url, { method: 'POST', body: bytes });
  if (!put.ok) throw new Error(`Slack upload failed: ${put.status}`);
  await api(token, 'files.completeUploadExternal', {
    files: [{ id: up.file_id, title: story.title }],
    channel_id: channel,
    initial_comment: summary(story),
  });
}
