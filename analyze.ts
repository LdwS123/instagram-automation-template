import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

type RawPost = {
  id: string;
  caption: string;
  permalink: string;
  timestamp: string;
  insights: Record<string, number>;
};

const data = JSON.parse(readFileSync('data/posts.json', 'utf-8')) as { posts: RawPost[] };
if (!data.posts || data.posts.length === 0) {
  console.log('No posts in data/posts.json. Skipping analysis.');
  process.exit(0);
}

function hookScore(p: RawPost): number {
  const i = p.insights || {};
  const reach = i.reach || 0;
  const watch = (i.ig_reels_avg_watch_time || 0) / 1000;
  const shares = i.shares || 0;
  const saved = i.saved || 0;
  const sharePct = reach > 0 ? (shares / reach) * 100 : 0;
  const savePct = reach > 0 ? (saved / reach) * 100 : 0;
  return watch * Math.sqrt(reach) * (1 + sharePct / 100 + savePct / 200);
}

const ranked = [...data.posts].sort((a, b) => hookScore(b) - hookScore(a));
const top = ranked.slice(0, 5);
const bottom = ranked.slice(-5);

function summarize(p: RawPost) {
  const i = p.insights || {};
  return {
    id: p.id,
    caption: p.caption.slice(0, 600),
    reach: i.reach || 0,
    views: i.views || 0,
    shares: i.shares || 0,
    saved: i.saved || 0,
    likes: i.likes || 0,
    comments: i.comments || 0,
    avg_watch_s: ((i.ig_reels_avg_watch_time || 0) / 1000).toFixed(1),
  };
}

const PROMPT = `You are an Instagram Reels analyst. Below are this creator's top 5 and bottom 5 reels from the last 30 days, with their performance metrics.

TOP 5:
${JSON.stringify(top.map(summarize), null, 2)}

BOTTOM 5:
${JSON.stringify(bottom.map(summarize), null, 2)}

Your task — produce TWO things:

1. **Five concrete concepts for new reels** that are likely to perform like the top 5. Each concept should reuse a winning pattern (theme, hook style, format) from the top reels but with a fresh angle. Avoid copy-paste.

2. **One short critique for each of the bottom 5** explaining WHY it likely underperformed (in 1–2 sentences each). Look at the caption AND the metrics: low avg_watch suggests bad hook, low reach with high watch suggests IG didn't push, low shares suggests no remarkable insight, etc. Be specific to the actual content.

Return ONLY a fenced JSON code block with no preamble:

\`\`\`json
{
  "concepts": [
    {
      "title": "<3-6 word working title>",
      "hook": "<the literal opening line of the reel — what the creator says/shows in the first 2 seconds>",
      "angle": "<1-2 sentences explaining the content arc and why it should work for THIS creator's audience>",
      "caption_opener": "<first sentence of the caption — punchy, copy-pastable>",
      "format_note": "<single line: e.g. 'talking head + b-roll', 'screen recording w/ voiceover', 'tier-list', 'POV', 'before/after'>"
    }
  ],
  "critiques": {
    "<post_id>": "<1-2 sentence diagnosis>"
  }
}
\`\`\`

Constraints:
- Match the creator's voice (reflect on top captions to learn it).
- Each concept should be distinct (don't propose 5 variations of the same topic).
- For critiques, use the literal post id from BOTTOM 5 as the key. All 5 must be present.
- Keep total output under 1500 tokens.`;

console.log('Asking Claude to generate concepts + critiques...');

let finalText = '';
for await (const message of query({
  prompt: PROMPT,
  options: {
    model: 'claude-sonnet-4-6',
    settingSources: [],
    permissionMode: 'bypassPermissions',
    allowedTools: [],
    maxTurns: 2,
  },
}) as AsyncIterable<any>) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text) finalText = block.text;
    }
  }
  if (message.type === 'result' && message.subtype === 'success' && typeof message.result === 'string') {
    finalText = message.result;
  }
}

const fence = finalText.match(/```json\s*([\s\S]*?)```/);
const jsonText = fence ? fence[1] : finalText;

let parsed: { concepts: any[]; critiques: Record<string, string> };
try {
  parsed = JSON.parse(jsonText);
} catch (err) {
  console.error('Could not parse Claude response.');
  console.error(finalText);
  process.exit(1);
}

mkdirSync('data', { recursive: true });
writeFileSync('data/insights.json', JSON.stringify({ generated_at: new Date().toISOString(), ...parsed }, null, 2));
console.log(`Wrote data/insights.json (${parsed.concepts?.length ?? 0} concepts, ${Object.keys(parsed.critiques || {}).length} critiques).`);
