'use strict';
/**
 * Laser types quiz (/lasers) for the FYS.501 Telegram bot.
 *
 * - Zero LLM calls: questions come from laser_types.json, grading is done in code.
 * - Button-only UI (inline keyboards); one message is edited in place per laser.
 * - Optional permanent mastery scoring (per-laser personal best, summed across all lasers)
 *   plus a hidden level ladder and an all-time anonymous leaderboard, all env-controlled.
 *
 * Mastery model: for each laser, only your BEST-ever round score counts, never the sum of
 * every attempt. Total mastery = sum of your best score per laser, across every laser you've
 * played. There is no weekly reset. This means reaching the top of the level ladder genuinely
 * requires close to 100% on every laser at least once — replaying a laser you've already
 * aced doesn't add anything, only improving on a laser you did worse on does. The streak
 * bonus (below) counts toward a round's mastery-candidate score, same as everything else in
 * that round — its default is kept deliberately small (LASER_QUIZ_STREAK_BONUS=3) precisely
 * so that a hot streak carried over from an earlier laser in the same session only nudges a
 * laser's banked best a little, rather than meaningfully distorting it.
 *
 * Env vars (all optional):
 *   WEEKLY_XP_ENABLED          collect mastery scores (needs QUIZ_SALT)         default off
 *   LEADERBOARD_VISIBLE        show the all-time top 10 (needs WEEKLY_XP_ENABLED) default off
 *   LASER_QUIZ_MAX_XP          ceiling on TOTAL mastery, 0 = uncapped               default 1000
 *   LASER_QUIZ_DAILY_XP_CAP    max mastery XP a student can GAIN per day, 0 = no cap  default 300
 *   LASER_QUIZ_POINTS_PER_QUESTION  XP for a fully-correct answer (before streak bonus)  default 6
 *   LASER_QUIZ_STREAK_MIN      perfect answers in a row before the streak bonus kicks in  default 3
 *   LASER_QUIZ_STREAK_BONUS    bonus XP per perfect answer once streak >= STREAK_MIN, counts
 *                              toward mastery (kept small by default, see model above)  default 3
 *   QUIZ_SALT                  secret for hashing Telegram IDs (keep stable!)
 *   QUIZ_DATA_DIR              persistent dir (Railway volume)                  default ./data
 *   QUIZ_TZ                    time zone for day boundaries (daily mastery-gain cap)  default Europe/Helsinki
 *   LASER_QUIZ_SESSION_TTL_MIN session timeout in minutes                       default 30
 *   LASER_QUIZ_LOG             append anonymized answer log (jsonl)             default on
 *   LASER_QUIZ_REQUIRE_REVIEW  only use lasers with "reviewed": true           default off
 *
 * Env var names kept as WEEKLY_XP_ENABLED / LEADERBOARD_VISIBLE for backward compatibility
 * with existing Railway config, even though the "weekly" framing they originally described
 * no longer applies — see the mastery model above.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LEVELS, ALIASES } = require('./laser_quiz_names');
const DATA = require('./laser_types.json');

const LETTERS = 'ABCDEFGH';
const ROMAN = ['', '', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const STEP_TITLES = {
  pump: 'Pumping mechanism',
  level: 'Level scheme',
  lifetime: 'Upper-state lifetime',
  pumpWavelength: 'Pump wavelength',
  lasing: 'Lasing wavelength',
  transition: 'Atomic transition',
  modes: 'Operating regimes',
  power: 'Power levels',
  apps: 'Applications',
};

// ---------- small helpers ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
const intEnv = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const bar = (v, max, w = 10) => {
  const f = Math.max(0, Math.min(w, Math.round((v / Math.max(1, max)) * w)));
  return '█'.repeat(f) + '░'.repeat(w - f);
};

function shuffle(a, rng = Math.random) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// ---------- config ----------

function readConfig(env = process.env) {
  const c = {
    weeklyXp: truthy(env.WEEKLY_XP_ENABLED),
    leaderboard: truthy(env.LEADERBOARD_VISIBLE),
    dailyCap: intEnv(env.LASER_QUIZ_DAILY_XP_CAP, 300),
    // Ceiling on the TOTAL mastery sum (not individual per-laser bests), 0 = uncapped, same
    // convention as dailyCap above. Default 1000 matches the top level's threshold in
    // laser_quiz_names.js -- see the warning below if you change one without the other.
    maxXp: intEnv(env.LASER_QUIZ_MAX_XP, 1000),
    // Default 6, not the raw grade()'s 0-10 scale: a full single-sitting 100% cycle through
    // all current lasers (112 questions as of the 13-laser set) reaches 1002 XP including
    // the streak bonus, which maxXp above then rounds down to the configured ceiling (1000
    // by default). Because of that cap, exact calibration here matters less than it used to
    // -- this just needs to keep the true achievable total AT OR ABOVE maxXp, or a 100%
    // player could never actually reach the top level (see the maxXp warning above). Recheck
    // that inequality whenever the laser count, streak settings, or maxXp change meaningfully.
    pointsPerQuestion: intEnv(env.LASER_QUIZ_POINTS_PER_QUESTION, 6) || 6,
    streakMin: intEnv(env.LASER_QUIZ_STREAK_MIN, 3),
    streakBonus: intEnv(env.LASER_QUIZ_STREAK_BONUS, 3),
    tz: env.QUIZ_TZ || 'Europe/Helsinki',
    salt: env.QUIZ_SALT || '',
    dataDir: env.QUIZ_DATA_DIR || path.join(__dirname, 'data'),
    ttlMs: (intEnv(env.LASER_QUIZ_SESSION_TTL_MIN, 30) || 30) * 60000,
    log: env.LASER_QUIZ_LOG === undefined ? true : truthy(env.LASER_QUIZ_LOG),
    requireReview: truthy(env.LASER_QUIZ_REQUIRE_REVIEW),
    warnings: [],
  };
  if (c.weeklyXp && !c.salt) {
    c.warnings.push('WEEKLY_XP_ENABLED is on but QUIZ_SALT is missing: mastery tracking disabled.');
    c.weeklyXp = false;
  }
  if (c.leaderboard && !c.weeklyXp) {
    c.warnings.push('LEADERBOARD_VISIBLE needs WEEKLY_XP_ENABLED: leaderboard hidden.');
    c.leaderboard = false;
  }
  if (c.maxXp > 0 && c.maxXp < LEVELS[0].min) {
    c.warnings.push(`LASER_QUIZ_MAX_XP (${c.maxXp}) is below the top level's threshold (${LEVELS[0].min}) in laser_quiz_names.js: the top level(s) can never be reached. Raise LASER_QUIZ_MAX_XP, lower the top level's "min", or set LASER_QUIZ_MAX_XP=0 to remove the cap.`);
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: c.tz });
  } catch (e) {
    c.warnings.push(`Unknown QUIZ_TZ "${c.tz}": using UTC.`);
    c.tz = 'UTC';
  }
  return c;
}

// ---------- time ----------

function localDay(tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function isoWeekOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dow);
  const y0 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt - y0) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

// ---------- data validation (quality gate at startup) ----------

function validateData(d) {
  const err = [];
  if (!Array.isArray(d.lasers) || d.lasers.length < 4) err.push('need at least 4 lasers (transition distractors come from other lasers)');
  const ids = new Set();
  for (const l of d.lasers || []) {
    const w = `laser ${l.id || '?'}`;
    if (!l.id || ids.has(l.id)) err.push(`${w}: missing or duplicate id`);
    ids.add(l.id);
    if (!l.name || !l.gain || !l.transition) err.push(`${w}: name, gain and transition are required`);
    const keys = [...((l.pump && l.pump.ok) || []), ...((l.pump && l.pump.no) || [])];
    keys.forEach((k) => { if (!d.pumpTypes[k]) err.push(`${w}: unknown pump key ${k}`); });
    if (!(l.pump && l.pump.ok && l.pump.ok.length)) err.push(`${w}: pump.ok is empty`);
    // level is nullable: some gain media (e.g. semiconductor diodes) don't map onto a
    // discrete-atomic-level scheme at all, so the "level scheme" step is skipped for them.
    if (l.level !== null && l.level !== undefined) {
      if (!(Number.isInteger(l.level) && l.level >= 0 && l.level < d.levelSchemes.length)) err.push(`${w}: bad level index`);
    }
    const singles = [['lasing', l.lasing], ['power', l.power]];
    if (l.pumpWavelength) singles.push(['pumpWavelength', l.pumpWavelength]);
    singles.forEach(([n, v]) => {
      if (!v || !v.ok || !Array.isArray(v.no) || v.no.length < 2) err.push(`${w}: ${n} needs "ok" and at least 2 distractors`);
    });
    if (!(l.modes || []).some((m) => m.ok) || !(l.modes || []).some((m) => !m.ok)) err.push(`${w}: modes need at least one right and one wrong option`);
    if (!(l.apps && l.apps.ok && l.apps.ok.length) || !(l.apps && l.apps.no && l.apps.no.length)) err.push(`${w}: apps need ok and no lists`);
    if (l.lifetime) {
      if (!Array.isArray(d.lifetimeBuckets) || !d.lifetimeBuckets.includes(l.lifetime.bucket)) err.push(`${w}: lifetime.bucket not in lifetimeBuckets`);
    }
    (l.extraQuestions || []).forEach((eq, i) => {
      const ew = `${w}: extraQuestions[${i}]`;
      if (!eq.id) err.push(`${ew}: missing id`);
      if (!eq.q) err.push(`${ew}: missing question text`);
      if (!eq.note) err.push(`${ew}: missing note`);
      if (!Array.isArray(eq.options) || eq.options.length < 2 || eq.options.length > 6) err.push(`${ew}: needs 2-6 options`);
      else {
        if (!eq.options.some((o) => o.ok)) err.push(`${ew}: no correct option`);
        if (!eq.options.some((o) => !o.ok)) err.push(`${ew}: no wrong option`);
        if (!eq.multi && eq.options.filter((o) => o.ok).length !== 1) err.push(`${ew}: single-choice needs exactly one correct option`);
      }
    });
    const nk = ['pump', 'lasing', 'transition', 'modes', 'power', 'apps'];
    if (l.level !== null && l.level !== undefined) nk.push('level');
    if (l.pumpWavelength) nk.push('pumpWavelength');
    if (l.lifetime) nk.push('lifetime');
    nk.forEach((k) => { if (!(l.notes && l.notes[k])) err.push(`${w}: missing note "${k}"`); });
  }
  if (err.length) throw new Error('laser_types.json invalid:\n - ' + err.join('\n - '));
}

// ---------- question engine (pure, no I/O) ----------

function buildSteps(l, all, rng = Math.random) {
  const P = DATA.pumpTypes;
  const sh = (a) => shuffle(a, rng);
  const opt = (t, ok) => ({ t, ok: !!ok });
  const one = (v) => sh([opt(v.ok, true), ...v.no.map((t) => opt(t, false))]);
  const steps = [];
  steps.push({
    id: 'pump', multi: true, q: 'How is this laser pumped? Select all that apply.',
    options: sh([...l.pump.ok.map((k) => opt(P[k], true)), ...l.pump.no.map((k) => opt(P[k], false))]),
    note: l.notes.pump,
  });
  if (l.level !== null && l.level !== undefined) {
    steps.push({
      id: 'level', multi: false, q: 'Which level scheme describes the main lasing transition?',
      options: DATA.levelSchemes.map((t, i) => opt(t, i === l.level)),
      note: l.notes.level,
    });
  }
  if (l.lifetime) {
    const wrongBuckets = sh(DATA.lifetimeBuckets.filter((b) => b !== l.lifetime.bucket)).slice(0, 3);
    steps.push({
      id: 'lifetime', multi: false, q: 'What is the approximate upper-state (metastable) lifetime of the gain medium?',
      options: sh([opt(l.lifetime.bucket, true), ...wrongBuckets.map((b) => opt(b, false))]),
      note: l.notes.lifetime,
    });
  }
  // Freeform slot for a laser-specific nuance that doesn't fit the standard fields above
  // (e.g. Er:YAG's self-terminating transition). Each entry supplies its own title/question/
  // options/note, so no changes to STEP_TITLES or validateData's field list are needed to add one.
  if (Array.isArray(l.extraQuestions)) {
    l.extraQuestions.forEach((eq) => {
      steps.push({
        id: eq.id, multi: !!eq.multi, q: eq.q, title: eq.title,
        options: sh(eq.options.map((o) => opt(o.t, o.ok))),
        note: eq.note,
      });
    });
  }
  if (l.pumpWavelength) {
    steps.push({ id: 'pumpWavelength', multi: false, q: 'What is the most common pump wavelength?', options: one(l.pumpWavelength), note: l.notes.pumpWavelength });
  }
  steps.push({ id: 'lasing', multi: false, q: 'What is the main lasing wavelength?', options: one(l.lasing), note: l.notes.lasing });
  const others = sh(all.filter((x) => x.id !== l.id && x.transition !== l.transition)).slice(0, 3).map((x) => opt(x.transition, false));
  steps.push({ id: 'transition', multi: false, q: 'Which transition produces the lasing?', options: sh([opt(l.transition, true), ...others]), note: l.notes.transition });
  steps.push({ id: 'modes', multi: true, q: 'Which operating regimes can be realized? Select all that apply.', options: sh(l.modes.map((m) => opt(m.t, m.ok))), note: l.notes.modes });
  steps.push({ id: 'power', multi: false, q: 'What power or energy levels are typical?', options: one(l.power), note: l.notes.power });
  steps.push({
    id: 'apps', multi: true, q: 'Which are main applications? Select all that apply.',
    options: sh([...l.apps.ok.map((t) => opt(t, true)), ...l.apps.no.map((t) => opt(t, false))]),
    note: l.notes.apps,
  });
  return steps;
}

// 10 points per step. Multi-select: each wrong pick cancels one right pick.
function grade(step, selected) {
  let k = 0, r = 0, w = 0;
  step.options.forEach((o, i) => {
    const p = selected.includes(i);
    if (o.ok) k++;
    if (p && o.ok) r++;
    if (p && !o.ok) w++;
  });
  return { pts: Math.max(0, Math.round(((r - w) / k) * 10)), perfect: r === k && w === 0, right: r, wrong: w, total: k };
}

function levelIndex(xp) {
  const i = LEVELS.findIndex((l) => xp >= l.min);
  return i < 0 ? LEVELS.length - 1 : i;
}

// ---------- persistence ----------

class XpStore {
  constructor(file) {
    this.file = file;
    this.data = { users: {} };
    this.dirty = false;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!this.data.users) this.data.users = {};
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[laserQuiz] could not read', file, e.message);
    }
    this.timer = setInterval(() => this.flush(), 5000);
    this.timer.unref();
  }
  flush() {
    if (!this.dirty) return;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      console.error('[laserQuiz] flush failed:', e.message);
    }
  }
}

// ---------- factory ----------

function createLaserQuiz(bot, opts = {}) {
  const cfg = readConfig(opts.env || process.env);
  cfg.warnings.forEach((w) => console.warn('[laserQuiz]', w));
  validateData(DATA);
  const lasers = DATA.lasers.filter((l) => !cfg.requireReview || l.reviewed);
  if (lasers.length < 4) throw new Error('[laserQuiz] fewer than 4 usable lasers (check "reviewed" flags)');
  const unreviewed = lasers.filter((l) => !l.reviewed).map((l) => l.name);
  if (unreviewed.length) console.warn('[laserQuiz] unreviewed lasers in use:', unreviewed.join(', '));

  const wantLog = cfg.log && !!cfg.salt;
  if (cfg.weeklyXp || wantLog) fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = cfg.weeklyXp ? new XpStore(path.join(cfg.dataDir, 'laser_xp.json')) : null;
  const logFile = path.join(cfg.dataDir, 'laser_quiz_log.jsonl');

  const sessions = new Map();
  const queues = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [uid, s] of sessions) if (now - s.last > cfg.ttlMs) sessions.delete(uid);
  }, 300000);
  sweeper.unref();

  const logErr = (e) => console.error('[laserQuiz]', e && e.message ? e.message : e);

  function enqueue(uid, fn) {
    const p = (queues.get(uid) || Promise.resolve()).then(fn).catch(logErr);
    queues.set(uid, p);
    p.then(() => { if (queues.get(uid) === p) queues.delete(uid); });
  }

  // ----- users, XP, aliases -----

  const userKey = (id) => crypto.createHmac('sha256', cfg.salt).update(String(id)).digest('hex').slice(0, 16);
  const today = () => localDay(cfg.tz);
  const baseName = (n) => n.replace(/ (?:[IVX]+|\d+)$/, '');
  const suffix = (k) => ROMAN[k] || String(k);

  function pickAlias(key) {
    const users = Object.values(store.data.users);
    const used = new Set(users.map((u) => u.alias));
    const cnt = { F: 0, M: 0 };
    users.forEach((u) => { cnt[ALIASES.F.includes(baseName(u.alias)) ? 'F' : 'M']++; });
    const h = parseInt(key.slice(0, 8), 16);
    const g = cnt.F < cnt.M ? 'F' : cnt.M < cnt.F ? 'M' : (h % 2 ? 'F' : 'M');
    const free = ALIASES[g].filter((n) => !used.has(n));
    if (free.length) return free[h % free.length];
    const b = ALIASES[g][h % ALIASES[g].length];
    let k = 2;
    while (used.has(`${b} ${suffix(k)}`)) k++;
    return `${b} ${suffix(k)}`;
  }

  // Per user: alias, bestByLaser (laser id -> best-ever round XP for that laser — the
  // permanent mastery record), and day/dayGain for the daily mastery-GAIN cap below.
  // No week/weekly-reset fields: mastery never resets.
  function touchUser(key) {
    const day = today();
    let u = store.data.users[key];
    if (!u) {
      u = { alias: pickAlias(key), bestByLaser: {}, day, dayGain: 0 };
      store.data.users[key] = u;
      store.dirty = true;
    }
    if (!u.bestByLaser) u.bestByLaser = {}; // defensive: pre-mastery-model records
    if (u.day !== day) { u.day = day; u.dayGain = 0; store.dirty = true; }
    return u;
  }

  // Capped at cfg.maxXp (0 = uncapped) so the displayed/level-driving total never exceeds a
  // clean, configurable ceiling even if the true achievable sum (from pointsPerQuestion,
  // streak bonus and the current laser count) lands slightly above it -- e.g. today's true
  // 100%-everything max is 1002, and this rounds that down to the configured 1000. Only the
  // TOTAL is capped; individual bestByLaser entries are stored uncapped and at full
  // precision, so this is purely a display/leveling ceiling, not a scoring change.
  const masteryOf = (u) => {
    const raw = Object.values(u.bestByLaser).reduce((a, b) => a + b, 0);
    return cfg.maxXp > 0 ? Math.min(cfg.maxXp, raw) : raw;
  };

  // Only ever updates bestByLaser[laserId] to a STRICTLY HIGHER value, and only ever does so
  // in full — never a partial/synthetic amount — so a stored "personal best" always reflects
  // an actual round the student played, never a number invented to fit under the daily cap.
  // If the improvement would exceed today's remaining room, nothing is stored this round;
  // the student can bank it by replaying the same laser again once the cap resets.
  function awardMastery(key, laserId, candidateXp) {
    const u = touchUser(key);
    const prevBest = u.bestByLaser[laserId] || 0;
    const masteryBefore = masteryOf(u);
    if (candidateXp <= prevBest) {
      return { isNewBest: false, delta: 0, capped: false, prevBest, masteryBefore, masteryAfter: masteryBefore };
    }
    const delta = candidateXp - prevBest;
    const room = cfg.dailyCap > 0 ? Math.max(0, cfg.dailyCap - u.dayGain) : Infinity;
    if (delta > room) {
      return { isNewBest: false, delta: 0, capped: true, prevBest, wouldBe: candidateXp, masteryBefore, masteryAfter: masteryBefore };
    }
    u.bestByLaser[laserId] = candidateXp;
    u.dayGain += delta;
    store.dirty = true;
    return { isNewBest: true, delta, capped: false, prevBest, masteryBefore, masteryAfter: masteryOf(u) };
  }

  function board(key) {
    const rows = Object.entries(store.data.users)
      .map(([k, u]) => ({ k, alias: u.alias, xp: masteryOf(u) }))
      .filter((r) => r.xp > 0)
      .sort((a, b) => b.xp - a.xp || a.alias.localeCompare(b.alias));
    return { rows, top: rows.slice(0, 10), mi: rows.findIndex((r) => r.k === key) };
  }

  function logEvent(s, stepId, g) {
    if (!wantLog || !s.key) return;
    const rec = { ts: new Date().toISOString(), u: s.key, kind: 'step', laser: s.laser.id, step: stepId, pts: g.pts, perfect: g.perfect };
    fs.appendFile(logFile, JSON.stringify(rec) + '\n', (e) => { if (e) logErr(e); });
  }

  // One event per completed laser (all steps answered), distinct from the per-step events
  // above. isNewBest/masteryDelta reflect the actual mastery-model outcome (see
  // awardMastery above): xp here is the round's raw candidate score, which may be HIGHER
  // than masteryDelta if it wasn't actually a new best (or was capped) — laserStats_fys501.js
  // should sum masteryDelta, not xp, for an accurate "total mastery gained" figure, since xp
  // alone would double-count replays of an already-mastered laser.
  function logRound(s, rawTotal, rawMax, masteryCandidate, roundResult) {
    if (!wantLog || !s.key) return;
    const rec = {
      ts: new Date().toISOString(), u: s.key, kind: 'round', laser: s.laser.id,
      steps: s.steps.length, pts: rawTotal, max: rawMax, perfect: s.pts.filter((p) => p === 10).length,
      xp: masteryCandidate, isNewBest: !!(roundResult && roundResult.isNewBest), masteryDelta: roundResult ? roundResult.delta : 0,
    };
    fs.appendFile(logFile, JSON.stringify(rec) + '\n', (e) => { if (e) logErr(e); });
  }

  const masteryOn = (s) => !!(store && s.key);
  const mastery = (s) => masteryOf(touchUser(s.key));

  // ----- rendering -----

  function boardText(key) {
    const { rows, top, mi } = board(key);
    if (!rows.length) return '🏆 <b>Mastery leaderboard</b>\nNo scores yet. Be the first!\n';
    const fmt = (i, r) => `${String(i + 1).padStart(2)}. ${trunc(r.alias, 21).padEnd(21)} ${String(r.xp).padStart(4)}${r.k === key ? ' ←' : ''}`;
    const lines = top.map((r, i) => fmt(i, r));
    if (mi >= 10) { lines.push('   …'); lines.push(fmt(mi, rows[mi])); }
    return `🏆 <b>Mastery leaderboard</b>\n<pre>${esc(lines.join('\n'))}</pre>\nAnonymous names · all-time, best score per laser\n`;
  }

  function introText(s) {
    let t = `🔬 <b>Laser types quiz</b>\n`;
    if (masteryOn(s)) t += `Mastery XP: ${mastery(s)}\n`;
    t += `\nConsider lasers with <b>${esc(s.laser.gain)}</b> as gain.\n\n${s.steps.length} questions.`;
    return t;
  }

  function questionText(s) {
    const st = s.steps[s.si];
    let t = `🔬 <b>${esc(s.laser.name)}</b> · question ${s.si + 1}/${s.steps.length}`;
    if (masteryOn(s)) t += ` · mastery XP ${mastery(s)}`;
    t += `\n<i>${esc(st.title || STEP_TITLES[st.id])}</i>\n\n${esc(st.q)}\n\n`;
    st.options.forEach((o, i) => {
      let mark = '';
      if (s.answered) {
        const p = s.sel.includes(i);
        mark = p && o.ok ? '✅ ' : p && !o.ok ? '❌ ' : o.ok ? '➕ ' : '▫️ ';
      } else if (st.multi && s.sel.includes(i)) {
        mark = '☑️ ';
      }
      t += `${mark}<b>${LETTERS[i]}</b>) ${esc(o.t)}\n`;
    });
    if (s.answered) {
      const r = s.lastResult;
      const head = r.perfect ? '✅ Correct' : r.pts > 0 ? '🟡 Partly right' : '❌ Not quite';
      t += `\n<b>${head}</b> · +${r.applied} XP`;
      if (r.bonus) t += ` · 🔥 streak bonus +${r.bonus}`;
      t += `\n\n💡 ${esc(st.note)}`;
    }
    return t;
  }

  function questionKb(s) {
    const st = s.steps[s.si];
    if (s.answered) {
      const last = s.si === s.steps.length - 1;
      return [[{ text: last ? '🏁 See results' : '➡️ Next question', callback_data: `lq:n:${s.si}` }]];
    }
    const btns = st.options.map((o, i) => ({
      text: (st.multi && s.sel.includes(i) ? '☑️ ' : '') + LETTERS[i],
      callback_data: `lq:t:${s.si}:${i}`,
    }));
    const rows = [];
    for (let i = 0; i < btns.length; i += 4) rows.push(btns.slice(i, i + 4));
    if (st.multi) rows.push([{ text: '✔️ Check answer', callback_data: `lq:c:${s.si}` }]);
    return rows;
  }

  function summaryText(s) {
    const sum = s.pts.reduce((a, b) => a + b, 0);
    const max = s.steps.length * 10;
    let t = `🏁 <b>${esc(s.laser.name)} complete</b>\n${sum}/${max} points\n`;
    if (!masteryOn(s)) return t + `${s.sessionXp} XP this session (mastery tracking is off)\n`;

    const r = s.roundResult || { isNewBest: false, capped: false, candidate: 0, prevBest: 0, masteryBefore: mastery(s), masteryAfter: mastery(s) };

    if (r.isNewBest) {
      t += r.prevBest > 0
        ? `\n🎉 New personal best for <b>${esc(s.laser.name)}</b>: ${r.candidate} XP (previous best: ${r.prevBest})\n`
        : `\n✨ First mastery score banked for <b>${esc(s.laser.name)}</b>: ${r.candidate} XP\n`;
    } else if (r.capped) {
      t += `\n⏳ This round scored ${r.candidate} XP — better than your current best of ${r.prevBest} for <b>${esc(s.laser.name)}</b> — but today's mastery-gain cap is reached. Play it again tomorrow to bank the improvement.\n`;
    } else {
      t += `\nYour best for <b>${esc(s.laser.name)}</b> is still ${r.prevBest} XP (this round: ${r.candidate}).\n`;
    }

    const total = r.masteryAfter;
    const li = levelIndex(total);
    const lb = levelIndex(r.masteryBefore);
    const L = LEVELS[li];
    const nextMin = li > 0 ? LEVELS[li - 1].min : null;
    t += `\n<b>Total mastery XP: ${total}</b>\n`;
    // Bar tracks progress toward the next hidden level, the same "always moving" approach
    // used before the weekly-goal concept was dropped — never sits maxed-out mid-climb.
    t += nextMin ? `${bar(total - L.min, nextMin - L.min)}\n` : `${bar(1, 1)}\n`;
    t += `Your mastery puts you at <b>${esc(L.name)}</b> level. ${esc(L.name)} ${esc(L.blurb)}.\n`;
    if (li < lb) t += '🎉 New level unlocked!\n';
    t += nextMin ? `Next level: ??? · ${nextMin - total} XP to go\n` : 'You reached the top level!\n';
    if (cfg.leaderboard) t += '\n' + boardText(s.key);
    return t;
  }

  function render(s) {
    if (s.si === -1) {
      return {
        text: introText(s),
        kb: [[{ text: `▶️ Start (${s.steps.length} questions)`, callback_data: 'lq:s' }], [{ text: '✋ Stop', callback_data: 'lq:x' }]],
      };
    }
    if (s.si >= s.steps.length) {
      return {
        text: summaryText(s),
        kb: [[{ text: '🔬 Next laser', callback_data: 'lq:l' }, { text: '✋ Stop', callback_data: 'lq:x' }]],
      };
    }
    return { text: questionText(s), kb: questionKb(s) };
  }

  async function present(s, preferEdit) {
    const { text, kb } = render(s);
    const o = { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb }, disable_web_page_preview: true };
    if (preferEdit && s.msgId) {
      try {
        await bot.editMessageText(text, { ...o, chat_id: s.chatId, message_id: s.msgId });
        return;
      } catch (e) {
        if (/not modified/i.test(String(e && e.message))) return;
      }
    }
    const m = await bot.sendMessage(s.chatId, text, o);
    s.msgId = m.message_id;
  }

  const clearKb = (chatId, msgId) => {
    if (chatId == null || msgId == null) return Promise.resolve();
    return Promise.resolve(bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId })).catch(() => {});
  };

  // ----- session flow -----

  function getSession(uid) {
    const s = sessions.get(uid);
    if (s && Date.now() - s.last > cfg.ttlMs) { sessions.delete(uid); return null; }
    return s || null;
  }

  function nextLaser(s) {
    if (!s.bag.length) s.bag = shuffle(lasers.map((_, i) => i));
    s.laser = lasers[s.bag.pop()];
    s.steps = buildSteps(s.laser, lasers);
    s.si = -1;
    s.sel = [];
    s.answered = false;
    s.lastResult = null;
    s.xpQuiz = 0;
    s.pts = [];
    s.roundLogged = false;
    s.roundResult = null;
  }

  async function startSession(uid, chatId) {
    const s = {
      uid, chatId, key: cfg.salt ? userKey(uid) : null, msgId: null, bag: [], laser: null, steps: [],
      si: -1, sel: [], answered: false, lastResult: null, xpQuiz: 0, pts: [], streak: 0, sessionXp: 0, roundLogged: false, roundResult: null, last: Date.now(),
    };
    sessions.set(uid, s);
    nextLaser(s);
    await present(s, false);
  }

  function gradeCurrent(s) {
    const st = s.steps[s.si];
    const g = grade(st, s.sel);
    // Live per-question XP, shown immediately as feedback. Accumulates into s.xpQuiz, which
    // finishRound() below uses directly as the round's mastery-candidate score once the
    // laser is complete -- so the streak bonus earned here does end up counting toward
    // mastery, not just toward the "this quiz"/"this session" display numbers.
    const xpBase = Math.max(0, Math.round((g.pts / 10) * cfg.pointsPerQuestion));
    let bonus = 0;
    if (g.perfect) { s.streak++; if (s.streak >= cfg.streakMin) bonus = cfg.streakBonus; } else { s.streak = 0; }
    const applied = xpBase + bonus;
    s.xpQuiz += applied;
    s.sessionXp += applied;
    s.pts.push(g.pts);
    s.answered = true;
    s.lastResult = { ...g, bonus, applied };
    logEvent(s, st.id, g);
  }

  // Called once, right when a laser's last question is answered and "next" is tapped.
  // masteryCandidate is s.xpQuiz -- the round's live per-question XP total, streak bonus
  // included (see gradeCurrent). Streak bonus counts toward mastery now that its default
  // value is small (LASER_QUIZ_STREAK_BONUS=3); a hot streak carried over from an earlier
  // laser in the same session can nudge a laser's banked best a little higher than a cold
  // first-ever attempt would, but at this magnitude that's an accepted, minor effect rather
  // than something worth excluding, unlike when the bonus was larger.
  function finishRound(s) {
    const rawTotal = s.pts.reduce((a, b) => a + b, 0);
    const rawMax = s.steps.length * 10;
    const masteryCandidate = Math.max(0, s.xpQuiz);
    let roundResult = null;
    if (masteryOn(s)) roundResult = { ...awardMastery(s.key, s.laser.id, masteryCandidate), candidate: masteryCandidate };
    s.roundResult = roundResult;
    logRound(s, rawTotal, rawMax, masteryCandidate, roundResult);
  }

  async function allowed(uid) {
    return opts.isAllowed ? !!(await opts.isAllowed(uid)) : true;
  }

  async function onCommand(msg) {
    const uid = msg.from.id;
    if (!(await allowed(uid))) {
      await bot.sendMessage(msg.chat.id, 'The laser quiz is available to course members only.');
      return;
    }
    await startSession(uid, msg.chat.id);
  }

  async function onCallback(q) {
    const uid = q.from.id;
    const chatId = q.message && q.message.chat.id;
    const msgId = q.message && q.message.message_id;
    const ack = (text) => Promise.resolve(bot.answerCallbackQuery(q.id, text ? { text } : {})).catch(() => {});
    if (!(await allowed(uid))) { await ack('Not available for your account.'); return; }
    const s = getSession(uid);
    if (!s) {
      await ack('Session expired. Send /lasers to start again.');
      await clearKb(chatId, msgId);
      return;
    }
    s.chatId = chatId;
    s.msgId = msgId;
    s.last = Date.now();
    const [, act, a, b] = q.data.split(':');

    if (act === 's') {
      await ack();
      if (s.si !== -1) return;
      s.si = 0;
      await present(s, true);
      return;
    }
    if (act === 'x') {
      await ack();
      sessions.delete(uid);
      await clearKb(chatId, msgId);
      await bot.sendMessage(chatId, '👋 Quiz stopped. Send /lasers to play again.');
      return;
    }
    if (act === 'l') {
      await ack();
      if (s.si < s.steps.length) return;
      await clearKb(chatId, msgId);
      nextLaser(s);
      await present(s, false);
      return;
    }

    if (Number(a) !== s.si) { await ack('That question is outdated.'); return; }
    const st = s.steps[s.si];
    if (!st) { await ack(); return; }

    if (act === 't') {
      const i = Number(b);
      if (s.answered || !(i >= 0 && i < st.options.length)) { await ack(); return; }
      if (st.multi) {
        const k = s.sel.indexOf(i);
        if (k > -1) s.sel.splice(k, 1); else s.sel.push(i);
        await ack();
        await present(s, true);
      } else {
        s.sel = [i];
        gradeCurrent(s);
        await ack();
        await present(s, true);
      }
      return;
    }
    if (act === 'c') {
      if (s.answered || !st.multi) { await ack(); return; }
      if (!s.sel.length) { await ack('Select at least one option first.'); return; }
      gradeCurrent(s);
      await ack();
      await present(s, true);
      return;
    }
    if (act === 'n') {
      await ack();
      if (!s.answered) return;
      s.si++;
      s.sel = [];
      s.answered = false;
      s.lastResult = null;
      if (s.si >= s.steps.length && !s.roundLogged) {
        s.roundLogged = true;
        finishRound(s);
      }
      await present(s, true);
      return;
    }
    await ack();
  }

  // ----- public API -----

  function handleCommand(msg) {
    if (!msg || typeof msg.text !== 'string' || !msg.from || !/^\/lasers(@\w+)?(\s|$)/i.test(msg.text)) return false;
    enqueue(msg.from.id, () => onCommand(msg));
    return true;
  }

  function handleCallback(q) {
    if (!q || typeof q.data !== 'string' || !q.data.startsWith('lq:')) return false;
    enqueue(q.from.id, () => onCallback(q));
    return true;
  }

  return {
    config: cfg,
    handleCommand,
    handleCallback,
    hasSession: (uid) => !!getSession(uid),
    shutdown: () => { if (store) store.flush(); },
    _internals: {
      sessions, userKey, touchUser, awardMastery, masteryOf, board,
      idle: () => Promise.all([...queues.values()]),
    },
  };
}

module.exports = { createLaserQuiz, _test: { grade, buildSteps, isoWeekOf, readConfig, validateData, shuffle, levelIndex } };
