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

mkdirSync('state', { recursive: true });
let replied: Record<string, any> = {};
if (existsSync('state/replied.json')) {
  replied = JSON.parse(readFileSync('state/replied.json', 'utf-8'));
}

const before = Object.keys(replied).length;
console.log(`Checking ${before} entries in state/replied.json against IG to find which need re-replying...`);

const ids = Object.keys(replied);
const concurrency = 10;
let kept = 0;
let cleared = 0;
let realReplies = 0;
let i = 0;

async function processOne(commentId: string) {
  const entry = replied[commentId];
  if (entry?.reply !== '[backfilled]') {
    realReplies++;
    return;
  }
  try {
    const r: any = await session.execute('INSTAGRAM_GET_IG_COMMENT_REPLIES', {
      ig_comment_id: commentId,
    });
    const replies = r?.data?.data?.data ?? r?.data?.data ?? [];
    const hasReplies = Array.isArray(replies) && replies.length > 0;
    if (hasReplies) {
      kept++;
    } else {
      delete replied[commentId];
      cleared++;
    }
  } catch (err) {
    console.warn(`  ✗ failed for ${commentId}: ${(err as Error).message}`);
    kept++;
  }
}

while (i < ids.length) {
  const batch = ids.slice(i, i + concurrency);
  await Promise.all(batch.map((id) => processOne(id)));
  i += concurrency;
  process.stdout.write(`  processed ${i}/${ids.length} — kept(replied) ${kept}, cleared(no reply yet) ${cleared}\r`);
}

writeFileSync('state/replied.json', JSON.stringify(replied, null, 2));
console.log(`\nDone.`);
console.log(`  Real replies preserved: ${realReplies}`);
console.log(`  Backfilled comments kept (you already replied on IG): ${kept}`);
console.log(`  Backfilled comments cleared (no reply yet → bot will handle them): ${cleared}`);
console.log(`  Final state size: ${Object.keys(replied).length}`);
console.log(`\nThe ${cleared} cleared comments will be processed by auto-reply.ts at 20/hour.`);
