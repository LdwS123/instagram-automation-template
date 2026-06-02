# Full setup guide

This repo runs **three independent automations** on top of one Instagram
account. You can enable them one at a time — none of them depend on the
others, but they share the same `COMPOSIO_API_KEY`.

| # | What it does                                  | Runs on            | Cadence       |
|---|-----------------------------------------------|--------------------|---------------|
| 1 | Daily analytics dashboard (`report.html`)     | GitHub Actions     | 06:00 UTC/day |
| 2 | AI auto-reply to new comments                 | GitHub Actions     | every 30 min  |
| 3 | Comment → DM bot (affiliate keywords)         | Cloudflare Worker  | every ~15 s   |

Why split between GitHub Actions and Cloudflare? GitHub Actions is free and
durable but does **not** honor sub-5-minute cron reliably. The DM bot needs
near-instant reaction time, so it lives on Cloudflare (whose 1-minute cron is
honored). Slow jobs stay on GitHub.

---

## Prerequisites

You need accounts on:

- **GitHub** — to host the repo and run Actions.
- **Composio** ([app.composio.dev](https://app.composio.dev)) — handles the
  Instagram OAuth + API calls. Free tier is enough.
- **OpenAI** ([platform.openai.com](https://platform.openai.com)) — only if
  you want system #2 (AI auto-reply). Costs a few cents per day at typical
  comment volume.
- **Cloudflare** ([dash.cloudflare.com](https://dash.cloudflare.com)) — only
  if you want system #3 (DM bot). Free tier is enough.

And locally:

- **Node.js 20+** and **npm**.
- **git**.

---

## Step 0 — Clone and install

```bash
git clone https://github.com/LdwS123/instagram-reels-analytics.git
cd instagram-reels-analytics
npm install
```

Copy the env template and fill in your keys:

```bash
cp .env.example .env
# then edit .env in your editor and paste your real keys
```

At minimum, set `COMPOSIO_API_KEY`. `OPENAI_API_KEY` is only needed for the
auto-reply bot.

---

## Step 1 — Connect Instagram via Composio (one time)

The very first time you run anything, Composio needs to OAuth into your
Instagram account.

```bash
npm run report
```

The script will print a line like:

```
AUTH_URL: https://backend.composio.dev/...
```

1. Open that URL in your browser.
2. Log into the Instagram account you want to automate.
3. Approve the requested permissions.
4. Re-run `npm run report`.

This time it should fetch your last 30 days of Reels and produce
`report.html`. Open it in a browser to confirm it works:

```bash
open report.html
```

If you see your dashboard, **Composio is wired up correctly**. You only ever
do this OAuth dance once per Instagram account.

> **What's `COMPOSIO_USER_ID`?** It's the label that ties your Composio key
> to a specific Instagram account in their system. The default
> (`instagram-reels-analytics`) is fine unless you connected Instagram under
> a different user id in Composio.

---

## Step 2 — Push to GitHub and add secrets

If you forked the repo, skip the push. Otherwise:

```bash
git remote set-url origin https://github.com/YOUR_USERNAME/instagram-reels-analytics.git
git push -u origin main
```

Now add your API keys as **repo secrets** (the workflows read them from
there, not from your local `.env`):

1. Go to your repo on GitHub → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**.
2. Add `COMPOSIO_API_KEY` — paste the same key from your `.env`.
3. Add `OPENAI_API_KEY` — only if you plan to enable system #2.

> ⚠️ The repo is **private** by default. If you fork it, keep your fork
> private too — your `COMPOSIO_USER_ID` references your real Instagram
> account.

---

## Step 3 — Enable system #1 (daily analytics dashboard)

The workflow lives at
[.github/workflows/daily-report.yml](.github/workflows/daily-report.yml). It
runs every day at 06:00 UTC, regenerates `report.html`, and commits it to
`docs/index.html`.

**To enable it:**

1. Go to your repo → **Actions** tab.
2. If Actions are disabled on a fork, click **Enable workflows**.
3. To verify it works, click **Daily Reels report** → **Run workflow** to
   trigger it manually. Wait ~2 minutes, then refresh — you should see a
   green check.

**To serve the dashboard as a public page:**

1. Go to **Settings** → **Pages**.
2. Source: **Deploy from a branch**.
3. Branch: `main`, folder: `/docs`.
4. Save. Your dashboard will be live at
   `https://YOUR_USERNAME.github.io/instagram-reels-analytics/`.

**To change the window** of Reels analyzed, edit `DAYS = 30` at the top of
[agent.ts](agent.ts).

**To change the cadence**, edit the `cron:` line in the workflow file.

---

## Step 4 — Enable system #2 (AI auto-reply bot)

The workflow lives at
[.github/workflows/auto-reply.yml](.github/workflows/auto-reply.yml). Every
30 minutes it refreshes your posts data, drafts a contextual reply to each
new comment using OpenAI, posts it on Instagram, then commits a log of who
was replied to.

**Prerequisites:** `COMPOSIO_API_KEY` AND `OPENAI_API_KEY` must both be set
as repo secrets (Step 2).

**To enable:**

1. The workflow is enabled by default once Actions are on.
2. Trigger one run manually to verify: **Actions** → **Auto-reply to
   comments** → **Run workflow**.
3. Check the log — you should see `replied to @someone on post …` lines.
4. Confirm on Instagram that the replies appeared.

**To dry-run locally before unleashing it:**

```bash
npm run reply:dry
```

This prints what it *would* reply without actually posting. Use it whenever
you change reply logic or tweak the prompt in `auto-reply.ts`.

**To tune behavior**, edit the `env:` block in the workflow file — the
defaults are conservative:

| Variable          | Default | Meaning                                     |
|-------------------|---------|---------------------------------------------|
| `LIMIT`           | `10`    | Max replies per run.                        |
| `MAX_PER_HOUR`    | `20`    | Hard cap per rolling hour (anti-spam).      |
| `SKIP_RECENT_MIN` | `30`    | Skip comments newer than this (in minutes). |

---

## Step 5 — Enable system #3 (Comment → DM bot, Cloudflare Worker)

This is the affiliate-link DM bot. It polls your comments every minute (with
4 sub-polls per tick ⇒ ~15s effective latency) and DMs anyone who comments a
campaign keyword (e.g. `build` → Emergent affiliate link, `krater` →
Krater.ai code).

It runs on Cloudflare Workers (free tier) because GitHub Actions does not
honor 1-minute cron reliably.

**Detailed setup is in
[cloudflare-worker/README.md](cloudflare-worker/README.md)** — the short
version:

```bash
cd cloudflare-worker
npm install

# 1. Log into Cloudflare (opens your browser)
npx wrangler login

# 2. Create the state store (dedupe + dashboard log)
npx wrangler kv namespace create STATE
# → copy the printed id and paste it into wrangler.toml,
#   replacing the existing `id = "..."` line on the [[kv_namespaces]] block.

# 3. Add your Composio key as a secret
npx wrangler secret put COMPOSIO_API_KEY
# (paste the same key when prompted)

# 4. Ship it
npx wrangler deploy
```

After deploy, `wrangler` prints your Worker URL, e.g.
`https://build-dm-bot.<your-subdomain>.workers.dev`.

- Open it in a browser → **live dashboard** (auto-refreshes every minute).
- Append `/run` to that URL → manually trigger one poll (handy for testing).

**To add a new affiliate partner**, open
[cloudflare-worker/src/worker.ts](cloudflare-worker/src/worker.ts), find
`const CAMPAIGNS`, push a new entry (keyword, link, DM template, public
replies), then re-run `npx wrangler deploy`. No GitHub commit needed —
Cloudflare deploys directly from your laptop.

**To tune the bot globally** (max DMs/hour, scan depth, age window…),
edit the `[vars]` block in
[cloudflare-worker/wrangler.toml](cloudflare-worker/wrangler.toml) and
re-deploy.

> ⚠️ The legacy GitHub Actions DM workflow
> ([.github/workflows/build-dm.yml](.github/workflows/build-dm.yml)) is
> **disabled on purpose** (its cron is commented out). Running both would
> double-DM people because they keep separate state. Stick with the
> Cloudflare Worker.

---

## Troubleshooting

**"AUTH_URL" keeps printing every run**
Your Composio Instagram connection expired or was never approved. Open the
URL, log in, approve, and re-run.

**Daily report workflow runs but no commit is created**
Normal if nothing changed. Check `docs/index.html` last-modified timestamp.
Otherwise inspect the run log — most commit failures come from a missing
`COMPOSIO_API_KEY` secret.

**Auto-reply commits state but nothing shows on Instagram**
Check `state/replied.json` — if your handle is listed for a comment but no
reply appeared, Instagram likely rejected it (rate limit, comment deleted,
etc.). The log line in the workflow run will say which one.

**Cloudflare Worker dashboard shows 0 DMs**
First, hit `…/run` to force a poll and read the response. The most common
causes are:
1. KV namespace id in `wrangler.toml` doesn't match the one you created.
2. `COMPOSIO_API_KEY` secret wasn't set (`npx wrangler secret put
   COMPOSIO_API_KEY`).
3. No comments match any campaign keyword on the recent posts being scanned
   (default `SCAN_POSTS=6`).

**`MAX_PER_HOUR` cap keeps tripping**
Either bump it in the relevant config (workflow `env:` for auto-reply,
`wrangler.toml` `[vars]` for the DM bot) or wait an hour. The cap is there
on purpose — Instagram throttles aggressive replying.

---

## File map

```
.
├── agent.ts                 # Fetches reels + insights from Composio
├── analyze.ts               # Optional deeper analysis pass
├── render.ts                # Builds report.html dashboard
├── auto-reply.ts            # AI comment reply bot (system #2)
├── build-dm.ts              # Legacy comment→DM script (replaced by worker)
├── render-replies.ts        # Builds replies.html log
├── render-build-dm.ts       # Builds build-dm.html dashboard
│
├── .env.example             # Template for your local .env
├── .github/workflows/       # GitHub Actions workflows
│   ├── daily-report.yml     # System #1
│   ├── auto-reply.yml       # System #2
│   └── build-dm.yml         # (disabled — Cloudflare Worker replaces it)
│
├── cloudflare-worker/       # System #3 — comment→DM bot
│   ├── src/worker.ts        # Campaigns config + poll loop
│   ├── wrangler.toml        # Bindings + tuning knobs
│   └── README.md            # Detailed worker docs
│
├── state/                   # Persistent state (dedupe, replied list, …)
├── data/                    # Raw API responses (git-ignored)
├── docs/                    # Built artifacts served by GitHub Pages
└── thumbs/                  # Cached reel thumbnails
```
