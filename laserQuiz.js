'use strict';
/**
 * Laser types quiz (/lasers) for the FYS.501 Telegram bot.
 *
 * - Zero LLM calls: questions come from laser_types.json, grading is done in code.
 * - Button-only UI (inline keyboards); one message is edited in place per laser.
 * - Optional weekly XP, goal, hidden level ladder and anonymous leaderboard, all env-controlled.
 *
 * Env vars (all optional):
 *   WEEKLY_XP_ENABLED          collect weekly XP (needs QUIZ_SALT)              default off
 *   LEADERBOARD_VISIBLE        show weekly top 10 (needs WEEKLY_XP_ENABLED)     default off
 *   WEEKLY_XP_TARGET           weekly XP goal                                   default 300
 *   LASER_QUIZ_DAILY_XP_CAP    max XP counted per day, 0 = no cap               default 300
 *   QUIZ_SALT                  secret for hashing Telegram IDs (keep stable!)
 *   QUIZ_DATA_DIR              persistent dir (Railway volume)                  default ./data
 *   QUIZ_TZ                    time zone for day/week boundaries                default Europe/Helsinki
 *   LASER_QUIZ_SESSION_TTL_MIN session timeout in minutes                       default 30
 *   LASER_QUIZ_LOG             append anonymized answer log (jsonl)             default on
 *   LASER_QUIZ_REQUIRE_REVIEW  only use lasers with "reviewed": true           default off
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
    target: intEnv(env.WEEKLY_XP_TARGET, 300) || 300,
    dailyCap: intEnv(env.LASER_QUIZ_DAILY_XP_CAP, 300),
    tz: env.QUIZ_TZ || 'Europe/Helsinki',
    salt: env.QUIZ_SALT || '',
    dataDir: env.QUIZ_DATA_DIR || path.join(__dirname, 'data'),
    ttlMs: (intEnv(env.LASER_QUIZ_SESSION_TTL_MIN, 30) || 30) * 60000,
    log: env.LASER_QUIZ_LOG === undefined ? true : truthy(env.LASER_QUIZ_LOG),
    requireReview: truthy(env.LASER_QUIZ_REQUIRE_REVIEW),
    warnings: [],
  };
  if (c.weeklyXp && !c.salt) {
    c.warnings.push('WEEKLY_XP_ENABLED is on but QUIZ_SALT is missing: weekly XP disabled.');
    c.weeklyXp = false;
  }
  if (c.leaderboard && !c.weeklyXp) {
    c.warnings.push('LEADERBOARD_VISIBLE needs WEEKLY_XP_ENABLED: leaderboard hidden.');
    c.leaderboard = false;
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
  const period = () => { const day = localDay(cfg.tz); return { day, week: isoWeekOf(day) }; };
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

  function touchUser(key) {
    const { day, week } = period();
    let u = store.data.users[key];
    if (!u) {
      u = { alias: pickAlias(key), week, xp: 0, day, dayXp: 0 };
      store.data.users[key] = u;
      store.dirty = true;
    }
    if (u.week !== week) { u.week = week; u.xp = 0; store.dirty = true; }
    if (u.day !== day) { u.day = day; u.dayXp = 0; store.dirty = true; }
    return u;
  }

  function award(key, xp) {
    const u = touchUser(key);
    const room = cfg.dailyCap > 0 ? Math.max(0, cfg.dailyCap - u.dayXp) : Infinity;
    const applied = Math.min(xp, room);
    u.xp += applied;
    u.dayXp += applied;
    store.dirty = true;
    return { applied, capped: applied < xp };
  }

  function board(key) {
    const { week } = period();
    const rows = Object.entries(store.data.users)
      .filter(([, u]) => u.week === week && u.xp > 0)
      .map(([k, u]) => ({ k, alias: u.alias, xp: u.xp }))
      .sort((a, b) => b.xp - a.xp || a.alias.localeCompare(b.alias));
    return { rows, top: rows.slice(0, 10), mi: rows.findIndex((r) => r.k === key) };
  }

  function logEvent(s, stepId, g) {
    if (!wantLog || !s.key) return;
    const rec = { ts: new Date().toISOString(), u: s.key, kind: 'step', laser: s.laser.id, step: stepId, pts: g.pts, perfect: g.perfect };
    fs.appendFile(logFile, JSON.stringify(rec) + '\n', (e) => { if (e) logErr(e); });
  }

  // One event per completed laser (all steps answered), distinct from the
  // per-step events above. Needed to count "rounds played" and total applied
  // XP cleanly — laser_xp.json's xp field resets every ISO week (it's for
  // leveling, not lifetime totals), so it can't answer "how much XP has been
  // earned in total" on its own. See laserStats_fys501.js / /laserstats.
  function logRound(s) {
    if (!wantLog || !s.key) return;
    const pts = s.pts.reduce((a, b) => a + b, 0);
    const rec = {
      ts: new Date().toISOString(), u: s.key, kind: 'round', laser: s.laser.id,
      steps: s.steps.length, pts, max: s.steps.length * 10, perfect: s.pts.filter((p) => p === 10).length, xp: s.xpQuiz,
    };
    fs.appendFile(logFile, JSON.stringify(rec) + '\n', (e) => { if (e) logErr(e); });
  }

  const weeklyOn = (s) => !!(store && s.key);
  const weekly = (s) => touchUser(s.key).xp;

  // ----- rendering -----

  function boardText(key) {
    const { rows, top, mi } = board(key);
    if (!rows.length) return '🏆 <b>Weekly top 10</b>\nNo scores yet. Be the first!\n';
    const fmt = (i, r) => `${String(i + 1).padStart(2)}. ${trunc(r.alias, 21).padEnd(21)} ${String(r.xp).padStart(4)}${r.k === key ? ' ←' : ''}`;
    const lines = top.map((r, i) => fmt(i, r));
    if (mi >= 10) { lines.push('   …'); lines.push(fmt(mi, rows[mi])); }
    return `🏆 <b>Weekly top 10</b>\n<pre>${esc(lines.join('\n'))}</pre>\nAnonymous names · resets every Monday\n`;
  }

  function introText(s) {
    let t = `🔬 <b>Laser types quiz</b>\n`;
    if (weeklyOn(s)) t += `Weekly XP: ${weekly(s)} / ${cfg.target}\n`;
    t += `\nConsider lasers with <b>${esc(s.laser.gain)}</b> as gain.\n\n${s.steps.length} questions.`;
    return t;
  }

  function questionText(s) {
    const st = s.steps[s.si];
    let t = `🔬 <b>${esc(s.laser.name)}</b> · question ${s.si + 1}/${s.steps.length}`;
    if (weeklyOn(s)) t += ` · weekly XP ${weekly(s)}/${cfg.target}`;
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
      if (r.capped) t += `\n⏳ Daily XP cap reached: more XP counts again tomorrow.`;
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
    let t = `🏁 <b>${esc(s.laser.name)} complete</b>\n${sum}/${max} points · +${s.xpQuiz} XP this quiz\n`;
    if (!weeklyOn(s)) return t + `${s.sessionXp} XP this session\n`;
    const wk = weekly(s);
    const tgt = cfg.target;
    const hit = wk >= tgt;
    const was = s.xp0 >= tgt;
    const li = levelIndex(wk);
    const lb = levelIndex(s.xp0);
    const L = LEVELS[li];
    const nextMin = li > 0 ? LEVELS[li - 1].min : null;
    t += `\n<b>Weekly XP: ${wk}</b>\n`;
    if (!hit) {
      // Before the weekly goal: bar tracks progress toward it, as before.
      t += `${bar(wk, tgt)} ${wk}/${tgt}\n`;
    } else if (nextMin) {
      // Past the weekly goal: instead of sitting maxed-out at tgt/tgt (which
      // reads as "you're done"), keep the bar moving toward the next hidden
      // level, matching the "Next level: ??? · N XP to go" line below. This
      // is what keeps a full climb to the top of the ladder (Maiman/Schawlow)
      // feel like visible progress rather than a wall at the weekly goal.
      t += `${bar(wk - L.min, nextMin - L.min)}\n`;
    } else {
      t += `${bar(1, 1)}\n`; // top of the ladder — nothing further to show progress toward
    }
    if (hit && !was) t += '🎯 Weekly goal reached! Keep going — every extra XP still climbs the ladder.\n';
    else if (hit) t += '🎯 Weekly goal reached. Extra XP still raises your level.\n';
    else {
      const gap = tgt - wk;
      const rd = s.xpQuiz > 0 ? Math.ceil(gap / s.xpQuiz) : 0;
      t += `${gap} XP to your weekly goal` + (rd ? ` (about ${rd} more round${rd > 1 ? 's' : ''} at this pace)` : '') + '\n';
    }
    t += `\nYour weekly XP puts you at <b>${esc(L.name)}</b> level. ${esc(L.name)} ${esc(L.blurb)}.\n`;
    if (li < lb) t += '🎉 New level unlocked!\n';
    t += nextMin ? `Next level: ??? · ${nextMin - wk} XP to go\n` : 'You reached the top level this week.\n';
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
    s.xp0 = weeklyOn(s) ? weekly(s) : 0;
  }

  async function startSession(uid, chatId) {
    const s = {
      uid, chatId, key: cfg.salt ? userKey(uid) : null, msgId: null, bag: [], laser: null, steps: [],
      si: -1, sel: [], answered: false, lastResult: null, xpQuiz: 0, xp0: 0, pts: [], streak: 0, sessionXp: 0, roundLogged: false, last: Date.now(),
    };
    sessions.set(uid, s);
    nextLaser(s);
    await present(s, false);
  }

  function gradeCurrent(s) {
    const st = s.steps[s.si];
    const g = grade(st, s.sel);
    let bonus = 0;
    if (g.perfect) { s.streak++; if (s.streak >= 3) bonus = 5; } else { s.streak = 0; }
    const raw = g.pts + bonus;
    let applied = raw;
    let capped = false;
    if (weeklyOn(s)) { const a = award(s.key, raw); applied = a.applied; capped = a.capped; }
    s.xpQuiz += applied;
    s.sessionXp += applied;
    s.pts.push(g.pts);
    s.answered = true;
    s.lastResult = { ...g, bonus, applied, capped };
    logEvent(s, st.id, g);
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
        logRound(s);
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
      sessions, userKey, touchUser, award, board,
      idle: () => Promise.all([...queues.values()]),
    },
  };
}

module.exports = { createLaserQuiz, _test: { grade, buildSteps, isoWeekOf, readConfig, validateData, shuffle, levelIndex } };
