'use strict';
/**
 * quizAnalytics_fys501.js
 * -----------------------
 * Records ONE pseudonymous event per graded quiz answer, so the instructor can see which
 * sections, concepts and misconceptions students struggle with (see QUIZ_ANALYTICS_fys501.md).
 *
 * Design rules (same spirit as the rest of the bot):
 *  - Never breaks a quiz: every public function swallows its own errors.
 *  - Deterministic: no LLM involved anywhere in logging or analysis.
 *  - Privacy by construction: the student is a keyed hash (HMAC) of the Telegram id, never the
 *    id itself; no names, usernames, message text or time of day are stored; students can
 *    /optout (which also deletes their stored events).
 *  - OFF unless ANALYTICS_HASH_SECRET is set (>= 16 chars), so the bot can never log with a
 *    missing or guessable secret.
 *
 * Railway variables:
 *   ANALYTICS_HASH_SECRET   secret for the HMAC pseudonym. REQUIRED to enable logging.
 *                           Keep it private; destroying it makes stored events unlinkable.
 *   QUIZ_ANALYTICS_DIR      directory on a Railway volume (e.g. /data). Events are appended to
 *                           quiz_events.jsonl there and the opt-out list to quiz_optout.json.
 *                           Without it, events exist only as QUIZ_EVENT lines in the log
 *                           (recover with: node quizStats_fys501.js railway-logs.txt).
 *
 * Event (one JSON object per line):
 *   { v:1, d:"2026-09-21", pid:"a1b2c3d4e5f6", kind:"single"|"multi",
 *     qid:"q3.5_004", qv:1, sec:"3.5", concepts:["res.stability"], live:0|1,
 *     pick:[storedOptionIdx...], score:0..1, wrong:[idx...], wrongTags:["M-STAB-02"|null...],
 *     missed:[idx...], stale?:1 }
 * Option indices are those of the STORED bank question (single-select serves shuffled options;
 * the answer is mapped back by option text). Live-generated questions (gen_/mvgen_ ids) are
 * logged with live:1 and no tags; the analysis excludes them by default.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SINGLE_BANK_PATH = path.join(__dirname, 'quizBank_fys501.json');
const MULTI_BANK_PATH = path.join(__dirname, 'multivalueQuizBank_fys501.json');
const EVENTS_FILE = 'quiz_events.jsonl';
const OPTOUT_FILE = 'quiz_optout.json';
const MIN_SECRET_LEN = 16;

// ---------- config ----------
function cfg() {
  return {
    secret: process.env.ANALYTICS_HASH_SECRET || '',
    dir: process.env.QUIZ_ANALYTICS_DIR || '',
  };
}

function isEnabled() {
  return cfg().secret.length >= MIN_SECRET_LEN;
}

function persistentDir() {
  return cfg().dir || null;
}

function eventsPath() {
  const d = cfg().dir;
  return d ? path.join(d, EVENTS_FILE) : null;
}

function optoutPath() {
  const d = cfg().dir;
  return d ? path.join(d, OPTOUT_FILE) : null;
}

let warnedWeak = false;
/** Human-readable state for /healthz and startup logs. */
function status() {
  const c = cfg();
  const enabled = isEnabled();
  if (c.secret && !enabled && !warnedWeak) {
    warnedWeak = true;
    console.warn(`quizAnalytics: ANALYTICS_HASH_SECRET is shorter than ${MIN_SECRET_LEN} characters - analytics stays OFF`);
  }
  let bytes = null;
  const p = eventsPath();
  if (p) {
    try { bytes = fs.statSync(p).size; } catch (e) { bytes = 0; }
  }
  return { enabled, persistentDir: !!c.dir, eventsFileBytes: bytes };
}

// ---------- pseudonym + date ----------
function pidOf(userId) {
  return crypto.createHmac('sha256', cfg().secret).update(String(userId)).digest('hex').slice(0, 12);
}

function dayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.LIMIT_TIMEZONE || 'Europe/Helsinki',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function writeJsonAtomic(p, data) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// ---------- opt-out list (persisted next to the events when a directory is configured) ----------
let _optout = null;
function loadOptout() {
  if (_optout) return _optout;
  _optout = new Set();
  const p = optoutPath();
  if (p) {
    try {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(arr)) arr.forEach((x) => _optout.add(String(x)));
    } catch (e) { /* missing file = nobody opted out yet */ }
  }
  return _optout;
}

function saveOptout() {
  const p = optoutPath();
  if (!p) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeJsonAtomic(p, [...loadOptout()]);
}

// ---------- bank index: question id -> { sec, q } (own read-only view of both banks) ----------
let _bankIdx = null;
function bankIndex() {
  if (_bankIdx) return _bankIdx;
  _bankIdx = new Map();
  for (const p of [SINGLE_BANK_PATH, MULTI_BANK_PATH]) {
    try {
      const bank = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const ch of Object.keys(bank)) {
        for (const sec of Object.keys(bank[ch] || {})) {
          for (const q of bank[ch][sec] || []) if (q && q.id) _bankIdx.set(q.id, { sec, q });
        }
      }
    } catch (e) { /* a missing bank simply means every question is treated as live */ }
  }
  return _bankIdx;
}

/** Test helper: forget the cached bank index. */
function resetCaches() {
  _bankIdx = null;
  _optout = null;
  _noticed.clear();
}

function sectionFromLiveId(id) {
  const m = String(id).match(/^(?:mv)?gen_(\d+)(?:\.(\d+))?_/);
  return m && m[2] ? `${m[1]}.${m[2]}` : null;
}

function resolve(question) {
  const hit = bankIndex().get(question.id);
  if (!hit) return { live: true, sec: sectionFromLiveId(question.id), qv: null, concepts: [], stored: null };
  const s = hit.q;
  return {
    live: false,
    sec: hit.sec,
    qv: Number.isInteger(s.version) ? s.version : 1,
    concepts: Array.isArray(s.concepts) ? s.concepts.slice() : [],
    stored: s,
  };
}

/** Maps an option index of the SERVED question to the STORED one (by text). -1 if it cannot be found. */
function storedIndex(info, question, servedIdx) {
  if (!info.stored) return servedIdx;
  return info.stored.options.indexOf(question.options[servedIdx]);
}

function tagAt(info, storedIdx) {
  const t = info.stored && Array.isArray(info.stored.optionTags) ? info.stored.optionTags[storedIdx] : null;
  return typeof t === 'string' && t ? t : null;
}

// ---------- writing ----------
function record(ev) {
  const line = JSON.stringify(ev);
  console.log(`QUIZ_EVENT ${line}`); // durable even without a volume (see header)
  const p = eventsPath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, line + '\n', 'utf8');
  } catch (e) {
    console.warn(`quizAnalytics: could not append to ${p} (${e.message}) - relying on log lines`);
  }
}

function prepare(userId) {
  if (!isEnabled() || userId === undefined || userId === null) return null;
  const pid = pidOf(userId);
  if (loadOptout().has(pid)) return null;
  return pid;
}

/**
 * Single-select answer. `question` is the SERVED question (options possibly shuffled);
 * `servedPick` the tapped index in that served order.
 */
function logSingle(userId, question, servedPick) {
  try {
    const pid = prepare(userId);
    if (!pid) return null;
    const info = resolve(question);
    const ok = servedPick === question.correctIndex;
    const sp = storedIndex(info, question, servedPick);
    const stale = sp < 0;
    const pick = stale ? servedPick : sp;
    const wrong = ok ? [] : [pick];
    const ev = {
      v: 1, d: dayKey(), pid, kind: 'single', qid: question.id, qv: info.qv, sec: info.sec,
      concepts: info.concepts, live: info.live ? 1 : 0,
      pick: [pick], score: ok ? 1 : 0,
      wrong, wrongTags: wrong.map((i) => (stale ? null : tagAt(info, i))), missed: [],
    };
    if (stale) ev.stale = 1;
    record(ev);
    return ev;
  } catch (e) {
    console.warn(`quizAnalytics.logSingle failed: ${e.message}`);
    return null;
  }
}

/** Multi-select answer, called at Submit. `selected` is a Set/array of option indices. */
function logMulti(userId, question, selected, score) {
  try {
    const pid = prepare(userId);
    if (!pid) return null;
    const info = resolve(question);
    const sel = [...selected].sort((a, b) => a - b);
    const correct = (question.correctIndices || []).slice().sort((a, b) => a - b);
    // multi-select options are never shuffled, so served index == stored index; verify anyway
    let stale = false;
    if (info.stored) {
      const so = info.stored.options;
      stale = so.length !== question.options.length || so.some((o, i) => o !== question.options[i]);
    }
    const wrong = sel.filter((i) => !correct.includes(i));
    const missed = correct.filter((i) => !sel.includes(i));
    const ev = {
      v: 1, d: dayKey(), pid, kind: 'multi', qid: question.id, qv: info.qv, sec: info.sec,
      concepts: info.concepts, live: info.live ? 1 : 0,
      pick: sel, score: Math.round(score * 1000) / 1000,
      wrong, wrongTags: wrong.map((i) => (stale ? null : tagAt(info, i))), missed,
    };
    if (stale) ev.stale = 1;
    record(ev);
    return ev;
  } catch (e) {
    console.warn(`quizAnalytics.logMulti failed: ${e.message}`);
    return null;
  }
}

// ---------- student-facing notice, privacy text, opt-out ----------
const _noticed = new Set();

// When the stored answers are deleted. Default wording fits any course; set the Railway variable
// QUIZ_ANALYTICS_RETENTION to a concrete phrase, e.g. "on 31 May 2027", to name a date.
function retentionText() {
  return (process.env.QUIZ_ANALYTICS_RETENTION || '').trim() || 'after the course ends';
}

function noticeText() {
  return 'Data collection notice: to find out which topics need more discussion in class, this bot ' +
    'records your quiz answers under a scrambled ID (pseudonymised: no name, username or message text). ' +
    `The data is used only for developing the course, has no effect on grades, and is deleted ${retentionText()}. ` +
    '/privacy for details, /optout to stop and delete your data now.';
}

/** Returns the one-time notice text for this user (once per bot process), or null. */
function noticeFor(userId) {
  try {
    if (!prepare(userId)) return null;
    const key = String(userId);
    if (_noticed.has(key)) return null;
    _noticed.add(key);
    return noticeText();
  } catch (e) {
    return null;
  }
}

function privacyText() {
  if (!isEnabled()) {
    return 'Quiz analytics are switched off: this bot is not recording your quiz answers.';
  }
  return [
    'Data collection notice: quiz answers',
    '',
    'Purpose: the instructor looks at combined results (never individuals) to see which concepts and common wrong answers to discuss in class. The data is used only for developing this course and has no effect on grades. Results for fewer than a handful of students are never shown.',
    '',
    'What is recorded for each quiz answer: a scrambled ID (pseudonymisation: a keyed hash of your Telegram id, not the id itself), the question, which option(s) you chose, whether it was right, and the date. Nothing else - no name, username, message text or time of day.',
    '',
    `Deletion: all of this data is deleted ${retentionText()}.`,
    '',
    'Your choice: /optout stops the recording and deletes the answers already stored for you right away. /optin turns it back on.',
  ].join('\n');
}

/** Removes every stored event of one pseudonym. Returns the number of removed events. */
function purgePid(pid) {
  const p = eventsPath();
  if (!p) return 0;
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return 0; }
  const keep = [];
  let removed = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let drop = false;
    try { drop = JSON.parse(line).pid === pid; } catch (e) { drop = false; }
    if (drop) removed++; else keep.push(line);
  }
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
  fs.renameSync(tmp, p);
  return removed;
}

/** /optout. Works even if analytics are currently off (nothing to do then). */
function optOut(userId) {
  try {
    if (!isEnabled()) return { ok: true, enabled: false, purged: 0, persistent: false };
    const pid = pidOf(userId);
    loadOptout().add(pid);
    saveOptout();
    const purged = purgePid(pid);
    return { ok: true, enabled: true, purged, persistent: !!persistentDir() };
  } catch (e) {
    console.warn(`quizAnalytics.optOut failed: ${e.message}`);
    return { ok: false };
  }
}

function optIn(userId) {
  try {
    if (!isEnabled()) return { ok: true, enabled: false };
    loadOptout().delete(pidOf(userId));
    saveOptout();
    return { ok: true, enabled: true };
  } catch (e) {
    console.warn(`quizAnalytics.optIn failed: ${e.message}`);
    return { ok: false };
  }
}

// ---------- admin helpers ----------
function readEventsText() {
  const p = eventsPath();
  if (!p) return '';
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

/** Empties the events file (admin /quizstats clear). Returns how many events were removed. */
function clearEvents() {
  const p = eventsPath();
  if (!p) return 0;
  const n = readEventsText().split('\n').filter((l) => l.trim()).length;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '', 'utf8');
  return n;
}

module.exports = {
  isEnabled, status, persistentDir, eventsPath,
  logSingle, logMulti,
  noticeFor, privacyText, optOut, optIn,
  readEventsText, clearEvents, purgePid,
  bankIndex, resetCaches, pidOf,
  noticeText, retentionText,
};
