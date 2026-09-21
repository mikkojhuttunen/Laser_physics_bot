'use strict';
/**
 * tagQuizBank_fys501.js
 * ---------------------
 * OFFLINE tool (run on your computer, not on Railway) that proposes `concepts` and
 * `optionTags` for the questions in quizBank_fys501.json / multivalueQuizBank_fys501.json,
 * lets you review the proposals, and writes the accepted ones into the banks.
 * The model only suggests; nothing is written to a bank until you accept it.
 *
 *   ANTHROPIC_API_KEY=sk-... node tagQuizBank_fys501.js suggest [--kind single|multi]
 *        [--section 3.5] [--limit 20] [--ids q3.5_001,mv3.5_002] [--model <id>]
 *        -> writes tag_suggestions.json (resumable) and tag_review.md
 *
 *   node tagQuizBank_fys501.js review
 *        -> regenerates tag_review.md from tag_suggestions.json
 *
 *   node tagQuizBank_fys501.js apply --accept q3.5_001,mv3.5_002 | --all-valid [--dry-run]
 *        -> writes concepts/optionTags into the banks (backups: <bank>.bak)
 *
 * Model: --model, else env TAG_MODEL, else claude-sonnet-5 (judging which misconception a
 * distractor embodies benefits from a stronger model than the live-quiz Haiku). Runs directly
 * against the Anthropic API with your own key; it does not use the bot's usage limiter.
 * Rough cost for all 320 questions: on the order of 2 USD (estimate, check current prices).
 *
 * After applying:  node validateQuizTags_fys501.js   then commit the changed banks.
 * Proposed NEW misconceptions are listed at the end of tag_review.md; add the ones you agree
 * with to misconceptions_fys501.json and re-run `suggest --ids ...` for those questions.
 */

const fs = require('fs');
const path = require('path');
const { validateBank, loadVocab, KINDS } = require('./validateQuizTags_fys501');

const SUGGESTIONS_FILE = 'tag_suggestions.json';
const REVIEW_FILE = 'tag_review.md';
const DEFAULT_MODEL = 'claude-sonnet-5';

const SYSTEM_PROMPT = `You tag multiple-choice questions from a graduate laser-physics course for a learning-analytics tool.
You receive one question (with its correct option(s) marked) and two controlled vocabularies: CONCEPTS and MISCONCEPTIONS.
Return ONLY a JSON object, no markdown fences, no commentary:
{"concepts": ["..."], "optionTags": [null, "M-...", null, null], "proposed": [{"index": 1, "text": "..."}]}
Rules:
- "concepts": 1 to 3 ids taken ONLY from CONCEPTS; the first is the main concept the question tests.
- "optionTags": exactly one entry per option, in the order given. null for every correct option. For a wrong option: the id from MISCONCEPTIONS that this option genuinely embodies, meaning a student who holds that belief would pick it. If none clearly fits, use null. Do NOT force a fit; null is the right answer for many wrong options.
- "proposed": only when a wrong option embodies a concrete, plausible student misconception that is missing from MISCONCEPTIONS. Give the 0-based option index and one sentence phrased as what the student believes. At most 2 per question; usually none.
- Never invent ids. Output nothing outside the JSON object.`;

// ---------- data access ----------
function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function loadBanks(dir) {
  const out = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    const p = path.join(dir, k.file);
    out[kind] = { path: p, bank: loadJson(p, {}) };
  }
  return out;
}

function* iterQuestions(banks) {
  for (const [kind, { bank }] of Object.entries(banks)) {
    for (const ch of Object.keys(bank)) {
      for (const sec of Object.keys(bank[ch] || {})) {
        for (const q of bank[ch][sec] || []) yield { kind, sec, q };
      }
    }
  }
}

// ---------- prompt + parsing ----------
function buildUserPrompt({ kind, sec, q }, vocab) {
  const concepts = [...vocab.concepts.values()].filter((c) => c.section === sec);
  const cIds = new Set(concepts.map((c) => c.id));
  const miscs = [...vocab.misconceptions.values()].filter((m) => cIds.has(m.concept_id));
  const correct = new Set(KINDS[kind].correct(q));
  const lines = [
    `SECTION ${sec}: ${vocab.sections[sec] || ''}`,
    '',
    'CONCEPTS:',
    ...(concepts.length ? concepts.map((c) => `- ${c.id}: ${c.label}`) : ['- (none defined for this section)']),
    '',
    'MISCONCEPTIONS:',
    ...(miscs.length ? miscs.map((m) => `- ${m.id} (${m.concept_id}): ${m.description}`) : ['- (none yet)']),
    '',
    `QUESTION (${kind === 'single' ? 'single-select' : 'select all that apply'}):`,
    `Stem: ${q.stem}`,
    'Options (0-based):',
    ...q.options.map((o, i) => `${i}. ${o}${correct.has(i) ? '   [CORRECT]' : ''}`),
    `Explanation: ${q.explanation || ''}`,
  ];
  return lines.join('\n');
}

function parseModelJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Turns a raw model suggestion into a safe one; collects notes; status OK only if concepts survive. */
function sanitise(raw, { kind, sec, q }, vocab) {
  const notes = [];
  const n = q.options.length;
  const correct = new Set(KINDS[kind].correct(q));

  let concepts = Array.isArray(raw && raw.concepts) ? raw.concepts.filter((c) => typeof c === 'string') : [];
  const unknownC = concepts.filter((c) => !vocab.concepts.has(c));
  if (unknownC.length) notes.push(`dropped unknown concept id(s): ${unknownC.join(', ')}`);
  concepts = [...new Set(concepts.filter((c) => vocab.concepts.has(c)))].slice(0, 3);

  const tags = Array.isArray(raw && raw.optionTags) ? raw.optionTags : [];
  if (tags.length !== n) notes.push(`optionTags had ${tags.length} entries for ${n} options; missing ones treated as null`);
  const optionTags = [];
  for (let i = 0; i < n; i++) {
    let t = tags[i] === undefined ? null : tags[i];
    if (t !== null && typeof t !== 'string') t = null;
    if (t !== null && correct.has(i)) { notes.push(`tag on correct option ${i} removed`); t = null; }
    if (t !== null && !vocab.misconceptions.has(t)) { notes.push(`dropped unknown misconception id "${t}" at option ${i}`); t = null; }
    optionTags.push(t);
  }

  const proposed = (Array.isArray(raw && raw.proposed) ? raw.proposed : [])
    .filter((p) => p && Number.isInteger(p.index) && p.index >= 0 && p.index < n && !correct.has(p.index) && typeof p.text === 'string' && p.text.trim())
    .slice(0, 2)
    .map((p) => ({ index: p.index, text: p.text.trim() }));

  const primary = vocab.concepts.get(concepts[0]);
  if (primary && primary.section !== sec) notes.push(`primary concept ${primary.id} is from section ${primary.section}`);

  return { status: concepts.length ? 'OK' : 'INVALID', concepts, optionTags, proposed, notes };
}

// ---------- model call (replaceable in tests) ----------
async function callAnthropic({ system, user, model }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model,
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// ---------- commands ----------
async function cmdSuggest(args, { dir = __dirname, callModel = callAnthropic, log = console.log } = {}) {
  const vocab = loadVocab(dir);
  const banks = loadBanks(dir);
  const model = args.model || process.env.TAG_MODEL || DEFAULT_MODEL;
  const sugPath = path.join(dir, SUGGESTIONS_FILE);
  const saved = loadJson(sugPath, { generatedAt: null, model, items: [] });
  const done = new Map(saved.items.map((it) => [it.id, it]));
  const wantIds = args.ids ? new Set(String(args.ids).split(',').map((s) => s.trim()).filter(Boolean)) : null;

  const todo = [];
  for (const it of iterQuestions(banks)) {
    if (args.kind && it.kind !== args.kind) continue;
    if (args.section && it.sec !== args.section) continue;
    if (wantIds) { if (!wantIds.has(it.q.id)) continue; }
    else if (it.q.concepts !== undefined || done.has(it.q.id)) continue;
    todo.push(it);
  }
  const limited = args.limit ? todo.slice(0, parseInt(args.limit, 10)) : todo;
  log(`${limited.length} question(s) to tag with ${model}${todo.length > limited.length ? ` (of ${todo.length} pending)` : ''}`);

  let n = 0;
  for (const it of limited) {
    let entry;
    try {
      const text = await callModel({ system: SYSTEM_PROMPT, user: buildUserPrompt(it, vocab), model });
      const s = sanitise(parseModelJson(text), it, vocab);
      entry = { id: it.q.id, kind: it.kind, section: it.sec, stem: it.q.stem, ...s };
    } catch (e) {
      entry = { id: it.q.id, kind: it.kind, section: it.sec, stem: it.q.stem, status: 'ERROR', concepts: [], optionTags: [], proposed: [], notes: [e.message] };
    }
    saved.items = saved.items.filter((x) => x.id !== entry.id).concat(entry);
    saved.generatedAt = new Date().toISOString();
    saved.model = model;
    writeJson(sugPath, saved); // after every question, so an interrupted run can resume
    n++;
    if (n % 10 === 0) log(`  ${n}/${limited.length}`);
  }
  writeReview(dir, saved, banks, vocab);
  log(`Wrote ${SUGGESTIONS_FILE} and ${REVIEW_FILE}. Review, then: node tagQuizBank_fys501.js apply --all-valid  (or --accept id1,id2)`);
  return saved;
}

function reviewMarkdown(saved, banks, vocab) {
  const byId = new Map();
  for (const it of iterQuestions(banks)) byId.set(it.q.id, it);
  const out = ['# Tag review', '',
    `Model: ${saved.model || '?'}, generated ${saved.generatedAt || '?'}. Tick nothing here: accept with \`node tagQuizBank_fys501.js apply --accept ID1,ID2\` or \`--all-valid\`.`, ''];
  const counts = { OK: 0, INVALID: 0, ERROR: 0 };
  const proposedAll = [];
  const items = saved.items.slice().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  for (const s of items) {
    counts[s.status] = (counts[s.status] || 0) + 1;
    const it = byId.get(s.id);
    out.push(`## ${s.id} (section ${s.section}, ${s.kind}) - ${s.status}`, '', `> ${s.stem}`, '');
    if (it) {
      const correct = new Set(KINDS[it.kind].correct(it.q));
      it.q.options.forEach((o, i) => {
        const t = s.optionTags[i];
        const label = correct.has(i) ? 'CORRECT' : (t ? `${t}: ${(vocab.misconceptions.get(t) || {}).description || ''}` : 'no tag');
        out.push(`- ${i}. ${o}  ->  **${label}**`);
      });
      out.push('');
    }
    out.push(`Concepts: ${s.concepts.length ? s.concepts.map((c) => `${c} (${(vocab.concepts.get(c) || {}).label || ''})`).join('; ') : '**none**'}`);
    (s.proposed || []).forEach((p) => { out.push(`Proposed new misconception for option ${p.index}: ${p.text}`); proposedAll.push({ id: s.id, section: s.section, ...p }); });
    (s.notes || []).forEach((n) => out.push(`Note: ${n}`));
    out.push('');
  }
  out.push('## Summary', '', `OK ${counts.OK || 0}, INVALID ${counts.INVALID || 0}, ERROR ${counts.ERROR || 0}`, '');
  out.push('## Proposed new misconceptions', '');
  if (!proposedAll.length) out.push('_None._');
  proposedAll.forEach((p) => out.push(`- ${p.id} option ${p.index} (section ${p.section}): ${p.text}`));
  out.push('');
  return out.join('\n');
}

function writeReview(dir, saved, banks, vocab) {
  fs.writeFileSync(path.join(dir, REVIEW_FILE), reviewMarkdown(saved, banks, vocab), 'utf8');
}

function cmdReview(_args, { dir = __dirname } = {}) {
  const saved = loadJson(path.join(dir, SUGGESTIONS_FILE), null);
  if (!saved) throw new Error(`no ${SUGGESTIONS_FILE} in ${dir}; run suggest first`);
  writeReview(dir, saved, loadBanks(dir), loadVocab(dir));
  return saved;
}

function cmdApply(args, { dir = __dirname, log = console.log } = {}) {
  const saved = loadJson(path.join(dir, SUGGESTIONS_FILE), null);
  if (!saved) throw new Error(`no ${SUGGESTIONS_FILE} in ${dir}; run suggest first`);
  const accept = new Set(String(args.accept || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (!accept.size && !args['all-valid']) throw new Error('apply needs --accept ID1,ID2 or --all-valid');
  const vocab = loadVocab(dir);
  const banks = loadBanks(dir);
  const bySug = new Map(saved.items.map((s) => [s.id, s]));
  for (const id of accept) if (!bySug.has(id)) throw new Error(`no suggestion for ${id}`);

  const applied = [];
  const skipped = [];
  const touched = new Set();
  for (const it of iterQuestions(banks)) {
    const s = bySug.get(it.q.id);
    if (!s) continue;
    if (!(accept.has(it.q.id) || (args['all-valid'] && s.status === 'OK'))) continue;
    if (s.status !== 'OK') { skipped.push(`${it.q.id}: ${s.status}`); continue; }
    it.q.concepts = s.concepts;
    it.q.optionTags = s.optionTags;
    touched.add(it.kind);
    applied.push(it.q.id);
  }
  log(`${applied.length} question(s) to tag${skipped.length ? `, skipped: ${skipped.join('; ')}` : ''}.`);

  // validate the result before writing anything
  for (const kind of touched) {
    const r = validateBank(banks[kind].bank, kind, vocab);
    if (r.errors.length) throw new Error(`refusing to write ${kind} bank, it would fail validation:\n${r.errors.slice(0, 10).join('\n')}`);
  }
  if (args['dry-run']) { log('Dry run - nothing written.'); return { applied, skipped }; }
  for (const kind of touched) {
    fs.copyFileSync(banks[kind].path, `${banks[kind].path}.bak`);
    writeJson(banks[kind].path, banks[kind].bank);
  }
  const remaining = saved.items.filter((s) => !applied.includes(s.id));
  writeJson(path.join(dir, SUGGESTIONS_FILE), { ...saved, items: remaining });
  log('Written. Next: node validateQuizTags_fys501.js, node e2e_quiz_test.js, then commit the changed bank file(s).');
  return { applied, skipped };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    if (['all-valid', 'dry-run'].includes(name)) out[name] = true;
    else out[name] = argv[++i];
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  (async () => {
    if (cmd === 'suggest') {
      if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY first.'); process.exit(2); }
      await cmdSuggest(args);
    } else if (cmd === 'review') { cmdReview(args); console.log(`Wrote ${REVIEW_FILE}`); }
    else if (cmd === 'apply') cmdApply(args);
    else { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*\n|^ \* ?/gm, '').trim()); process.exit(cmd ? 1 : 0); }
  })().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}

module.exports = { buildUserPrompt, parseModelJson, sanitise, cmdSuggest, cmdReview, cmdApply, reviewMarkdown, SYSTEM_PROMPT };
