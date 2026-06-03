/**
 * Affiliate Comment → DM bot — Cloudflare Worker.
 *
 * Runs on a 1-minute cron with sub-minute polling (~15s effective latency).
 * Each tick:
 *   1. fetches your most recent posts + comments via Composio's REST API,
 *   2. checks each comment against EVERY campaign keyword (first match wins),
 *   3. DMs that person the campaign's link + posts a public reply,
 *   4. records them in KV so nobody is messaged twice.
 *
 * To add a new partnership: push a new entry to CAMPAIGNS and redeploy.
 *
 * No Node SDK here (Workers run V8 isolates), so we call Composio's REST API
 * directly with fetch. Slugs/args were verified against the live API.
 */

const TOOLS_URL = 'https://backend.composio.dev/api/v3/tools/execute';

// ── Campaigns ──────────────────────────────────────────────────────────────
// One entry per partnership. Order matters: if a comment matches multiple
// keywords, the FIRST campaign wins. Put more specific keywords above generic.
type Campaign = {
  name: string;            // shown on the dashboard
  keyword: string;         // matched case-insensitively, anywhere in the comment (@mentions stripped first)
  link: string;            // affiliate link sent in the DM (and substituted for {link})
  dmTemplate: string;      // {link} is replaced with `link`
  publicReplies: string[]; // one is picked at random per match for variety
};

const CAMPAIGNS: Campaign[] = [
  {
    name: 'Emergent',
    keyword: 'build',
    link: 'https://app.emergent.sh/register?ref=YOUR_REF_CODE',
    dmTemplate:
      'Yo! 🙌 Wanna build your own app like in the reel? Sign up with my link and you get 5 free credits to start on Emergent: {link}\n\nBuild something and tag me 👀',
    publicReplies: [
      'just slid into your DMs 📩',
      'check your DMs 👀',
      'sent you the link in DMs 📩',
      'dropped it in your DMs ✅',
    ],
  },
  {
    name: 'Krater',
    keyword: 'krater',
    link: 'https://krater.ai/?amb=YOUR_AMBASSADOR_ID&coupon=YOUR_COUPON_CODE&utm_source=affiliate',
    dmTemplate:
      'Yo! 🙌 Krater = the AI SuperApp I use — ChatGPT, Claude, Midjourney, Runway, Suno all in ONE sub (350+ models, no juggling tabs).\n\n15% off your first month with my code YOUR_COUPON_CODE:\n{link}\n\nTry it and tell me what you make 👀',
    publicReplies: [
      'just slid into your DMs — got you 15% off 📩',
      'check your DMs 👀 sent you the Krater code',
      'in your DMs with the discount 📩',
      'dropped the link + promo code in your DMs ✅',
    ],
  },
];

interface Env {
  STATE: KVNamespace;
  COMPOSIO_API_KEY: string;
  COMPOSIO_USER_ID?: string;
  MAX_PER_HOUR?: string;
  PER_RUN_CAP?: string;
  SCAN_POSTS?: string;
  MAX_AGE_DAYS?: string;
  REPLY_PUBLICLY?: string;
  SUB_POLLS?: string;
}

type Entry = {
  comment_id: string;
  campaign: string;        // which campaign matched (for the dashboard)
  from: string;
  from_id?: string;
  commentText: string;
  at: string;
  permalink?: string;
  dm_text: string;
  dm_status: 'sent' | 'failed' | 'skipped';
  dm_error?: string;
  public_reply?: string;
  public_status?: 'sent' | 'failed' | 'skipped';
};

function cfg(env: Env) {
  return {
    maxPerHour: Number(env.MAX_PER_HOUR || 10),
    perRunCap: Number(env.PER_RUN_CAP || 5),
    scanPosts: Number(env.SCAN_POSTS || 6),
    maxAgeDays: Number(env.MAX_AGE_DAYS || 7),
    replyPublicly: env.REPLY_PUBLICLY !== 'false',
  };
}

// Calls a Composio tool over its REST API (the Node SDK can't run on Workers).
async function callTool(env: Env, slug: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${TOOLS_URL}/${slug}`, {
    method: 'POST',
    headers: { 'x-api-key': env.COMPOSIO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: env.COMPOSIO_USER_ID || 'instagram-reels-analytics', arguments: args }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(`${slug}: ${j?.error?.message || `HTTP ${r.status}`}`);
  return j.data;
}

// Find the first campaign whose keyword appears in the comment text.
// @mentions are stripped first so the account's own handle (e.g. @your_ig_handle,
// which literally contains "build") never triggers a false match.
function findCampaign(text: string): Campaign | undefined {
  const cleaned = text.replace(/@[\w.]+/g, ' ').toLowerCase();
  return CAMPAIGNS.find((c) => cleaned.includes(c.keyword.toLowerCase()));
}

async function pushLog(env: Env, entry: Entry) {
  const log: Entry[] = JSON.parse((await env.STATE.get('log')) || '[]');
  log.unshift(entry);
  await env.STATE.put('log', JSON.stringify(log.slice(0, 500)));
}

async function poll(env: Env): Promise<{ handled: number; matched: number; error?: string }> {
  const c = cfg(env);
  const hourKey = `hour:${new Date().toISOString().slice(0, 13)}`;
  let hourCount = Number(await env.STATE.get(hourKey)) || 0;
  if (hourCount >= c.maxPerHour) return { handled: 0, matched: 0 };

  let media: any[];
  try {
    const mediaRes = await callTool(env, 'INSTAGRAM_GET_USER_MEDIA', { limit: c.scanPosts });
    media = mediaRes?.data ?? [];
  } catch (e) {
    return { handled: 0, matched: 0, error: (e as Error).message };
  }

  const tooOld = Date.now() - c.maxAgeDays * 86400000;
  let handled = 0;
  let matched = 0;

  for (const post of media) {
    if (handled >= c.perRunCap || hourCount >= c.maxPerHour) break;

    let comments: any[] = [];
    try {
      const cr = await callTool(env, 'INSTAGRAM_GET_POST_COMMENTS', { ig_post_id: post.id, limit: 50 });
      comments = cr?.data ?? [];
    } catch {
      continue;
    }

    for (const cm of comments) {
      if (handled >= c.perRunCap || hourCount >= c.maxPerHour) break;

      const text: string = (cm?.text || '').trim();
      const id: string | undefined = cm?.id;
      if (!id || !text) continue;
      const campaign = findCampaign(text);
      if (!campaign) continue;
      const ts = cm?.timestamp ? new Date(cm.timestamp).getTime() : Date.now();
      if (ts < tooOld) continue;

      matched++;
      if (await env.STATE.get(`seen:${id}`)) continue;

      const fromId: string | undefined = cm?.from_user?.id;
      const fromName: string = cm?.from_user?.username || 'unknown';
      const dmText = campaign.dmTemplate.replace('{link}', campaign.link);
      const publicReply = c.replyPublicly
        ? campaign.publicReplies[Math.floor(Math.random() * campaign.publicReplies.length)]
        : undefined;

      const entry: Entry = {
        comment_id: id,
        campaign: campaign.name,
        from: fromName,
        from_id: fromId,
        commentText: text,
        at: new Date().toISOString(),
        permalink: post.permalink,
        dm_text: dmText,
        dm_status: 'skipped',
        public_reply: publicReply,
        public_status: publicReply ? 'skipped' : undefined,
      };

      // 1) Private DM
      if (!fromId) {
        entry.dm_status = 'skipped';
        entry.dm_error = 'no recipient id on comment';
      } else {
        try {
          await callTool(env, 'INSTAGRAM_SEND_TEXT_MESSAGE', { recipient_id: fromId, text: dmText });
          entry.dm_status = 'sent';
        } catch (e) {
          entry.dm_status = 'failed';
          entry.dm_error = (e as Error).message;
        }
      }

      // 2) Public reply
      if (publicReply) {
        try {
          await callTool(env, 'INSTAGRAM_REPLY_TO_COMMENT', { ig_comment_id: id, message: publicReply });
          entry.public_status = 'sent';
        } catch {
          entry.public_status = 'failed';
        }
      }

      // Persist
      await env.STATE.put(`seen:${id}`, '1', { expirationTtl: 60 * 86400 });
      await pushLog(env, entry);
      if (entry.dm_status === 'sent') {
        hourCount++;
        await env.STATE.put(hourKey, String(hourCount), { expirationTtl: 7200 });
      }
      handled++;
    }
  }

  return { handled, matched };
}

// ── Dashboard ───────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

// Distinct color per campaign so they're visually obvious on the dashboard.
const CAMPAIGN_COLORS: Record<string, string> = {
  Emergent: '#7c3aed',  // purple
  Krater: '#0a66ff',    // blue
};

function dashboard(log: Entry[]): string {
  const sent = log.filter((e) => e.dm_status === 'sent').length;
  const failed = log.filter((e) => e.dm_status === 'failed').length;
  const last24h = log.filter((e) => Date.now() - new Date(e.at).getTime() < 86400000).length;

  // Pre-multi-campaign entries have no `campaign` field; they were all Emergent,
  // so fold them under the first campaign. Same logic in camBadge below.
  const tagOf = (e: Entry) => e.campaign || CAMPAIGNS[0].name;
  const perCampaign = CAMPAIGNS.map((c) => {
    const n = log.filter((e) => tagOf(e) === c.name && e.dm_status === 'sent').length;
    const col = CAMPAIGN_COLORS[c.name] || '#7c3aed';
    return `<div class="stat" style="border-left:4px solid ${col}"><div class="v">${n}</div><div class="k">${escapeHtml(c.name)} · "${escapeHtml(c.keyword)}"</div></div>`;
  }).join('');

  const badge = (s?: string) => {
    const m: Record<string, [string, string]> = {
      sent: ['✓ DM sent', 'b-green'],
      failed: ['✗ DM failed', 'b-red'],
      skipped: ['– skipped', 'b-muted'],
    };
    const [l, cls] = m[s || ''] || ['?', 'b-muted'];
    return `<span class="badge ${cls}">${l}</span>`;
  };

  const camBadge = (name?: string) => {
    if (!name) return '';
    const col = CAMPAIGN_COLORS[name] || '#7c3aed';
    return `<span class="cam" style="background:${col}20;color:${col}">${escapeHtml(name)}</span>`;
  };

  const rows = log
    .map(
      (e) => `<div class="row">
      <div class="row-meta">${camBadge(tagOf(e))}<span class="from">@${escapeHtml(e.from)}</span>${badge(e.dm_status)}<span class="time" data-iso="${escapeHtml(e.at)}">${escapeHtml(e.at)}</span>${e.permalink ? `<a class="post" href="${escapeHtml(e.permalink)}" target="_blank" rel="noopener">📍 reel ↗</a>` : ''}</div>
      <div class="comment">${escapeHtml(e.commentText)}</div>
      <div class="dm">${escapeHtml(e.dm_text)}</div>
      ${e.public_reply ? `<div class="public">${escapeHtml(e.public_reply)} ${e.public_status === 'sent' ? '<span class="ok">✓ posted</span>' : e.public_status === 'failed' ? '<span class="no">✗ failed</span>' : ''}</div>` : ''}
      ${e.dm_error ? `<div class="err">⚠ ${escapeHtml(e.dm_error)}</div>` : ''}
    </div>`
    )
    .join('');

  const campaignsList = CAMPAIGNS.map((c) => `"${c.keyword}" → ${c.name}`).join(' · ');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comment → DM bot</title>
<style>
  :root{--bg:#f5f5f7;--card:#fff;--ink:#0d1117;--muted:#5a6271;--line:#e8e8ec;--green:#197043;--red:#a02323}
  *{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;max-width:900px;margin:32px auto 60px;padding:0 24px;color:var(--ink);background:var(--bg);line-height:1.5}
  h1{font-size:26px;margin:0 0 4px}.sub{color:var(--muted);font-size:13px;margin-bottom:20px}
  a{color:#0a66ff;text-decoration:none}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:24px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 14px}
  .stat .v{font-size:26px;font-weight:700}.stat .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-top:4px;font-weight:600}
  .stat.feature{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff}.stat.feature .k{color:rgba(255,255,255,.85)}
  .row{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:8px}
  .row-meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-bottom:8px}
  .from{font-weight:700;color:var(--ink);font-size:14px}.post{background:#eef0f3;padding:2px 8px;border-radius:6px;color:var(--muted)}
  .cam{font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px}
  .comment{font-size:13px;color:var(--muted);padding-left:10px;border-left:3px solid var(--line);margin-bottom:8px}.comment::before{content:'💬 '}
  .dm{font-size:14px;padding:8px 12px;background:linear-gradient(90deg,#f3e8ff,#faf5ff);border-left:3px solid #7c3aed;border-radius:0 6px 6px 0;white-space:pre-wrap}.dm::before{content:'📩 '}
  .public{font-size:14px;padding:8px 12px;margin-top:6px;background:linear-gradient(90deg,#e6f7ee,#f0f9f4);border-left:3px solid var(--green);border-radius:0 6px 6px 0}.public::before{content:'💬 public reply: ';color:var(--green);font-weight:600}
  .public .ok{color:var(--green);font-weight:600}.public .no{color:var(--red);font-weight:600}
  .err{font-size:11px;color:var(--red);margin-top:6px}
  .badge{font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px}.b-green{background:#e6f7ee;color:var(--green)}.b-red{background:#fdecec;color:var(--red)}.b-muted{background:#eef0f3;color:var(--muted)}
  .empty{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:40px;text-align:center;color:var(--muted)}
</style></head><body>
<h1>🚀 Comment → DM <span style="font-size:13px;color:#7c3aed;font-weight:600">· instant (~15s)</span></h1>
<div class="sub">Cloudflare Worker · ${CAMPAIGNS.length} campaign${CAMPAIGNS.length > 1 ? 's' : ''}: ${escapeHtml(campaignsList)}</div>
<div class="stats">
  <div class="stat feature"><div class="v">${sent}</div><div class="k">DMs sent (total)</div></div>
  ${perCampaign}
  <div class="stat"><div class="v">${last24h}</div><div class="k">Triggered (24h)</div></div>
  <div class="stat"><div class="v">${failed}</div><div class="k">DM failed</div></div>
</div>
${log.length === 0 ? `<div class="empty"><strong>No keyword comments handled yet.</strong><p>Polling every minute. Comment any of the keywords on a recent reel and it'll appear here within ~15s.</p></div>` : rows}
<script>
document.querySelectorAll('[data-iso]').forEach(el=>{const d=new Date(el.getAttribute('data-iso'));el.textContent=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(d);el.title=d.toString();});
setTimeout(()=>location.reload(),60000);
</script>
</body></html>`;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cloudflare's minimum cron is 1 minute, so to react faster we poll several
    // times within the tick (poll → wait → poll …). SUB_POLLS=4 ⇒ ~15s latency.
    const n = Math.max(1, Math.min(6, Number(env.SUB_POLLS || 4)));
    const gap = Math.floor(60000 / n);
    ctx.waitUntil(
      (async () => {
        for (let i = 0; i < n; i++) {
          try {
            const r = await poll(env);
            console.log('poll', i, JSON.stringify(r));
          } catch (e) {
            console.log('poll error', (e as Error).message);
          }
          if (i < n - 1) await new Promise((res) => setTimeout(res, gap));
        }
      })()
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Manual run for testing: GET /run
    if (url.pathname === '/run') {
      const r = await poll(env);
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    }
    const log: Entry[] = JSON.parse((await env.STATE.get('log')) || '[]');
    return new Response(dashboard(log), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};
