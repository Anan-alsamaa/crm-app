/**
 * MAHA, THE 50-CHAT TEST (owner, 2026-11-09) - run once the PAID company key
 * is in place, before Maha answers anyone.
 *
 * Replays 50 real past customer questions (the redacted prod export: phone
 * numbers, emails and long numbers already replaced) through EXACTLY what Maha
 * runs - the same prompt, the same structured answer, the same hard-limit
 * checks before and after the model - and writes a review sheet beside what
 * the agent really answered. Operations read it and say where Maha is wrong.
 *
 * Nothing is sent to any customer and nothing is written to the CRM.
 *
 * REFUSES TO RUN unless MAHA_EVAL_PAID_KEY=yes: real (redacted) chats must
 * never go through the free tier, whose terms let Google use them.
 *
 *   MAHA_EVAL_PAID_KEY=yes GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.8-flash \
 *     npx tsx services/ai-gateway/scripts/maha-eval.ts D:/emad/ai-kb/data/pairs.json [kb.json]
 *
 * Output: maha-eval-<date>.md + .csv next to the input file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GeminiProvider } from '../src/provider/gemini.js';
import {
  autoReplyPrompt,
  AUTO_REPLY_RESPONSE_SCHEMA,
  type KnowledgeEntry,
} from '../src/prompts/auto-reply.js';
import { preCheck, postCheck } from '../src/autoreply-guard.js';
import { estimateCostUsd } from '../src/usage-log.js';

interface Pair {
  q: string;
  a: string;
  topic: string;
  first: boolean;
}

/* What a person did for each kind of question - the yardstick. Maha should
   answer the first group and hand over the second. */
const SHOULD_ANSWER = new Set(['greeting', 'thanks', 'branch_hours_area', 'cancel', 'menu_price']);
const SHOULD_HAND_OVER = new Set([
  'compensation_refund',
  'missing_item',
  'wrong_item',
  'quality',
  'ask_person',
  'payment',
]);

async function main() {
  /* MAHA_EVAL_DRY=1: a stand-in model that always hands over - proves the
     sheet is produced without calling anything. */
  const dry = process.env.MAHA_EVAL_DRY === '1';
  if (!dry && process.env.MAHA_EVAL_PAID_KEY !== 'yes') {
    console.error('Refusing: set MAHA_EVAL_PAID_KEY=yes only with the PAID company key.');
    process.exit(2);
  }
  const [input, kbPath] = process.argv.slice(2);
  if (!input) {
    console.error('usage: maha-eval.ts <pairs.json> [knowledge.json]');
    process.exit(2);
  }
  const pairs = JSON.parse(readFileSync(input, 'utf8')) as Pair[];
  const knowledge: KnowledgeEntry[] = kbPath
    ? (JSON.parse(readFileSync(kbPath, 'utf8')) as KnowledgeEntry[])
    : [];
  const model = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
  const provider = dry
    ? {
        name: 'dry',
        run: async () => ({
          text: JSON.stringify({
            action: 'handover',
            reply: null,
            reason: 'dry run',
            summary: null,
          }),
          model: 'dry',
        }),
      }
    : new GeminiProvider(process.env.GEMINI_API_KEY ?? '', model);

  /* 50 first questions, spread across the topics in proportion, fixed seed so
     a re-run asks the same 50. */
  const firsts = pairs.filter((p) => p.first && p.q.trim().length > 3);
  const byTopic = new Map<string, Pair[]>();
  for (const p of firsts) byTopic.set(p.topic, [...(byTopic.get(p.topic) ?? []), p]);
  const sample: Pair[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (const [, list] of byTopic) {
    const n = Math.max(1, Math.round((50 * list.length) / firsts.length));
    for (let i = 0; i < n && list.length; i++)
      sample.push(list.splice(Math.floor(rnd() * list.length), 1)[0]!);
  }
  sample.splice(50);

  const rows: string[][] = [
    ['#', 'topic', 'customer', 'agent said', 'maha', 'maha said / reason', 'verdict'],
  ];
  let usd = 0;
  let agree = 0;
  for (const [i, p] of sample.entries()) {
    let action = '';
    let said = '';
    const early = preCheck(p.q);
    if (early) {
      action = 'handover';
      said = `(no model) ${early}`;
    } else {
      const prompt = autoReplyPrompt({
        transcript: [{ from: 'customer', text: p.q }],
        knowledge,
        order: null,
        arabic: /[\u0600-\u06FF]/.test(p.q),
      });
      try {
        const out = await provider.run({
          endpoint: '/auto-reply',
          system: prompt.system,
          user: prompt.user,
          responseSchema: AUTO_REPLY_RESPONSE_SCHEMA,
        });
        usd += estimateCostUsd(out.model, out.usage) ?? 0;
        const j = JSON.parse(out.text) as {
          action: string;
          reply?: string;
          reason?: string;
          summary?: string;
        };
        const broken = j.action === 'reply' && j.reply ? postCheck(j.reply) : null;
        action = broken ? 'handover' : j.action;
        said = broken
          ? `(blocked) ${broken}`
          : j.action === 'reply'
            ? (j.reply ?? '')
            : `${j.reason ?? ''} | ${j.summary ?? ''}`;
      } catch (err) {
        action = 'error';
        said = (err as Error).message.slice(0, 120);
      }
    }
    const verdict = SHOULD_HAND_OVER.has(p.topic)
      ? action === 'handover'
        ? 'ok'
        : 'CHECK: should hand over'
      : SHOULD_ANSWER.has(p.topic)
        ? action === 'reply'
          ? 'ok - check the wording'
          : 'handed over (acceptable, check)'
        : 'review';
    if (verdict.startsWith('ok')) agree += 1;
    rows.push([String(i + 1), p.topic, p.q, p.a, action, said, verdict]);
    process.stdout.write(`\r${i + 1}/${sample.length}`);
  }
  console.log();

  const day = new Date().toISOString().slice(0, 10);
  const base = join(dirname(input), `maha-eval-${day}`);
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  writeFileSync(`${base}.csv`, '\ufeff' + csv);
  const md = [
    `# Maha - 50-chat test, ${day}`,
    '',
    `Model ${model}. ${sample.length} real first questions (redacted). Knowledge entries: ${knowledge.length}.`,
    `Clear agreement with what the case needed: ${agree}/${sample.length}. Cost of this run: $${usd.toFixed(4)}.`,
    '',
    '| # | Topic | Customer | Agent said | Maha | Maha said / reason | Verdict |',
    '|---|---|---|---|---|---|---|',
    ...rows
      .slice(1)
      .map(
        (r) =>
          `| ${r.map((c) => c.replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 160)).join(' | ')} |`,
      ),
  ].join('\n');
  writeFileSync(`${base}.md`, md);
  console.log(`wrote ${base}.md and .csv`);
}

void main();
