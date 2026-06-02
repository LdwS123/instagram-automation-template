import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

type RawPost = {
  id: string;
  caption: string;
  permalink: string;
  thumbnail_url: string;
  timestamp: string;
  media_type: string;
  duration?: number | null;
  insights: Record<string, number>;
};

type Account = {
  id?: string;
  username?: string;
  name?: string;
  biography?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  profile_picture_url?: string;
};

type Computed = RawPost & {
  reach: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saved: number;
  total_interactions: number;
  watch_s: number;
  duration_s: number;
  share_pct: number;
  save_pct: number;
  engagement_rate: number;
  follower_reach_pct: number;
  hook_rate: number;
  replay_rate: number;
  hook_score: number;
  hook_axis: number;
  reach_axis: number;
  viral_axis: number;
  hour: number;
  weekday: number;
  caption_length: number;
  hashtag_count: number;
  emoji_count: number;
  has_question: boolean;
  word_count: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  grade_reason: string;
};

const data = JSON.parse(readFileSync('data/posts.json', 'utf-8')) as {
  fetched_at: string;
  window_days?: number;
  window_start?: string;
  window_end?: string;
  account?: Account;
  account_insights?: any;
  posts: RawPost[];
};

type Insights = {
  generated_at?: string;
  concepts?: { title: string; hook: string; angle: string; caption_opener: string; format_note?: string }[];
  critiques?: Record<string, string>;
};
let insights: Insights = {};
try {
  insights = JSON.parse(readFileSync('data/insights.json', 'utf-8')) as Insights;
} catch {
  // optional file
}

if (!data.posts || data.posts.length === 0) {
  writeFileSync(
    'report.html',
    `<!doctype html><meta charset="utf-8"><title>Reels report</title><body style="font-family:sans-serif;padding:40px"><h1>No reels in the last ${data.window_days || 30} days.</h1><p>Re-run after you post some.</p></body>`
  );
  console.log('No posts in data/posts.json. Wrote stub report.html.');
  process.exit(0);
}

const account = data.account || {};
const followers = account.followers_count || 0;

mkdirSync('thumbs', { recursive: true });

for (const p of data.posts) {
  const path = `thumbs/${p.id}.jpg`;
  if (!existsSync(path) && p.thumbnail_url) {
    try {
      execFileSync('curl', [
        '-fsSL', '--max-time', '20',
        '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '-H', 'Accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        '-H', 'Referer: https://www.instagram.com/',
        '-o', path, p.thumbnail_url,
      ], { stdio: 'pipe' });
    } catch {
      console.warn(`thumb failed: ${p.id}`);
    }
  }
}

const num = (v: any): number => (typeof v === 'number' && isFinite(v) ? v : 0);

const EMOJI_RE = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;

function captionStats(caption: string) {
  const c = caption || '';
  return {
    caption_length: c.length,
    word_count: (c.match(/\S+/g) || []).length,
    hashtag_count: (c.match(HASHTAG_RE) || []).length,
    emoji_count: (c.match(EMOJI_RE) || []).length,
    has_question: /\?/.test(c),
  };
}

const computedRaw: Computed[] = data.posts.map((p) => {
  const i = p.insights || {};
  const reach = num(i.reach);
  const views = num(i.views ?? (i as any).plays ?? (i as any).video_views);
  const likes = num(i.likes);
  const comments = num(i.comments);
  const shares = num(i.shares);
  const saved = num(i.saved);
  const total_interactions = num(i.total_interactions) || (likes + comments + shares + saved);
  const watch_s = num(i.ig_reels_avg_watch_time) / 1000;
  const duration_s = typeof p.duration === 'number' && p.duration > 0 ? p.duration : 30;
  const share_pct = reach > 0 ? (shares / reach) * 100 : 0;
  const save_pct = reach > 0 ? (saved / reach) * 100 : 0;
  const engagement_rate = reach > 0 ? (total_interactions / reach) * 100 : 0;
  const follower_reach_pct = followers > 0 ? (reach / followers) * 100 : 0;
  const hook_rate = duration_s > 0 ? watch_s / duration_s : 0;
  const replay_rate = reach > 0 ? views / reach : 0;
  const hook_score = watch_s * Math.sqrt(reach) * (1 + share_pct / 100 + save_pct / 200);
  const ts = new Date(p.timestamp);
  const cap = captionStats(p.caption || '');
  return {
    ...p,
    reach, views, likes, comments, shares, saved, total_interactions,
    watch_s, duration_s, share_pct, save_pct, engagement_rate, follower_reach_pct,
    hook_rate, replay_rate, hook_score,
    hook_axis: 0, reach_axis: 0, viral_axis: 0,
    hour: ts.getHours(),
    weekday: ts.getDay(),
    ...cap,
    grade: 'C' as const,
    grade_reason: '',
  };
});

const safeMax = (xs: number[]) => Math.max(1, ...xs);
const maxWatch = safeMax(computedRaw.map((c) => c.watch_s));
const maxReach = safeMax(computedRaw.map((c) => c.reach));
const maxViral = safeMax(computedRaw.map((c) => c.shares + c.saved));
for (const c of computedRaw) {
  c.hook_axis = Math.round((c.watch_s / maxWatch) * 100);
  c.reach_axis = Math.round((c.reach / maxReach) * 100);
  c.viral_axis = Math.round(((c.shares + c.saved) / maxViral) * 100);
}

const computed = [...computedRaw].sort((a, b) => b.hook_score - a.hook_score);

const scoreRank = new Map(computed.map((c, i) => [c.id, i]));
function gradeOf(c: Computed): { grade: 'A' | 'B' | 'C' | 'D' | 'F'; reason: string } {
  const rank = scoreRank.get(c.id) ?? 0;
  const pct = (computed.length - rank) / computed.length;
  let grade: 'A' | 'B' | 'C' | 'D' | 'F';
  if (pct >= 0.85) grade = 'A';
  else if (pct >= 0.65) grade = 'B';
  else if (pct >= 0.40) grade = 'C';
  else if (pct >= 0.20) grade = 'D';
  else grade = 'F';
  const parts: string[] = [];
  if (c.hook_axis >= 70) parts.push('hook ✓');
  if (c.hook_axis <= 30) parts.push('hook ✗');
  if (c.reach_axis >= 70) parts.push('reach ✓');
  if (c.reach_axis <= 30) parts.push('reach ✗');
  if (c.viral_axis >= 70) parts.push('shares ✓');
  if (c.viral_axis <= 30) parts.push('shares ✗');
  return { grade, reason: parts.join(' · ') || 'mid range on all axes' };
}
for (const c of computed) {
  const g = gradeOf(c);
  c.grade = g.grade;
  c.grade_reason = g.reason;
}

const medianShare = (() => {
  const arr = computed.map((c) => c.share_pct).filter((n) => n > 0).sort((a, b) => a - b);
  return arr[Math.floor(arr.length / 2)] || 0;
})();
const medianSave = (() => {
  const arr = computed.map((c) => c.save_pct).filter((n) => n > 0).sort((a, b) => a - b);
  return arr[Math.floor(arr.length / 2)] || 0;
})();
const medianWatch = (() => {
  const arr = computed.map((c) => c.watch_s).filter((n) => n > 0).sort((a, b) => a - b);
  return arr[Math.floor(arr.length / 2)] || 0;
})();

function whyPushed(c: Computed): { points: { factor: string; signal: string; importance: 'huge' | 'big' | 'mid' }[]; verdict: string } {
  const points: { factor: string; signal: string; importance: 'huge' | 'big' | 'mid' }[] = [];

  if (followers > 0) {
    const reachToFollowers = c.reach / followers;
    if (reachToFollowers >= 5) {
      points.push({
        factor: `Reach = ${reachToFollowers.toFixed(1)}× tes followers (${fmtExact(c.reach)} pour ${fmtExact(followers)} abonnés)`,
        signal: 'IG a poussé ce reel BIEN au-delà de ta base — il a été montré massivement à des non-followers.',
        importance: 'huge',
      });
    } else if (reachToFollowers >= 1.5) {
      points.push({
        factor: `Reach = ${reachToFollowers.toFixed(1)}× tes followers`,
        signal: 'IG a sorti ce reel de ta base et l\'a poussé à des non-followers.',
        importance: 'big',
      });
    }
  }

  if (medianShare > 0 && c.share_pct >= medianShare * 1.5) {
    const lift = (c.share_pct / medianShare).toFixed(1);
    points.push({
      factor: `Share rate ${c.share_pct.toFixed(2)}% (ta médiane: ${medianShare.toFixed(2)}%, soit ${lift}× plus)`,
      signal: 'Le partage est LE plus fort signal IG. Quand des gens envoient ton reel à un ami, l\'algo lit ça comme "ce contenu mérite d\'être montré à plus de monde".',
      importance: 'huge',
    });
  }

  if (medianSave > 0 && c.save_pct >= medianSave * 1.5) {
    const lift = (c.save_pct / medianSave).toFixed(1);
    points.push({
      factor: `Save rate ${c.save_pct.toFixed(2)}% (ta médiane: ${medianSave.toFixed(2)}%, soit ${lift}× plus)`,
      signal: 'Les sauvegardes disent à IG "le viewer voudra revoir ça" → contenu de haute qualité, donc poussé.',
      importance: 'big',
    });
  }

  if (medianWatch > 0 && c.watch_s >= medianWatch * 1.3) {
    points.push({
      factor: `Watch time moyen ${c.watch_s.toFixed(1)}s (ta médiane: ${medianWatch.toFixed(1)}s)`,
      signal: 'Plus le hook accroche, moins les viewers scroll. IG voit la rétention et continue de pousser.',
      importance: 'big',
    });
  }

  if (c.replay_rate >= 1.5) {
    points.push({
      factor: `${c.replay_rate.toFixed(1)} vues par personne (views ÷ reach)`,
      signal: 'Beaucoup de gens ont regardé en boucle. IG sait que ton reel "hold" — signal ultra positif.',
      importance: 'big',
    });
  } else if (c.replay_rate >= 1.2) {
    points.push({
      factor: `${c.replay_rate.toFixed(1)} vues par personne (views ÷ reach)`,
      signal: 'Replays au-dessus de la moyenne — les gens ne scrollent pas, ils restent.',
      importance: 'mid',
    });
  }

  if (c.engagement_rate >= 8) {
    points.push({
      factor: `Engagement rate ${c.engagement_rate.toFixed(1)}% (likes+comments+shares+saves ÷ reach)`,
      signal: 'Très haut taux d\'interaction par viewer — IG voit que ton audience cible réagit fort.',
      importance: 'mid',
    });
  }

  let verdict = '';
  const huge = points.filter((p) => p.importance === 'huge').length;
  const big = points.filter((p) => p.importance === 'big').length;
  if (huge >= 2) verdict = 'Combo viral parfait : plusieurs des plus forts signaux IG sont activés en même temps.';
  else if (huge === 1 && big >= 1) verdict = 'Un signal majeur (le partage ou le reach hors-base) a déclenché la cascade algorithmique.';
  else if (huge === 1) verdict = 'Un signal fort a fait basculer l\'algo en faveur de ce reel.';
  else if (big >= 2) verdict = 'Plusieurs signaux secondaires combinés ont rendu ce reel intéressant pour l\'algo.';
  else verdict = 'Performance solide sans signal viral dominant.';

  return { points, verdict };
}

const top3Ids = new Set(computed.slice(0, 3).map((c) => c.id));
const bot3Ids = new Set(computed.slice(-3).map((c) => c.id));
const sortedHookRate = [...computed].sort((a, b) => b.hook_rate - a.hook_rate);
const sortedWatchAsc = [...computed].sort((a, b) => a.watch_s - b.watch_s);
const qSize = Math.max(1, Math.floor(computed.length / 4));
const topQuartileHook = new Set(sortedHookRate.slice(0, qSize).map((c) => c.id));
const botQuartileWatch = new Set(sortedWatchAsc.slice(0, qSize).map((c) => c.id));
const fixIds = new Set([...topQuartileHook].filter((id) => botQuartileWatch.has(id)));

const reachesAsc = computed.map((c) => c.reach).sort((a, b) => a - b);
const median = reachesAsc[Math.floor(reachesAsc.length / 2)] || 1;
const topReach = reachesAsc[reachesAsc.length - 1] || 0;
const reachMultiplier = (topReach / Math.max(1, median)).toFixed(1);

const totalReach = reachesAsc.reduce((a, b) => a + b, 0) || 1;
const top25n = Math.max(1, Math.ceil(reachesAsc.length / 4));
const top25Reach = reachesAsc.slice(-top25n).reduce((a, b) => a + b, 0);
const concentrationPct = Math.round((top25Reach / totalReach) * 100);

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const halfIdx = Math.ceil(computed.length / 2);
const watchGap = (avg(computed.slice(0, halfIdx).map((c) => c.watch_s))
                  - avg(computed.slice(halfIdx).map((c) => c.watch_s))).toFixed(1);

const strongHooks = computed.filter((c) => c.watch_s >= 12).length;
const replayWinners = computed.filter((c) => c.replay_rate >= 1.2).length;

const totalViews = sum(computed.map((c) => c.views));
const totalShares = sum(computed.map((c) => c.shares));
const totalSaves = sum(computed.map((c) => c.saved));
const totalLikes = sum(computed.map((c) => c.likes));
const totalComments = sum(computed.map((c) => c.comments));
const avgReach = Math.round(avg(computed.map((c) => c.reach)));
const avgWatch = avg(computed.map((c) => c.watch_s));
const avgFollowerReach = avg(computed.map((c) => c.follower_reach_pct));
const avgEngagement = avg(computed.map((c) => c.engagement_rate));

const STOP = new Set([
  'the','and','for','this','that','your','you','with','from','but','was','are','have','will',
  'they','all','not','one','can','out','now','its','when','who','how','what','our','via','about',
  'into','just','made','make','here','there','some','more','only','then','than','also','very',
  'like','too','really','still','been','were','had','does','him','her','his','she','their','them',
  'these','those','any','because','said','say','says','get','got','let','com','www','http','https',
  'pour','les','des','une','est','que','dans','tout','plus','sur','avec','mais','par','aux','ses','sont','être','avoir','faire',
]);
const tokens = (s: string) => (s.toLowerCase().match(/[\p{L}][\p{L}']{2,}/gu) || []).filter((w) => !STOP.has(w));
const uniqWords = (s: string) => Array.from(new Set(tokens(s)));

const top5 = computed.slice(0, Math.min(5, computed.length));
const bot5 = computed.slice(Math.max(0, computed.length - 5));
const tally = (posts: Computed[]) => {
  const m = new Map<string, number>();
  for (const p of posts) for (const w of uniqWords(p.caption)) m.set(w, (m.get(w) || 0) + 1);
  return m;
};
const topWords = tally(top5);
const botWords = tally(bot5);
const winnerWords = [...topWords.entries()].filter(([w, n]) => n >= 2 && !botWords.has(w)).map(([w]) => w);
const loserWords = [...botWords.entries()].filter(([w, n]) => n >= 2 && !topWords.has(w)).map(([w]) => w);

const hashtagPerf = new Map<string, { uses: number; reach: number; hook: number }>();
for (const c of computed) {
  const tags = (c.caption || '').match(HASHTAG_RE) || [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    const prev = hashtagPerf.get(key) || { uses: 0, reach: 0, hook: 0 };
    prev.uses += 1;
    prev.reach += c.reach;
    prev.hook += c.hook_score;
    hashtagPerf.set(key, prev);
  }
}
const topHashtags = [...hashtagPerf.entries()]
  .filter(([, v]) => v.uses >= 2)
  .map(([tag, v]) => ({ tag, uses: v.uses, avgReach: Math.round(v.reach / v.uses), avgHook: v.hook / v.uses }))
  .sort((a, b) => b.avgHook - a.avgHook)
  .slice(0, 8);

function correlation(xs: number[], ys: number[]) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = avg(xs), my = avg(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom ? num / denom : 0;
}

const corrCaptionLen = correlation(computed.map((c) => c.caption_length), computed.map((c) => c.hook_score));
const corrHashtags = correlation(computed.map((c) => c.hashtag_count), computed.map((c) => c.hook_score));
const corrEmoji = correlation(computed.map((c) => c.emoji_count), computed.map((c) => c.hook_score));

const questionPosts = computed.filter((c) => c.has_question);
const noQuestionPosts = computed.filter((c) => !c.has_question);
const questionLift = questionPosts.length && noQuestionPosts.length
  ? avg(questionPosts.map((c) => c.hook_score)) / avg(noQuestionPosts.map((c) => c.hook_score))
  : 1;

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayBuckets: number[][] = Array.from({ length: 7 }, () => []);
for (const c of computed) weekdayBuckets[c.weekday].push(c.hook_score);
const weekdayAvgs = weekdayBuckets.map((arr) => (arr.length ? avg(arr) : 0));

const HOUR_BUCKETS = 8;
const hourBuckets: number[][] = Array.from({ length: HOUR_BUCKETS }, () => []);
for (const c of computed) hourBuckets[Math.floor(c.hour / 3)].push(c.hook_score);
const hourAvgs = hourBuckets.map((arr) => (arr.length ? avg(arr) : 0));
const hourCounts = hourBuckets.map((arr) => arr.length);
const HOUR_LABELS = ['0–3', '3–6', '6–9', '9–12', '12–15', '15–18', '18–21', '21–24'];

function diagnose(c: Computed): { tag: string; color: 'green' | 'red' | 'amber' | 'gray' } {
  const h = c.hook_axis, r = c.reach_axis, v = c.viral_axis;
  if (h >= 60 && r >= 60 && v >= 60) return { tag: 'Winner — all three axes worked', color: 'green' };
  if (h <= 35 && r <= 35 && v <= 35) return { tag: 'Weak on all axes — kill this format', color: 'red' };
  if (h >= 60 && r <= 35) return { tag: "Strong hook, IG didn't push it", color: 'amber' };
  if (r >= 60 && h <= 35) return { tag: "People clicked, content didn't hold", color: 'amber' };
  if (v >= 60 && h <= 35) return { tag: 'Sharable concept, weak delivery', color: 'amber' };
  if (h >= 60) return { tag: 'Hook landed', color: 'green' };
  return { tag: 'Underperformed', color: 'gray' };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));
}

function thumbSrc(p: { id: string; thumbnail_url: string }): string {
  const path = `thumbs/${p.id}.jpg`;
  if (existsSync(path)) {
    try {
      const b = readFileSync(path);
      if (b.length > 0) return `data:image/jpeg;base64,${b.toString('base64')}`;
    } catch {}
  }
  return p.thumbnail_url || '';
}

function fmtN(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return Math.round(n).toString();
}

function fmtExact(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function fmtPct(n: number, digits = 1): string {
  return n.toFixed(digits) + '%';
}

const SVG_DEFS = `<defs><linearGradient id="cbar-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0a66ff"/><stop offset="100%" stop-color="#4a8aff"/></linearGradient></defs>`;

function svgBarChart(labels: string[], values: number[], opts: { width?: number; height?: number; counts?: number[]; valueFmt?: (n: number) => string; highlightMax?: boolean } = {}) {
  const W = opts.width ?? 720;
  const H = opts.height ?? 180;
  const padL = 40, padR = 16, padT = 14, padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxV = Math.max(1, ...values);
  const maxIdx = values.indexOf(maxV);
  const barW = innerW / values.length;
  const fmtV = opts.valueFmt ?? ((n: number) => Math.round(n).toString());
  const bars = values.map((v, i) => {
    const x = padL + i * barW + 4;
    const w = Math.max(2, barW - 8);
    const h = (v / maxV) * innerH;
    const y = padT + innerH - h;
    const count = opts.counts ? opts.counts[i] : null;
    const isMax = opts.highlightMax && i === maxIdx;
    const fill = isMax ? '#197043' : 'url(#cbar-grad)';
    const valLabel = v > 0 ? `<text x="${x + w / 2}" y="${y - 4}" text-anchor="middle" class="cval">${fmtV(v)}</text>` : '';
    const countLabel = count !== null && count !== undefined ? `<text x="${x + w / 2}" y="${padT + innerH + 12}" text-anchor="middle" class="cax">${labels[i]}<tspan class="ccnt"> (${count})</tspan></text>` : `<text x="${x + w / 2}" y="${padT + innerH + 14}" text-anchor="middle" class="cax">${labels[i]}</text>`;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${fill}"/>${valLabel}${countLabel}`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="chart">
    ${SVG_DEFS}
    <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" class="caxis"/>
    ${bars}
  </svg>`;
}

function svgScatter(points: { x: number; y: number; label?: string; highlight?: boolean }[], xLabel: string, yLabel: string, opts: { width?: number; height?: number } = {}) {
  const W = opts.width ?? 720;
  const H = opts.height ?? 260;
  const padL = 50, padR = 20, padT = 14, padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const sx = (x: number) => padL + ((x - minX) / (maxX - minX || 1)) * innerW;
  const sy = (y: number) => padT + innerH - ((y - minY) / (maxY - minY || 1)) * innerH;
  const dots = points.map((p) =>
    `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${p.highlight ? 6 : 3.5}" class="cpt ${p.highlight ? 'hi' : ''}"/>`
  ).join('');
  const labels = points.filter((p) => p.highlight && p.label).map((p) => {
    const x = sx(p.x), y = sy(p.y);
    return `<text x="${x + 9}" y="${y + 4}" class="cpt-label">${escapeHtml(p.label!)}</text>`;
  }).join('');
  const xticks = [minX, (minX + maxX) / 2, maxX].map((v) =>
    `<text x="${sx(v)}" y="${padT + innerH + 14}" text-anchor="middle" class="cax">${fmtN(v)}</text>`
  ).join('');
  const yticks = [minY, (minY + maxY) / 2, maxY].map((v) =>
    `<text x="${padL - 6}" y="${sy(v) + 3}" text-anchor="end" class="cax">${fmtN(v)}</text>`
  ).join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="chart">
    ${SVG_DEFS}
    <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" class="caxis"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" class="caxis"/>
    ${xticks}${yticks}
    ${dots}
    ${labels}
    <text x="${(padL + W - padR) / 2}" y="${H - 6}" text-anchor="middle" class="caxlbl">${xLabel}</text>
    <text x="${12}" y="${(padT + H - padB) / 2}" text-anchor="middle" transform="rotate(-90 12 ${(padT + H - padB) / 2})" class="caxlbl">${yLabel}</text>
  </svg>`;
}

function svgAreaLine(labels: string[], values: number[], opts: { width?: number; height?: number; valueFmt?: (n: number) => string } = {}) {
  const W = opts.width ?? 1040;
  const H = opts.height ?? 220;
  const padL = 56, padR = 20, padT = 18, padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxV = Math.max(1, ...values);
  const fmtV = opts.valueFmt ?? fmtN;
  const sx = (i: number) => padL + (values.length <= 1 ? innerW / 2 : (i / (values.length - 1)) * innerW);
  const sy = (v: number) => padT + innerH - (v / maxV) * innerH;
  const pts = values.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const area = `M ${sx(0)},${padT + innerH} L ${values.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' L ')} L ${sx(values.length - 1)},${padT + innerH} Z`;
  const dots = values.map((v, i) =>
    v > 0 ? `<circle cx="${sx(i).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="2.5" class="cpt-line"/>` : ''
  ).join('');
  const yT = [0, maxV / 4, maxV / 2, (maxV * 3) / 4, maxV];
  const yticks = yT.map((v) => `
    <line x1="${padL}" y1="${sy(v).toFixed(1)}" x2="${W - padR}" y2="${sy(v).toFixed(1)}" class="cgrid"/>
    <text x="${padL - 8}" y="${sy(v) + 3}" text-anchor="end" class="cax">${fmtV(v)}</text>
  `).join('');
  const tickStep = Math.max(1, Math.ceil(values.length / 12));
  const xticks = labels.map((lab, i) =>
    i % tickStep === 0 ? `<text x="${sx(i).toFixed(1)}" y="${padT + innerH + 14}" text-anchor="middle" class="cax">${lab}</text>` : ''
  ).join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="chart">
    ${SVG_DEFS}
    ${yticks}
    <path d="${area}" class="carea"/>
    <polyline points="${pts}" class="cline"/>
    ${dots}
    ${xticks}
  </svg>`;
}

function svgHistogram(values: number[], opts: { width?: number; height?: number; bins?: number; xLabel?: string } = {}) {
  const W = opts.width ?? 510;
  const H = opts.height ?? 200;
  const padL = 50, padR = 16, padT = 14, padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const sorted = [...values].sort((a, b) => a - b);
  const maxV = sorted[sorted.length - 1] || 1;
  const bins = opts.bins ?? 8;
  const useLog = maxV / Math.max(1, sorted[0]) > 100;
  const log = (v: number) => Math.log10(Math.max(1, v));
  const max = useLog ? log(maxV) : maxV;
  const min = useLog ? log(Math.max(1, sorted[0])) : 0;
  const binW = (max - min) / bins;
  const counts = Array.from({ length: bins }, () => 0);
  for (const v of values) {
    const x = useLog ? log(v) : v;
    let idx = Math.floor((x - min) / binW);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  const maxCount = Math.max(1, ...counts);
  const bars = counts.map((c, i) => {
    const x = padL + (i / bins) * innerW + 2;
    const w = Math.max(1, innerW / bins - 4);
    const h = (c / maxCount) * innerH;
    const y = padT + innerH - h;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="url(#cbar-grad)"/>${c > 0 ? `<text x="${x + w / 2}" y="${y - 3}" text-anchor="middle" class="cval">${c}</text>` : ''}`;
  }).join('');
  const xT = [0, bins / 4, bins / 2, (bins * 3) / 4, bins].map((b) => {
    const v = useLog ? Math.round(Math.pow(10, min + b * binW)) : Math.round(min + b * binW);
    const x = padL + (b / bins) * innerW;
    return `<text x="${x}" y="${padT + innerH + 14}" text-anchor="middle" class="cax">${fmtN(v)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="chart">
    ${SVG_DEFS}
    <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" class="caxis"/>
    ${bars}${xT}
    ${opts.xLabel ? `<text x="${(padL + W - padR) / 2}" y="${H - 4}" text-anchor="middle" class="caxlbl">${opts.xLabel}${useLog ? ' (log scale)' : ''}</text>` : ''}
  </svg>`;
}

function gradeColor(g: string) {
  return ({ A: '#197043', B: '#3a8a55', C: '#8d5400', D: '#a85533', F: '#a02323' } as Record<string, string>)[g] || '#666';
}

const cardsHtml = computed.map((c, idx) => {
  const d = diagnose(c);
  const isTop = top3Ids.has(c.id);
  const isBot = bot3Ids.has(c.id);
  const isFix = fixIds.has(c.id);
  const cardClass = isTop ? 'green' : isBot ? 'red' : isFix ? 'amber' : '';
  const src = thumbSrc(c);
  const thumb = src
    ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="thumb-placeholder"></div>`;
  const dateStr = new Date(c.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const cap = c.caption || '';
  const isLong = cap.length > 220;
  const captionShort = cap.slice(0, 220) + (isLong ? '…' : '');
  const captionEsc = escapeHtml(cap);
  const critique = insights.critiques?.[c.id];
  return `<div class="card ${cardClass}" data-caption="${captionEsc}">
  <div class="rank">#${idx + 1}</div>
  <a href="${escapeHtml(c.permalink)}" target="_blank" rel="noopener" class="thumb-link">${thumb}<span class="grade" style="background:${gradeColor(c.grade)}">${c.grade}</span></a>
  <div class="body">
    <div class="meta">
      <span class="tag ${d.color}">${escapeHtml(d.tag)}</span>
      <span class="dt">${escapeHtml(dateStr)}</span>
      <button class="copy-btn" data-copy-id="${escapeHtml(c.id)}" aria-label="Copy caption">📋 Copy caption</button>
    </div>
    <div class="cap${isLong ? ' clamp' : ''}">${escapeHtml(captionShort || '(no caption)')}</div>
    ${isLong ? `<button class="expand-btn" data-target="${escapeHtml(c.id)}">Show full caption ▼</button>` : ''}
    ${isLong ? `<div class="cap-full" id="cap-full-${escapeHtml(c.id)}" hidden>${captionEsc}</div>` : ''}
    ${critique ? `<div class="critique"><span class="critique-label">⚠️ Why it underperformed:</span> ${escapeHtml(critique)}</div>` : ''}
    <div class="axes">
      <span class="lbl">Hook</span><div class="bar"><span style="width:${c.hook_axis}%"></span></div><span class="num">${c.watch_s.toFixed(1)}s</span>
      <span class="lbl">Reach</span><div class="bar"><span style="width:${c.reach_axis}%"></span></div><span class="num">${fmtExact(c.reach)}</span>
      <span class="lbl">Viral</span><div class="bar"><span style="width:${c.viral_axis}%"></span></div><span class="num">${fmtExact(c.shares + c.saved)}</span>
    </div>
    <div class="micro">
      <span><b>${fmtExact(c.views)}</b> views</span>
      ${followers ? `<span><b>${fmtPct(c.follower_reach_pct, 0)}</b> of followers</span>` : ''}
      <span><b>${fmtPct(c.engagement_rate)}</b> eng.</span>
      <span>${fmtExact(c.likes)} ❤</span>
      <span>${fmtExact(c.comments)} 💬</span>
      <span>${fmtExact(c.shares)} ↗</span>
      <span>${fmtExact(c.saved)} 🔖</span>
      <span>${c.hashtag_count} #</span>
      <span>${c.word_count}w</span>
    </div>
  </div>
  <div class="score">
    <span class="num">${c.hook_score.toFixed(0)}</span>
    <small>hook score</small>
    <span class="grade-small" style="color:${gradeColor(c.grade)}">${c.grade}</span>
    <a href="${escapeHtml(c.permalink)}" class="open" target="_blank" rel="noopener">open on IG ↗</a>
  </div>
</div>`;
}).join('');

const top3 = computed.slice(0, 3);
const breakdownHtml = top3.map((c, idx) => {
  const src = thumbSrc(c);
  const thumb = src
    ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="thumb-placeholder large"></div>`;
  const dateStr = new Date(c.timestamp).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const hourStr = new Date(c.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const trophy = ['🥇', '🥈', '🥉'][idx] || '🏅';
  return `<div class="winner">
    <div class="winner-head">
      <span class="trophy">${trophy}</span>
      <a href="${escapeHtml(c.permalink)}" target="_blank" rel="noopener" class="winner-thumb">${thumb}</a>
      <div class="winner-stats">
        <div class="winner-rank">#${idx + 1} · grade ${c.grade}</div>
        <div class="winner-date">${escapeHtml(dateStr)} at ${escapeHtml(hourStr)}</div>
        <div class="winner-numbers">
          <span><b>${fmtExact(c.views)}</b> views</span>
          <span><b>${fmtExact(c.reach)}</b> reach</span>
          <span><b>${fmtPct(c.follower_reach_pct, 0)}</b> of followers</span>
          <span><b>${c.watch_s.toFixed(1)}s</b> avg watch</span>
          <span><b>${fmtExact(c.shares)}</b> shares</span>
          <span><b>${fmtExact(c.saved)}</b> saves</span>
        </div>
      </div>
      <button class="copy-btn big" data-copy-id="${escapeHtml(c.id)}">📋 Copy this caption</button>
    </div>
    ${(() => {
      const w = whyPushed(c);
      if (w.points.length === 0) return '';
      return `<div class="why-pushed">
        <div class="why-pushed-title">🚀 Pourquoi l'algo IG l'a poussé</div>
        ${w.points.map((p) => `<div class="why-pushed-point why-${p.importance}">
          <div class="why-factor">${escapeHtml(p.factor)}</div>
          <div class="why-signal">${escapeHtml(p.signal)}</div>
        </div>`).join('')}
        <div class="why-verdict">${escapeHtml(w.verdict)}</div>
      </div>`;
    })()}
    <div class="winner-caption" id="winner-cap-${escapeHtml(c.id)}">${escapeHtml(c.caption || '(no caption)')}</div>
  </div>`;
}).join('');

const captionMapJs = JSON.stringify(
  Object.fromEntries(computed.map((c) => [c.id, c.caption || '']))
);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(account.username || 'Instagram')} — Reels analytics</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f5f5f7;
    --card: #fff;
    --ink: #0d1117;
    --muted: #5a6271;
    --line: #e8e8ec;
    --accent: #0a66ff;
    --green: #197043;
    --red: #a02323;
    --amber: #8d5400;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif; max-width: 1100px; margin: 32px auto 60px; padding: 0 24px; color: var(--ink); background: var(--bg); line-height: 1.45; -webkit-font-smoothing: antialiased; }
  h1, h2, h3 { letter-spacing: -0.4px; font-weight: 700; }
  h1 { font-size: 30px; margin: 0; }
  h2 { font-size: 18px; margin: 36px 0 12px; }
  h3 { font-size: 14px; margin: 0 0 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 13px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: #eef0f3; padding: 1px 6px; border-radius: 4px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, monospace; }

  .header { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding-bottom: 22px; border-bottom: 1px solid var(--line); margin-bottom: 32px; }
  .header .id { display: flex; align-items: center; gap: 18px; }
  .header img.avatar { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; background: #ddd; box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
  .header .who .name { font-size: 14px; color: var(--muted); margin-bottom: 2px; }
  .header .who .uname { font-size: 26px; font-weight: 800; letter-spacing: -0.6px; }
  .header .who .bio { font-size: 12px; color: var(--muted); margin-top: 4px; max-width: 340px; line-height: 1.4; }
  .header .meta-r { text-align: right; font-size: 12px; color: var(--muted); }
  .header .meta-r .badge { display: inline-block; background: linear-gradient(135deg, #0a66ff 0%, #4a8aff 100%); color: #fff; font-weight: 600; padding: 4px 10px; border-radius: 6px; font-size: 11px; letter-spacing: 0.4px; text-transform: uppercase; margin-bottom: 6px; }

  .glossary { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 0; margin-bottom: 24px; overflow: hidden; }
  .glossary > summary { padding: 14px 20px; cursor: pointer; font-weight: 600; font-size: 14px; list-style: none; display: flex; align-items: center; justify-content: space-between; }
  .glossary > summary::-webkit-details-marker { display: none; }
  .glossary > summary::after { content: '▼'; font-size: 11px; color: var(--muted); transition: transform 0.2s; }
  .glossary[open] > summary::after { transform: rotate(180deg); }
  .glossary-body { padding: 0 20px 18px; border-top: 1px solid var(--line); }
  .gloss-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 20px; margin-top: 14px; font-size: 13px; line-height: 1.5; }
  .gloss-item { padding: 6px 0; }
  .gloss-item .term { font-weight: 700; color: var(--ink); }
  .gloss-item .term .formula { font-family: ui-monospace, monospace; background: #eef0f3; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; color: var(--muted); margin-left: 6px; }
  .gloss-item .desc { color: var(--muted); margin-top: 2px; }
  .gloss-item .desc .key { color: var(--accent); font-weight: 600; }

  .kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 28px; }
  .kpi { background: var(--card); border-radius: 12px; padding: 16px 14px; border: 1px solid var(--line); }
  .kpi .v { font-size: 22px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .kpi .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; font-weight: 600; }
  .kpi.feature { background: linear-gradient(135deg, #0a66ff 0%, #4a8aff 100%); color: #fff; border-color: transparent; }
  .kpi.feature .k { color: rgba(255,255,255,0.85); }

  .headline { background: var(--card); border-radius: 12px; padding: 22px 26px; margin-bottom: 14px; border-left: 4px solid var(--green); border-top: 1px solid var(--line); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .headline strong { font-size: 24px; display: block; margin-bottom: 6px; letter-spacing: -0.4px; }

  .pattern { background: var(--card); border-radius: 12px; padding: 14px 18px; margin-bottom: 28px; font-size: 13px; border: 1px solid var(--line); }
  .pattern .pos { color: var(--green); font-weight: 600; }
  .pattern .neg { color: var(--red); font-weight: 600; }

  .row { display: grid; gap: 14px; margin-bottom: 22px; }
  .row.three { grid-template-columns: 1fr 1fr 1fr; }
  .row.two { grid-template-columns: 1fr 1fr; }

  .panel { background: var(--card); border-radius: 12px; padding: 18px 20px; border: 1px solid var(--line); }
  .panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-bottom: 8px; flex-wrap: wrap; }
  .panel-head h3 { margin: 0; }
  .panel-meta { font-size: 12px; color: var(--muted); }
  .panel-meta b { color: var(--ink); font-weight: 600; }
  .panel .item { font-size: 13px; padding: 8px 0; color: var(--ink); border-top: 1px solid var(--line); display: flex; align-items: center; gap: 8px; }
  .panel .item:first-of-type { border-top: 0; }
  .panel .item .b { background: var(--line); border-radius: 99px; font-size: 10px; padding: 1px 6px; color: var(--muted); flex-shrink: 0; }
  .panel .empty { color: #9aa1ad; font-size: 12px; padding: 6px 0; }

  .insights { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .insight { background: var(--card); border-radius: 10px; padding: 14px 16px; font-size: 13px; border: 1px solid var(--line); }
  .insight .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; font-weight: 600; }
  .insight .val { font-size: 15px; font-weight: 600; }
  .insight .val.pos { color: var(--green); }
  .insight .val.neg { color: var(--red); }
  .insight .note { font-size: 12px; color: var(--muted); margin-top: 4px; }

  .chart { width: 100%; height: auto; }
  .cbar { fill: url(#cbar-grad); }
  .cval { fill: var(--ink); font-size: 10px; font-family: ui-monospace, monospace; }
  .cax { fill: var(--muted); font-size: 10px; }
  .ccnt { fill: #9aa1ad; }
  .caxis { stroke: var(--line); stroke-width: 1; }
  .cgrid { stroke: var(--line); stroke-width: 1; stroke-dasharray: 2 4; }
  .caxlbl { fill: var(--muted); font-size: 11px; }
  .cpt { fill: #345; opacity: 0.6; }
  .cpt.hi { fill: var(--green); opacity: 1; stroke: #fff; stroke-width: 2; }
  .cpt-label { fill: var(--green); font-size: 11px; font-weight: 600; }
  .cpt-line { fill: var(--accent); }
  .cline { fill: none; stroke: var(--accent); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
  .carea { fill: var(--accent); opacity: 0.12; }

  .hashtags { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 0 14px; font-size: 13px; align-items: center; }
  .hashtags .h { font-weight: 600; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; padding: 6px 0; border-bottom: 1px solid var(--line); }
  .hashtags .c { padding: 8px 0; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  .hashtags .c.t { font-family: ui-monospace, monospace; font-size: 12px; }
  .hashtags .c.n { text-align: right; }

  .winners { display: grid; gap: 12px; margin-bottom: 14px; }
  .winner { background: var(--card); border-radius: 14px; padding: 18px 20px; border: 1px solid var(--line); border-left: 5px solid var(--green); }
  .winner-head { display: grid; grid-template-columns: 32px 90px 1fr auto; gap: 16px; align-items: center; margin-bottom: 12px; }
  .trophy { font-size: 24px; }
  .winner-thumb { display: block; }
  .winner-thumb img, .winner-thumb .thumb-placeholder { width: 90px; height: 120px; object-fit: cover; border-radius: 8px; display: block; }
  .winner-rank { font-weight: 700; font-size: 14px; color: var(--green); }
  .winner-date { font-size: 12px; color: var(--muted); margin: 2px 0 8px; }
  .winner-numbers { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--muted); }
  .winner-numbers b { color: var(--ink); font-size: 13px; font-variant-numeric: tabular-nums; }
  .winner-caption { background: #fafbfd; border-radius: 8px; padding: 14px 16px; font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; border: 1px solid var(--line); font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  .why-pushed { background: #f0f7ff; border: 1px solid #cfe1ff; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .why-pushed-title { font-size: 13px; font-weight: 700; color: var(--accent); margin-bottom: 10px; letter-spacing: -0.2px; }
  .why-pushed-point { padding: 8px 0; border-top: 1px solid #d8e6fb; }
  .why-pushed-point:first-of-type { border-top: 0; padding-top: 0; }
  .why-pushed-point.why-huge { position: relative; padding-left: 14px; }
  .why-pushed-point.why-huge::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 8px; width: 3px; background: var(--accent); border-radius: 2px; }
  .why-factor { font-size: 13px; font-weight: 600; color: var(--ink); margin-bottom: 4px; }
  .why-signal { font-size: 12px; color: var(--muted); line-height: 1.5; }
  .why-verdict { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #cfe1ff; font-size: 12px; font-style: italic; color: var(--ink); font-weight: 500; }

  .critique { background: #fef6e7; border-left: 3px solid var(--amber); padding: 8px 12px; border-radius: 0 6px 6px 0; font-size: 12px; line-height: 1.5; color: #5a4218; margin: 8px 0; }
  .critique-label { font-weight: 600; color: var(--amber); }

  .concepts-section { margin: 32px 0 20px; }
  .concepts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .concept { background: linear-gradient(135deg, #fff 0%, #f5f8ff 100%); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; }
  .concept-num { display: inline-block; background: var(--accent); color: #fff; border-radius: 50%; width: 26px; height: 26px; text-align: center; line-height: 26px; font-weight: 700; font-size: 13px; margin-right: 8px; vertical-align: middle; }
  .concept-title { font-size: 16px; font-weight: 700; letter-spacing: -0.3px; margin-bottom: 12px; display: flex; align-items: center; }
  .concept-format { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 10px; font-weight: 600; }
  .concept-block { font-size: 13px; line-height: 1.45; margin-bottom: 10px; }
  .concept-block .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 3px; }
  .concept-block .val { color: var(--ink); }
  .concept-block.hook .val { font-style: italic; color: #2e3a4f; background: #fff; padding: 6px 10px; border-radius: 6px; border: 1px dashed var(--line); }
  .concept-copy { background: transparent; border: 1px solid var(--accent); color: var(--accent); border-radius: 6px; padding: 5px 10px; font-size: 11px; font-weight: 500; cursor: pointer; font-family: inherit; }
  .concept-copy:hover { background: var(--accent); color: #fff; }
  .concept-copy.copied { background: var(--green); color: #fff; border-color: var(--green); }

  .copy-btn { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 5px 10px; font-size: 11px; font-weight: 500; cursor: pointer; transition: background 0.15s; font-family: inherit; }
  .copy-btn:hover { background: #084dc7; }
  .copy-btn.big { padding: 8px 14px; font-size: 13px; align-self: start; }
  .copy-btn.copied { background: var(--green); }
  .copy-btn.copied::after { content: " ✓"; }
  .expand-btn { background: transparent; border: 0; color: var(--accent); cursor: pointer; padding: 4px 0 8px; font-size: 12px; font-family: inherit; font-weight: 500; }
  .expand-btn:hover { text-decoration: underline; }
  .cap-full { background: #fafbfd; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; border: 1px solid var(--line); max-height: 320px; overflow-y: auto; }

  .ranklist { margin-top: 12px; }
  .card { background: var(--card); border-radius: 12px; padding: 14px 16px; margin-bottom: 10px; display: grid; grid-template-columns: 36px 100px 1fr 130px; gap: 14px; align-items: center; border: 1px solid var(--line); border-left-width: 4px; border-left-color: transparent; }
  .card.green { border-left-color: var(--green); }
  .card.red { border-left-color: var(--red); }
  .card.amber { border-left-color: var(--amber); }
  .card .rank { font-size: 18px; font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums; text-align: center; }
  .card .thumb-link { position: relative; display: block; }
  .card img, .thumb-placeholder { width: 100px; height: 130px; object-fit: cover; border-radius: 8px; background: #eee; display: block; }
  .card .grade { position: absolute; top: 6px; right: 6px; color: #fff; font-weight: 700; font-size: 13px; padding: 2px 7px; border-radius: 6px; }
  .card .body { min-width: 0; }
  .card .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .card .dt { font-size: 11px; color: var(--muted); }
  .card .cap { font-size: 13px; color: var(--ink); line-height: 1.4; margin-bottom: 10px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .card .micro { display: flex; gap: 14px; margin-top: 8px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
  .tag { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 99px; font-weight: 500; }
  .tag.green { background: #e6f7ee; color: var(--green); }
  .tag.red { background: #fce9e9; color: var(--red); }
  .tag.amber { background: #fdf3df; color: var(--amber); }
  .tag.gray { background: #eef0f3; color: var(--muted); }
  .axes { display: grid; grid-template-columns: 50px 1fr 70px; gap: 4px 10px; align-items: center; font-size: 11px; }
  .axes .lbl { color: var(--muted); }
  .bar { background: #eef0f3; border-radius: 4px; height: 6px; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: linear-gradient(90deg, #345 0%, #57a 100%); }
  .num { font-size: 11px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
  .score { text-align: right; line-height: 1.1; }
  .score .num { font-size: 26px; font-weight: 700; color: var(--ink); display: block; }
  .score small { display: block; font-size: 9px; color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
  .score .grade-small { display: inline-block; font-weight: 700; font-size: 13px; margin-top: 4px; }
  .score .open { display: block; font-size: 11px; color: var(--accent); margin-top: 6px; font-weight: 500; }

  .legend { font-size: 11px; color: var(--muted); margin-top: 8px; }
  .csv-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 13px; }
  .csv-link { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--accent); border-radius: 6px; color: var(--accent); font-weight: 500; text-decoration: none; }
  .csv-link:hover { background: var(--accent); color: #fff; text-decoration: none; }

  @media print {
    body { background: white; }
    .card, .panel, .kpi, .insight, .pattern, .headline { break-inside: avoid; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="id">
    ${account.profile_picture_url ? `<img class="avatar" src="${escapeHtml(account.profile_picture_url)}" alt="" referrerpolicy="no-referrer">` : '<div class="avatar"></div>'}
    <div class="who">
      <div class="name">${escapeHtml(account.name || 'Instagram')}</div>
      <div class="uname">@${escapeHtml(account.username || 'unknown')}</div>
      ${account.biography ? `<div class="bio">${escapeHtml((account.biography || '').replace(/\n/g, ' · '))}</div>` : ''}
    </div>
  </div>
  <div class="meta-r">
    <div class="badge">Reels analytics</div>
    <div><b>${data.window_start && data.window_end ? `${new Date(data.window_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} → ${new Date(data.window_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : `${data.window_days || 30} days`}</b></div>
    <div>${fmtExact(computed.length)} reels · ${data.window_days || 30}-day window</div>
    <div>Generated ${escapeHtml(new Date(data.fetched_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</div>
  </div>
</div>

<details class="glossary">
  <summary>📖 Comment lire ce rapport · clique pour ouvrir</summary>
  <div class="glossary-body">
    <p style="font-size:13px; color:var(--muted); margin: 14px 0 4px;">
      Pour comprendre les chiffres et savoir <b>quoi faire avec</b>. Tout vient directement de l'API Instagram officielle (rien d'inventé).
    </p>
    <div class="gloss-grid">
      <div class="gloss-item">
        <div class="term">Hook (avg watch time)<span class="formula">ig_reels_avg_watch_time ÷ 1000</span></div>
        <div class="desc">Temps moyen pendant lequel les viewers regardent ton reel avant de scroll. <span class="key">C'est le signal #1</span> — si les gens partent dans les 2 premières secondes, l'algo arrête de pousser. Vise <b>≥ 8s</b>.</div>
      </div>
      <div class="gloss-item">
        <div class="term">Reach<span class="formula">unique people</span></div>
        <div class="desc">Nombre unique de comptes qui ont vu ton reel. À comparer à ton nombre de followers : si reach > followers, l'algo te pousse <b>au-delà de ta base</b> (jackpot).</div>
      </div>
      <div class="gloss-item">
        <div class="term">Views<span class="formula">total plays</span></div>
        <div class="desc">Total de lectures (replays inclus). Si <b>views ÷ reach > 1.2</b>, ça veut dire que les gens regardent en boucle — IG adore.</div>
      </div>
      <div class="gloss-item">
        <div class="term">Reach / followers %<span class="formula">reach ÷ followers</span></div>
        <div class="desc">Le ratio qui dit si l'algo te pousse à des non-followers. <b>>100% = bon</b>. <b>>500% = viral</b>. <100% = ton reel reste dans ta bulle.</div>
      </div>
      <div class="gloss-item">
        <div class="term">Share rate<span class="formula">shares ÷ reach × 100</span></div>
        <div class="desc"><span class="key">LE plus fort signal IG.</span> Quand quelqu'un envoie ton reel à un ami, l'algo lit ça comme "ce contenu mérite plus de viewers". Vise <b>≥ 2%</b>.</div>
      </div>
      <div class="gloss-item">
        <div class="term">Save rate<span class="formula">saves ÷ reach × 100</span></div>
        <div class="desc">"Je veux revoir ça plus tard" = signal de qualité. Presque aussi fort que le share. Vise <b>≥ 1%</b>.</div>
      </div>
      <div class="gloss-item">
        <div class="term">Engagement rate<span class="formula">interactions ÷ reach × 100</span></div>
        <div class="desc">Pourcentage de viewers qui interagissent (likes + comments + shares + saves). <b>5%+ = excellent</b>, 2-5% = ok, <2% = faible.</div>
      </div>
      <div class="gloss-item">
        <div class="term">Hook score<span class="formula">watch_s × √reach × (1 + share_pct/100 + save_pct/200)</span></div>
        <div class="desc">Le score composite qu'on a inventé pour ranker tes reels. Combine la qualité du hook (watch), l'échelle (reach), et la viralité (shares/saves). Plus c'est haut, mieux c'est.</div>
      </div>
      <div class="gloss-item">
        <div class="term">Letter grade<span class="formula">A → F</span></div>
        <div class="desc"><b>A</b> = top 15% · <b>B</b> = top 35% · <b>C</b> = milieu · <b>D</b> = bottom 40% · <b>F</b> = bottom 20%. Note relative à TES propres reels, pas une norme externe.</div>
      </div>
      <div class="gloss-item">
        <div class="term">Strong hook ≥12s</div>
        <div class="desc">Reels où les viewers ont passé en moyenne 12+ secondes — un seuil au-dessus duquel IG continue très fortement à pousser.</div>
      </div>
      <div class="gloss-item">
        <div class="term">Replay winner<span class="formula">views ≥ 1.2 × reach</span></div>
        <div class="desc">Reels où les gens ont regardé en moyenne plus d'1× — donc replays. Signal très positif pour l'algo.</div>
      </div>
      <div class="gloss-item">
        <div class="term">Packaging mismatch (🟡 Fix)</div>
        <div class="desc">Reels avec un hook fort (premiers secondes accrocheuses) mais un watch time faible — le titre/thumbnail attire mais le contenu déçoit. À retravailler avant de jeter.</div>
      </div>
    </div>
    <p style="font-size:12px; color:var(--muted); margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line);">
      <b>Ordre de priorité quand tu décides quel reel pousser/recréer :</b><br>
      1️⃣ Share rate (le plus fort signal IG) →
      2️⃣ Reach / followers % (te sort de ta bulle) →
      3️⃣ Save rate →
      4️⃣ Watch time / hook →
      5️⃣ Engagement.
    </p>
  </div>
</details>

<div class="kpis">
  <div class="kpi feature"><div class="v">${fmtExact(followers)}</div><div class="k">Followers</div></div>
  <div class="kpi"><div class="v">${fmtExact(totalReach)}</div><div class="k">Total reach</div></div>
  <div class="kpi"><div class="v">${fmtExact(avgReach)}</div><div class="k">Avg reach / reel</div></div>
  <div class="kpi"><div class="v">${followers ? fmtPct(avgFollowerReach, 0) : '—'}</div><div class="k">Reach / followers</div></div>
  <div class="kpi"><div class="v">${avgWatch.toFixed(1)}s</div><div class="k">Avg watch time</div></div>
  <div class="kpi"><div class="v">${fmtPct(avgEngagement)}</div><div class="k">Avg engagement</div></div>
</div>

<div class="kpis">
  <div class="kpi"><div class="v">${fmtExact(totalViews)}</div><div class="k">Views</div></div>
  <div class="kpi"><div class="v">${fmtExact(totalShares)}</div><div class="k">Shares</div></div>
  <div class="kpi"><div class="v">${fmtExact(totalSaves)}</div><div class="k">Saves</div></div>
  <div class="kpi"><div class="v">${fmtExact(totalLikes + totalComments)}</div><div class="k">Likes + comments</div></div>
  <div class="kpi"><div class="v">${fmtExact(strongHooks)}</div><div class="k">Strong hooks ≥12s</div></div>
  <div class="kpi"><div class="v">${fmtExact(replayWinners)}</div><div class="k">Replay winners (views ≥1.2× reach)</div></div>
</div>

<div class="headline">
  <strong>Your top reel reached ${reachMultiplier}× more than your median.</strong>
  <span class="sub">Top: ${fmtExact(topReach)} reach · Median: ${fmtExact(median)} reach · Top 25% account for ${concentrationPct}% of all reach · Watch gap top vs bottom half: ${watchGap}s</span>
</div>

<div class="pattern">
  ${winnerWords.length ? `<span class="pos">Winner caption words:</span> ${winnerWords.slice(0, 12).map((w) => `<code>${escapeHtml(w)}</code>`).join(' ')}` : `<span class="pos">No common pattern in top captions.</span>`}
  &nbsp;·&nbsp;
  ${loserWords.length ? `<span class="neg">Loser caption words:</span> ${loserWords.slice(0, 12).map((w) => `<code>${escapeHtml(w)}</code>`).join(' ')}` : `<span class="neg">No common pattern in bottom captions.</span>`}
</div>

<div class="row three">
  <div class="panel">
    <h3>🟢 Do more · top 3 by hook score</h3>
    ${computed.slice(0, 3).map((c) => `<div class="item"><span class="b">${c.grade}</span>${escapeHtml((c.caption || '(no caption)').slice(0, 70))}</div>`).join('') || '<div class="empty">none</div>'}
  </div>
  <div class="panel">
    <h3>🔴 Stop · bottom 3</h3>
    ${computed.slice(-3).map((c) => `<div class="item"><span class="b">${c.grade}</span>${escapeHtml((c.caption || '(no caption)').slice(0, 70))}</div>`).join('') || '<div class="empty">none</div>'}
  </div>
  <div class="panel">
    <h3>🟡 Fix · packaging mismatch</h3>
    ${[...fixIds].map((id) => computed.find((c) => c.id === id)).filter(Boolean).map((c) => `<div class="item"><span class="b">${c!.grade}</span>${escapeHtml((c!.caption || '(no caption)').slice(0, 70))}</div>`).join('') || '<div class="empty">none flagged — your hook & watch are aligned</div>'}
  </div>
</div>

${(() => {
  const sortedByTime = [...computed].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const dayMap = new Map<string, { reach: number; count: number }>();
  for (const c of sortedByTime) {
    const k = new Date(c.timestamp).toISOString().slice(0, 10);
    const prev = dayMap.get(k) || { reach: 0, count: 0 };
    prev.reach += c.reach;
    prev.count += 1;
    dayMap.set(k, prev);
  }
  const startDate = data.window_start ? new Date(data.window_start) : new Date(sortedByTime[0]?.timestamp || Date.now());
  const endDate = data.window_end ? new Date(data.window_end) : new Date();
  const dayLabels: string[] = [];
  const dayValues: number[] = [];
  const dayCounts: number[] = [];
  const cur = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const last = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  while (cur <= last) {
    const k = cur.toISOString().slice(0, 10);
    const v = dayMap.get(k);
    dayLabels.push(`${cur.getUTCMonth() + 1}/${cur.getUTCDate()}`);
    dayValues.push(v?.reach || 0);
    dayCounts.push(v?.count || 0);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  const totalDays = dayLabels.length;
  const activeDays = dayCounts.filter((c) => c > 0).length;
  const bestDayIdx = dayValues.indexOf(Math.max(...dayValues));
  const bestDayLabel = dayLabels[bestDayIdx];
  const bestDayReach = dayValues[bestDayIdx];

  return `<h2>Performance over time</h2>
<div class="panel">
  <div class="panel-head"><h3>Daily total reach · ${totalDays} days</h3>
  <div class="panel-meta">Best day: <b>${bestDayLabel}</b> · ${fmtExact(bestDayReach)} reach · Active days: ${activeDays}/${totalDays}</div></div>
  ${svgAreaLine(dayLabels, dayValues, { width: 1040, height: 230, valueFmt: fmtN })}
</div>

<div class="row two">
  <div class="panel">
    <h3>Best posting day · avg hook score</h3>
    ${svgBarChart(WEEKDAY_LABELS, weekdayAvgs, { counts: WEEKDAY_LABELS.map((_, i) => weekdayBuckets[i].length), width: 510, height: 200, valueFmt: (n) => Math.round(n).toString(), highlightMax: true })}
    <div class="legend">Green bar = your strongest day. (n) = posts on that day.</div>
  </div>
  <div class="panel">
    <h3>Best posting hour · avg hook score</h3>
    ${svgBarChart(HOUR_LABELS, hourAvgs, { counts: hourCounts, width: 510, height: 200, valueFmt: (n) => Math.round(n).toString(), highlightMax: true })}
    <div class="legend">Green bar = your strongest 3-hour window (account local time).</div>
  </div>
</div>

<div class="row two">
  <div class="panel">
    <h3>Reach distribution · how often each tier hits</h3>
    ${svgHistogram(computed.map((c) => c.reach), { width: 510, height: 220, bins: 8, xLabel: 'reach' })}
    <div class="legend">Most reels cluster in low reach; viral hits live in the long tail. Numbers above bars = how many reels in that bucket.</div>
  </div>
  <div class="panel">
    <h3>Hook (watch) vs reach · winners cluster top-right</h3>
    ${svgScatter(
      computed.map((c) => ({
        x: c.watch_s,
        y: c.reach,
        highlight: top3Ids.has(c.id),
        label: top3Ids.has(c.id) ? `#${computed.indexOf(c) + 1}` : undefined,
      })),
      'avg watch time (s)',
      'reach',
      { width: 510, height: 220 }
    )}
    <div class="legend">Each dot is one reel. Green = top 3 by hook score.</div>
  </div>
</div>`;
})()}

<h2>Caption pattern lab</h2>
<div class="insights">
  <div class="insight">
    <div class="label">Caption length</div>
    <div class="val ${corrCaptionLen > 0.15 ? 'pos' : corrCaptionLen < -0.15 ? 'neg' : ''}">
      ${corrCaptionLen > 0.15 ? 'Longer = better' : corrCaptionLen < -0.15 ? 'Shorter = better' : 'No clear pattern'}
      <span class="sub">(r=${corrCaptionLen.toFixed(2)})</span>
    </div>
    <div class="note">Top captions avg ${Math.round(avg(top5.map((c) => c.caption_length)))} chars · bottom avg ${Math.round(avg(bot5.map((c) => c.caption_length)))}</div>
  </div>
  <div class="insight">
    <div class="label">Hashtags per reel</div>
    <div class="val ${corrHashtags > 0.15 ? 'pos' : corrHashtags < -0.15 ? 'neg' : ''}">
      ${corrHashtags > 0.15 ? 'More = better' : corrHashtags < -0.15 ? 'Fewer = better' : 'No clear pattern'}
      <span class="sub">(r=${corrHashtags.toFixed(2)})</span>
    </div>
    <div class="note">Top: ${avg(top5.map((c) => c.hashtag_count)).toFixed(1)} avg · bottom: ${avg(bot5.map((c) => c.hashtag_count)).toFixed(1)}</div>
  </div>
  <div class="insight">
    <div class="label">Emoji usage</div>
    <div class="val ${corrEmoji > 0.15 ? 'pos' : corrEmoji < -0.15 ? 'neg' : ''}">
      ${corrEmoji > 0.15 ? 'More emoji helps' : corrEmoji < -0.15 ? 'Fewer emoji is better' : 'No clear pattern'}
      <span class="sub">(r=${corrEmoji.toFixed(2)})</span>
    </div>
    <div class="note">Top: ${avg(top5.map((c) => c.emoji_count)).toFixed(1)} avg · bottom: ${avg(bot5.map((c) => c.emoji_count)).toFixed(1)}</div>
  </div>
  <div class="insight">
    <div class="label">Question in caption?</div>
    <div class="val ${questionLift > 1.15 ? 'pos' : questionLift < 0.85 ? 'neg' : ''}">
      ${questionLift > 1.15 ? `Questions perform ${((questionLift - 1) * 100).toFixed(0)}% better` : questionLift < 0.85 ? `Questions hurt by ${((1 - questionLift) * 100).toFixed(0)}%` : 'About the same either way'}
    </div>
    <div class="note">${questionPosts.length} reels with "?", ${noQuestionPosts.length} without</div>
  </div>
</div>

${topHashtags.length ? `<h2>Hashtag performance</h2>
<div class="panel">
  <div class="hashtags">
    <div class="h">Hashtag</div><div class="h" style="text-align:right">Uses</div><div class="h" style="text-align:right">Avg reach</div><div class="h" style="text-align:right">Avg hook score</div>
    ${topHashtags.map((h) => `<div class="c t">${escapeHtml(h.tag)}</div><div class="c n">${h.uses}</div><div class="c n">${fmtExact(h.avgReach)}</div><div class="c n">${h.avgHook.toFixed(0)}</div>`).join('')}
  </div>
  <div class="legend">Hashtags used at least twice, sorted by avg hook score.</div>
</div>` : ''}

${insights.concepts && insights.concepts.length ? `<h2 class="concepts-section">💡 Next reel concepts · AI-generated from your top 5 patterns</h2>
<div class="concepts">
${insights.concepts.map((c, i) => `<div class="concept">
  <div class="concept-title"><span class="concept-num">${i + 1}</span>${escapeHtml(c.title)}</div>
  ${c.format_note ? `<div class="concept-format">${escapeHtml(c.format_note)}</div>` : ''}
  <div class="concept-block hook">
    <span class="lbl">Hook (first 2 seconds)</span>
    <span class="val">${escapeHtml(c.hook)}</span>
  </div>
  <div class="concept-block">
    <span class="lbl">Angle</span>
    <span class="val">${escapeHtml(c.angle)}</span>
  </div>
  <div class="concept-block">
    <span class="lbl">Caption opener</span>
    <span class="val">${escapeHtml(c.caption_opener)}</span>
  </div>
  <button class="concept-copy" data-concept-idx="${i}">📋 Copy caption opener</button>
</div>`).join('')}
</div>
<div class="legend" style="margin: 10px 0 28px">Generated ${insights.generated_at ? new Date(insights.generated_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'just now'} by Claude analyzing your top 5 reels' patterns.</div>` : ''}

<h2>🏆 Top 3 winners · full breakdown</h2>
<div class="winners">${breakdownHtml}</div>
<div class="legend csv-row" style="margin-bottom:24px">
  Click "Copy this caption" to copy text. Or download all reels (ranked, with full captions + metrics) as CSV:
  <a href="captions.csv" download class="csv-link">📥 Download captions.csv</a>
</div>

<h2>All reels · ranked by hook score</h2>
<div class="ranklist">${cardsHtml}</div>

<script>
const CAPTIONS = ${captionMapJs};
const CONCEPT_OPENERS = ${JSON.stringify((insights.concepts || []).map((c) => c.caption_opener))};
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.matches('.concept-copy')) {
    const idx = Number(t.getAttribute('data-concept-idx'));
    const text = CONCEPT_OPENERS[idx];
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        const original = t.textContent;
        t.classList.add('copied');
        t.textContent = 'Copied';
        setTimeout(() => { t.classList.remove('copied'); t.textContent = original; }, 1400);
      });
    }
  }
  if (t.matches('.copy-btn')) {
    const id = t.getAttribute('data-copy-id');
    if (id && CAPTIONS[id] !== undefined) {
      navigator.clipboard.writeText(CAPTIONS[id]).then(() => {
        const original = t.textContent;
        t.classList.add('copied');
        t.textContent = 'Copied';
        setTimeout(() => { t.classList.remove('copied'); t.textContent = original; }, 1400);
      });
    }
  }
  if (t.matches('.expand-btn')) {
    const id = t.getAttribute('data-target');
    const full = document.getElementById('cap-full-' + id);
    const clamp = t.previousElementSibling;
    if (full && clamp) {
      const isHidden = full.hasAttribute('hidden');
      if (isHidden) {
        full.removeAttribute('hidden');
        clamp.classList.remove('clamp');
        clamp.style.display = 'none';
        t.textContent = 'Hide full caption ▲';
      } else {
        full.setAttribute('hidden', '');
        clamp.classList.add('clamp');
        clamp.style.display = '';
        t.textContent = 'Show full caption ▼';
      }
    }
  }
});
</script>

<div class="legend" style="margin-top:24px">
  <strong>Methodology.</strong> hook_score = watch_s × √reach × (1 + share_pct/100 + save_pct/200). Letter grades: A = top 15%, B = next 20%, C = middle 25%, D = next 20%, F = bottom 20%. "Packaging mismatch" = top quartile hook_rate but bottom quartile watch — people clicked through but the content didn't reward them.
</div>

</body></html>`;

writeFileSync('report.html', html);
console.log(`Wrote report.html (${computed.length} reels, ${followers ? followers.toLocaleString() + ' followers' : 'no follower data'}).`);

const CSV_COLS: { key: string; header: string; get: (c: Computed) => string | number }[] = [
  { key: 'rank', header: 'rank', get: (c) => computed.indexOf(c) + 1 },
  { key: 'grade', header: 'grade', get: (c) => c.grade },
  { key: 'date', header: 'date', get: (c) => c.timestamp.slice(0, 10) },
  { key: 'permalink', header: 'permalink', get: (c) => c.permalink },
  { key: 'hook_score', header: 'hook_score', get: (c) => Math.round(c.hook_score) },
  { key: 'reach', header: 'reach', get: (c) => c.reach },
  { key: 'views', header: 'views', get: (c) => c.views },
  { key: 'likes', header: 'likes', get: (c) => c.likes },
  { key: 'comments', header: 'comments', get: (c) => c.comments },
  { key: 'shares', header: 'shares', get: (c) => c.shares },
  { key: 'saved', header: 'saved', get: (c) => c.saved },
  { key: 'watch_s', header: 'avg_watch_s', get: (c) => c.watch_s.toFixed(2) },
  { key: 'followers_pct', header: 'reach_pct_followers', get: (c) => c.follower_reach_pct.toFixed(1) },
  { key: 'engagement_pct', header: 'engagement_pct', get: (c) => c.engagement_rate.toFixed(2) },
  { key: 'hashtags', header: 'hashtag_count', get: (c) => c.hashtag_count },
  { key: 'caption', header: 'caption', get: (c) => c.caption },
];

function csvEscape(v: string | number): string {
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const csvRows = [
  CSV_COLS.map((col) => col.header).join(','),
  ...computed.map((c) => CSV_COLS.map((col) => csvEscape(col.get(c))).join(',')),
];
writeFileSync('captions.csv', csvRows.join('\n') + '\n');
console.log(`Wrote captions.csv (${computed.length} rows).`);
