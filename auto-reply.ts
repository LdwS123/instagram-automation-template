import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { Composio } from '@composio/core';
import OpenAI from 'openai';

const composioKey = process.env.COMPOSIO_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
if (!composioKey) {
  console.error('Missing COMPOSIO_API_KEY in .env');
  process.exit(1);
}
if (!openaiKey) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

const userId = process.env.COMPOSIO_USER_ID || 'instagram-reels-analytics';
const SEND = process.argv.includes('--send');
const LIMIT = Number(process.env.LIMIT || 8);
const SLEEP_MS = Number(process.env.SLEEP_MS || 4000);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const SKIP_RECENT_MIN = Number(process.env.SKIP_RECENT_MIN || 30);
const MAX_PER_HOUR = Number(process.env.MAX_PER_HOUR || 12);

console.log(`Mode: ${SEND ? 'LIVE' : 'DRY-RUN'}`);
console.log(`Limits: max ${LIMIT}/run · ${MAX_PER_HOUR}/hour · skip comments < ${SKIP_RECENT_MIN} min old · ${SLEEP_MS}ms between posts`);

const composio = new Composio({ apiKey: composioKey });
const openai = new OpenAI({ apiKey: openaiKey });
const session: any = await composio.create(userId);

type Post = { id: string; caption: string; permalink: string; timestamp: string; insights: Record<string, number> };
type Account = { username?: string; name?: string; biography?: string };
const data = JSON.parse(readFileSync('data/posts.json', 'utf-8')) as { posts: Post[]; account: Account };
const myUsername = data.account?.username;
const myBio = data.account?.biography || '';

mkdirSync('data', { recursive: true });
mkdirSync('state', { recursive: true });
let replied: Record<string, { reply: string; at: string; commentText: string; from: string; post_id?: string; post_permalink?: string }> = {};
if (existsSync('state/replied.json')) {
  replied = JSON.parse(readFileSync('state/replied.json', 'utf-8'));
}

const oneHourAgo = Date.now() - 60 * 60 * 1000;
const repliedLastHour = Object.values(replied).filter(
  (r) => r.reply !== '[backfilled]' && new Date(r.at).getTime() > oneHourAgo
).length;
console.log(`Already replied in last hour: ${repliedLastHour}/${MAX_PER_HOUR}`);
if (repliedLastHour >= MAX_PER_HOUR) {
  console.log(`Hourly cap hit. Exiting cleanly. Next run will retry.`);
  process.exit(0);
}
const remainingThisHour = MAX_PER_HOUR - repliedLastHour;
const effectiveLimit = Math.min(LIMIT, remainingThisHour);
console.log(`This run: max ${effectiveLimit} new replies.`);

const ranked = [...data.posts].sort((a, b) => (b.insights?.reach || 0) - (a.insights?.reach || 0));
const voiceExamples = ranked
  .slice(0, 5)
  .map((p, i) => `Sample ${i + 1} (caption excerpt):\n${(p.caption || '').slice(0, 400)}`)
  .join('\n\n');

async function ig(slug: string, args: Record<string, any>) {
  const r = await session.execute(slug, args);
  if (r?.error) throw new Error(`${slug}: ${r.error}`);
  return r.data;
}

const SYSTEM_PROMPT = `You are the creator @${myUsername}. You reply to comments on your own Instagram reels in YOUR voice. Output ONLY the reply text — no quotes, no preamble.

YOUR BIO: ${myBio.replace(/\n/g, ' · ').slice(0, 220)}

YOUR VOICE — study these caption samples carefully:

${voiceExamples}

LENGTH (hard cap):
- Default: 4 to 10 words. ONE line.
- Max 12 words ever. NEVER 2 sentences unless absolutely necessary (rare).
- A bare "👀" or "for real" or "this aged poorly" is fine if it lands.

VOICE FINGERPRINT to copy:
- Dry, confident, founder/SF/AI-coded. Lightly sarcastic. Real talk.
- Drops references like "Claude", "Cursor", "Anthropic", "Dario", "shipped", "stack", "founder".
- Uses casual contractions ("ain't", "gonna", "ngl"). Lowercase often. Sparse punctuation.
- Emoji rare and weighted (1 max, often 0). NO 🙏, NO 🚀, NO multi-emoji chains.
- NEVER "Thanks!", "Appreciate it!", "Great point!", "Glad you liked it!". Generic gratitude is FORBIDDEN.

QUESTIONS BACK — context-driven:
- Emoji-only or 1-3 word comments: NO question. Just a punchy line.
- Substantive comments (a real opinion, a question, a take): you may end with a SPECIFIC question tied to what they actually said. About 1 in 3 substantive replies should have one.
- BANNED generic questions: "what's your stack?", "what are you building?", "what do you think?", "what's it replacing?". Never use these. Be specific to their words or skip the question.

SPAM / PROMO DETECTION — important:
- If the comment plugs a brand/tool you don't recognize ("PaperBleach", random "best AI tool"), that's a promo bot. NEVER acknowledge the product, NEVER repeat its name, NEVER ask follow-up questions about it.
- Reply with a SHORT dismissal in different shapes — vary across replies:
  • "👀"
  • "noted"
  • "interesting"
  • "we'll see"
  • "respectfully no"
  • "not on the list for a reason"
  • "good for you"
  • "moving on"
  • "save it"
  • "ok, sure"
  • or an empty-but-classy 3-word brush-off in the same vibe
- Never recommend, validate, endorse, or get curious about a product you don't already know.
- ABSOLUTELY NEVER invent or recommend an alternative brand/tool name. If you don't recognize a tool from the comment, do not name any other tool in your reply. Just dismiss without mentioning competitors.
- Hostile / troll: same family — short, dignified, slightly witty if it lands. Never insult.

LANGUAGE:
- Reply in the SAME language as the comment. Spanish → Spanish. French → French. Portuguese → Portuguese.

VARIETY:
- Do NOT reuse the same opening 3 words across replies. No "Just trying to keep up", "Appreciate the hype", "Sounds like" repeated.
- Each reply should feel hand-written — different rhythm, different angle.

EMOJI-ONLY COMMENTS (e.g. "👏👏", "🔥🔥🔥", "😍"):
- Reply with a single beat that references the reel's actual topic OR a specific founder/tool OR a self-deprecating one-liner. NEVER "thanks".
- Pick ONE — vary across replies, do not repeat the same line:
  • "claude wrote this one tbh"
  • "this one wrote itself ngl"
  • "wait till next week 👀"
  • "the SF tap water is hitting"
  • "dario keeps making it too easy"
  • "anthropic dropped this in my lap"
  • "felt that one writing it"
  • "this aged 30 minutes"
  • "we're so back"
  • "the timeline writes itself rn"
  • "one of those weeks 😮‍💨"
  • or invent a fresh one in the same register
- Match emoji intensity loosely: 0 or 1 emoji max in your reply.

NO hashtags. NO links. NO "DM me". NO pitches. NO sign-offs.`;

async function generateReply(commentText: string, fromUsername: string, postCaption: string): Promise<string> {
  const userMsg = `Reel caption (excerpt):\n${postCaption.slice(0, 250)}\n\nComment from @${fromUsername}:\n"${commentText}"\n\nWrite my reply.`;
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    temperature: 1.0,
    presence_penalty: 0.7,
    frequency_penalty: 0.5,
    max_tokens: 80,
  });
  let out = completion.choices[0]?.message?.content?.trim() || '';
  out = out.replace(/^["'`]+|["'`]+$/g, '').trim();
  return out;
}

let processed = 0;
let totalNew = 0;

for (const post of data.posts) {
  if (processed >= effectiveLimit) break;

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

  const skipBefore = Date.now() - SKIP_RECENT_MIN * 60 * 1000;
  const newOnes = comments.filter((c: any) => {
    if (!c?.id || replied[c.id]) return false;
    if (c?.from?.username === myUsername) return false;
    if (c.timestamp && new Date(c.timestamp).getTime() > skipBefore) return false;
    return true;
  });
  if (newOnes.length === 0) continue;

  console.log(`\n📝 ${post.permalink}  (${newOnes.length} new of ${comments.length} total)`);

  for (const c of newOnes) {
    if (processed >= effectiveLimit) break;

    const commentText: string = (c.text || '').trim();
    const fromUsername: string = c?.from?.username || 'unknown';
    if (!commentText) continue;

    let reply = '';
    try {
      reply = await generateReply(commentText, fromUsername, post.caption || '');
    } catch (err) {
      console.warn(`  ✗ OpenAI failed for @${fromUsername}: ${(err as Error).message}`);
      continue;
    }
    if (!reply || reply.length > 300) {
      console.warn(`  ✗ Skipping bad reply for @${fromUsername} (len=${reply.length})`);
      continue;
    }

    console.log(`  @${fromUsername}: "${commentText.slice(0, 80)}"`);
    console.log(`     → "${reply}"`);

    if (SEND) {
      try {
        await ig('INSTAGRAM_POST_IG_COMMENT_REPLIES', { ig_comment_id: c.id, message: reply });
        console.log(`     ✓ posted`);
      } catch (err) {
        console.warn(`     ✗ post failed: ${(err as Error).message}`);
        continue;
      }
    }

    replied[c.id] = {
      reply,
      at: new Date().toISOString(),
      commentText,
      from: fromUsername,
      post_id: post.id,
      post_permalink: post.permalink,
    };
    writeFileSync('state/replied.json', JSON.stringify(replied, null, 2));
    processed++;
    totalNew++;
    if (SEND && processed < effectiveLimit) {
      await new Promise((res) => setTimeout(res, SLEEP_MS));
    }
  }
}

console.log(`\nDone. ${totalNew} replies ${SEND ? 'posted' : 'previewed'}.`);
console.log(`Tracked: state/replied.json (${Object.keys(replied).length} total).`);
if (!SEND && totalNew > 0) console.log('\nTo actually post: npm run reply:send');
