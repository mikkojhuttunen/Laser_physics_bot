/**
 * e2e_analytics_test.js - regression test for the quiz analytics (v1.6.0).
 * Run from the repo root:  node e2e_analytics_test.js
 * Uses temp folders only; Telegram and the Anthropic API are stubbed (no network).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
process.env.ANTHROPIC_API_KEY = 'dummy';
process.env.QUIZ_PENDING_DIR = path.join(tmp, 'pending');
process.env.ADMIN_USER_IDS = '999';
delete process.env.ANALYTICS_HASH_SECRET;
delete process.env.QUIZ_ANALYTICS_DIR;

const single = require('./quizGenerator_fys501.js');
const multi = require('./multivalueQuizGenerator_fys501.js');
const analytics = require('./quizAnalytics_fys501.js');
const stats = require('./quizStats_fys501.js');
const commands = require('./quizAnalyticsCommands_fys501.js');
const tags = require('./validateQuizTags_fys501.js');
const tagger = require('./tagQuizBank_fys501.js');
const sBank = require('./quizBank_fys501.json');
const mBank = require('./multivalueQuizBank_fys501.json');

const problems = [];
let checks = 0;
const check = (cond, msg) => { checks++; if (!cond) problems.push(msg); };
const flat = (b) => Object.values(b).flatMap((c) => Object.values(c).flat());
const sByStem = new Map(flat(sBank).map((q) => [q.stem, q]));
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function mkBot() {
  const log = { sent: [], edits: [] };
  let mid = 1;
  return {
    log,
    sendMessage: async (c, t, o) => { log.sent.push({ c, t, o, mid }); return { message_id: mid++ }; },
    editMessageText: async (t, o) => { log.edits.push({ t, o }); return {}; },
    answerCallbackQuery: async () => {},
  };
}
const eventsFile = () => path.join(tmp, 'analytics', 'quiz_events.jsonl');
const readEvents = () => (fs.existsSync(eventsFile()) ? fs.readFileSync(eventsFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const withQuietLog = async (fn) => { const orig = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = orig; } };

// Plays a single-select quiz; pickFn(i, opts, q, cI) returns the tapped served index.
async function playSingle(userId, sec, pickFn) {
  const bot = mkBot();
  await withQuietLog(() => single.startQuiz(bot, userId, `quiz me on section ${sec}, 4 questions`, undefined, userId));
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const m = bot.log.sent[bot.log.sent.length - 1];
    const stem = (m.t.match(/<\/b>\n\n([\s\S]*?)\n\n<b>A\)/) || [])[1];
    const q = sByStem.get(stem);
    const opts = [...m.t.matchAll(/<b>([A-F])\)<\/b> (.*)/g)].map((x) => x[2]);
    const cI = opts.indexOf(q.options[q.correctIndex]);
    const pick = pickFn(i, opts, q, cI);
    seen.push({ q, opts, pick, cI });
    await withQuietLog(() => single.handleQuizAnswer(bot, { id: 'x', from: { id: userId }, data: `quiz:${i}:${pick}`, message: { chat: { id: userId }, message_id: m.mid } }));
  }
  return { bot, seen };
}

async function playMulti(userId, sec, plan) {
  const bot = mkBot();
  await withQuietLog(() => multi.startMultivalueQuiz(bot, userId, `mvquiz section ${sec}, 3 questions`, undefined, userId));
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const m = bot.log.sent[bot.log.sent.length - 1];
    const q = flat(mBank).find((x) => m.t.includes(esc(x.stem)));
    const want = plan(i, q);
    const sid = m.o.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];
    for (const idx of want) {
      await multi.handleMultivalueQuizAnswer(bot, { id: 'x', from: { id: userId }, data: `mv:${sid}:${i}:t:${idx}`, message: { chat: { id: userId }, message_id: m.mid } });
    }
    await withQuietLog(() => multi.handleMultivalueQuizAnswer(bot, { id: 'x', from: { id: userId }, data: `mv:${sid}:${i}:s`, message: { chat: { id: userId }, message_id: m.mid } }));
    seen.push({ q, want });
  }
  return { bot, seen };
}

(async () => {
  // ---------- A. off by default ----------
  check(analytics.isEnabled() === false, 'analytics must be OFF without ANALYTICS_HASH_SECRET');
  {
    const { bot } = await playSingle(101, '3.5', (i, o, q, c) => c);
    check(!bot.log.sent.some((m) => /\/privacy/.test(m.t)), 'no notice when analytics are off');
    check(analytics.logSingle(101, { id: 'q3.5_001', options: ['a', 'b'], correctIndex: 0 }, 0) === null, 'logSingle is a no-op when off');
  }
  process.env.ANALYTICS_HASH_SECRET = 'short';
  check(analytics.isEnabled() === false, 'a secret shorter than 16 chars must not enable analytics');

  // ---------- B. single-select events ----------
  process.env.ANALYTICS_HASH_SECRET = 'test-secret-0123456789';
  process.env.QUIZ_ANALYTICS_DIR = path.join(tmp, 'analytics');
  analytics.resetCaches();
  check(analytics.isEnabled(), 'analytics ON with a 16+ char secret');

  const uA = 111;
  const { bot: botA, seen: seenA } = await playSingle(uA, '3.5', (i, opts, q, cI) => (i % 2 === 0 ? cI : (cI + 1) % 4));
  const noticeMsgs = botA.log.sent.filter((m) => /\/privacy/.test(m.t));
  check(noticeMsgs.length === 1, 'first quiz shows the analytics notice exactly once');
  check(botA.log.sent[0] === noticeMsgs[0] && /Question 1\/4/.test(noticeMsgs[0].t) && noticeMsgs[0].o && noticeMsgs[0].o.reply_markup, 'notice and first question are ONE message with the answer keyboard (quiz starts immediately)');
  check(noticeMsgs[0].t.indexOf('/privacy') < noticeMsgs[0].t.indexOf('Question 1/4'), 'notice comes before the first question in that message');
  let ev = readEvents();
  check(ev.length === 4, `4 events written (got ${ev.length})`);
  const pidA = analytics.pidOf(uA);
  ev.forEach((e, i) => {
    const s = seenA[i];
    check(e.pid === pidA && e.pid !== String(uA) && /^[0-9a-f]{12}$/.test(e.pid), 'pid is a 12-hex keyed hash, not the Telegram id');
    check(e.qid === s.q.id && e.sec === '3.5' && e.kind === 'single' && e.live === 0, `event ${i}: qid/sec/kind/live`);
    check(e.score === (i % 2 === 0 ? 1 : 0), `event ${i}: score`);
    const storedPick = s.q.options.indexOf(s.opts[s.pick]);   // shuffle mapped back to the STORED index
    check(e.pick.length === 1 && e.pick[0] === storedPick, `event ${i}: pick is the stored option index (served ${s.pick} -> stored ${storedPick}, logged ${e.pick})`);
    check(/^\d{4}-\d{2}-\d{2}$/.test(e.d) && !('ts' in e) && !('t' in e), 'date only, no time of day');
    check(JSON.stringify(e).includes(String(uA)) === false, 'raw Telegram id never appears in an event');
  });
  { // notice only once per user
    const { bot } = await playSingle(uA, '3.4', (i, o, q, c) => c);
    check(!bot.log.sent.some((m) => /\/privacy/.test(m.t)), 'notice is shown only once per user');
  }

  // ---------- C. tags follow the STORED option, whatever the served order ----------
  {
    const stored = sBank['3']['3.5'][0];
    const entry = analytics.bankIndex().get(stored.id);
    entry.q.concepts = ['res.stability'];
    const firstWrong = [0, 1, 2, 3].find((i) => i !== stored.correctIndex);
    entry.q.optionTags = stored.options.map((_, i) => (i === stored.correctIndex ? null : (i === firstWrong ? 'M-STAB-02' : 'M-STAB-03')));
    entry.q.version = 2;
    const perm = [2, 0, 3, 1]; // served order
    const served = { ...stored, options: perm.map((i) => stored.options[i]), correctIndex: perm.indexOf(stored.correctIndex) };
    const wrongStored = [0, 1, 2, 3].find((i) => i !== stored.correctIndex && entry.q.optionTags[i] === 'M-STAB-02');
    const servedPick = wrongStored === undefined ? -1 : perm.indexOf(wrongStored);
    check(wrongStored !== undefined, 'test question has a distractor at stored index 0');
    if (wrongStored !== undefined) {
      const e = await withQuietLog(() => analytics.logSingle(222, served, servedPick));
      check(e.pick[0] === wrongStored, 'tagged event keeps the stored index');
      check(e.wrongTags[0] === 'M-STAB-02' && e.concepts[0] === 'res.stability' && e.qv === 2, 'event carries the tag, concepts and version of the stored question');
    }
  }

  // ---------- D. multi-select events ----------
  const { bot: botM, seen: seenM } = await playMulti(444, '3.5', (i, q) => (i === 0 ? q.correctIndices : i === 1 ? [...q.correctIndices, [0, 1, 2, 3, 4, 5, 6, 7].find((x) => x < q.options.length && !q.correctIndices.includes(x))] : q.correctIndices.slice(1)));
  check(/\/privacy/.test(botM.log.sent[0].t) && botM.log.sent[0].o.reply_markup && /1\/3/.test(botM.log.sent[0].t), 'multi-select: notice and first question are one message with the keyboard');
  process.env.QUIZ_ANALYTICS_RETENTION = 'on <31> & later';
  check(analytics.noticeHtml(556).includes('&lt;31&gt; &amp; later') && !/<31>/.test(analytics.noticeHtml(557) || 'x'), 'noticeHtml escapes HTML characters');
  delete process.env.QUIZ_ANALYTICS_RETENTION;
  const evM = readEvents().filter((e) => e.kind === 'multi');
  check(evM.length === 3, `3 multi events (got ${evM.length})`);
  if (evM.length === 3) {
    check(evM[0].score === 1 && evM[0].wrong.length === 0 && evM[0].missed.length === 0, 'multi: perfect answer');
    check(evM[1].wrong.length === 1 && evM[1].score < 1, 'multi: one extra wrong tick recorded in wrong[]');
    check(evM[2].missed.length === 1 && evM[2].wrong.length === 0, 'multi: a missed correct option is recorded in missed[]');
    check(evM[0].qid === seenM[0].q.id && evM[0].sec === '3.5', 'multi: qid and section');
  }

  // ---------- E. live-generated ids ----------
  {
    const e = await withQuietLog(() => analytics.logSingle(333, { id: 'gen_3.5_1700000000_0', options: ['a', 'b', 'c', 'd'], correctIndex: 1 }, 0));
    check(e.live === 1 && e.sec === '3.5' && e.qv === null && e.concepts.length === 0, 'live question: live=1, section from id, no tags');
    const e2 = await withQuietLog(() => analytics.logMulti(333, { id: 'mvgen_2_1700000000_0', options: ['a', 'b', 'c', 'd'], correctIndices: [0, 1] }, new Set([0]), 0.5));
    check(e2.live === 1 && e2.sec === null, 'chapter-wide live question has no section');
  }

  // ---------- F. opt-out / opt-in ----------
  {
    const before = readEvents().filter((e) => e.pid === pidA).length;
    check(before >= 4, 'student A has stored events before opting out');
    const r = analytics.optOut(uA);
    check(r.ok && r.purged === before && r.persistent, `opt-out deletes the student's stored events (purged ${r.purged}/${before})`);
    check(readEvents().filter((e) => e.pid === pidA).length === 0, 'no events of the opted-out student remain');
    check(readEvents().length > 0, 'other students events are kept');
    const { bot } = await playSingle(uA, '3.3', (i, o, q, c) => c);
    check(readEvents().filter((e) => e.pid === pidA).length === 0, 'opted-out student is not logged');
    check(!bot.log.sent.some((m) => /\/privacy/.test(m.t)), 'no notice for an opted-out student');
    analytics.resetCaches(); // simulate a bot restart: the opt-out list must persist on the volume
    check(analytics.logSingle(uA, { id: 'q3.5_001', options: ['a', 'b', 'c', 'd'], correctIndex: 0 }, 0) === null, 'opt-out survives a restart (persisted list)');
    analytics.optIn(uA);
    check((await withQuietLog(() => analytics.logSingle(uA, { ...sBank['3']['3.5'][0] }, 0))) !== null, 'opt-in resumes logging');
  }
  check(!/^\s*$/.test(commands.privacyReply()) && /optout/.test(commands.privacyReply()), 'privacy text mentions /optout');
  for (const [name, text] of [['notice', analytics.noticeText()], ['privacy text', commands.privacyReply()]]) {
    check(/pseudonymis/i.test(text), `${name} mentions pseudonymisation`);
    check(/discuss|course/i.test(text) && /grades/.test(text), `${name} states the purpose`);
    if (name === 'privacy text') check(/a\) facilitate group discussions, b\) update materials\/quizzes/.test(text) && /and the date\. Nothing else/.test(text), 'privacy text has the agreed purpose and recorded-data wording');
    check(/deleted after the course end, specifically on 31 Dec 2026/.test(text), `${name} states the deletion time`);
  }
  check(analytics.noticeText().length < 500, 'notice stays short');
  process.env.QUIZ_ANALYTICS_RETENTION = 'on 31 May 2027';
  check(/deleted on 31 May 2027/.test(analytics.noticeText()) && /deleted on 31 May 2027/.test(commands.privacyReply()), 'retention wording can be set to a date');
  delete process.env.QUIZ_ANALYTICS_RETENTION;

  // ---------- G. statistics ----------
  {
    const mk = (pid, qid, score, extra = {}) => ({ v: 1, d: '2026-09-21', pid, kind: 'single', qid, qv: 1, sec: extra.sec || '3.5', concepts: extra.concepts || ['res.stability'], live: 0, pick: [0], score, wrong: score ? [] : [0], wrongTags: score ? [] : [extra.tag || null], missed: [] });
    const evs = [];
    for (let s = 1; s <= 8; s++) evs.push(mk(`s${s}`, 'q3.5_001', s <= 2 ? 1 : 0, { tag: 'M-STAB-02' }));        // weak concept: 25%
    for (let s = 1; s <= 8; s++) evs.push(mk(`s${s}`, 'q3.1_001', s <= 7 ? 1 : 0, { sec: '3.1', concepts: ['abcd.system'] })); // strong: 87.5%
    for (let s = 1; s <= 3; s++) evs.push(mk(`s${s}`, 'q2.2_001', 0, { sec: '2.2', concepts: ['einstein.ab'] }));  // only 3 students: hidden
    for (let s = 1; s <= 8; s++) evs.push(mk(`s${s}`, 'q3.5_001', 1));                                          // repeat attempts must not count
    evs.push(mk('s1', 'gen_3.5_1_0', 0, { concepts: [] })); evs[evs.length - 1].live = 1;                     // live question excluded
    const meta = stats.loadMeta();
    const r = stats.analyse(evs, { minN: 5 }, meta);
    check(r.sections[0].id === '3.5' && Math.abs(r.sections[0].mean - 0.25) < 1e-9 && r.sections[0].students === 8, 'section ranking: weakest is 3.5 at 25% (repeats ignored)');
    check(r.sections.every((s) => s.id !== '2.2') && r.hidden.sections === 1, 'a group of 3 students is hidden');
    check(r.concepts[0].id === 'res.stability' && r.concepts[1].id === 'abcd.system', 'concept ranking');
    check(r.totals.liveExcluded === 1 && r.totals.firstExposureAnswers === 8 + 8 + 3, 'live excluded, first exposure counted once');
    check(r.questions[0].id === 'q3.5_001' && r.questions[0].topWrong[0].label === 'M-STAB-02' && r.questions[0].topWrong[0].students === 6, 'question view lists the top wrong answer by tag');
    check(r.misconceptions.length && r.misconceptions[0].id === 'M-STAB-02' && r.misconceptions[0].picked === 6, 'misconception picked by 6 students');
    const rl = stats.analyse(evs, { minN: 5, includeLive: true }, meta);
    check(rl.totals.liveExcluded === 0 && rl.totals.events === evs.length, '--live includes live questions');
    const txt = stats.formatTelegram(r);
    check(txt.length < 3500 && /Weakest sections/.test(txt) && /3\.5/.test(txt), 'telegram text is compact and lists sections');
    check(/# Quiz briefing/.test(stats.formatMarkdown(r)), 'markdown briefing renders');
    // events logged before tagging are enriched from the current bank (same version only)
    {
      const early = [1, 2, 3, 4, 5].map((n) => mk(`e${n}`, 'q9.9_001', n <= 1 ? 1 : 0, { sec: '3.5', concepts: [], tag: null }));
      const bank = new Map([['q9.9_001', { sec: '3.5', q: { id: 'q9.9_001', options: ['a', 'b', 'c', 'd'], correctIndex: 1, concepts: ['res.stability'], optionTags: ['M-STAB-02', null, 'M-STAB-03', null] } }]]);
      const re = stats.analyse(early, { minN: 5 }, { ...meta, bank });
      check(re.concepts.some((c) => c.id === 'res.stability' && c.students === 5), 'untagged events are enriched with concepts from the current bank');
      check(re.misconceptions.some((m) => m.id === 'M-STAB-02' && m.picked === 4 && m.exposed === 5), 'untagged events are enriched with misconception tags');
      const bumped = new Map([['q9.9_001', { sec: '3.5', q: { ...bank.get('q9.9_001').q, version: 2 } }]]);
      check(stats.analyse(early, { minN: 5 }, { ...meta, bank: bumped }).concepts.length === 0, 'no enrichment when the question version changed');
    }
    // parsing: raw lines, plain log lines, JSON-wrapped log lines, duplicates
    const one = JSON.stringify(evs[0]);
    const parsed = stats.parseEvents([one, `2026-09-21 QUIZ_EVENT ${one}`, JSON.stringify({ message: `QUIZ_EVENT ${JSON.stringify(evs[1])}` }), 'noise', '{"not":"an event"}'].join('\n'));
    check(parsed.length === 2, `parser: dedupes, unwraps and ignores noise (got ${parsed.length})`);
  }

  // ---------- H. commands ----------
  {
    const sent = [];
    const docs = [];
    const io = { sendText: async (c, t) => sent.push(t), sendDocument: async (c, p, n) => docs.push(n) };
    check((await commands.handleQuizStatsCommand({ chatId: 1, userId: 5, arg: '', ...io })) === false && sent.length === 0, '/quizstats ignored for non-admins');
    check((await commands.handleQuizStatsCommand({ chatId: 1, userId: 999, arg: '', ...io })) === true && /Quiz statistics/.test(sent[0]), '/quizstats works for admins');
    await commands.handleQuizStatsCommand({ chatId: 1, userId: 999, arg: 'export', ...io });
    check(docs.includes('quiz_events.jsonl'), '/quizstats export sends the events file');
    await commands.handleQuizStatsCommand({ chatId: 1, userId: 999, arg: 'clear', ...io });
    check(readEvents().length > 0, '/quizstats clear without confirm does nothing');
    await commands.handleQuizStatsCommand({ chatId: 1, userId: 999, arg: 'clear confirm', ...io });
    check(readEvents().length === 0, '/quizstats clear confirm empties the file');
    await commands.handleQuizStatsCommand({ chatId: 1, userId: 999, arg: 'bogus', ...io });
    check(/Usage/.test(sent[sent.length - 1]), 'unknown argument prints usage');
    check(/deleted the \d+ stored/.test(commands.optOutReply(7)) && /on again/.test(commands.optInReply(7)), 'opt-out / opt-in replies');
  }

  // ---------- I. tag validator ----------
  {
    const vocab = tags.loadVocab();
    const good = { 3: { '3.5': [{ id: 'q3.5_001', stem: 's', options: ['a', 'b', 'c', 'd'], correctIndex: 1, concepts: ['res.stability'], optionTags: ['M-STAB-01', null, 'M-STAB-02', null], version: 2 }] } };
    check(tags.validateBank(good, 'single', vocab).errors.length === 0, 'valid tags pass');
    const bad = JSON.parse(JSON.stringify(good));
    Object.assign(bad['3']['3.5'][0], { concepts: ['nope'], optionTags: ['M-STAB-01', 'M-STAB-02', 'M-XXX', null], version: 0 });
    const errs = tags.validateBank(bad, 'single', vocab).errors.join('|');
    check(/unknown concept/.test(errs) && /correct option/.test(errs) && /unknown misconception/.test(errs) && /version/.test(errs), 'validator catches unknown ids, tag on a correct option, bad version');
    const short = JSON.parse(JSON.stringify(good)); short['3']['3.5'][0].optionTags = [null, null];
    check(/one entry per option/.test(tags.validateBank(short, 'single', vocab).errors.join('|')), 'validator catches optionTags of the wrong length');
    check(tags.validateBank(sBank, 'single', vocab).errors.length === 0 && tags.validateBank(mBank, 'multi', vocab).errors.length === 0, 'the real banks pass validation');
  }

  // ---------- J. tagging tool (model stubbed) ----------
  {
    const dir = path.join(tmp, 'tagwork');
    fs.mkdirSync(dir);
    ['quizBank_fys501.json', 'multivalueQuizBank_fys501.json', 'concepts_fys501.json', 'misconceptions_fys501.json'].forEach((f) => fs.copyFileSync(path.join(__dirname, f), path.join(dir, f)));
    let calls = 0;
    const callModel = async ({ user }) => {
      calls++;
      if (calls === 3) return 'this is not json';
      const opts = [...user.matchAll(/^(\d+)\. .*$/gm)].map((m) => ({ i: +m[1], correct: /\[CORRECT\]/.test(m[0]) }));
      const tagsOut = opts.map((o, k) => (o.correct ? null : (k === 0 || (opts[0].correct && k === 1) ? 'M-STAB-02' : (k === 2 ? 'M-NOPE-99' : null))));
      return '```json\n' + JSON.stringify({ concepts: ['res.stability', 'made.up'], optionTags: tagsOut, proposed: [{ index: opts.findIndex((o) => !o.correct), text: 'Students think a longer cavity is always more stable.' }] }) + '\n```';
    };
    const saved = await tagger.cmdSuggest({ section: '3.6', kind: 'single', limit: '4' }, { dir, callModel, log: () => {} });
    check(saved.items.length === 4 && calls === 4, 'suggest processes the requested questions');
    check(saved.items.filter((s) => s.status === 'ERROR').length === 1, 'unparseable model output becomes an ERROR entry, not a crash');
    const okItem = saved.items.find((s) => s.status === 'OK');
    check(okItem.concepts.length === 1 && okItem.concepts[0] === 'res.stability', 'unknown concept ids are dropped');
    check(saved.items.some((x) => x.notes.some((n) => /unknown misconception/.test(n))) && saved.items.every((x) => x.optionTags.every((t) => t === null || t === 'M-STAB-02')), 'unknown misconception ids are dropped');
    check(fs.existsSync(path.join(dir, 'tag_review.md')) && /Proposed new misconceptions/.test(fs.readFileSync(path.join(dir, 'tag_review.md'), 'utf8')), 'review markdown written with proposals');
    const before = saved.items.map((s) => s.id).sort().join();
    const again = await tagger.cmdSuggest({ section: '3.6', kind: 'single', limit: '4' }, { dir, callModel, log: () => {} });
    check(again.items.length === 8 && calls === 8 && before.split(',').every((id) => again.items.some((s) => s.id === id)), 'suggest is resumable (already-suggested questions are skipped, new ones added)');
    // fail fast: three consecutive API errors stop the run and keep progress
    {
      let n = 0;
      let threw = null;
      try { await tagger.cmdSuggest({ section: '4.4', kind: 'single' }, { dir, callModel: async () => { n++; throw new Error('401 invalid x-api-key'); }, log: () => {} }); } catch (e) { threw = e; }
      check(threw && /3 consecutive errors/.test(threw.message) && /spend limit/.test(threw.message) && n === 3, 'suggest stops after 3 consecutive API errors with a helpful message');
      const file = path.join(dir, 'tag_suggestions.json');
      const all = JSON.parse(fs.readFileSync(file, 'utf8'));
      check(all.items.filter((x) => x.section === '4.4' && x.status === 'ERROR').length === 3, 'the failed attempts are recorded as ERROR entries');
      fs.writeFileSync(file, JSON.stringify({ ...all, items: all.items.filter((x) => x.section !== '4.4') }, null, 2));
    }
    const est = tagger.cmdEstimate({ section: '3.6' }, { dir, log: () => {} });
    check(est.count > 0 && est.usd > 0 && est.inTok > 0, 'estimate reports a count and a cost');
    const lines = [];
    tagger.cmdPrompt({ id: 'q3.5_004' }, { dir, log: (l) => lines.push(l) });
    check(lines.join('\n').includes('SYSTEM PROMPT') && lines.join('\n').includes('[CORRECT]'), 'prompt prints the system prompt and the marked question');
    const dry = tagger.cmdApply({ 'all-valid': true, 'dry-run': true }, { dir, log: () => {} });
    check(dry.applied.length === 7 && !fs.existsSync(path.join(dir, 'quizBank_fys501.json.bak')), 'dry-run applies nothing');
    const res = tagger.cmdApply({ 'all-valid': true }, { dir, log: () => {} });
    check(res.applied.length === 7 && fs.existsSync(path.join(dir, 'quizBank_fys501.json.bak')), 'apply writes tags and a backup');
    const banked = JSON.parse(fs.readFileSync(path.join(dir, 'quizBank_fys501.json'), 'utf8'));
    const tagged = banked['3']['3.6'].filter((q) => q.concepts);
    check(tagged.length === 7 && tagged.every((q) => q.optionTags.length === 4), 'banks now hold concepts + optionTags');
    check(tags.validateBank(banked, 'single', tags.loadVocab(dir)).errors.length === 0, 'the tagged bank still validates');
    check(banked['3']['3.6'].every((q) => q.id && q.stem && q.correctIndex !== undefined), 'existing fields untouched');
  }

  console.log(`CHECKS: ${checks}`);
  console.log('PROBLEMS:', problems.length ? problems : 'none');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
