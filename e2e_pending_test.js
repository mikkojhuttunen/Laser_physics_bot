/**
 * e2e_pending_test.js — regression test for the pending-question pipeline (no network, no Telegram).
 *   node e2e_pending_test.js
 * Covers: live-generation capture into the pending files (single + multi), validation of live output,
 * QUIZ_PENDING_DIR volume, size cap, corrupt-file quarantine, /pending admin module, and the
 * mergePending_fys501.js extract / review / merge CLI. Uses temp folders only; repo files are not touched.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-test-'));
process.env.ANTHROPIC_API_KEY = 'dummy';
process.env.ADMIN_USER_IDS = '111';
process.env.QUIZ_PENDING_DIR = path.join(tmp, 'vol', 'nested'); // does not exist yet -> must be created
process.env.QUIZ_PENDING_MAX = '6';

const limiter = require('./usageLimiter');
const single = require('./quizGenerator_fys501');
const multi = require('./multivalueQuizGenerator_fys501');
const admin = require('./pendingAdmin_fys501');
const sBank = require('./quizBank_fys501.json');

let passed = 0;
const logs = [], warns = [];
const realLog = console.log, realWarn = console.warn;
const ok = (name) => { passed++; realLog(`  ok  ${name}`); };
console.log = (...a) => { logs.push(a.join(' ')); };
console.warn = (...a) => { warns.push(a.join(' ')); };
const say = (...a) => realLog(...a);

const sPath = path.join(process.env.QUIZ_PENDING_DIR, 'quizBankPending_fys501.json');
const mPath = path.join(process.env.QUIZ_PENDING_DIR, 'multivalueQuizBankPending_fys501.json');
const readP = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const goodS = (n) => ({ stem: `Live single question ${n} about saturation?`, options: [`right ${n}`, `wrong a ${n}`, `wrong b ${n}`, `wrong c ${n}`], correctIndex: 1, explanation: 'because' });
const goodM = (n) => ({ stem: `Live multi question ${n} about cavities (Select all that apply)`, options: ['a1', 'b2', 'c3', 'd4', 'e5'].map((x) => `${x} ${n}`), correctIndices: [0, 2, 3], explanation: 'because', ref: 'Lecture notes 3.1' });
let nextText = '';
limiter.trackedCreate = async () => ({ content: [{ type: 'text', text: nextText }] });

(async () => {
  say('Part 1 — live-generation capture');
  // single: bank has 8 for 2.4, ask for 12 -> 4 generated; LLM returns 4 good + 1 malformed
  nextText = JSON.stringify({ questions: [goodS(1), goodS(2), { ...goodS(9), correctIndex: 9 }, goodS(3), goodS(4)] });
  let qs = await single.getQuizQuestions(9001, '2', '2.4', 12, 7001);
  assert.strictEqual(qs.length, 12); ok('single: 8 bank + 4 valid live questions served (malformed one dropped)');
  assert.ok(fs.existsSync(sPath)); ok('QUIZ_PENDING_DIR created on demand and pending file written there');
  let p = readP(sPath);
  assert.strictEqual(p.length, 4);
  assert.ok(p.every((e) => e.chapter === '2' && e.section === '2.4' && /^gen_2\.4_/.test(e.question.id) && e.generatedAt));
  ok('single: 4 pending entries with chapter/section/id/timestamp, malformed question NOT captured');
  assert.strictEqual(logs.filter((l) => l.startsWith('QUIZ_PENDING_QUESTION ')).length, 4); ok('single: 4 QUIZ_PENDING_QUESTION log lines');
  assert.ok(!fs.readdirSync(process.env.QUIZ_PENDING_DIR).some((f) => f.endsWith('.tmp'))); ok('atomic write left no .tmp file');

  // multi: 3.1 has 8, ask 11 -> 3 generated; LLM returns 3 good + 1 with a single correct option (invalid)
  nextText = JSON.stringify({ questions: [goodM(1), { ...goodM(8), correctIndices: [1] }, goodM(2), goodM(3)] });
  qs = await multi.getQuizQuestions(9002, '3', '3.1', 11, 7002);
  assert.strictEqual(qs.length, 11); ok('multi: 8 bank + 3 valid live questions served (single-correct one dropped)');
  p = readP(mPath); assert.strictEqual(p.length, 3); assert.ok(p.every((e) => e.section === '3.1' && /^mvgen_3\.1_/.test(e.question.id)));
  assert.strictEqual(logs.filter((l) => l.startsWith('MVQUIZ_PENDING_QUESTION ')).length, 3); ok('multi: 3 pending entries + 3 MVQUIZ_PENDING_QUESTION log lines');
  assert.strictEqual(readP(sPath).length, 4); ok('single file untouched by multi capture');

  // cap: QUIZ_PENDING_MAX=6, single has 4 -> 4 more would exceed it
  const before = logs.length;
  nextText = JSON.stringify({ questions: [goodS(11), goodS(12), goodS(13), goodS(14)] });
  await single.getQuizQuestions(9003, '2', '2.4', 12, 7003);
  assert.strictEqual(readP(sPath).length, 4); assert.ok(warns.some((w) => /pending file is full/.test(w)));
  assert.strictEqual(logs.slice(before).filter((l) => l.startsWith('QUIZ_PENDING_QUESTION ')).length, 4);
  ok('cap: file not grown past QUIZ_PENDING_MAX, warning issued, log lines still emitted');

  // corrupt file is quarantined, never silently overwritten
  fs.writeFileSync(sPath, '{ this is not json');
  nextText = JSON.stringify({ questions: [goodS(21)] });
  await single.getQuizQuestions(9004, '2', '2.4', 9, 7004);
  assert.ok(fs.readdirSync(process.env.QUIZ_PENDING_DIR).some((f) => f.startsWith('quizBankPending_fys501.json.corrupt-')));
  assert.strictEqual(readP(sPath).length, 1); ok('corrupt pending file moved aside (.corrupt-<ts>) and a fresh file started');

  // summary / clear
  const sum = single.pendingSummary();
  assert.deepStrictEqual([sum.total, sum.bySection['2.4'], sum.persistentDir], [1, 1, true]); ok('pendingSummary() counts by section');
  assert.strictEqual(multi.clearPending(), 3); assert.deepStrictEqual(readP(mPath), []); ok('clearPending() empties the file and reports the count');

  say('Part 2 — admin /pending command module');
  // refill both files
  nextText = JSON.stringify({ questions: [goodS(31), goodS(32)] }); await single.getQuizQuestions(9005, '2', '2.4', 10, 7005);
  nextText = JSON.stringify({ questions: [goodM(31)] }); await multi.getQuizQuestions(9006, '3', '3.1', 9, 7006);
  const sent = [], docs = [];
  const deps = { sendText: async (c, t) => sent.push(t), sendDocument: async (c, f, name, cap) => docs.push({ f, name, cap }) };
  assert.strictEqual(await admin.handlePendingCommand({ chatId: 1, userId: 555, arg: '', ...deps }), false);
  assert.strictEqual(sent.length + docs.length, 0); ok('non-admin: silently ignored, nothing sent');
  assert.strictEqual(await admin.handlePendingCommand({ chatId: 1, userId: 111, arg: '', ...deps }), true);
  assert.ok(/Single-select: 3 \(2\.4: 3\)/.test(sent[0]) && /Multi-select: 1 \(3\.1: 1\)/.test(sent[0])); ok('admin: summary shows counts per section');
  assert.deepStrictEqual(docs.map((d) => d.name).sort(), ['multivalueQuizBankPending_fys501.json', 'quizBankPending_fys501.json']); ok('admin: both pending files sent as documents');
  sent.length = 0; docs.length = 0;
  await admin.handlePendingCommand({ chatId: 1, userId: 111, arg: 'bogus', ...deps }); assert.ok(/Usage/.test(sent[0]) && !docs.length); ok('admin: unknown argument -> usage text');
  sent.length = 0;
  await admin.handlePendingCommand({ chatId: 1, userId: 111, arg: 'clear', ...deps });
  assert.ok(/3 single-select and 1 multi-select/.test(sent[0])); assert.deepStrictEqual(readP(sPath), []); ok('admin: /pending clear empties both files');
  sent.length = 0;
  await admin.handlePendingCommand({ chatId: 1, userId: 111, arg: '', ...deps }); assert.strictEqual(docs.length, 0); ok('admin: nothing to export -> no documents sent');

  say('Part 3 — mergePending_fys501.js CLI');
  const work = path.join(tmp, 'merge'); fs.mkdirSync(work);
  const banks = { s: path.join(work, 'quizBank_fys501.json'), m: path.join(work, 'multivalueQuizBank_fys501.json') };
  fs.copyFileSync('quizBank_fys501.json', banks.s); fs.copyFileSync('multivalueQuizBank_fys501.json', banks.m);
  const bankStem = sBank['2']['2.4'][0].stem;
  const entry = (chapter, section, q) => ({ chapter, section, question: q, generatedAt: '2026-09-20T10:00:00.000Z' });
  const cue = { stem: 'Which effect widens a spectral line uniformly for every atom?', options: ['Natural broadening from the finite lifetime of the excited state, identical for all atoms in the medium', 'Doppler shift', 'Local field', 'Strain'], correctIndex: 0, explanation: 'x' };
  const pendS = [
    entry('2', '2.4', goodS(101)),                                               // OK
    entry('2', '2.4', { ...goodS(102), correctIndex: 7 }),                        // INVALID
    entry('2', '2.4', { ...goodS(103), stem: bankStem }),                         // DUPLICATE of bank
    entry('2', '2.4', { ...goodS(104), stem: bankStem.replace(/\?$/, '') + ' here?' }), // SIMILAR
    entry('2', null, goodS(105)),                                                  // needs section
    entry('2', '2.5', cue),                                                        // OK + LENGTH CUE warning
  ];
  const pendM = [entry('3', '3.1', { ...goodM(101), stem: 'Live multi question 101 about cavities' }), entry('3', '3.1', { ...goodM(102), correctIndices: [1] })];
  fs.writeFileSync(path.join(work, 'quizBankPending_fys501.json'), JSON.stringify(pendS));
  fs.writeFileSync(path.join(work, 'multivalueQuizBankPending_fys501.json'), JSON.stringify(pendM));
  const cli = (...a) => spawnSync('node', [path.join(__dirname, 'mergePending_fys501.js'), ...a], { encoding: 'utf8' });
  const { keyOf } = require('./mergePending_fys501.js');
  const K = (kind, q) => keyOf(kind, q);

  let r = cli('review', '--dir', work, '--bank-dir', work, '--out', path.join(work, 'review.md'));
  assert.strictEqual(r.status, 0, r.stderr);
  for (const re of [/single-select: 6 pending/, /2 OK/, /2 INVALID/, /1 DUPLICATE/, /1 SIMILAR/, /multi-select: 2 pending — 1 OK, 1 INVALID/]) assert.ok(re.test(r.stdout), `${re} not in ${r.stdout}`);
  const sheet = fs.readFileSync(path.join(work, 'review.md'), 'utf8');
  assert.ok(/DUPLICATE: identical stem already in bank/.test(sheet) && /SIMILAR: \d+% word overlap/.test(sheet) && /LENGTH CUE/.test(sheet) && /no section/.test(sheet) && /at least 2 correct/.test(sheet));
  ok('review: statuses OK / INVALID / DUPLICATE / SIMILAR, length-cue warning, missing-section and single-correct problems all detected');

  const key = (k, q) => K(k, q.question);
  r = cli('merge', '--dir', work, '--bank-dir', work, '--accept', key('single', pendS[1]));
  assert.ok(/INVALID/.test(r.stdout) && /Nothing to do/.test(r.stdout)); ok('merge: refuses to merge an INVALID question');
  r = cli('merge', '--dir', work, '--bank-dir', work, '--accept', 'S-000000'); assert.strictEqual(r.status, 1); ok('merge: unknown key -> error exit');
  r = cli('merge', '--dir', work, '--bank-dir', work); assert.strictEqual(r.status, 1); ok('merge: without --accept/--all-valid -> error exit');

  const acc = [key('single', pendS[0]), key('single', pendS[5]), key('single', pendS[4]), key('multi', pendM[0])].join(',');
  const dry = cli('merge', '--dir', work, '--bank-dir', work, '--accept', acc, '--assign', `${key('single', pendS[4])}=2.4`, '--reviewed', '--drop-rest', '--dry-run');
  assert.ok(/Dry run/.test(dry.stdout) && readP(banks.s)['2']['2.4'].length === 8); ok('merge --dry-run changes nothing');
  r = cli('merge', '--dir', work, '--bank-dir', work, '--accept', acc, '--assign', `${key('single', pendS[4])}=2.4`, '--reviewed', '--drop-rest');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const sb = readP(banks.s), mb = readP(banks.m);
  assert.deepStrictEqual(sb['2']['2.4'].slice(8).map((q) => q.id), ['q2.4_009', 'q2.4_010']); assert.deepStrictEqual(sb['2']['2.5'].slice(8).map((q) => q.id), ['q2.5_009']);
  assert.deepStrictEqual(mb['3']['3.1'].slice(8).map((q) => q.id), ['mv3.1_009']);
  ok('merge: new ids continue each section sequentially (q2.4_009, q2.4_010, q2.5_009, mv3.1_009); --assign gave the sectionless question 2.4');
  const merged = [sb['2']['2.4'][8], sb['2']['2.5'][8], mb['3']['3.1'][8]];
  assert.ok(merged.every((q) => q.reviewed === true && q.source === 'claude-live-generated' && /^\d{4}-\d\d-\d\d$/.test(q.addedAt))); ok('merged questions carry reviewed:true, source, addedAt');
  assert.ok(/\(Select all that apply\)$/.test(mb['3']['3.1'][8].stem) && mb['3']['3.1'][8].correctIndices.length === 3); ok('multi stem gets the "(Select all that apply)" suffix');
  assert.deepStrictEqual([readP(path.join(work, 'quizBankPending_fys501.json')), readP(path.join(work, 'multivalueQuizBankPending_fys501.json'))], [[], []]); ok('merged and dropped questions removed from both pending files');
  assert.ok(fs.existsSync(`${banks.s}.bak`) && fs.existsSync(`${banks.m}.bak`)); ok('.bak backups of the banks written');
  fs.copyFileSync(banks.s, path.join(tmp, 'merged_quizBank.json')); fs.copyFileSync(banks.m, path.join(tmp, 'merged_multivalueQuizBank.json'));

  // extract from a Railway-style log
  const ex = path.join(tmp, 'extract'); fs.mkdirSync(ex);
  const line = (tag, o) => `2026-09-20T10:05:00Z ${tag} ${JSON.stringify(o)}`;
  const logFile = path.join(tmp, 'railway.log');
  fs.writeFileSync(logFile, [
    'some unrelated line', line('QUIZ_PENDING_QUESTION', pendS[0]), line('MVQUIZ_PENDING_QUESTION', pendM[0]),
    JSON.stringify({ message: `QUIZ_PENDING_QUESTION ${JSON.stringify(pendS[5])}`, timestamp: 'x' }),
    line('QUIZ_PENDING_QUESTION', pendS[0]), 'QUIZ_PENDING_QUESTION {broken json}',
  ].join('\n'));
  r = cli('extract', logFile, '--dir', ex); assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readP(path.join(ex, 'quizBankPending_fys501.json')).length, 2); assert.strictEqual(readP(path.join(ex, 'multivalueQuizBankPending_fys501.json')).length, 1);
  assert.ok(/unparseable/.test(r.stdout)); ok('extract: plain + JSON-wrapped log lines parsed, MVQUIZ/QUIZ tags kept apart, duplicate and broken lines handled');
  r = cli('extract', logFile, '--dir', ex); assert.ok(/0 new added/.test(r.stdout)); ok('extract: running it twice does not duplicate entries');

  console.log = realLog; console.warn = realWarn;
  say(`\nAll ${passed} checks passed. Temp files in ${tmp}`);
  say(`Merged banks for a follow-up regression run: ${path.join(tmp, 'merged_quizBank.json')}`);
})().catch((e) => { console.log = realLog; console.warn = realWarn; console.error('FAILED:', e.stack || e); process.exit(1); });
