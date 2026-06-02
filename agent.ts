import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Composio } from '@composio/core';

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) {
  console.error('Missing COMPOSIO_API_KEY. Paste it into ./.env and re-run.');
  process.exit(1);
}

const userId = process.env.COMPOSIO_USER_ID || 'instagram-reels-analytics';

const composio = new Composio({ apiKey });

console.log('Opening Composio Tool Router session...');
const session: any = await composio.create(userId);

console.log('Checking Instagram connection...');
const accounts: any = await composio.connectedAccounts.list({
  userIds: [userId],
  toolkitSlugs: ['instagram'],
});
const active = (accounts?.items ?? []).find((a: any) => a.status === 'ACTIVE');

if (!active) {
  const conn = await session.authorize('instagram');
  console.log('\n--- Instagram authorization required ---');
  if (conn.redirectUrl) {
    console.log(`AUTH_URL: ${conn.redirectUrl}`);
    console.log('\nClick the link, log into Instagram, approve, then re-run: npm run report');
  } else {
    console.log('No redirect URL returned. Status:', conn.status);
  }
  process.exit(1);
}
console.log(`Instagram connection: ACTIVE (${active.id})`);

const DAYS = 30;
const now = new Date();
const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59, 999));
const start = new Date(end.getTime() - DAYS * 24 * 60 * 60 * 1000);
console.log(`Window: ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)} (${DAYS} days, ending yesterday)`);

async function ig(slug: string, args: Record<string, any>): Promise<any> {
  const r = await session.execute(slug, args);
  if (r?.error) throw new Error(`${slug}: ${r.error}`);
  return r.data;
}

console.log('\nFetching account info...');
const userInfoRes: any = await ig('INSTAGRAM_GET_USER_INFO', {
  ig_user_id: 'me',
  fields: 'id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url',
});
const account = userInfoRes?.data ?? userInfoRes;
console.log(`  @${account.username} · ${account.followers_count?.toLocaleString() ?? '?'} followers · ${account.media_count} total media`);

console.log('\nFetching recent media...');
let allMedia: any[] = [];
let after: string | undefined;
for (let page = 0; page < 4; page++) {
  const args: Record<string, any> = {
    ig_user_id: 'me',
    limit: 50,
    fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,duration',
  };
  if (after) args.after = after;
  const res: any = await ig('INSTAGRAM_GET_IG_USER_MEDIA', args);
  const items = res?.data?.data ?? res?.data ?? [];
  allMedia.push(...items);
  const nextCursor = res?.data?.paging?.cursors?.after ?? res?.paging?.cursors?.after;
  if (!nextCursor || items.length < 50) break;
  if (items.length && new Date(items[items.length - 1].timestamp) < start) break;
  after = nextCursor;
}
console.log(`  fetched ${allMedia.length} media total across pages`);

const reels = allMedia.filter((m: any) => {
  const isReel = m.media_type === 'VIDEO' || m.media_product_type === 'REELS';
  const ts = new Date(m.timestamp);
  return isReel && ts >= start && ts <= end;
});
console.log(`  ${reels.length} reels in window`);

console.log('\nFetching insights for each reel (parallel)...');
const FULL_METRICS = 'reach,views,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time';
const FALLBACK_METRICS = 'reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time';

async function getInsights(mediaId: string): Promise<Record<string, number>> {
  const tryWith = async (metric: string) => {
    const res: any = await session.execute('INSTAGRAM_GET_IG_MEDIA_INSIGHTS', { ig_media_id: mediaId, metric });
    if (res?.error) return null;
    const items = res?.data?.data?.data ?? res?.data?.data ?? [];
    const out: Record<string, number> = {};
    for (const m of items) {
      const v = Array.isArray(m.values) ? m.values[0]?.value : m.value;
      if (typeof v === 'number') out[m.name] = v;
      else if (v && typeof v === 'object') out[m.name] = (Object.values(v) as number[]).find((n) => typeof n === 'number') ?? 0;
    }
    return out;
  };
  let result = await tryWith(FULL_METRICS);
  if (!result || Object.keys(result).length === 0) result = await tryWith(FALLBACK_METRICS);
  return result || {};
}

const insightsResults = await Promise.all(
  reels.map(async (m: any, i: number) => {
    const ins = await getInsights(m.id);
    process.stdout.write(`  insights ${i + 1}/${reels.length}\r`);
    return ins;
  })
);
console.log(`  ✓ ${reels.length} insights done`.padEnd(40));

const posts = reels.map((m: any, i: number) => ({
  id: m.id,
  caption: m.caption || '',
  permalink: m.permalink,
  thumbnail_url: m.thumbnail_url || m.media_url || '',
  timestamp: m.timestamp,
  media_type: m.media_type,
  duration: typeof m.duration === 'number' ? m.duration : null,
  insights: insightsResults[i],
}));

mkdirSync('data', { recursive: true });
const out = {
  fetched_at: new Date().toISOString(),
  window_days: DAYS,
  window_start: start.toISOString(),
  window_end: end.toISOString(),
  account: {
    id: account.id,
    username: account.username,
    name: account.name,
    biography: account.biography,
    followers_count: account.followers_count,
    follows_count: account.follows_count,
    media_count: account.media_count,
    profile_picture_url: account.profile_picture_url,
  },
  posts,
};
writeFileSync('data/posts.json', JSON.stringify(out, null, 2));
console.log(`\nSaved ${posts.length} posts -> data/posts.json`);
