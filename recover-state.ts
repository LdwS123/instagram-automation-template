import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { Composio } from '@composio/core';

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) {
  console.error('Missing COMPOSIO_API_KEY in .env');
  process.exit(1);
}

const userId = process.env.COMPOSIO_USER_ID || 'instagram-reels-analytics';

const composio = new Composio({ apiKey });
const session: any = await composio.create(userId);

const data = JSON.parse(readFileSync('data/posts.json', 'utf-8'));
const myUsername: string = data.account?.username;

mkdirSync('state', { recursive: true });
let replied: Record<string, any> = {};
if (existsSync('state/replied.json')) {
  replied = JSON.parse(readFileSync('state/replied.json', 'utf-8'));
}
const before = Object.keys(replied).length;

console.log(`Starting state has ${before} entries.`);
console.log('Fetching ALL comments on ALL recent reels and marking as replied (so we never re-reply)...');

let added = 0;
for (const post of data.posts) {
  const r: any = await session.execute('INSTAGRAM_GET_IG_MEDIA_COMMENTS', {
    ig_media_id: post.id,
    fields: 'id,text,from,timestamp',
  });
  const comments = r?.data?.data?.data ?? r?.data?.data ?? [];
  if (!Array.isArray(comments)) continue;
  for (const c of comments) {
    if (!c?.id) continue;
    if (c?.from?.username === myUsername) continue;
    if (replied[c.id]) continue;
    replied[c.id] = {
      reply: '[backfilled]',
      at: new Date().toISOString(),
      commentText: (c.text || '').slice(0, 200),
      from: c?.from?.username || 'unknown',
    };
    added++;
  }
  process.stdout.write(`  +${added} new   \r`);
}

writeFileSync('state/replied.json', JSON.stringify(replied, null, 2));
console.log(`\nDone. Added ${added} entries. Total now: ${Object.keys(replied).length}.`);
