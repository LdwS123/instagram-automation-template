import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { Composio } from '@composio/core';

// ─────────────────────────────────────────────────────────────────────────
// Build → DM bot (ManyChat-style).
// When someone comments the keyword ("build") on one of your reels, the bot:
//   1. sends them a private DM with your Emergent link, and
//   2. (optionally) posts a short public reply ("Check your DMs 📩").
// Tracks everything in state/build-dm.json so nobody gets messaged twice.
// ─────────────────────────────────────────────────────────────────────────

const composioKey = process.env.COMPOSIO_API_KEY;
if (!composioKey) {
  console.error('Missing COMPOSIO_API_KEY in .env');
  process.exit(1);
}

// ── Config you can tweak ───────────────────────────────────────────────────
// The link the DM points people to. Set EMERGENT_LINK in .env (or the workflow)
// — never hardcode anything secret here, a referral link is fine to keep public.
const EMERGENT_LINK = process.env.EMERGENT_LINK || 'https://app.emergent.sh/register?ref=YOUR_REF_CODE';

// The trigger keyword. Matched case-insensitively, anywhere in the comment
// ("build", "Build", "let's build", "BUILD IT" all match).
const KEYWORD = (process.env.KEYWORD || 'build').toLowerCase();

// The private DM that gets sent. {link} is replaced with EMERGENT_LINK.
// Short & direct, and it leads with the free-credits offer — edit freely.
const DM_TEMPLATE =
  process.env.DM_TEMPLATE ||
  `Yo! 🙌 Wanna build your own app like in the reel? Sign up with my link and you get 5 free credits to start on Emergent: {link}\n\nBuild something and tag me 👀`;

// Public replies posted under the comment. One is picked at random so the
// comment section doesn't look copy-pasted. Edit / add your own lines.
const PUBLIC_REPLIES = (process.env.PUBLIC_REPLIES?.split('|') ?? [
  'just slid into your DMs 📩',
  'check your DMs 👀',
  'sent you the link in DMs 📩',
  'dropped it in your DMs ✅',
]).map((s) => s.trim()).filter(Boolean);

// ── Run knobs (same family as auto-reply.ts) ───────────────────────────────
const userId = process.env.COMPOSIO_USER_ID || 'instagram-reels-analytics';
const SEND = process.argv.includes('--send');
const LIMIT = Number(process.env.LIMIT || 8);            // max new people per run
const MAX_PER_HOUR = Number(process.env.MAX_PER_HOUR || 10);
const SKIP_RECENT_MIN = Number(process.env.SKIP_RECENT_MIN || 0); // act fast on fresh comments
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 7); // IG private-reply window
const SLEEP_MS = Number(process.env.SLEEP_MS || 5000);
const REPLY_PUBLICLY = process.env.REPLY_PUBLICLY !== 'false'; // default: yes

console.log(`Mode: ${SEND ? 'LIVE' : 'DRY-RUN'}`);
console.log(`Keyword: "${KEYWORD}" · link: ${EMERGENT_LINK}`);
console.log(`Limits: max ${LIMIT}/run · ${MAX_PER_HOUR}/hour · only comments < ${MAX_AGE_DAYS}d old · public reply: ${REPLY_PUBLICLY}`);

const composio = new Composio({ apiKey: composioKey });
const session: any = await composio.create(userId);

async function ig(slug: string, args: Record<string, any>) {
  const r = await session.execute(slug, args);
  if (r?.error) throw new Error(`${slug}: ${r.error}`);
  return r.data;
}

type Post = { id: string; caption: string; permalink: string; timestamp: string };
type Account = { username?: string };

const SCAN_POSTS = Number(process.env.SCAN_POSTS || 25);

// Load recent posts. Prefer the rich data/posts.json (from agent.ts) when it
// exists; otherwise self-fetch a lightweight list (no insights) so this script
// can run on its own, every few minutes, without the heavy refresh step.
async function loadPosts(): Promise<{ posts: Post[]; account: Account }> {
  if (existsSync('data/posts.json')) {
    return JSON.parse(readFileSync('data/posts.json', 'utf-8'));
  }
  const info: any = await ig('INSTAGRAM_GET_USER_INFO', { ig_user_id: 'me', fields: 'id,username,name,biography' });
  const account = (info?.data ?? info) as Account;
  const mediaRes: any = await ig('INSTAGRAM_GET_IG_USER_MEDIA', {
    ig_user_id: 'me',
    limit: SCAN_POSTS,
    fields: 'id,caption,permalink,timestamp',
  });
  const items: any[] = mediaRes?.data?.data ?? mediaRes?.data ?? [];
  // Scan the most recent SCAN_POSTS posts regardless of their age — the
  // per-comment age filter (MAX_AGE_DAYS) decides who actually gets DM'd, so a
  // fresh "build" comment on an older post is still caught.
  const posts: Post[] = items.map((m) => ({ id: m.id, caption: m.caption || '', permalink: m.permalink, timestamp: m.timestamp }));
  mkdirSync('data', { recursive: true });
  writeFileSync('data/posts.json', JSON.stringify({ fetched_at: new Date().toISOString(), account, posts }, null, 2));
  return { posts, account };
}

const data = await loadPosts();
const myUsername = data.account?.username;

mkdirSync('state', { recursive: true });

type DmEntry = {
  from: string;
  from_id?: string;
  commentText: string;
  at: string;
  post_id?: string;
  post_permalink?: string;
  dm_text: string;
  dm_status: 'sent' | 'failed' | 'skipped' | 'dry-run';
  dm_error?: string;
  public_reply?: string;
  public_status?: 'sent' | 'failed' | 'skipped' | 'dry-run';
};

let processedState: Record<string, DmEntry> = {};
if (existsSync('state/build-dm.json')) {
  processedState = JSON.parse(readFileSync('state/build-dm.json', 'utf-8'));
}

// Hourly cap: count DMs we actually sent (or attempted) in the last 60 min.
const oneHourAgo = Date.now() - 60 * 60 * 1000;
const sentLastHour = Object.values(processedState).filter(
  (e) => e.dm_status === 'sent' && new Date(e.at).getTime() > oneHourAgo
).length;
console.log(`Already DM'd in last hour: ${sentLastHour}/${MAX_PER_HOUR}`);
if (sentLastHour >= MAX_PER_HOUR) {
  console.log('Hourly cap hit. Exiting cleanly. Next run will retry.');
  process.exit(0);
}
const effectiveLimit = Math.min(LIMIT, MAX_PER_HOUR - sentLastHour);
console.log(`This run: max ${effectiveLimit} new people.`);

// Strip @mentions before matching, so the account's own handle (e.g.
// @your_ig_handle — which literally contains "build") never triggers a false hit.
// We only care about the keyword in what the person actually wrote.
function matchesKeyword(text: string): boolean {
  const withoutHandles = text.replace(/@[\w.]+/g, ' ');
  return withoutHandles.toLowerCase().includes(KEYWORD);
}

function buildDmText(): string {
  return DM_TEMPLATE.replace('{link}', EMERGENT_LINK);
}

function pickPublicReply(): string {
  return PUBLIC_REPLIES[Math.floor(Math.random() * PUBLIC_REPLIES.length)] || 'check your DMs 📩';
}

// Composio's INSTAGRAM_SEND_TEXT_MESSAGE param shape isn't documented publicly,
// so we try the most likely shapes in order and stop at the first that works.
// Only retry the next shape on a *validation* error (bad params) — not on
// permission / rate errors, which another shape won't fix.
async function sendDM(recipientId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const candidates: Record<string, any>[] = [
    { recipient_id: recipientId, text },
    { recipient_id: recipientId, message: text },
    { ig_user_id: 'me', recipient_id: recipientId, text },
    { recipient: { id: recipientId }, message: { text } },
  ];
  let lastError = '';
  for (const args of candidates) {
    try {
      await ig('INSTAGRAM_SEND_TEXT_MESSAGE', args);
      return { ok: true };
    } catch (err) {
      lastError = (err as Error).message;
      const looksLikeBadParams = /param|required|invalid|unexpected|schema|propert|missing|body/i.test(lastError);
      if (!looksLikeBadParams) break; // permission/rate/etc — stop trying shapes
    }
  }
  return { ok: false, error: lastError };
}

const skipBefore = SKIP_RECENT_MIN > 0 ? Date.now() - SKIP_RECENT_MIN * 60 * 1000 : Date.now();
const tooOldBefore = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

let processed = 0;

for (const post of data.posts) {
  if (processed >= effectiveLimit) break;

  // Fetch comments (paginated, same approach as auto-reply.ts).
  let comments: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < 4; page++) {
    const args: Record<string, any> = {
      ig_media_id: post.id,
      fields: 'id,text,from,timestamp,like_count,hidden',
      limit: 50,
    };
    if (after) args.after = after;
    const r: any = await ig('INSTAGRAM_GET_IG_MEDIA_COMMENTS', args);
    const items = r?.data?.data ?? r?.data ?? [];
    if (!Array.isArray(items) || items.length === 0) break;
    comments.push(...items);
    const nextCursor = r?.paging?.cursors?.after ?? r?.data?.paging?.cursors?.after;
    if (!nextCursor || items.length < 50) break;
    after = nextCursor;
  }
  if (comments.length === 0) continue;

  const matches = comments.filter((c: any) => {
    if (!c?.id || processedState[c.id]) return false;             // already handled
    if (c?.from?.username === myUsername) return false;            // not your own comment
    const text = (c.text || '').trim();
    if (!text || !matchesKeyword(text)) return false;             // must contain keyword
    const ts = c.timestamp ? new Date(c.timestamp).getTime() : Date.now();
    if (ts > skipBefore) return false;                            // too recent (if SKIP_RECENT_MIN set)
    if (ts < tooOldBefore) return false;                          // outside DM window
    return true;
  });
  if (matches.length === 0) continue;

  console.log(`\n📝 ${post.permalink}  (${matches.length} "${KEYWORD}" comment(s))`);

  for (const c of matches) {
    if (processed >= effectiveLimit) break;

    const commentText: string = (c.text || '').trim();
    const fromUsername: string = c?.from?.username || 'unknown';
    const fromId: string | undefined = c?.from?.id;
    const dmText = buildDmText();
    const publicReply = REPLY_PUBLICLY ? pickPublicReply() : undefined;

    console.log(`  @${fromUsername}: "${commentText.slice(0, 80)}"`);
    console.log(`     → DM: "${dmText.replace(/\n/g, ' ').slice(0, 90)}…"`);
    if (publicReply) console.log(`     → public: "${publicReply}"`);

    const entry: DmEntry = {
      from: fromUsername,
      from_id: fromId,
      commentText,
      at: new Date().toISOString(),
      post_id: post.id,
      post_permalink: post.permalink,
      dm_text: dmText,
      dm_status: 'dry-run',
      public_reply: publicReply,
      public_status: publicReply ? 'dry-run' : 'skipped',
    };

    if (SEND) {
      // 1) Private DM
      if (!fromId) {
        entry.dm_status = 'skipped';
        entry.dm_error = 'no recipient id on comment (account may not expose it)';
        console.log(`     ✗ DM skipped: no recipient id`);
      } else {
        const res = await sendDM(fromId, dmText);
        entry.dm_status = res.ok ? 'sent' : 'failed';
        entry.dm_error = res.error;
        console.log(res.ok ? `     ✓ DM sent` : `     ✗ DM failed: ${res.error}`);
      }
      // 2) Public reply (always reliable — same call the auto-reply bot uses)
      if (publicReply) {
        try {
          await ig('INSTAGRAM_POST_IG_COMMENT_REPLIES', { ig_comment_id: c.id, message: publicReply });
          entry.public_status = 'sent';
          console.log(`     ✓ public reply posted`);
        } catch (err) {
          entry.public_status = 'failed';
          console.log(`     ✗ public reply failed: ${(err as Error).message}`);
        }
      }
    }

    // Only persist on a live send — a dry-run must not mark people as handled,
    // otherwise the real send would skip them.
    if (SEND) {
      processedState[c.id] = entry;
      writeFileSync('state/build-dm.json', JSON.stringify(processedState, null, 2));
    }
    processed++;
    if (SEND && processed < effectiveLimit) {
      await new Promise((res) => setTimeout(res, SLEEP_MS));
    }
  }
}

const sentCount = Object.values(processedState).filter((e) => e.dm_status === 'sent').length;
console.log(`\nDone. ${processed} new ${SEND ? 'handled' : 'previewed'} this run.`);
console.log(`Tracked: state/build-dm.json (${Object.keys(processedState).length} total, ${sentCount} DMs sent).`);
if (!SEND && processed > 0) console.log('\nTo actually send: npm run build-dm:send');
