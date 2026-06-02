import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Renders build-dm.html — the dashboard for the "Build → DM" automation.
// Mirrors the look of replies.html so all pages feel like one product.

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

const state: Record<string, DmEntry> = existsSync('state/build-dm.json')
  ? JSON.parse(readFileSync('state/build-dm.json', 'utf-8'))
  : {};

const data = existsSync('data/posts.json')
  ? JSON.parse(readFileSync('data/posts.json', 'utf-8'))
  : { account: {}, posts: [] };
const account = data.account || {};
const postById: Record<string, { permalink: string; caption: string }> = {};
for (const p of data.posts || []) {
  postById[p.id] = { permalink: p.permalink, caption: (p.caption || '').slice(0, 80) };
}

const entries = Object.entries(state)
  .map(([id, v]) => ({ comment_id: id, ...v }))
  .sort((a, b) => b.at.localeCompare(a.at));

const sent = entries.filter((e) => e.dm_status === 'sent').length;
const failed = entries.filter((e) => e.dm_status === 'failed').length;
const skipped = entries.filter((e) => e.dm_status === 'skipped').length;
const last24h = entries.filter((e) => Date.now() - new Date(e.at).getTime() < 24 * 60 * 60 * 1000).length;

function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const badge = (status?: string) => {
  const map: Record<string, [string, string]> = {
    sent: ['✓ DM sent', 'b-green'],
    failed: ['✗ DM failed', 'b-red'],
    skipped: ['– skipped', 'b-muted'],
    'dry-run': ['◌ dry-run', 'b-amber'],
  };
  const [label, cls] = map[status || ''] || ['?', 'b-muted'];
  return `<span class="badge ${cls}">${label}</span>`;
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build → DM log · @${escapeHtml(account.username || 'unknown')}</title>
<style>
  :root { color-scheme: light; --bg:#f5f5f7; --card:#fff; --ink:#0d1117; --muted:#5a6271; --line:#e8e8ec; --accent:#0a66ff; --green:#197043; --amber:#8d5400; --red:#a02323; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif; max-width: 980px; margin: 32px auto 60px; padding: 0 24px; color: var(--ink); background: var(--bg); line-height: 1.5; -webkit-font-smoothing: antialiased; }
  h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.5px; }
  h2 { font-size: 17px; margin: 30px 0 12px; letter-spacing: -0.3px; }
  .sub { color: var(--muted); font-size: 13px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .header { padding-bottom: 18px; border-bottom: 1px solid var(--line); margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .header .h-r { text-align: right; font-size: 12px; color: var(--muted); }
  .nav { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .nav a { background: var(--card); border: 1px solid var(--line); padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 500; }
  .nav a.active { background: var(--accent); color: white; border-color: var(--accent); }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 28px; }
  .stat { background: var(--card); border-radius: 12px; padding: 16px 14px; border: 1px solid var(--line); }
  .stat .v { font-size: 26px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .stat .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; font-weight: 600; }
  .stat.feature { background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); color: #fff; border-color: transparent; }
  .stat.feature .k { color: rgba(255,255,255,0.85); }

  .filters { background: var(--card); padding: 14px 16px; border-radius: 12px; border: 1px solid var(--line); margin-bottom: 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .filters input { flex: 1; min-width: 200px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; font-size: 13px; font-family: inherit; }

  .row { background: var(--card); border-radius: 12px; padding: 14px 18px; margin-bottom: 8px; border: 1px solid var(--line); }
  .row-meta { display: flex; gap: 10px; font-size: 11px; color: var(--muted); align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .row-from { font-weight: 700; color: var(--ink); font-size: 14px; }
  .row-time { font-variant-numeric: tabular-nums; }
  .row-post { background: #eef0f3; padding: 2px 8px; border-radius: 6px; font-size: 11px; color: var(--muted); }
  .row-post a { color: var(--muted); }
  .row-comment { font-size: 13px; color: var(--muted); padding-left: 10px; border-left: 3px solid var(--line); margin-bottom: 8px; }
  .row-comment::before { content: '💬 '; }
  .row-dm { font-size: 14px; color: var(--ink); padding: 8px 12px; background: linear-gradient(90deg, #f3e8ff 0%, #faf5ff 100%); border-left: 3px solid #7c3aed; border-radius: 0 6px 6px 0; white-space: pre-wrap; }
  .row-dm::before { content: '📩 '; }
  .row-public { font-size: 14px; color: var(--ink); padding: 8px 12px; margin-top: 6px; background: linear-gradient(90deg, #e6f7ee 0%, #f0f9f4 100%); border-left: 3px solid var(--green); border-radius: 0 6px 6px 0; }
  .row-public::before { content: '💬 public reply: '; color: var(--green); font-weight: 600; }
  .row-public .ok { color: var(--green); font-weight: 600; }
  .row-public .no { color: var(--red); font-weight: 600; }
  .row-err { font-size: 11px; color: var(--red); margin-top: 6px; word-break: break-word; }

  .badge { font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 99px; }
  .b-green { background: #e6f7ee; color: var(--green); }
  .b-red { background: #fdecec; color: var(--red); }
  .b-amber { background: #fbf3e0; color: var(--amber); }
  .b-muted { background: #eef0f3; color: var(--muted); }

  .empty { background: var(--card); border-radius: 12px; padding: 40px 30px; text-align: center; border: 1px solid var(--line); color: var(--muted); }
  .empty code { background: #eef0f3; padding: 2px 6px; border-radius: 5px; }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>🚀 Build → DM log</h1>
    <div class="sub">Everyone who commented the keyword and got auto-DM'd the Emergent link · @${escapeHtml(account.username || 'unknown')}</div>
  </div>
  <div class="h-r">
    <div>Updated <span data-iso="${escapeHtml(new Date().toISOString())}" data-mode="full">…</span></div>
    <div>Next run: <span id="next-cron">…</span></div>
    <div>Cron: every 5 min</div>
  </div>
</div>

<div class="nav">
  <a href="index.html">📊 Dashboard</a>
  <a href="replies.html">🤖 Auto-reply log</a>
  <a href="build-dm.html" class="active">🚀 Build → DM</a>
</div>

<div class="stats">
  <div class="stat feature"><div class="v">${sent}</div><div class="k">DMs sent</div></div>
  <div class="stat"><div class="v">${last24h}</div><div class="k">Triggered (24h)</div></div>
  <div class="stat"><div class="v">${failed}</div><div class="k">DM failed</div></div>
  <div class="stat"><div class="v">${skipped}</div><div class="k">Skipped</div></div>
</div>

${entries.length === 0 ? `<div class="empty">
  <strong>No "build" comments handled yet.</strong>
  <p>Runs every 5 minutes. When someone comments the keyword on one of your recent reels, they get the Emergent link in their DMs automatically.</p>
  <p>Test it now: <code>npm run build-dm:dry</code> (preview) then <code>npm run build-dm:send</code> (live).</p>
</div>` : `
<div class="filters">
  <input type="search" id="search" placeholder="Search people, comments, or DMs…">
</div>
${entries.map((e) => {
  const post = e.post_id ? postById[e.post_id] : undefined;
  const permalink = e.post_permalink || post?.permalink;
  const postCaption = post?.caption ? post.caption + '…' : '';
  return `<div class="row">
    <div class="row-meta">
      <span class="row-from">@${escapeHtml(e.from)}</span>
      ${badge(e.dm_status)}
      <span class="row-time" data-iso="${escapeHtml(e.at)}" data-mode="ago">${escapeHtml(timeAgo(e.at))}</span>
      ${permalink ? `<span class="row-post"><a href="${escapeHtml(permalink)}" target="_blank" rel="noopener">📍 reel${postCaption ? ` · ${escapeHtml(postCaption)}` : ''} ↗</a></span>` : ''}
    </div>
    <div class="row-comment">${escapeHtml(e.commentText)}</div>
    <div class="row-dm">${escapeHtml(e.dm_text)}</div>
    ${e.public_reply ? `<div class="row-public">${escapeHtml(e.public_reply)} ${e.public_status === 'sent' ? '<span class="ok">✓ posted</span>' : e.public_status === 'failed' ? '<span class="no">✗ failed</span>' : ''}</div>` : ''}
    ${e.dm_error ? `<div class="row-err">⚠ ${escapeHtml(e.dm_error)}</div>` : ''}
  </div>`;
}).join('')}
`}

<script>
(function formatTimes() {
  const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  function relAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    return Math.floor(hr / 24) + 'd ago';
  }
  document.querySelectorAll('[data-iso]').forEach(el => {
    const iso = el.getAttribute('data-iso');
    const mode = el.getAttribute('data-mode');
    if (mode === 'ago') el.textContent = relAgo(iso);
    else if (mode === 'full') el.textContent = fmtFull.format(new Date(iso));
    el.setAttribute('title', new Date(iso).toString());
  });
})();

(function showNextCron() {
  const el = document.getElementById('next-cron');
  if (!el) return;
  const now = new Date();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(Math.floor(now.getUTCMinutes() / 5) * 5 + 5);
  const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const minsAway = Math.round((next.getTime() - now.getTime()) / 60000);
  el.textContent = fmt.format(next) + ' (in ' + minsAway + ' min)';
  el.setAttribute('title', next.toString());
})();

const search = document.getElementById('search');
if (search) {
  search.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.row').forEach(r => {
      r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}
</script>

</body></html>`;

writeFileSync('build-dm.html', html);
console.log(`Wrote build-dm.html (${entries.length} handled, ${sent} DMs sent, ${failed} failed, ${skipped} skipped).`);
