# Instagram automation stack

Three independent automations on top of **one** Instagram account, sharing
**one** Composio API key. Built for creators who want to (1) understand which
of their Reels actually performed, (2) reply to comments while the algorithm
is still pushing the post, and (3) DM affiliate links to anyone who comments a
trigger keyword — all without lifting a finger.

> **Want to install this?** Read **[SETUP.md](SETUP.md)** for the
> step-by-step walkthrough. This README explains what each piece does and
> why. Read it first if you're new to the project.

---

## The three systems at a glance

| # | What it does                                      | Lives in           | Runs on                | Cadence      |
|---|---------------------------------------------------|--------------------|------------------------|--------------|
| 1 | **Daily analytics dashboard** — scores your Reels | `agent.ts`, `render.ts` | GitHub Actions    | 06:00 UTC/day |
| 2 | **AI auto-reply** — drafts a reply to each new comment | `auto-reply.ts` | GitHub Actions       | every 30 min |
| 3 | **Comment → DM bot** — affiliate keyword triggers | `instagram-dm-bot/` | Cloudflare Workers  | every ~15 s  |

They are **fully independent**. You can run only #1 if all you want is
analytics. You can skip #1 entirely and only ship #3. Nothing breaks.

---

## Why this split between GitHub Actions and Cloudflare?

GitHub Actions is free, durable, has built-in storage (git itself), and is
perfect for jobs that run every few minutes or longer. But **GitHub Actions
does not honor cron schedules below ~5 minutes reliably** — runs can be
delayed 5–15 minutes during peak hours.

A comment → DM bot needs to react in seconds (Instagram's private-reply
window closes fast, and the DM feels less spammy the closer it is to the
comment). So that piece lives on **Cloudflare Workers**, whose 1-minute cron
is honored to the second. The Worker then internally sub-polls 4 times per
tick to get effective ~15-second latency.

Everything else stays on GitHub because the cadence is fine and the cost is
zero.

---

## How each system works

### System #1 — Daily analytics dashboard

```
agent.ts              ← fetches last 30 days of Reels via Composio MCP
   ↓
data/reels.json       ← raw API response cached on disk
   ↓
render.ts             ← scores each reel, builds report.html
   ↓
report.html           ← self-contained dashboard (single HTML file)
   ↓
GitHub Actions        ← commits to docs/index.html every day at 06:00 UTC
   ↓
GitHub Pages          ← serves the dashboard publicly (optional)
```

**What the dashboard shows:**
- Account KPIs (followers, total reach, avg reach/follower, engagement)
- Headline insight (top reel's reach multiplier vs. the median)
- Caption pattern callout (which words correlate with winners vs. losers)
- "Do More / Stop / Fix" grid based on the last 30 days
- Daily reach time-series, posting day/hour heatmaps, reach distribution,
  hook×reach scatter
- Caption pattern lab (length, hashtags, emoji, question correlations)
- Hashtag performance table
- Top 3 winners with full caption + copy-to-clipboard
- Full ranked list with letter grades A–F per reel

**Tweak the window:** change `DAYS = 30` at the top of `agent.ts`. The
window ends *yesterday* on purpose — the last 24h of Instagram analytics
data are unstable and pollute averages.

**The score:** an opinionated blend of reach, engagement, and reach-rate
relative to your own median. It's a *relative* score within your account,
not a universal one. A "B" reel on a huge account may have more reach than
an "A" reel on a small one — the grade tells you which posts your audience
responded to compared to the rest of your content.

---

### System #2 — AI auto-reply to comments

```
agent.ts              ← refresh posts data (so we know which comments are new)
   ↓
auto-reply.ts         ← for each new comment:
                          1. read the comment + parent reel caption
                          2. ask OpenAI to draft a contextual reply
                          3. post the reply via Composio
                          4. record the comment id in state/replied.json
   ↓
state/replied.json    ← dedupe state, committed to git
   ↓
render-replies.ts     ← builds replies.html (audit log of every reply)
```

**Why this matters for the algorithm:** Instagram boosts posts that get
early engagement after publishing. Replying to every comment in the first
hour (and ideally with something more thoughtful than "🙏") materially helps
reach. Doing it manually doesn't scale beyond ~50 followers; doing it with
a tuned LLM scales infinitely.

**Anti-spam guardrails:**
- `LIMIT=10` per run, `MAX_PER_HOUR=20` (rolling) — hard caps so you don't
  blow past Instagram's throttle.
- `SKIP_RECENT_MIN=30` — never reply to a comment less than 30 minutes old,
  so you have time to reply manually first if it's an important commenter.
- Dedupe via `state/replied.json` — every comment gets replied to at most
  once, even if the workflow runs twice in a row.

**Tune the prompt:** open `auto-reply.ts`, find the `buildPrompt(...)`
function. The default prompt aims for a short, warm, on-brand reply that
references the reel's topic. Edit it to match your voice — this is the
single biggest lever for quality.

**Dry-run locally before changing anything:**

```bash
npm run reply:dry
```

Prints what it *would* reply to each new comment without posting.

---

### System #3 — Comment → DM bot (Cloudflare Worker)

```
Cloudflare cron (1 min)
   ↓
worker.ts             ← every minute, runs 4 sub-polls (~15s apart):
                          1. fetch recent posts via Composio REST API
                          2. fetch comments on each post
                          3. for each comment, check if it matches any
                             CAMPAIGN keyword (case-insensitive)
                          4. on match → DM the author the affiliate link,
                             post a public reply, record in KV
   ↓
KV namespace          ← dedupe + per-hour cap + dashboard log
   ↓
Worker URL            ← live dashboard, auto-refreshing every minute
```

**The CAMPAIGNS array** at the top of `instagram-dm-bot/src/worker.ts` is
where all the per-partnership config lives. One entry per affiliate deal:

```ts
{
  name: 'Emergent',                                          // shown on dashboard
  keyword: 'build',                                          // matched in comments
  link: 'https://app.emergent.sh/register?ref=YOUR_REF_CODE', // DMed to commenter
  dmTemplate: 'Yo! 🙌 Want to build like in the reel? {link}',
  publicReplies: ['check your DMs 📩', 'sent it to you 👀'], // one is picked at random
}
```

Adding a new partner = paste ~7 lines, `npx wrangler deploy`. Done.

**Order matters:** if a comment matches multiple keywords, the **first**
campaign in the array wins. Put more specific keywords above generic ones.

**Anti-double-DM:** state is shared across all campaigns. The same person
who comments two keywords on two posts gets one DM total (from whichever
matched first). The `MAX_PER_HOUR` cap is also shared — across every
campaign combined.

**Why a separate KV store and not git?** GitHub Actions can commit state
files between runs, but Cloudflare Workers don't have a filesystem and run
in V8 isolates. KV (Cloudflare's key-value store, free tier) is the
canonical way to persist state. Each run reads "who have I already DMed",
processes new comments, then writes back the updated set.

**Live dashboard:** after deploy, the Worker URL itself
(`https://instagram-dm-bot.<your-subdomain>.workers.dev`) renders an HTML
dashboard showing each campaign's hourly DM count, last-matched comments,
and current cap usage. Visit `URL/run` to manually trigger one poll
(useful for debugging — no need to wait for the cron).

---

## Quick start

Full walkthrough is in [`SETUP.md`](SETUP.md). The 30-second version:

```bash
git clone https://github.com/LdwS123/instagram-automation-template.git
cd instagram-automation-template
npm install
cp .env.example .env                 # edit and add your COMPOSIO_API_KEY
npm run report                       # first run opens an AUTH_URL — log into IG, then re-run
open report.html                     # boom, your dashboard
```

To enable the GitHub Actions automations (#1 + #2), push the repo to your
own GitHub and add `COMPOSIO_API_KEY` (and `OPENAI_API_KEY` for #2) as repo
secrets. To enable the DM bot (#3), `cd instagram-dm-bot && npx wrangler
deploy`. Details in SETUP.md.

---

## Tech stack

| Layer              | Choice                                            | Why                                              |
|--------------------|---------------------------------------------------|--------------------------------------------------|
| Instagram API      | [Composio](https://composio.dev) hosted MCP       | Handles OAuth + rate limits + endpoint mapping   |
| AI replies         | OpenAI (`gpt-4o` by default)                      | Best quality-per-cent for short conversational text |
| Slow automations   | GitHub Actions                                    | Free, durable, git-as-database                   |
| Fast automation    | Cloudflare Workers + KV                           | Honored 1-min cron, ~15s real latency, free tier |
| Runtime            | TypeScript + `tsx` (Node 20)                      | Type safety without a build step                 |
| Dashboard          | Hand-rolled HTML/CSS/JS, single file              | No JS framework, no build, lives in one `.html`  |

No package-as-a-product, no SaaS subscription beyond Composio and (optional)
OpenAI. Everything runs on free tiers.

---

## File map

```
.
├── agent.ts                 # System #1 — fetches reels + insights from Composio
├── analyze.ts               # Optional deeper pattern analysis pass
├── render.ts                # Builds report.html (the dashboard)
│
├── auto-reply.ts            # System #2 — AI comment reply bot
├── render-replies.ts        # Builds replies.html (audit log)
│
├── build-dm.ts              # Legacy comment→DM script (replaced by Cloudflare worker)
├── render-build-dm.ts       # Builds build-dm.html dashboard for legacy script
│
├── catchup-state.ts         # Manual utility: backfill `state/replied.json`
├── recover-state.ts         # Manual utility: rebuild state from current IG comments
│
├── .env.example             # Env var template
├── .github/workflows/       # GitHub Actions
│   ├── daily-report.yml     # System #1 cron
│   ├── auto-reply.yml       # System #2 cron
│   └── build-dm.yml         # (DISABLED on purpose — Cloudflare Worker replaces it)
│
├── instagram-dm-bot/       # System #3 — the live DM bot
│   ├── src/worker.ts        # CAMPAIGNS array + poll loop + dashboard
│   ├── wrangler.toml        # KV binding + per-deployment tuning knobs
│   ├── package.json
│   └── README.md            # Detailed worker docs
│
├── state/                   # Persistent state (dedupe lists, audit logs)
├── data/                    # Raw API responses (git-ignored)
├── docs/                    # Built artifacts served by GitHub Pages
├── thumbs/                  # Cached reel thumbnails
│
├── SETUP.md                 # ← start here when installing
└── README.md                # ← you are here
```

---

## Customization cheat sheet

| Want to…                                            | Edit…                                          |
|-----------------------------------------------------|------------------------------------------------|
| Analyze more/fewer days of Reels                    | `DAYS = 30` at the top of `agent.ts`           |
| Change the daily report time                        | `cron:` in `.github/workflows/daily-report.yml`|
| Reply more/less often                               | `cron:` in `.github/workflows/auto-reply.yml`  |
| Change the AI reply voice                           | `buildPrompt(...)` in `auto-reply.ts`          |
| Use a cheaper / different OpenAI model              | `OPENAI_MODEL` env var in `auto-reply.yml`     |
| Add a new affiliate DM campaign                     | `CAMPAIGNS` array in `instagram-dm-bot/src/worker.ts` |
| Cap how many DMs/hour the bot can send              | `MAX_PER_HOUR` in `instagram-dm-bot/wrangler.toml` |
| React faster than 15s to comments                   | `SUB_POLLS` in `instagram-dm-bot/wrangler.toml` (4 → 6 ⇒ ~10s, costs more API calls) |

---

## Caveats and honest limits

- **Composio rate limits.** Composio sits between you and Instagram; if you
  hammer it (e.g. drop `SUB_POLLS` cron to 1s) you will get 429s. The
  defaults are calibrated to stay well under the free tier ceiling.
- **Instagram private-reply window.** You can only DM someone in response
  to a comment for **7 days** after they commented. The DM bot's
  `MAX_AGE_DAYS=7` reflects this — older comments are skipped.
- **The AI reply bot will occasionally write something bland.** Comments
  with very little context ("nice!", "🔥") are hard to reply to
  interestingly; the bot defaults to a warm acknowledgement rather than
  inventing context. If you want zero bland replies, raise
  `SKIP_RECENT_MIN` and reply manually to the high-signal ones.
- **This isn't a SaaS.** There's no admin UI, no team support, no SLA.
  It's your repo running on your accounts. That's the point.

---

## License

No license file — treat this as a personal-use template. Fork it, modify
it, ship it on your own account. Don't resell it as a product without
talking to the author first.
