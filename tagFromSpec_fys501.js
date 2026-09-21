'use strict';
/**
 * tagFromSpec_fys501.js
 * ---------------------
 * Turns a compact, hand-written tagging spec into tag_suggestions.json (same format the API
 * tool writes), so tags decided in a Claude chat (no API key) go through the same review and
 * apply steps as tagQuizBank_fys501.js.
 *
 *   node tagFromSpec_fys501.js spec_3.5.json [--reset]
 *   node tagQuizBank_fys501.js apply --all-valid --dry-run
 *   node tagQuizBank_fys501.js apply --all-valid
 *
 * Spec format (option numbers are the 0-based STORED option indices; only wrong options get tags):
 *   { "q3.5_004": { "c": ["res.stability"], "t": { "2": "M-STAB-04" },
 *                   "p": [{ "i": 1, "text": "proposed new misconception, as a student belief" }] } }
 * Unknown ids, tags on correct options etc. are dropped and reported, exactly as in the API tool.
 */
const fs = require('fs');
const path = require('path');
const tagger = require('./tagQuizBank_fys501');
const { loadVocab, KINDS } = require('./validateQuizTags_fys501');

function run(specPath, { dir = __dirname, reset = false, log = console.log } = {}) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const vocab = loadVocab(dir);
  const byId = new Map();
  for (const [kind, k] of Object.entries(KINDS)) {
    const bank = JSON.parse(fs.readFileSync(path.join(dir, k.file), 'utf8'));
    for (const ch of Object.keys(bank)) for (const sec of Object.keys(bank[ch])) for (const q of bank[ch][sec]) byId.set(q.id, { kind, sec, q });
  }
  const sugPath = path.join(dir, 'tag_suggestions.json');
  let saved = { generatedAt: null, model: 'hand-tagged in a Claude chat', items: [] };
  if (!reset && fs.existsSync(sugPath)) saved = JSON.parse(fs.readFileSync(sugPath, 'utf8'));
  const problems = [];
  let n = 0;
  for (const [id, s] of Object.entries(spec)) {
    const it = byId.get(id);
    if (!it) { problems.push(`${id}: unknown question id`); continue; }
    const raw = {
      concepts: s.c,
      optionTags: it.q.options.map((_, i) => (s.t && s.t[i] !== undefined ? s.t[i] : null)),
      proposed: (s.p || []).map((p) => ({ index: p.i, text: p.text })),
    };
    const clean = tagger.sanitise(raw, it, vocab);
    if (clean.notes.length) problems.push(`${id}: ${clean.notes.join('; ')}`);
    saved.items = saved.items.filter((x) => x.id !== id).concat({ id, kind: it.kind, section: it.sec, stem: it.q.stem, ...clean });
    n++;
  }
  saved.generatedAt = new Date().toISOString();
  fs.writeFileSync(sugPath, JSON.stringify(saved, null, 2), 'utf8');
  tagger.cmdReview({}, { dir });
  log(`${n} question(s) written to tag_suggestions.json (review: tag_review.md). Problems: ${problems.length ? '\n' + problems.join('\n') : 'none'}`);
  return { n, problems };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const spec = args.find((a) => !a.startsWith('--'));
  if (!spec) { console.error('usage: node tagFromSpec_fys501.js <spec.json> [--reset]'); process.exit(2); }
  run(spec, { reset: args.includes('--reset') });
}

module.exports = { run };
