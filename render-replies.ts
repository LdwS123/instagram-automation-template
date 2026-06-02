import { readFileSync, writeFileSync, existsSync } from 'node:fs';

type ReplyEntry = {
  reply: string;
  at: string;
  commentText: string;
  from: string;
  post_id?: string;
  post_permalink?: string;
};

const replied: Record<string, ReplyEntry> = existsSync('state/replied.json')
  ? JSON.parse(readFileSync('state/replied.json', 'utf-8'))
  : {};

const data = existsSync('data/posts.json') ? JSON.parse(readFileSync('data/posts.json', 'utf-8')) : { account: {}, posts: [] };
const account = data.account || {};
const postById: Record<string, { permalink: string; caption: string; timestamp: string }> = {};
for (const p of data.posts || []) {
  postById[p.id] = { permalink: p.permalink, caption: (p.caption || '').slice(0, 80), timestamp: p.timestamp };
}

const real = Object.entries(replied)
  .filter(([_, v]) => v.reply && v.reply !== '[backfilled]')
  .map(([id, v]) => ({ comment_id: id, ...v }))
  .sort((a, b) => b.at.localeCompare(a.at));

const totalBackfilled = Object.values(replied).filter((v) => v.reply === '[backfilled]').length;

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
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

const groupedByPost: Record<string, typeof real> = {};
for (const r of real) {
  const key = r.post_id || 'unknown';
  if (!groupedByPost[key]) groupedByPost[key] = [];
  groupedByPost[key].push(r);
}

const postKeys = Object.keys(groupedByPost).sort((a, b) => groupedByPost[b].length - groupedByPost[a].length);

const last24h = real.filter((r) => Date.now() - new Date(r.at).getTime() < 24 * 60 * 60 * 1000).length;
const lastHour = real.filter((r) => Date.now() - new Date(r.at).getTime() < 60 * 60 * 1000).length;

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Auto-reply log · @${escapeHtml(account.username || 'unknown')}</title>
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
  .nav { display: flex; gap: 12px; margin-bottom: 24px; }
  .nav a { background: var(--card); border: 1px solid var(--line); padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 500; }
  .nav a.active { background: var(--accent); color: white; border-color: var(--accent); }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 28px; }
  .stat { background: var(--card); border-radius: 12px; padding: 16px 14px; border: 1px solid var(--line); }
  .stat .v { font-size: 26px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .stat .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; font-weight: 600; }
  .stat.feature { background: linear-gradient(135deg, var(--accent) 0%, #4a8aff 100%); color: #fff; border-color: transparent; }
  .stat.feature .k { color: rgba(255,255,255,0.85); }

  .filters { background: var(--card); padding: 14px 16px; border-radius: 12px; border: 1px solid var(--line); margin-bottom: 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .filters input { flex: 1; min-width: 200px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; font-size: 13px; font-family: inherit; }
  .filters button { background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; font-size: 12px; font-weight: 500; cursor: pointer; font-family: inherit; }
  .filters button.active { background: var(--accent); color: #fff; border-color: var(--accent); }

  .reply { background: var(--card); border-radius: 12px; padding: 14px 18px; margin-bottom: 8px; border: 1px solid var(--line); display: grid; grid-template-columns: 1fr auto; gap: 10px 14px; align-items: start; }
  .reply-meta { grid-column: 1 / -1; display: flex; gap: 10px; font-size: 11px; color: var(--muted); align-items: center; flex-wrap: wrap; }
  .reply-from { font-weight: 700; color: var(--ink); font-size: 14px; }
  .reply-time { font-variant-numeric: tabular-nums; }
  .reply-post { background: #eef0f3; padding: 2px 8px; border-radius: 6px; font-size: 11px; color: var(--muted); }
  .reply-post a { color: var(--muted); }
  .reply-comment { font-size: 13px; color: var(--muted); padding-left: 10px; border-left: 3px solid var(--line); margin-bottom: 6px; }
  .reply-comment::before { content: '💬 '; }
  .reply-out { font-size: 14px; color: var(--ink); padding: 8px 12px; background: linear-gradient(90deg, #e6f7ee 0%, #f0f9f4 100%); border-left: 3px solid var(--green); border-radius: 0 6px 6px 0; }
  .reply-out::before { content: '🤖 '; }
  .reply-actions { font-size: 11px; color: var(--muted); display: flex; gap: 8px; align-items: center; grid-column: 1 / -1; padding-top: 4px; }
  .reply-actions a { color: var(--accent); font-weight: 500; }

  .post-section { background: var(--card); border-radius: 12px; padding: 14px 18px; margin-bottom: 16px; border: 1px solid var(--line); }
  .post-section-head { display: flex; gap: 12px; align-items: center; padding-bottom: 12px; border-bottom: 1px solid var(--line); margin-bottom: 12px; }
  .post-section-head .count { background: var(--accent); color: #fff; border-radius: 99px; font-size: 11px; padding: 2px 9px; font-weight: 600; }
  .post-section-head .ttl { font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
  .post-section-head .ttl b { color: var(--ink); }

  .empty { background: var(--card); border-radius: 12px; padding: 40px 30px; text-align: center; border: 1px solid var(--line); color: var(--muted); }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>🤖 Auto-reply log</h1>
    <div class="sub">Toutes les réponses postées par le bot sur les commentaires de @${escapeHtml(account.username || 'unknown')}</div>
  </div>
  <div class="h-r">
    <div>Updated <span data-iso="${escapeHtml(new Date().toISOString())}" data-mode="full">…</span></div>
    <div>Next run: <span id="next-cron">…</span></div>
    <div>Cron: every 30 min (:09 / :39 UTC)</div>
  </div>
</div>

<div class="nav">
  <a href="index.html">📊 Dashboard</a>
  <a href="captions.csv" download>📥 CSV captions</a>
  <a href="replies.html" class="active">🤖 Auto-reply log</a>
  <a href="build-dm.html">🚀 Build → DM</a>
</div>

<div class="stats">
  <div class="stat feature"><div class="v">${real.length}</div><div class="k">Total réponses bot</div></div>
  <div class="stat"><div class="v">${last24h}</div><div class="k">Dernières 24h</div></div>
  <div class="stat"><div class="v">${lastHour}</div><div class="k">Dernière heure</div></div>
  <div class="stat"><div class="v">${totalBackfilled}</div><div class="k">Skip (déjà répondu)</div></div>
</div>

${real.length === 0 ? `<div class="empty">
  <strong>Aucune réponse postée pour l'instant.</strong>
  <p>Le bot tourne toutes les 30 minutes (à :09 et :39). Quand un commentaire arrive sur un de tes reels (au moins 30 min après son post), le bot lui répondra automatiquement, max 10 par run et 20 par heure.</p>
</div>` : `

<div class="filters">
  <input type="search" id="search" placeholder="Cherche dans les commentaires ou réponses…">
  <button id="view-list" class="active">📜 Liste chronologique</button>
  <button id="view-grouped">📁 Groupé par reel</button>
</div>

<div id="view-list-content">
  <h2>Chronologique · plus récent en premier</h2>
  ${real.map((r) => {
    const post = r.post_id ? postById[r.post_id] : undefined;
    const permalink = r.post_permalink || post?.permalink;
    const postCaption = post?.caption ? post.caption + '…' : '';
    return `<div class="reply">
      <div class="reply-meta">
        <span class="reply-from">@${escapeHtml(r.from)}</span>
        <span class="reply-time" data-iso="${escapeHtml(r.at)}" data-mode="ago">${escapeHtml(timeAgo(r.at))}</span>
        ${permalink ? `<span class="reply-post"><a href="${escapeHtml(permalink)}" target="_blank" rel="noopener">📍 reel${postCaption ? ` · ${escapeHtml(postCaption)}` : ''} ↗</a></span>` : ''}
      </div>
      <div class="reply-comment">${escapeHtml(r.commentText)}</div>
      <div></div>
      <div class="reply-out">${escapeHtml(r.reply)}</div>
      <div></div>
      <div class="reply-actions">
        <span data-iso="${escapeHtml(r.at)}" data-mode="full">${escapeHtml(r.at)}</span>
        ${permalink ? `<a href="${escapeHtml(permalink)}" target="_blank" rel="noopener">voir sur Instagram ↗</a>` : ''}
      </div>
    </div>`;
  }).join('')}
</div>

<div id="view-grouped-content" hidden>
  <h2>Groupé par reel · ${postKeys.length} reels avec réponses</h2>
  ${postKeys.map((k) => {
    const post = postById[k];
    const replies = groupedByPost[k];
    const permalink = post?.permalink || replies[0]?.post_permalink;
    const captionPreview = post?.caption ? post.caption + '…' : '(reel inconnu)';
    return `<div class="post-section">
      <div class="post-section-head">
        <span class="count">${replies.length}</span>
        <span class="ttl"><b>${escapeHtml(captionPreview)}</b></span>
        ${permalink ? `<a href="${escapeHtml(permalink)}" target="_blank" rel="noopener">ouvrir ↗</a>` : ''}
      </div>
      ${replies.map((r) => `<div class="reply" style="border:0; padding: 8px 0; margin: 0;">
        <div class="reply-meta">
          <span class="reply-from">@${escapeHtml(r.from)}</span>
          <span class="reply-time">${escapeHtml(timeAgo(r.at))}</span>
        </div>
        <div class="reply-comment">${escapeHtml(r.commentText)}</div>
        <div></div>
        <div class="reply-out">${escapeHtml(r.reply)}</div>
        <div></div>
      </div>`).join('')}
    </div>`;
  }).join('')}
</div>
`}

<script>
// Convert all timestamps to the visitor's local timezone
(function formatTimes() {
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
  const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  function relAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const d = Math.floor(hr / 24);
    return d + 'd ago';
  }
  document.querySelectorAll('[data-iso]').forEach(el => {
    const iso = el.getAttribute('data-iso');
    const mode = el.getAttribute('data-mode');
    if (mode === 'ago') el.textContent = relAgo(iso);
    else if (mode === 'full') el.textContent = fmtFull.format(new Date(iso));
    else el.textContent = fmt.format(new Date(iso));
    el.setAttribute('title', new Date(iso).toString());
  });
})();

// Show next cron run time (cron is :09 and :39 UTC of every hour)
(function showNextCron() {
  const el = document.getElementById('next-cron');
  if (!el) return;
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(now.getUTCMinutes() < 9 ? 9 : now.getUTCMinutes() < 39 ? 39 : 9);
  next.setUTCSeconds(0); next.setUTCMilliseconds(0);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
  const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const minsAway = Math.round((next.getTime() - now.getTime()) / 60000);
  el.textContent = fmt.format(next) + ' (in ' + minsAway + ' min)';
  el.setAttribute('title', next.toString());
})();

const search = document.getElementById('search');
if (search) {
  search.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.reply').forEach(r => {
      r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}
const btnList = document.getElementById('view-list');
const btnGroup = document.getElementById('view-grouped');
const contentList = document.getElementById('view-list-content');
const contentGroup = document.getElementById('view-grouped-content');
if (btnList && btnGroup) {
  btnList.addEventListener('click', () => {
    btnList.classList.add('active'); btnGroup.classList.remove('active');
    contentList.removeAttribute('hidden'); contentGroup.setAttribute('hidden', '');
  });
  btnGroup.addEventListener('click', () => {
    btnGroup.classList.add('active'); btnList.classList.remove('active');
    contentGroup.removeAttribute('hidden'); contentList.setAttribute('hidden', '');
  });
}
</script>

</body></html>`;

writeFileSync('replies.html', html);
console.log(`Wrote replies.html (${real.length} bot replies, ${totalBackfilled} skipped, ${postKeys.length} reels covered).`);
