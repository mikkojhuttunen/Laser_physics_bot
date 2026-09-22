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
  const g = _test.grade(nuance, nuance.options.map((o, i) => (o.ok ? i : -1)).filter((i) => i >= 0));
  assert.strictEqual(g.pts, 10, 'selecting exactly the correct options should score full marks');
}

const step = { options: [{ ok: true }, { ok: true }, { ok: false }, { ok: false }] };
assert.deepStrictEqual(_test.grade(step, [0, 1]).pts, 10);
assert.strictEqual(_test.grade(step, [0]).pts, 5);
assert.strictEqual(_test.grade(step, [0, 2]).pts, 0);
assert.strictEqual(_test.grade(step, [2, 3]).pts, 0);
assert.strictEqual(_test.grade(step, [0, 1, 2]).pts, 5);

// --- config flags ---
let c = _test.readConfig({ WEEKLY_XP_ENABLED: 'true' });
assert.strictEqual(c.weeklyXp, false, 'weekly XP needs QUIZ_SALT');
c = _test.readConfig({ LEADERBOARD_VISIBLE: 'true', QUIZ_SALT: 'x' });
assert.strictEqual(c.leaderboard, false, 'leaderboard needs weekly XP');
c = _test.readConfig({ WEEKLY_XP_ENABLED: '1', LEADERBOARD_VISIBLE: 'yes', QUIZ_SALT: 'x', WEEKLY_XP_TARGET: '250' });
assert(c.weeklyXp && c.leaderboard && c.target === 250);

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
  const env = { WEEKLY_XP_ENABLED: 'true', LEADERBOARD_VISIBLE: 'true', QUIZ_SALT: 'test-salt', QUIZ_DATA_DIR: dir, WEEKLY_XP_TARGET: '60', LASER_QUIZ_DAILY_XP_CAP: '0' };
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

  // full quiz flow, always answering correctly
  const uid = 42;
  const cb = (data) => ({ id: 'q', from: { id: uid }, message: { chat: { id: uid }, message_id: 7 }, data });
  assert.strictEqual(lq.handleCommand({ text: '/lasers', from: { id: uid }, chat: { id: uid } }), true);
  assert.strictEqual(lq.handleCommand({ text: 'hello', from: { id: uid }, chat: { id: uid } }), false);
  await I.idle();
  assert(/Consider lasers with/.test(bot.sent[0].text));
  lq.handleCallback(cb('lq:s')); await I.idle();
  const s = I.sessions.get(uid);
  const n = s.steps.length;
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
  assert(/complete/.test(last) && /Weekly XP/.test(last) && /Weekly top 10/.test(last), 'summary text');
  assert(/Weekly goal reached/.test(last), 'goal of 60 XP reached with a perfect round');
  const key = I.userKey(uid);
  assert(I.touchUser(key).xp >= n * 10, 'XP stored');
  console.log(last.replace(/<[^>]+>/g, ''));

  // stale button is ignored
  const before = I.touchUser(key).xp;
  lq.handleCallback(cb('lq:t:0:0')); await I.idle();
  assert.strictEqual(I.touchUser(key).xp, before);

  lq.shutdown();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'laser_xp.json'), 'utf8'));
  assert(!Object.keys(saved.users).includes(String(uid)), 'raw Telegram IDs must not be stored');
  console.log('\nAll tests passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
