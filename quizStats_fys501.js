'use strict';
/**
 * quizStats_fys501.js
 * -------------------
 * Turns quiz events (quizAnalytics_fys501.js) into a briefing on what students find hard.
 * Pure functions + a small CLI; no LLM, no network.
 *
 *   node quizStats_fys501.js <events.jsonl | railway-logs.txt> [more files...]
 *        [--min 5] [--live] [--top 10] [--json]
 *
 * Input lines may be raw event JSON (quiz_events.jsonl) or Railway log lines containing
 * "QUIZ_EVENT {...}" (plain or JSON-wrapped); exact duplicates are ignored.
 *
 * Method
 *  - Each student's FIRST answer to a question (per question version) counts, so repeated
 *    practice does not inflate the numbers.
 *  - A group's score = mean over students of that student's mean score in the group
 *    (heavy users do not dominate). n = number of distinct students.
 *  - Any group with fewer than --min students (default 5, env QUIZ_STATS_MIN_N) is hidden.
 *  - Live-generated (unreviewed) questions are excluded unless --live.
 *  - Sections work for every question; concepts and misconceptions need tagged questions
 *    (see validateQuizTags_fys501.js / tagQuizBank_fys501.js).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MIN_N = 5;

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

/** Vocabulary + bank index for labels and misconception exposure. */
function loadMeta(dir = __dirname) {
  const concepts = loadJson(path.join(dir, 'concepts_fys501.json'), { sections: {}, concepts: [] });
  const misc = loadJson(path.join(dir, 'misconceptions_fys501.json'), { misconceptions: [] });
  const bank = new Map();
  for (const f of ['quizBank_fys501.json', 'multivalueQuizBank_fys501.json']) {
    const b = loadJson(path.join(dir, f), {});
    for (const ch of Object.keys(b)) {
      for (const sec of Object.keys(b[ch] || {})) {
        for (const q of b[ch][sec] || []) if (q && q.id) bank.set(q.id, { sec, q });
      }
    }
  }
  return {
    sections: concepts.sections || {},
    concepts: new Map((concepts.concepts || []).map((c) => [c.id, c])),
    misconceptions: new Map((misc.misconceptions || []).map((m) => [m.id, m])),
    bank,
  };
}

// ---------- parsing ----------
function parseEvents(text) {
  const seen = new Set();
  const out = [];
  for (let line of String(text).split('\n')) {
    line = line.trim();
    if (!line) continue;
    // JSON-wrapped log line: {"message":"QUIZ_EVENT {...}", ...}
    if (line.startsWith('{')) {
      try {
        const o = JSON.parse(line);
        if (o && typeof o.message === 'string') line = o.message;
      } catch (e) { /* not JSON at all; fall through */ }
    }
    const i = line.indexOf('QUIZ_EVENT ');
    const body = (i >= 0 ? line.slice(i + 'QUIZ_EVENT '.length) : line).trim();
    if (!body.startsWith('{') || seen.has(body)) continue;
    let ev;
    try { ev = JSON.parse(body); } catch (e) { continue; }
    if (!ev || ev.v !== 1 || !ev.pid || !ev.qid || typeof ev.score !== 'number') continue;
    seen.add(body);
    out.push(ev);
  }
  return out;
}

// ---------- aggregation ----------
function groupStats(items) {
  // items: [{pid, score}] -> {students, answers, mean}
  const per = new Map();
  for (const it of items) {
    const e = per.get(it.pid) || { sum: 0, n: 0 };
    e.sum += it.score; e.n += 1;
    per.set(it.pid, e);
  }
  let total = 0;
  for (const e of per.values()) total += e.sum / e.n;
  return { students: per.size, answers: items.length, mean: per.size ? total / per.size : null };
}

function bucket(map, key, item) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(item);
}

/**
 * Events logged BEFORE a question was tagged carry no concepts/tags. If the question's version
 * is unchanged, fill them in from the current bank, so tagging can happen after logging started.
 */
function enrich(e, bank) {
  const hit = bank.get(e.qid);
  if (!hit || e.stale) return e;
  const q = hit.q;
  if (e.qv !== (Number.isInteger(q.version) ? q.version : 1)) return e;
  let out = e;
  if (!(e.concepts || []).length && Array.isArray(q.concepts) && q.concepts.length) out = { ...out, concepts: q.concepts };
  if ((e.wrongTags || []).every((t) => !t) && Array.isArray(q.optionTags) && (e.wrong || []).length) {
    out = { ...out, wrongTags: e.wrong.map((i) => q.optionTags[i] || null) };
  }
  return out;
}

function analyse(events, opts = {}, meta = {}) {
  const minN = Number.isFinite(opts.minN) ? opts.minN : (parseInt(process.env.QUIZ_STATS_MIN_N, 10) || DEFAULT_MIN_N);
  const includeLive = !!opts.includeLive;
  const sections = meta.sections || {};
  const conceptMeta = meta.concepts || new Map();
  const miscMeta = meta.misconceptions || new Map();
  const bank = meta.bank || new Map();

  const liveExcluded = includeLive ? 0 : events.filter((e) => e.live).length;
  const usable = (includeLive ? events : events.filter((e) => !e.live)).map((e) => enrich(e, bank));

  // first exposure per (student, question, version)
  const firstSeen = new Set();
  const first = [];
  for (const e of usable) {
    const k = `${e.pid}|${e.qid}|${e.qv}`;
    if (firstSeen.has(k)) continue;
    firstSeen.add(k);
    first.push(e);
  }

  const bySec = new Map();
  const byConcept = new Map();
  const byQuestion = new Map();
  const pickedBy = new Map();   // misconception id -> Set(pid) who picked it
  const exposedTo = new Map();  // misconception id -> Set(pid) who saw a question where it is a distractor

  for (const e of first) {
    const it = { pid: e.pid, score: e.score };
    if (e.sec) bucket(bySec, e.sec, it);
    for (const c of e.concepts || []) bucket(byConcept, c, it);
    bucket(byQuestion, `${e.qid}|${e.qv}`, { ...it, ev: e });
    (e.wrongTags || []).forEach((t) => {
      if (!t) return;
      if (!pickedBy.has(t)) pickedBy.set(t, new Set());
      pickedBy.get(t).add(e.pid);
    });
    const stored = bank.get(e.qid);
    if (stored && Array.isArray(stored.q.optionTags)) {
      const correctSet = new Set(stored.q.correctIndices || [stored.q.correctIndex]);
      stored.q.optionTags.forEach((t, i) => {
        if (!t || correctSet.has(i)) return;
        if (!exposedTo.has(t)) exposedTo.set(t, new Set());
        exposedTo.get(t).add(e.pid);
      });
    }
  }

  const hidden = { sections: 0, concepts: 0, questions: 0, misconceptions: 0 };
  const ranked = (map, kind, decorate) => {
    const rows = [];
    for (const [key, items] of map) {
      const g = groupStats(items);
      if (g.students < minN) { hidden[kind] += 1; continue; }
      rows.push({ key, ...g, ...(decorate ? decorate(key, items) : {}) });
    }
    return rows.sort((a, b) => a.mean - b.mean || b.students - a.students);
  };

  const sectionRows = ranked(bySec, 'sections', (k) => ({ id: k, title: sections[k] || '' }));
  const conceptRows = ranked(byConcept, 'concepts', (k) => ({
    id: k, label: (conceptMeta.get(k) || {}).label || '', section: (conceptMeta.get(k) || {}).section || '',
  }));
  const questionRows = ranked(byQuestion, 'questions', (k, items) => {
    const [qid, qv] = k.split('|');
    const ev0 = items[0].ev;
    // most common wrong picks (distinct students), by tag when available
    const wrongBy = new Map();
    for (const it of items) {
      (it.ev.wrong || []).forEach((idx, j) => {
        const label = (it.ev.wrongTags || [])[j] || `opt${idx + 1}`;
        if (!wrongBy.has(label)) wrongBy.set(label, new Set());
        wrongBy.get(label).add(it.pid);
      });
    }
    const topWrong = [...wrongBy.entries()].map(([label, set]) => ({ label, students: set.size }))
      .sort((a, b) => b.students - a.students).slice(0, 3);
    const fullCorrect = ev0.kind === 'multi'
      ? items.filter((x) => x.score >= 0.999).length / items.length : null;
    return { id: qid, qv: Number(qv) || null, kind: ev0.kind, sec: ev0.sec, concepts: ev0.concepts || [], topWrong, fullCorrect };
  });

  const miscRows = [];
  for (const [id, pids] of pickedBy) {
    const exposed = exposedTo.has(id) ? exposedTo.get(id).size : null;
    const denom = exposed !== null ? exposed : null;
    const students = denom !== null ? denom : pids.size;
    if (students < minN) { hidden.misconceptions += 1; continue; }
    const m = miscMeta.get(id) || {};
    miscRows.push({
      id, description: m.description || '', concept: m.concept_id || '',
      picked: pids.size, exposed, rate: denom ? pids.size / denom : null,
    });
  }
  miscRows.sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.picked - a.picked);

  return {
    minN,
    includeLive,
    totals: {
      events: usable.length,
      firstExposureAnswers: first.length,
      students: new Set(first.map((e) => e.pid)).size,
      liveExcluded,
      taggedShare: first.length ? first.filter((e) => (e.concepts || []).length).length / first.length : 0,
    },
    sections: sectionRows,
    concepts: conceptRows,
    questions: questionRows,
    misconceptions: miscRows,
    hidden,
  };
}

// ---------- formatting ----------
const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);

function headerLines(r) {
  const t = r.totals;
  const lines = [
    `Quiz statistics (groups under ${r.minN} students are hidden)`,
    `${t.firstExposureAnswers} first answers from ${t.students} students; ${pct(t.taggedShare)} on concept-tagged questions` +
      (t.liveExcluded ? `; ${t.liveExcluded} live-generated answers excluded` : ''),
  ];
  return lines;
}

function formatTelegram(r, { top = 5, focus = null } = {}) {
  const lines = headerLines(r);
  if (!r.totals.students) {
    lines.push('', 'No usable answers yet (or every group is below the minimum size).');
    return lines.join('\n');
  }
  const show = (name) => !focus || focus === name;
  if (show('sections') && r.sections.length) {
    lines.push('', 'Weakest sections');
    r.sections.slice(0, top).forEach((s) => lines.push(`${s.id} ${s.title} - ${pct(s.mean)} (n=${s.students})`));
  }
  if (show('concepts') && r.concepts.length) {
    lines.push('', 'Weakest concepts');
    r.concepts.slice(0, top).forEach((c) => lines.push(`${c.id} - ${pct(c.mean)} (n=${c.students})`));
  } else if (show('concepts') && r.totals.taggedShare === 0) {
    lines.push('', 'No concept-tagged questions answered yet (see QUIZ_ANALYTICS_fys501.md, tagging).');
  }
  if (show('misconceptions') && r.misconceptions.length) {
    lines.push('', 'Most attractive wrong answers');
    r.misconceptions.slice(0, top).forEach((m) => {
      const rate = m.rate !== null ? `${pct(m.rate)} of ${m.exposed}` : `${m.picked} students`;
      lines.push(`${m.id}: ${m.description || m.concept} - ${rate}`);
    });
  }
  if (show('questions') && r.questions.length) {
    lines.push('', 'Hardest questions');
    r.questions.slice(0, top).forEach((q) => {
      const w = q.topWrong[0] ? `, top wrong: ${q.topWrong[0].label}` : '';
      lines.push(`${q.id}${q.qv > 1 ? ' v' + q.qv : ''} - ${pct(q.mean)} (n=${q.students})${w}`);
    });
  }
  const h = r.hidden;
  const hiddenTotal = h.sections + h.concepts + h.questions + h.misconceptions;
  if (hiddenTotal) lines.push('', `Hidden (too few students): ${hiddenTotal} group(s).`);
  return lines.join('\n');
}

function formatMarkdown(r, { top = 10 } = {}) {
  const t = r.totals;
  const out = [];
  out.push('# Quiz briefing', '');
  out.push(`- First-exposure answers: **${t.firstExposureAnswers}** from **${t.students}** students`);
  out.push(`- Minimum group size: ${r.minN} students (smaller groups hidden: ${Object.entries(r.hidden).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  out.push(`- Answers on concept-tagged questions: ${pct(t.taggedShare)}${t.liveExcluded ? `; live-generated answers excluded: ${t.liveExcluded}` : ''}`, '');
  const table = (title, head, rows) => {
    out.push(`## ${title}`, '');
    if (!rows.length) { out.push('_Nothing to show yet._', ''); return; }
    out.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
    rows.forEach((row) => out.push(`| ${row.join(' | ')} |`));
    out.push('');
  };
  table('Weakest sections', ['Section', 'Title', 'Score', 'Students'],
    r.sections.slice(0, top).map((s) => [s.id, s.title, pct(s.mean), s.students]));
  table('Weakest concepts', ['Concept', 'Label', 'Score', 'Students'],
    r.concepts.slice(0, top).map((c) => [c.id, c.label, pct(c.mean), c.students]));
  table('Most attractive wrong answers (misconceptions)', ['ID', 'Student belief', 'Picked by', 'Of students who saw it'],
    r.misconceptions.slice(0, top).map((m) => [m.id, m.description, m.picked, m.rate !== null ? `${pct(m.rate)} of ${m.exposed}` : '-']));
  table('Hardest questions', ['Question', 'Kind', 'Score', 'Students', 'Top wrong answers'],
    r.questions.slice(0, top).map((q) => [q.id, q.kind, pct(q.mean), q.students, q.topWrong.map((w) => `${w.label} (${w.students})`).join(', ') || '-']));
  return out.join('\n');
}

// ---------- CLI ----------
function main(argv) {
  const files = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
  const flag = (n) => argv.includes(`--${n}`);
  const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (!files.length) {
    console.error('usage: node quizStats_fys501.js <events.jsonl|logs.txt> [...] [--min 5] [--live] [--top 10] [--json]');
    process.exit(2);
  }
  let text;
  try {
    text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  } catch (e) {
    console.error(`Cannot read input: ${e.message}`);
    process.exit(2);
  }
  const events = parseEvents(text);
  const r = analyse(events, { minN: val('min') ? parseInt(val('min'), 10) : undefined, includeLive: flag('live') }, loadMeta());
  console.log(flag('json') ? JSON.stringify(r, null, 2) : formatMarkdown(r, { top: val('top') ? parseInt(val('top'), 10) : 10 }));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseEvents, analyse, formatTelegram, formatMarkdown, loadMeta, groupStats };
