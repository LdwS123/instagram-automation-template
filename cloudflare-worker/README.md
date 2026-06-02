# Comment → DM bot — Cloudflare Worker (instant, ~15s)

Polls your Instagram comments every minute (with 4 sub-polls per tick ⇒ ~15s
effective latency) and DMs anyone who comments one of your **campaign keywords**
the matching affiliate link + a public reply. Runs on Cloudflare's free tier;
Cloudflare honors 1-minute crons reliably (GitHub Actions does not).

## Campaigns

Per-partnership config (keyword, link, DM copy, public replies) lives in the
`CAMPAIGNS` array at the top of `src/worker.ts`. Adding a new partner = paste
~7 lines, redeploy.

Current campaigns:

| Keyword | Partner | Offer |
|---------|---------|-------|
| `build` | Emergent | 5 free credits |
| `krater` | Krater.ai | 15% off first month (code `YOUR_COUPON_CODE`) |

Order matters — if a comment matches multiple keywords, the **first** campaign
in the array wins. Hourly cap and dedupe state are **shared** across all
campaigns (anti-spam guarantee: your total DM volume stays bounded).

## One-time deploy (~5 min)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
cd cloudflare-worker
npm install

# 1. Log in (opens your browser)
npx wrangler login

# 2. Create the state store, then paste the printed id into wrangler.toml
#    (replace PASTE_KV_ID_HERE)
npx wrangler kv namespace create STATE

# 3. Add your Composio key as a secret (paste it when prompted)
npx wrangler secret put COMPOSIO_API_KEY

# 4. Ship it
npx wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g.
`https://build-dm-bot.<your-subdomain>.workers.dev`.

- Open that URL → **live dashboard** (auto-refreshes every minute, one stat
  block per campaign).
- `…/run` → manually trigger one poll right now (handy for testing).

## Shared config (`wrangler.toml` → `[vars]`)

After editing, re-run `npx wrangler deploy`.

| var | default | meaning |
|-----|---------|---------|
| `MAX_PER_HOUR` | `10` | max DMs per hour, total across all campaigns (anti-spam) |
| `PER_RUN_CAP` | `5` | max DMs handled in a single poll |
| `SCAN_POSTS` | `6` | how many recent posts to scan each poll |
| `MAX_AGE_DAYS` | `7` | ignore comments older than this (IG private-reply window) |
| `REPLY_PUBLICLY` | `true` | also post a public reply under the comment |
| `SUB_POLLS` | `4` | polls per minute (4 ⇒ ~15s latency; bumping it ⇒ more API load) |

## Adding a new campaign

Open `src/worker.ts`, find `const CAMPAIGNS`, and push a new entry:

```ts
{
  name: 'PartnerName',
  keyword: 'trigger',
  link: 'https://partner.com/?ref=YOU',
  dmTemplate: 'Pitch + offer + {link}',
  publicReplies: ['check your DMs 📩', 'sent it to you 👀'],
},
```

Then `npx wrangler deploy`. That's it — the new keyword is live within seconds.

## Important

This Worker **replaces** the GitHub Actions `build-dm` bot. The GitHub cron
is disabled so the two don't double-DM. The GitHub analytics + auto-reply
bots are untouched and still run.
