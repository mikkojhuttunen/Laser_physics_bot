'use strict';
/**
 * validateQuizTags_fys501.js
 * --------------------------
 * Checks the OPTIONAL analytics fields on quiz-bank questions and reports tagging coverage.
 * Nothing here is required by the quiz itself: untagged questions keep working and still
 * count towards section-level statistics.
 *
 * Fields (added to existing question objects, nothing else changes):
 *   concepts    string[1-3]   ids from concepts_fys501.json; first = primary concept
 *   optionTags  (string|null)[]  parallel to `options` (STORED order, before any shuffle):
 *                             null at correct options; at a wrong option, the id of the
 *                             misconception it embodies (misconceptions_fys501.json) or
 *                             null if it matches none
 *   version     integer >= 1  bump when stem/options/correct answer/tags CHANGE how students
 *                             respond (analysis keeps versions apart); absent = 1
 *
 *   node validateQuizTags_fys501.js            report + problems, exit 1 on errors
 *   node validateQuizTags_fys501.js --strict   also fail if any question is untagged
 */

const fs = require('fs');
const path = require('path');

const KINDS = {
  single: { file: 'quizBank_fys501.json', correct: (q) => [q.correctIndex] },
  multi: { file: 'multivalueQuizBank_fys501.json', correct: (q) => q.correctIndices || [] },
};

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

function loadVocab(dir = __dirname) {
  const c = loadJson(path.join(dir, 'concepts_fys501.json'), { sections: {}, concepts: [] });
  const m = loadJson(path.join(dir, 'misconceptions_fys501.json'), { misconceptions: [] });
  return {
    sections: c.sections || {},
    concepts: new Map((c.concepts || []).map((x) => [x.id, x])),
    misconceptions: new Map((m.misconceptions || []).map((x) => [x.id, x])),
  };
}

function* questions(bank) {
  for (const ch of Object.keys(bank || {})) {
    for (const sec of Object.keys(bank[ch] || {})) {
      for (const q of bank[ch][sec] || []) yield { sec, q };
    }
  }
}

/**
 * @returns {{errors: string[], warnings: string[], coverage: object}}
 */
function validateBank(bank, kind, vocab) {
  const errors = [];
  const warnings = [];
  const cov = { questions: 0, withConcepts: 0, distractors: 0, taggedDistractors: 0, bySection: {} };
  const correctOf = KINDS[kind].correct;

  for (const { sec, q } of questions(bank)) {
    const tag = q.id || `(no id, section ${sec})`;
    const err = (m) => errors.push(`${kind} ${tag}: ${m}`);
    const warn = (m) => warnings.push(`${kind} ${tag}: ${m}`);
    const s = (cov.bySection[sec] = cov.bySection[sec] || { questions: 0, withConcepts: 0, distractors: 0, taggedDistractors: 0 });
    cov.questions++; s.questions++;

    if (q.version !== undefined && (!Number.isInteger(q.version) || q.version < 1)) err('version must be an integer >= 1');

    const opts = Array.isArray(q.options) ? q.options : [];
    const correct = new Set(correctOf(q));
    const nDistractors = opts.length - correct.size;
    cov.distractors += nDistractors; s.distractors += nDistractors;

    if (q.concepts !== undefined) {
      if (!Array.isArray(q.concepts) || q.concepts.length < 1 || q.concepts.length > 3) {
        err('concepts must list 1-3 concept ids');
      } else {
        if (new Set(q.concepts).size !== q.concepts.length) err('concepts contains duplicates');
        q.concepts.forEach((c) => { if (!vocab.concepts.has(c)) err(`unknown concept id "${c}"`); });
        const primary = vocab.concepts.get(q.concepts[0]);
        if (primary && primary.section !== sec) warn(`primary concept ${primary.id} belongs to section ${primary.section}, question is in ${sec}`);
        cov.withConcepts++; s.withConcepts++;
      }
    }

    if (q.optionTags !== undefined) {
      if (!Array.isArray(q.optionTags) || q.optionTags.length !== opts.length) {
        err(`optionTags must be an array with one entry per option (${opts.length})`);
      } else {
        const used = [];
        q.optionTags.forEach((t, i) => {
          if (t === null) return;
          if (typeof t !== 'string') return err(`optionTags[${i}] must be a string or null`);
          if (correct.has(i)) return err(`optionTags[${i}] is set on a correct option (must be null)`);
          const m = vocab.misconceptions.get(t);
          if (!m) return err(`unknown misconception id "${t}" at option ${i}`);
          used.push(t);
          cov.taggedDistractors++; s.taggedDistractors++;
          if (Array.isArray(q.concepts) && !q.concepts.includes(m.concept_id)) {
            warn(`option ${i}: ${t} belongs to concept ${m.concept_id}, which is not in this question's concepts`);
          }
        });
        if (new Set(used).size !== used.length) warn('two options share a misconception; the analysis cannot tell them apart');
        if (q.concepts === undefined) warn('optionTags present but no concepts');
      }
    }
  }
  return { errors, warnings, coverage: cov };
}

function formatCoverage(covs) {
  const lines = [];
  for (const [kind, cov] of Object.entries(covs)) {
    const pctv = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
    lines.push(`${kind}: ${cov.withConcepts}/${cov.questions} questions with concepts (${pctv(cov.withConcepts, cov.questions)}), ` +
      `${cov.taggedDistractors}/${cov.distractors} distractors tagged (${pctv(cov.taggedDistractors, cov.distractors)})`);
  }
  return lines.join('\n');
}

/** Compact one-line coverage for /source_quizzes. */
function coverageSummary(dir = __dirname) {
  const vocab = loadVocab(dir);
  const covs = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    covs[kind] = validateBank(loadJson(path.join(dir, k.file), {}), kind, vocab).coverage;
  }
  return covs;
}

function main(argv) {
  const strict = argv.includes('--strict');
  const vocab = loadVocab();
  let errors = [];
  let warnings = [];
  const covs = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    const r = validateBank(loadJson(path.join(__dirname, k.file), {}), kind, vocab);
    errors = errors.concat(r.errors);
    warnings = warnings.concat(r.warnings);
    covs[kind] = r.coverage;
  }
  console.log(formatCoverage(covs));
  for (const [kind, cov] of Object.entries(covs)) {
    const rows = Object.keys(cov.bySection).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((sec) => `${sec}: ${cov.bySection[sec].withConcepts}/${cov.bySection[sec].questions}q, ${cov.bySection[sec].taggedDistractors}/${cov.bySection[sec].distractors}d`);
    console.log(`  ${kind} by section (questions with concepts / distractors tagged): ${rows.join('  ')}`);
  }
  warnings.forEach((w) => console.log('WARN  ' + w));
  errors.forEach((e) => console.log('ERROR ' + e));
  if (strict) {
    for (const [kind, cov] of Object.entries(covs)) {
      if (cov.withConcepts < cov.questions) { console.log(`ERROR ${kind}: ${cov.questions - cov.withConcepts} question(s) have no concepts (--strict)`); errors.push('untagged'); }
    }
  }
  console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length ? 1 : 0);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { validateBank, loadVocab, coverageSummary, formatCoverage, KINDS };
