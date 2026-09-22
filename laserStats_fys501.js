'use strict';
/**
 * laserStats_fys501.js
 * ---------------------
 * Turns laser_quiz_log.jsonl (written by laserQuiz.js) into a usage + learning briefing
 * for the /lasers quiz. Pure functions + a small CLI; no LLM, no network. Same spirit and
 * shape as quizStats_fys501.js for the /quiz and /mvquiz side.
 *
 *   node laserStats_fys501.js <laser_quiz_log.jsonl | railway-logs.txt> [more files...]
 *        [--json]
 *
 * Input lines may be raw event JSON or Railway log lines containing a JSON object anywhere
 * on the line (plain or wrapped in {"message": "..."}); exact duplicate lines are ignored.
 *
 * Two event kinds are read from the same file:
 *   step  event: { ts, u, kind:"step",  laser, step, pts, perfect }        - one per answered question
 *   round event: { ts, u, kind:"round", laser, steps, pts, max, perfect, xp, isNewBest, masteryDelta }
 *               - one per completed laser. xp is that round's candidate score; masteryDelta is what
 *                 was actually banked (0 unless isNewBest is true) -- see laserQuiz.js's mastery model.
 * (Events logged before the "kind" field existed are treated as "step" events — see parseEvents.)
 *
 * Method
 *  - Unique students / total rounds / total mastery XP gained: straightforward counts and sums
 *    over round events (mastery XP sums masteryDelta, not xp -- see the code comment below).
 *  - Per-laser/step class accuracy: mean(pts/10) over step events, grouped by laser+step. This is
 *    the same "what do students find hard" lens /quizstats gives for the course quiz — worth
 *    comparing side by side with that report.
 *  - Weekly active students: distinct students per ISO week (any event counts), a simple adoption/
 *    engagement-over-the-term trend.
 *  - Repeated-exposure learning curve: for each (student, laser, step), order that student's step
 *    events chronologically and label them attempt 1, 2, 3, ... Average accuracy by attempt number
 *    across the whole class. Rising accuracy with attempt number is a direct behavioural signal of
 *    retention/learning from repeated play — much stronger evidence than raw usage counts, since
 *    lasers are drawn from a shuffled bag so repeat exposure to the same laser+step happens
 *    naturally for returning students rather than being requested.
 *  - First-attempt-only weekly accuracy: same "first answer counts" methodology quizStats_fys501.js
 *    uses, so heavy players don't dominate the trend. Useful to eyeball against the lecture schedule.
 */

const fs = require('fs');

// ---------- parsing ----------

function parseEvents(text) {
  const seen = new Set();
  const out = [];
  for (let line of String(text).split('\n')) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const o = JSON.parse(line);
        if (o && typeof o.message === 'string') line = o.message;
      } catch (e) { /* not JSON at all; fall through */ }
    }
    const i = line.indexOf('{');
    const body = (i >= 0 ? line.slice(i) : line).trim();
    if (!body.startsWith('{') || seen.has(body)) continue;
    let ev;
    try { ev = JSON.parse(body); } catch (e) { continue; }
    if (!ev || !ev.u || !ev.laser || typeof ev.ts !== 'string') continue;
    if (!ev.kind) ev.kind = 'step'; // events logged before "kind" existed
    seen.add(body);
    out.push(ev);
  }
  return out;
}

// ---------- small helpers ----------

function isoWeekOf(iso) {
  const dt = new Date(iso);
  const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((d - y0) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function pct(x) {
  return x === null ? 'n/a' : `${Math.round(x * 100)}%`;
}

// ---------- aggregation ----------

function analyse(events, opts = {}) {
  const minN = Number.isFinite(opts.minN) ? opts.minN : (parseInt(process.env.LASER_STATS_MIN_N, 10) || 3);

  const steps = events.filter((e) => e.kind === 'step' && typeof e.pts === 'number');
  const rounds = events.filter((e) => e.kind === 'round' && typeof e.xp === 'number');

  const students = new Set(events.map((e) => e.u));

  // ---- basic usage ----
  // masteryDelta (not xp) is what was actually banked as a permanent personal-best gain --
  // summing xp instead would double-count replays of a laser under the mastery model (xp is
  // just that round's candidate score, whether or not it beat the stored best). Falls back to
  // xp for events logged before masteryDelta existed (pre-mastery-model rounds), so older logs
  // still degrade gracefully rather than reporting zero.
  const totalMasteryGained = rounds.reduce((a, r) => a + (typeof r.masteryDelta === 'number' ? r.masteryDelta : r.xp), 0);
  const usage = {
    uniqueStudents: students.size,
    totalRounds: rounds.length,
    totalXp: totalMasteryGained,
    totalQuestionsAnswered: steps.length,
    lasersPlayed: (() => {
      const m = new Map();
      for (const r of rounds) m.set(r.laser, (m.get(r.laser) || 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    })(),
  };

  // ---- weekly active students (any event) ----
  const byWeek = new Map();
  for (const e of events) {
    const wk = isoWeekOf(e.ts);
    if (!byWeek.has(wk)) byWeek.set(wk, new Set());
    byWeek.get(wk).add(e.u);
  }
  const weeklyActive = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([wk, set]) => ({ week: wk, students: set.size }));

  // ---- per-laser/step class accuracy (like /quizstats' weakest sections) ----
  const byLaserStep = new Map();
  for (const e of steps) {
    const key = `${e.laser}|${e.step}`;
    if (!byLaserStep.has(key)) byLaserStep.set(key, []);
    byLaserStep.get(key).push(e.pts / 10);
  }
  const laserStepAccuracy = [...byLaserStep.entries()]
    .map(([key, scores]) => {
      const [laser, step] = key.split('|');
      return { laser, step, n: scores.length, mean: mean(scores) };
    })
    .filter((r) => r.n >= minN)
    .sort((a, b) => a.mean - b.mean);

  // ---- repeated-exposure learning curve ----
  // group step events by (student, laser, step), sort each group chronologically,
  // label attempt index, then average accuracy per attempt index across everyone.
  const byStudentLaserStep = new Map();
  for (const e of steps) {
    const key = `${e.u}|${e.laser}|${e.step}`;
    if (!byStudentLaserStep.has(key)) byStudentLaserStep.set(key, []);
    byStudentLaserStep.get(key).push(e);
  }
  const byAttempt = new Map(); // attemptIndex (1-based) -> [scores]
  for (const list of byStudentLaserStep.values()) {
    list.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    list.forEach((e, i) => {
      const idx = i + 1;
      if (!byAttempt.has(idx)) byAttempt.set(idx, []);
      byAttempt.get(idx).push(e.pts / 10);
    });
  }
  const learningCurve = [...byAttempt.entries()]
    .sort(([a], [b]) => a - b)
    .map(([attempt, scores]) => ({ attempt, n: scores.length, mean: mean(scores) }))
    .filter((r) => r.n >= minN);

  // ---- first-attempt-only weekly accuracy trend ----
  const firstSeen = new Set();
  const firstAttempts = [];
  const chronological = [...steps].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  for (const e of chronological) {
    const k = `${e.u}|${e.laser}|${e.step}`;
    if (firstSeen.has(k)) continue;
    firstSeen.add(k);
    firstAttempts.push(e);
  }
  const firstByWeek = new Map();
  for (const e of firstAttempts) {
    const wk = isoWeekOf(e.ts);
    if (!firstByWeek.has(wk)) firstByWeek.set(wk, []);
    firstByWeek.get(wk).push(e.pts / 10);
  }
  const firstAttemptWeeklyTrend = [...firstByWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([wk, scores]) => ({ week: wk, n: scores.length, mean: mean(scores) }));

  return { minN, usage, weeklyActive, laserStepAccuracy, learningCurve, firstAttemptWeeklyTrend };
}

// ---------- Telegram-friendly formatting ----------

function formatTelegram(r) {
  const u = r.usage;
  const lines = [];
  lines.push('🔬 <b>Laser quiz stats</b>');
  lines.push('');
  lines.push(`Unique students: ${u.uniqueStudents}`);
  lines.push(`Rounds played: ${u.totalRounds}`);
  lines.push(`Total mastery XP gained (all-time): ${u.totalXp}`);
  lines.push(`Questions answered: ${u.totalQuestionsAnswered}`);

  if (u.lasersPlayed.length) {
    lines.push('');
    lines.push('Rounds by laser:');
    for (const [laser, n] of u.lasersPlayed) lines.push(`  ${laser}: ${n}`);
  }

  if (r.weeklyActive.length) {
    lines.push('');
    lines.push('Weekly active students:');
    for (const w of r.weeklyActive) lines.push(`  ${w.week}: ${w.students}`);
  }

  if (r.laserStepAccuracy.length) {
    lines.push('');
    lines.push(`Hardest laser/step questions (n≥${r.minN}):`);
    for (const row of r.laserStepAccuracy.slice(0, 8)) {
      lines.push(`  ${row.laser} · ${row.step}: ${pct(row.mean)} (n=${row.n})`);
    }
  }

  if (r.learningCurve.length > 1) {
    lines.push('');
    lines.push('Accuracy by repeat exposure (learning signal):');
    for (const row of r.learningCurve) {
      lines.push(`  attempt ${row.attempt}: ${pct(row.mean)} (n=${row.n})`);
    }
  }

  if (r.firstAttemptWeeklyTrend.length) {
    lines.push('');
    lines.push('First-attempt accuracy by week:');
    for (const row of r.firstAttemptWeeklyTrend) {
      lines.push(`  ${row.week}: ${pct(row.mean)} (n=${row.n})`);
    }
  }

  return lines.join('\n');
}

// ---------- CLI ----------

function main(argv) {
  const asJson = argv.includes('--json');
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('Usage: node laserStats_fys501.js <laser_quiz_log.jsonl | railway-logs.txt> [more files...] [--json]');
    process.exit(1);
  }
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const events = parseEvents(text);
  const report = analyse(events);
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(formatTelegram(report).replace(/<\/?b>/g, ''));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseEvents, analyse, formatTelegram, isoWeekOf };
