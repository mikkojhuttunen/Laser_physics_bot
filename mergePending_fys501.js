#!/usr/bin/env node
/**
 * mergePending_fys501.js
 * ----------------------
 * Human-in-the-loop pipeline for live-generated quiz questions:
 *
 *   extract  <logfile...>   pull QUIZ_PENDING_QUESTION / MVQUIZ_PENDING_QUESTION lines out of a
 *                           Railway log export into the two pending files (use this if the pending
 *                           files were lost on a redeploy)
 *   review                  validate + duplicate-check every pending question and write a review
 *                           sheet (pending_review.md) with a short KEY per question
 *   merge                   append the questions you approved to the banks, remove them from the
 *                           pending files
 *
 * Nothing is merged without an explicit --accept / --all-valid. Full workflow:
 * PENDING_QUESTIONS_fys501.md.
 *
 * Options (all commands):  --dir <path>       folder holding the pending files   (default: repo folder)
 *                          --bank-dir <path>  folder holding the two bank files  (default: repo folder)
 * review:                  --out <file>       review sheet path                  (default: pending_review.md)
 * merge:                   --accept K1,K2     keys to merge            --all-valid   merge every valid, non-duplicate question
 *                          --drop K1,K2       keys to discard          --drop-rest   discard every pending question not accepted
 *                          --reviewed         mark merged questions "reviewed": true (default false)
 *                          --allow-similar    also accept questions flagged SIMILAR (never exact duplicates)
 *                          --assign K=2.4     give a section to a question that has none
 *                          --dry-run          show what would happen, change nothing
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = {
  single: {
    label: 'single-select', bank: 'quizBank_fys501.json', pending: 'quizBankPending_fys501.json',
    logTag: 'QUIZ', keyPrefix: 'S', idPrefix: 'q',
  },
  multi: {
    label: 'multi-select', bank: 'multivalueQuizBank_fys501.json', pending: 'multivalueQuizBankPending_fys501.json',
    logTag: 'MVQUIZ', keyPrefix: 'M', idPrefix: 'mv',
  },
};
const SEC_RE = /^[1-4]\.[1-9]$/;
const SELECT_SUFFIX = '(Select all that apply)';

// ------------------------------------------------------------------ helpers --
function parseArgs(argv) {
  const out = { _: [], assign: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    if (['reviewed', 'all-valid', 'drop-rest', 'allow-similar', 'dry-run'].includes(name)) { out[name] = true; continue; }
    const val = argv[++i];
    if (val === undefined) die(`Missing value for --${name}`);
    if (name === 'assign') {
      const [k, sec] = val.split('=');
      if (!k || !SEC_RE.test(sec || '')) die(`--assign expects KEY=SECTION (e.g. S-a1b2c3=2.4), got "${val}"`);
      out.assign[k] = sec;
    } else out[name] = val;
  }
  return out;
}
function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die(`${p} is not valid JSON: ${e.message}`); }
}
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); }

const normStem = (s) => String(s || '').toLowerCase().replace(/\(select all that apply\)/g, '').replace(/[^a-z0-9α-ωÀ-ÿ]+/g, ' ').trim();
const words = (s) => new Set(normStem(s).split(' ').filter((w) => w.length >= 3));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
const keyOf = (kind, q) => `${KINDS[kind].keyPrefix}-${crypto.createHash('sha1').update(normStem(q && q.stem)).digest('hex').slice(0, 6)}`;

function loadState(args) {
  const dir = path.resolve(args.dir || __dirname);
  const bankDir = path.resolve(args['bank-dir'] || __dirname);
  const st = { dir, bankDir, kinds: {} };
  for (const [kind, k] of Object.entries(KINDS)) {
    const pending = readJson(path.join(dir, k.pending), []);
    if (!Array.isArray(pending)) die(`${k.pending} must contain a JSON array`);
    st.kinds[kind] = { pending, bank: readJson(path.join(bankDir, k.bank), {}) };
  }
  return st;
}

// ---------------------------------------------------------------- validation --
function validate(kind, entry, assignedSection) {
  const problems = [];
  const warnings = [];
  const q = entry && entry.question;
  if (!q || typeof q !== 'object') return { problems: ['entry has no question object'], warnings };
  if (typeof q.stem !== 'string' || !q.stem.trim()) problems.push('missing stem');
  const opts = Array.isArray(q.options) ? q.options : null;
  if (!opts) problems.push('options is not an array');
  else {
    if (!opts.every((o) => typeof o === 'string' && o.trim())) problems.push('an option is empty or not text');
    if (new Set(opts.map((o) => String(o).trim().toLowerCase())).size !== opts.length) problems.push('duplicate options');
    if (kind === 'single' && opts.length !== 4) problems.push(`needs exactly 4 options (has ${opts.length})`);
    if (kind === 'multi' && (opts.length < 4 || opts.length > 8)) problems.push(`needs 4-8 options (has ${opts.length})`);
  }
  if (opts) {
    if (kind === 'single') {
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= opts.length) problems.push('correctIndex missing or out of range');
    } else {
      const ci = q.correctIndices;
      if (!Array.isArray(ci) || !ci.length) problems.push('correctIndices missing');
      else {
        const set = new Set(ci);
        if (set.size !== ci.length || !ci.every((i) => Number.isInteger(i) && i >= 0 && i < opts.length)) problems.push('correctIndices invalid');
        else if (set.size < 2 || set.size >= opts.length) problems.push('multi-select needs at least 2 correct and at least 1 wrong option');
      }
    }
  }
  const section = entry.section || assignedSection || null;
  if (!section) problems.push('no section (use --assign KEY=2.4)');
  else if (!SEC_RE.test(section)) problems.push(`bad section "${section}"`);
  else if (String(entry.chapter) !== section.split('.')[0]) problems.push(`section ${section} does not match chapter ${entry.chapter}`);

  if (!problems.length) {
    if (!q.explanation || !String(q.explanation).trim()) warnings.push('no explanation');
    const correct = kind === 'single' ? [q.correctIndex] : q.correctIndices;
    const wrong = opts.map((_, i) => i).filter((i) => !correct.includes(i));
    const maxC = Math.max(...correct.map((i) => opts[i].length));
    const maxW = Math.max(...wrong.map((i) => opts[i].length));
    if (kind === 'single' && maxC >= maxW * 1.25 && maxC - maxW >= 15) warnings.push('LENGTH CUE: correct option is much longer than every distractor');
    if ([q.stem, q.explanation, ...opts].some((t) => /<[A-Za-z/!?]|&[A-Za-z#]/.test(String(t || '')))) warnings.push('contains "<letter" or "&entity" (may break Telegram HTML)');
  }
  return { problems, warnings, section };
}

/** Annotates every pending entry with key, status and duplicate info. */
function analyse(state, args) {
  const result = { single: [], multi: [] };
  for (const kind of Object.keys(KINDS)) {
    const { pending, bank } = state.kinds[kind];
    const bankQs = Object.values(bank).flatMap((secs) => Object.entries(secs).flatMap(([sec, qs]) => qs.map((q) => ({ q, sec }))));
    const bankExact = new Map(bankQs.map(({ q }) => [normStem(q.stem), q.id]));
    const seen = new Map();
    pending.forEach((entry, index) => {
      const key = keyOf(kind, entry && entry.question);
      const assigned = args && args.assign ? args.assign[key] : null;
      const v = validate(kind, entry, assigned);
      let dup = null, similar = null;
      const stem = entry && entry.question && entry.question.stem;
      if (stem) {
        const n = normStem(stem);
        if (bankExact.has(n)) dup = `identical stem already in bank (${bankExact.get(n)})`;
        else if (seen.has(n)) dup = `identical to earlier pending question ${seen.get(n)}`;
        else {
          const w = words(stem);
          const sec = v.section;
          let best = { s: 0, id: null };
          for (const { q, sec: bsec } of bankQs) {
            if (sec && bsec !== sec) continue;
            const s = jaccard(w, words(q.stem));
            if (s > best.s) best = { s, id: q.id };
          }
          if (best.s >= 0.6) similar = `${Math.round(best.s * 100)}% word overlap with bank question ${best.id}`;
        }
        if (!seen.has(n)) seen.set(n, key);
      }
      const status = v.problems.length ? 'INVALID' : dup ? 'DUPLICATE' : similar ? 'SIMILAR' : 'OK';
      result[kind].push({ kind, index, key, entry, section: v.section, problems: v.problems, warnings: v.warnings, dup, similar, status });
    });
  }
  return result;
}

// ------------------------------------------------------------------ commands --
function cmdExtract(args) {
  const files = args._.slice(1);
  if (!files.length) die('extract needs at least one log file: node mergePending_fys501.js extract railway-logs.txt');
  const dir = path.resolve(args.dir || __dirname);
  const found = { single: [], multi: [] };
  let scanned = 0, bad = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) die(`log file not found: ${f}`);
    for (let line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      scanned++;
      // Railway JSON exports wrap each log line in an object with a "message" field.
      if (line.startsWith('{')) {
        try { const o = JSON.parse(line); if (typeof o.message === 'string') line = o.message; else if (typeof o.msg === 'string') line = o.msg; } catch (e) { /* not a wrapper */ }
      }
      const m = line.match(/(?<![A-Z_])(MVQUIZ|QUIZ)_PENDING_QUESTION (\{.*\})\s*$/);
      if (!m) continue;
      try {
        found[m[1] === 'MVQUIZ' ? 'multi' : 'single'].push(JSON.parse(m[2]));
      } catch (e) { bad++; }
    }
  }
  for (const [kind, entries] of Object.entries(found)) {
    const k = KINDS[kind];
    const p = path.join(dir, k.pending);
    const existing = readJson(p, []);
    const have = new Set(existing.map((e) => keyOf(kind, e.question)));
    let added = 0;
    for (const e of entries) {
      const key = keyOf(kind, e.question);
      if (have.has(key)) continue;
      have.add(key); existing.push(e); added++;
    }
    if (added) writeJson(p, existing);
    console.log(`${k.label}: ${entries.length} log line(s) found, ${added} new added to ${k.pending} (${existing.length} total)`);
  }
  if (bad) console.log(`${bad} log line(s) had unparseable JSON and were skipped.`);
  console.log(`Scanned ${scanned} lines. Next: node mergePending_fys501.js review`);
}

function reviewMarkdown(analysis) {
  const out = ['# Pending live-generated questions — review sheet', '',
    'Read each question, then merge the ones you accept with `node mergePending_fys501.js merge --accept KEY1,KEY2 --reviewed` (see the bottom of this file).',
    '✅ = correct option. Status: OK / SIMILAR (near-duplicate of a bank question) / DUPLICATE / INVALID.', ''];
  let n = 0;
  for (const kind of Object.keys(KINDS)) {
    const items = analysis[kind];
    out.push(`## ${KINDS[kind].label} (${items.length})`, '');
    if (!items.length) out.push('_none_', '');
    for (const it of items) {
      n++;
      const q = it.entry && it.entry.question ? it.entry.question : {};
      out.push(`### ${it.key} — section ${it.section || '?'} — ${it.status}`, '', `**${q.stem || '(no stem)'}**`, '');
      const cs = kind === 'single' ? [q.correctIndex] : (q.correctIndices || []);
      (Array.isArray(q.options) ? q.options : []).forEach((o, i) => out.push(`- ${cs.includes(i) ? '✅' : '⬜'} ${'ABCDEFGH'[i]}) ${o}`));
      if (q.explanation) out.push('', `*Explanation:* ${q.explanation}`);
      const notes = [...it.problems.map((p) => `PROBLEM: ${p}`), ...(it.dup ? [`DUPLICATE: ${it.dup}`] : []), ...(it.similar ? [`SIMILAR: ${it.similar}`] : []), ...it.warnings.map((w) => `warning: ${w}`)];
      if (notes.length) out.push('', ...notes.map((x) => `> ${x}`));
      out.push('');
    }
  }
  if (!n) out.push('No pending questions.');
  else {
    const ok = ['single', 'multi'].flatMap((k) => analysis[k]).filter((x) => x.status === 'OK').map((x) => x.key);
    out.push('---', '', '## Merge commands', '',
      'Accept specific questions:', '```', 'node mergePending_fys501.js merge --accept KEY1,KEY2 --reviewed --drop-rest', '```', '',
      ok.length ? `Accept every OK question (${ok.length}): \`node mergePending_fys501.js merge --all-valid --reviewed --drop-rest\`` : '_No question is currently OK to merge._');
  }
  return out.join('\n');
}

function cmdReview(args) {
  const state = loadState(args);
  const analysis = analyse(state, args);
  const outPath = path.resolve(args.out || 'pending_review.md');
  fs.writeFileSync(outPath, reviewMarkdown(analysis), 'utf8');
  for (const kind of Object.keys(KINDS)) {
    const c = {};
    analysis[kind].forEach((x) => { c[x.status] = (c[x.status] || 0) + 1; });
    console.log(`${KINDS[kind].label}: ${analysis[kind].length} pending — ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
  }
  console.log(`Review sheet written to ${outPath}`);
}

function nextId(kind, bank, section) {
  const pre = `${KINDS[kind].idPrefix}${section}_`;
  const nums = ((bank[section.split('.')[0]] || {})[section] || []).map((q) => (String(q.id).startsWith(pre) ? parseInt(String(q.id).slice(pre.length), 10) : 0));
  return `${pre}${String(Math.max(0, ...nums.filter(Number.isFinite)) + 1).padStart(3, '0')}`;
}

function cmdMerge(args) {
  const accept = new Set(list(args.accept));
  const drop = new Set(list(args.drop));
  if (!accept.size && !args['all-valid']) die('merge needs --accept KEY1,KEY2 or --all-valid (run `review` first to see the keys)');
  const state = loadState(args);
  const analysis = analyse(state, args);
  const today = new Date().toISOString().slice(0, 10);
  const allKeys = new Set(['single', 'multi'].flatMap((k) => analysis[k].map((x) => x.key)));
  for (const k of [...accept, ...drop]) if (!allKeys.has(k)) die(`unknown key ${k} — run \`review\` again (keys are derived from the question text)`);
  for (const k of accept) if (drop.has(k)) die(`${k} is in both --accept and --drop`);

  const plan = { merged: [], removed: [], skipped: [] };
  for (const kind of Object.keys(KINDS)) {
    const { bank } = state.kinds[kind];
    for (const it of analysis[kind]) {
      const wanted = accept.has(it.key) || (args['all-valid'] && !drop.has(it.key) && it.status === 'OK');
      if (wanted) {
        const okStatus = it.status === 'OK' || (it.status === 'SIMILAR' && args['allow-similar']);
        if (!okStatus) { plan.skipped.push(`${it.key}: ${it.status}${it.problems.length ? ' (' + it.problems.join('; ') + ')' : ''}${it.dup ? ' (' + it.dup + ')' : ''}${it.similar ? ' (' + it.similar + ' — add --allow-similar to force)' : ''}`); continue; }
        const q = it.entry.question;
        const sec = it.section, ch = sec.split('.')[0];
        bank[ch] = bank[ch] || {}; bank[ch][sec] = bank[ch][sec] || [];
        const id = nextId(kind, bank, sec);
        const rec = kind === 'single'
          ? { id, stem: q.stem.trim(), options: q.options.map((o) => o.trim()), correctIndex: q.correctIndex, explanation: q.explanation || '' }
          : { id, stem: /\(select all that apply\)\s*$/i.test(q.stem) ? q.stem.trim() : `${q.stem.trim()} ${SELECT_SUFFIX}`, options: q.options.map((o) => o.trim()), correctIndices: [...q.correctIndices].sort((a, b) => a - b), explanation: q.explanation || '', ref: q.ref || 'Live-generated from the course notes (merged from pending)' };
        Object.assign(rec, { addedAt: today, source: 'claude-live-generated', reviewed: !!args.reviewed });
        bank[ch][sec].push(rec);
        plan.merged.push(`${it.key} -> ${id}`);
        plan.removed.push({ kind, index: it.index });
      } else if (drop.has(it.key) || (args['drop-rest'] && !accept.has(it.key))) {
        plan.removed.push({ kind, index: it.index });
        plan.skipped.push(`${it.key}: dropped (${it.status})`);
      }
    }
  }
  console.log(`Merge plan: ${plan.merged.length} to merge, ${plan.removed.length - plan.merged.length} to drop.`);
  plan.merged.forEach((m) => console.log(`  + ${m}`));
  plan.skipped.forEach((m) => console.log(`  - ${m}`));
  if (args['dry-run']) { console.log('Dry run — nothing written.'); return; }
  if (!plan.removed.length) { console.log('Nothing to do.'); return; }

  for (const [kind, k] of Object.entries(KINDS)) {
    const drops = new Set(plan.removed.filter((r) => r.kind === kind).map((r) => r.index));
    if (!drops.size) continue;
    const bankPath = path.join(state.bankDir, k.bank), pendPath = path.join(state.dir, k.pending);
    if (plan.merged.some((m) => m.startsWith(k.keyPrefix + '-'))) {
      fs.copyFileSync(bankPath, `${bankPath}.bak`);
      writeJson(bankPath, state.kinds[kind].bank);
    }
    writeJson(pendPath, state.kinds[kind].pending.filter((_, i) => !drops.has(i)));
  }
  console.log(`\nDone. Backups: <bank>.bak. Next steps:\n  1. node e2e_quiz_test.js   (optional regression run)\n  2. git add quizBank_fys501.json multivalueQuizBank_fys501.json && git commit && git push\n  3. In Telegram send /pending clear so the bot does not export these again`);
}

// ---------------------------------------------------------------------- main --
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'extract') cmdExtract(args);
  else if (cmd === 'review') cmdReview(args);
  else if (cmd === 'merge') cmdMerge(args);
  else {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*\n|^ \* ?/gm, '').trim());
    process.exit(cmd ? 1 : 0);
  }
}

module.exports = { validate, analyse, normStem, keyOf, parseArgs };
