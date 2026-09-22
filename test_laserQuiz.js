'use strict';
// Run with: node test_laserQuiz.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LEVELS, ALIASES } = require('./laser_quiz_names');
const { createLaserQuiz, _test } = require('./laserQuiz');
const DATA = require('./laser_types.json');

// --- names ---
assert.strictEqual(ALIASES.F.length, ALIASES.M.length, 'alias pool must be 50/50');
const all = [...ALIASES.F, ...ALIASES.M];
assert.strictEqual(new Set(all).size, all.length, 'duplicate alias');
LEVELS.forEach((l) => assert(!all.includes(l.name), `alias overlaps level: ${l.name}`));
assert.strictEqual(LEVELS[LEVELS.length - 1].min, 0);
for (let i = 1; i < LEVELS.length; i++) assert(LEVELS[i - 1].min > LEVELS[i].min, 'LEVELS must be sorted high to low');
const lf = LEVELS.filter((l) => l.g === 'F').length;
console.log(`levels: ${lf} women / ${LEVELS.length - lf} men; aliases: ${ALIASES.F.length} women / ${ALIASES.M.length} men`);
assert(Math.abs(lf - (LEVELS.length - lf)) <= 1);

// --- data + engine ---
_test.validateData(DATA);
assert.strictEqual(_test.isoWeekOf('2026-09-21'), '2026-W39');
assert.strictEqual(_test.isoWeekOf('2026-01-01'), '2026-W01');
assert.strictEqual(_test.isoWeekOf('2027-01-01'), '2026-W53');
assert.strictEqual(_test.levelIndex(0), LEVELS.length - 1);
assert.strictEqual(_test.levelIndex(1000), 0);
assert.strictEqual(_test.levelIndex(999), 1);

for (const l of DATA.lasers) {
  const steps = _test.buildSteps(l, DATA.lasers);
  // base 7 = pump, level, lasing, transition, modes, power, apps; level is dropped if null/undefined (e.g. diode, er-yag)
  const base = (l.level === null || l.level === undefined) ? 6 : 7;
  const extra = (l.extraQuestions || []).length;
  assert.strictEqual(steps.length, base + (l.pumpWavelength ? 1 : 0) + (l.lifetime ? 1 : 0) + extra, `${l.id} step count`);
  steps.forEach((s) => {
    assert(s.options.some((o) => o.ok), `${l.id}/${s.id}: no correct option`);
    assert(s.options.some((o) => !o.ok), `${l.id}/${s.id}: no wrong option`);
    assert(s.options.length <= 6, `${l.id}/${s.id}: too many options for buttons`);
    assert.strictEqual(new Set(s.options.map((o) => o.t)).size, s.options.length, `${l.id}/${s.id}: duplicate option text`);
    if (!s.multi) assert.strictEqual(s.options.filter((o) => o.ok).length, 1, `${l.id}/${s.id}: single-choice needs exactly one answer`);
  });
}

// lifetime step: present for every laser except HeNe/CO2, always single-choice with 4 buckets
for (const l of DATA.lasers) {
  const steps = _test.buildSteps(l, DATA.lasers);
  const lifeStep = steps.find((s) => s.id === 'lifetime');
  if (l.id === 'hene' || l.id === 'co2') {
    assert(!lifeStep, `${l.id} should skip the lifetime step (gas lasers don't have one clean number)`);
  } else {
    assert(lifeStep, `${l.id} should have a lifetime step`);
    assert.strictEqual(lifeStep.options.length, 4, `${l.id} lifetime step should offer 4 buckets`);
  }
}
// diode laser: level scheme step still appears, but answers "N/A – semiconductor"
{
  const diode = DATA.lasers.find((l) => l.id === 'diode');
  const steps = _test.buildSteps(diode, DATA.lasers);
  const levelStep = steps.find((s) => s.id === 'level');
  assert(levelStep, 'diode should still get a level-scheme step (answer: N/A)');
  assert(/N\/A/.test(levelStep.options.find((o) => o.ok).t), 'diode\'s correct level answer should be the N/A option');
  assert(!steps.find((s) => s.id === 'pumpWavelength'), 'diode has no optical pump wavelength, so that step should be skipped');
}
// thulium: dedicated cross-relaxation question, in addition to (not replacing) its level-scheme step
{
  const tm = DATA.lasers.find((l) => l.id === 'thulium');
  const steps = _test.buildSteps(tm, DATA.lasers);
  assert(steps.find((s) => s.id === 'level'), 'thulium should still have its normal level-scheme step');
  const cr = steps.find((s) => s.id === 'crossRelaxation');
  assert(cr, 'thulium should have the cross-relaxation nuance question');
  assert.strictEqual(cr.title, 'Two-for-one cross-relaxation');
  assert(cr.multi, 'cross-relaxation question should be multi-select');
  assert.strictEqual(cr.options.filter((o) => o.ok).length, 2, 'exactly 2 correct options');
  const g = _test.grade(cr, cr.options.map((o, i) => (o.ok ? i : -1)).filter((i) => i >= 0));
  assert.strictEqual(g.pts, 10, 'selecting exactly the correct options should score full marks');
}
// er:yag: level-scheme step is skipped outright (self-terminating transition doesn't fit the 3/4-level picture),
// replaced by a dedicated nuance question
{
  const er = DATA.lasers.find((l) => l.id === 'er-yag');
  const steps = _test.buildSteps(er, DATA.lasers);
  assert(!steps.find((s) => s.id === 'level'), 'er-yag should skip the level-scheme step');
  const nuance = steps.find((s) => s.id === 'selfTerminating');
  assert(nuance, 'er-yag should have the self-terminating nuance question');
  assert.strictEqual(nuance.title, 'Self-terminating transition');
  assert(nuance.multi, 'nuance question should be multi-select');
  const g2 = _test.grade(nuance, nuance.options.map((o, i) => (o.ok ? i : -1)).filter((i) => i >= 0));
  assert.strictEqual(g2.pts, 10, 'selecting exactly the correct options should score full marks');
}

const step = { options: [{ ok: true }, { ok: true }, { ok: false }, { ok: false }] };
assert.deepStrictEqual(_test.grade(step, [0, 1]).pts, 10);
assert.strictEqual(_test.grade(step, [0]).pts, 5);
assert.strictEqual(_test.grade(step, [0, 2]).pts, 0);
assert.strictEqual(_test.grade(step, [2, 3]).pts, 0);
assert.strictEqual(_test.grade(step, [0, 1, 2]).pts, 5);

// --- config flags ---
let c = _test.readConfig({ WEEKLY_XP_ENABLED: 'true' });
assert.strictEqual(c.weeklyXp, false, 'mastery tracking needs QUIZ_SALT');
c = _test.readConfig({ LEADERBOARD_VISIBLE: 'true', QUIZ_SALT: 'x' });
assert.strictEqual(c.leaderboard, false, 'leaderboard needs mastery tracking enabled');
c = _test.readConfig({ WEEKLY_XP_ENABLED: '1', LEADERBOARD_VISIBLE: 'yes', QUIZ_SALT: 'x' });
assert(c.weeklyXp && c.leaderboard);

// --- fake Telegram bot ---
function fakeBot() {
  const b = { sent: [], edits: [], acks: [], n: 100 };
  b.sendMessage = async (chat, text, o) => { b.sent.push({ chat, text, o }); return { message_id: ++b.n }; };
  b.editMessageText = async (text, o) => { b.edits.push({ text, o }); return {}; };
  b.editMessageReplyMarkup = async () => ({});
  b.answerCallbackQuery = async (id, o) => { b.acks.push(o); return true; };
  return b;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lq-'));
  const env = { WEEKLY_XP_ENABLED: 'true', LEADERBOARD_VISIBLE: 'true', QUIZ_SALT: 'test-salt', QUIZ_DATA_DIR: dir, LASER_QUIZ_DAILY_XP_CAP: '0' };
  const bot = fakeBot();
  const lq = createLaserQuiz(bot, { env });
  const I = lq._internals;

  // alias balance for a full class, then suffixes
  for (let i = 1; i <= 40; i++) I.touchUser(I.userKey(1000 + i));
  const aliases = [];
  for (let i = 1; i <= 40; i++) aliases.push(I.touchUser(I.userKey(1000 + i)).alias);
  assert.strictEqual(new Set(aliases).size, 40);
  assert.strictEqual(aliases.filter((a) => ALIASES.F.includes(a)).length, 20, 'exactly 20 women aliases for 40 users');
  const extra = I.touchUser(I.userKey(2000)).alias;
  assert(/ (II|III)$/.test(extra), `41st user gets a numbered alias, got ${extra}`);

  // --- mastery model: sum of PER-LASER PERSONAL BESTS, never a decreasing or simply
  // accumulating total. Tested directly against awardMastery() in isolation from the
  // UI/session machinery, since this is the core mechanic the design depends on. ---
  {
    const mkey = I.userKey(90001);
    // first score for laser A: a genuine new best (was 0)
    let r = I.awardMastery(mkey, 'laser-a', 40);
    assert.strictEqual(r.isNewBest, true);
    assert.strictEqual(r.delta, 40);
    assert.strictEqual(I.masteryOf(I.touchUser(mkey)), 40, 'mastery = laser A best only so far');

    // a WORSE replay of laser A must NOT decrease the stored best
    r = I.awardMastery(mkey, 'laser-a', 25);
    assert.strictEqual(r.isNewBest, false, 'worse replay is not a new best');
    assert.strictEqual(I.touchUser(mkey).bestByLaser['laser-a'], 40, 'best for laser A must stay at 40, not drop to 25');
    assert.strictEqual(I.masteryOf(I.touchUser(mkey)), 40, 'mastery unchanged by a worse replay');

    // a BETTER replay of laser A raises the stored best
    r = I.awardMastery(mkey, 'laser-a', 55);
    assert.strictEqual(r.isNewBest, true);
    assert.strictEqual(r.delta, 15, 'delta is the IMPROVEMENT only (55-40), not the full new score');
    assert.strictEqual(I.masteryOf(I.touchUser(mkey)), 55);

    // mastery for a SECOND, never-before-played laser B is ADDITIVE on top, not a replacement
    r = I.awardMastery(mkey, 'laser-b', 30);
    assert.strictEqual(r.isNewBest, true);
    assert.strictEqual(I.masteryOf(I.touchUser(mkey)), 85, 'mastery = best(laser A) + best(laser B) = 55 + 30');

    // replaying laser A again at its EXISTING best (not higher) must not double-count
    r = I.awardMastery(mkey, 'laser-a', 55);
    assert.strictEqual(r.isNewBest, false, 'matching (not exceeding) the existing best is not a new best');
    assert.strictEqual(I.masteryOf(I.touchUser(mkey)), 85, 'replaying at the same score must not inflate the total');
  }

  // --- daily mastery-GAIN cap: an improvement bigger than today's remaining room is not
  // applied at all (never partially applied to a synthetic in-between value) ---
  {
    const cappedEnv = { ...env, LASER_QUIZ_DAILY_XP_CAP: '10' };
    const cappedLq = createLaserQuiz(fakeBot(), { env: cappedEnv });
    const CI = cappedLq._internals;
    const ckey = CI.userKey(90002);
    let r = CI.awardMastery(ckey, 'laser-a', 6); // within the 10/day room
    assert.strictEqual(r.isNewBest, true);
    assert.strictEqual(CI.touchUser(ckey).bestByLaser['laser-a'], 6);
    r = CI.awardMastery(ckey, 'laser-a', 25); // delta would be 19, only 4 room left
    assert.strictEqual(r.isNewBest, false);
    assert.strictEqual(r.capped, true);
    assert.strictEqual(CI.touchUser(ckey).bestByLaser['laser-a'], 6, 'capped improvement must not be partially applied');
    cappedLq.shutdown();
  }

  // --- LASER_QUIZ_MAX_XP: ceiling on the TOTAL mastery sum, not individual per-laser bests.
  // Uses a very high daily-gain cap so it never interferes with reaching the ceiling here. ---
  {
    const maxEnv = { ...env, LASER_QUIZ_DAILY_XP_CAP: '0', LASER_QUIZ_MAX_XP: '100' };
    const maxLq = createLaserQuiz(fakeBot(), { env: maxEnv });
    const MI = maxLq._internals;
    const xkey = MI.userKey(90003);
    MI.awardMastery(xkey, 'laser-a', 70);
    assert.strictEqual(MI.masteryOf(MI.touchUser(xkey)), 70, 'below the 100 ceiling: total is unaffected');
    MI.awardMastery(xkey, 'laser-b', 60); // true sum would be 130, ceiling is 100
    assert.strictEqual(MI.masteryOf(MI.touchUser(xkey)), 100, 'total must be rounded down to LASER_QUIZ_MAX_XP');
    // per-laser bests themselves stay at full, uncapped precision -- only the aggregate is capped
    assert.strictEqual(MI.touchUser(xkey).bestByLaser['laser-a'], 70);
    assert.strictEqual(MI.touchUser(xkey).bestByLaser['laser-b'], 60);
    maxLq.shutdown();

    // LASER_QUIZ_MAX_XP=0 means uncapped, same convention as LASER_QUIZ_DAILY_XP_CAP
    const uncappedEnv = { ...env, LASER_QUIZ_DAILY_XP_CAP: '0', LASER_QUIZ_MAX_XP: '0' };
    const uncappedLq = createLaserQuiz(fakeBot(), { env: uncappedEnv });
    const UI = uncappedLq._internals;
    const ukey = UI.userKey(90004);
    UI.awardMastery(ukey, 'laser-a', 70);
    UI.awardMastery(ukey, 'laser-b', 60);
    assert.strictEqual(UI.masteryOf(UI.touchUser(ukey)), 130, 'LASER_QUIZ_MAX_XP=0 must leave the total uncapped');
    uncappedLq.shutdown();

    // a config with LASER_QUIZ_MAX_XP set below the top level's threshold should warn at startup
    const lowMaxCfg = _test.readConfig({ ...maxEnv, LASER_QUIZ_MAX_XP: '10' });
    assert(lowMaxCfg.warnings.some((w) => /top level.*unreachable|unreachable.*top level/i.test(w) || /below the top level/i.test(w)), 'a too-low LASER_QUIZ_MAX_XP should produce a startup warning');
  }

  // --- full quiz flow through the real UI/session layer, always answering correctly ---
  const uid = 42;
  const cb = (data) => ({ id: 'q', from: { id: uid }, message: { chat: { id: uid }, message_id: 7 }, data });
  assert.strictEqual(lq.handleCommand({ text: '/lasers', from: { id: uid }, chat: { id: uid } }), true);
  assert.strictEqual(lq.handleCommand({ text: 'hello', from: { id: uid }, chat: { id: uid } }), false);
  await I.idle();
  assert(/Consider lasers with/.test(bot.sent[0].text));
  lq.handleCallback(cb('lq:s')); await I.idle();
  const s = I.sessions.get(uid);
  const n = s.steps.length;
  const playedLaserId = s.laser.id;
  for (let k = 0; k < n; k++) {
    const st = s.steps[s.si];
    const right = st.options.map((o, i) => (o.ok ? i : -1)).filter((i) => i >= 0);
    for (const i of right) { lq.handleCallback(cb(`lq:t:${s.si}:${i}`)); await I.idle(); }
    if (st.multi) { lq.handleCallback(cb(`lq:c:${s.si}`)); await I.idle(); }
    assert(s.answered, `step ${k} should be graded`);
    lq.handleCallback(cb(`lq:t:${s.si}:0`)); await I.idle();
    lq.handleCallback(cb(`lq:n:${s.si}`)); await I.idle();
  }
  const last = bot.edits[bot.edits.length - 1].text;
  assert(/complete/.test(last) && /Total mastery/.test(last) && /Mastery leaderboard/.test(last), 'summary text');
  assert(/New personal best|First mastery score banked/.test(last), 'a fresh 100% round should bank a new best');
  const key = I.userKey(uid);
  // A perfect round banks n*pointsPerQuestion PLUS the streak bonus earned during that same
  // round (streak bonus now counts toward mastery -- see the header comment in laserQuiz.js).
  // This is that session's FIRST round, so streak starts at 0: bonus-eligible questions are
  // every one from the streakMin-th perfect answer onward, i.e. max(0, n - (streakMin - 1)).
  const bonusEligible = Math.max(0, n - (lq.config.streakMin - 1));
  const expectedBest = n * lq.config.pointsPerQuestion + bonusEligible * lq.config.streakBonus;
  assert.strictEqual(I.touchUser(key).bestByLaser[playedLaserId], expectedBest, 'a perfect round should bank n*pointsPerQuestion plus its streak bonus');
  console.log(last.replace(/<[^>]+>/g, ''));

  // stale button is ignored
  const before = I.masteryOf(I.touchUser(key));
  lq.handleCallback(cb('lq:t:0:0')); await I.idle();
  assert.strictEqual(I.masteryOf(I.touchUser(key)), before);

  lq.shutdown();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'laser_xp.json'), 'utf8'));
  assert(!Object.keys(saved.users).includes(String(uid)), 'raw Telegram IDs must not be stored');
  console.log('\nAll tests passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
