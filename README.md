# Instagram Reels — analytics dashboard

Pulls your last 30 days of Reels via Composio's hosted MCP, scores them, and renders a self-contained `report.html`. Auto-updates daily via GitHub Actions.

> **Setting this up for the first time (or sharing it with someone)?** Go to **[SETUP.md](SETUP.md)** — it walks through all three automations (daily analytics, AI auto-reply, Cloudflare comment→DM bot) end-to-end. The section below covers only the daily report.

## Local setup (one time)

```bash
npm install
echo 'COMPOSIO_API_KEY=your_key_here' > .env
```

## Run locally

```bash
npm run report
open report.html
```

**First run only:** Composio prints an `AUTH_URL: …` line. Click it, log into Instagram, approve, then re-run.

## Daily auto-update on GitHub

This repo includes a workflow at [`.github/workflows/daily-report.yml`](.github/workflows/daily-report.yml) that runs every day at 06:00 UTC, regenerates the report, and commits the result to `docs/index.html`.

To enable it on your fork:

1. Add a repo secret named `COMPOSIO_API_KEY` (Settings → Secrets and variables → Actions → New repository secret).
2. (Optional) Enable GitHub Pages to serve `docs/` — Settings → Pages → Source: `main` branch, folder: `/docs`.

The workflow runs **once a day at 06:00 UTC**. To change cadence, edit the cron in the workflow file.

## Configure window

Edit `DAYS = 30` at the top of `agent.ts`. The window ends yesterday so analytics aren't polluted by the unstable last-24h-of-data window.

## What it shows

- Account KPIs (followers, total reach, avg reach/follower, engagement)
- Headline insight (top reel reach multiplier vs. median)
- Caption pattern callout (winner words vs. loser words)
- Do More / Stop / Fix grid
- Daily reach time-series, posting day/hour heatmaps, reach distribution, hook×reach scatter
- Caption pattern lab (length, hashtags, emoji, question correlations)
- Hashtag performance table
- Top 3 winners with full caption + copy-to-clipboard
- Full ranked list with letter grades A–F per reel
