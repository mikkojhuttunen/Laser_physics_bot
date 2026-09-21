/**
 * quizGenerator.js
 * -----------------
 * Chapter/section quiz generation + grading for the FYS.501 TA bot.
 *
 * Follows existing patterns from lectureLinks.js / checkhw:
 *  - Local regex gate before any API call (STAGE1_TRIGGER)
 *  - LLM only used for content generation (structured JSON), never for grading
 *  - Grading is deterministic, done in code
 *  - Session state via in-memory Map with expiry (mirrors checkhw sessions)
 *  - Corpus-grounded generation (no invented content outside course_corpus_fys501.txt)
 *
 * Architecture (see QUIZ_FEATURE_SETUP_GUIDE.md section 2):
 *  - Bank-first: sampleFromBank() draws from the pre-built quizBank_fys501.json,
 *    no API call.
 *  - Generate-as-fallback: if the bank doesn't have enough unused questions
 *    for the request, generateQuiz() is called live, scoped to just the
 *    requested section's corpus excerpt, to make up the shortfall.
 *  - Self-expanding: live-generated fallback questions are appended to
 *    quizBankPending_fys501.json (and also logged as a structured JSON line to
 *    stdout, so a log-based capture pipeline works too if the deployment's
 *    filesystem doesn't persist across restarts — see section 5a of the
 *    guide). They are never written into quizBank_fys501.json directly; that only
 *    happens via a reviewed `node mergePending_fys501.js merge` run.
 *
 * Wiring into bot_fys501.js (see INTEGRATION notes at bottom) mirrors how
 * lectureLinks.js and checkhw-image-handler.js were integrated:
 * this file stays self-contained, bot_fys501.js just calls a few exported functions.
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const corpusLoader = require('./corpusLoader_fys501');
const limiter = require('./usageLimiter');
const { getCorpusSection } = corpusLoader;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const QUIZ_BANK_PATH = path.join(__dirname, 'quizBank_fys501.json');
// Pending (unreviewed, live-generated) questions. QUIZ_PENDING_DIR lets a Railway volume hold them.
const PENDING_DIR = process.env.QUIZ_PENDING_DIR || __dirname;
const QUIZ_BANK_PENDING_PATH = path.join(PENDING_DIR, 'quizBankPending_fys501.json');
const PENDING_MAX = Math.max(1, parseInt(process.env.QUIZ_PENDING_MAX || '500', 10) || 500);

// ---------- Stage 1: local trigger gate (no API call) ----------

const STAGE1_TRIGGER = /\b(quiz|test me|quiz me)\b/i;
const CHAPTER_HINT = /chapter\s?([1-4])|ch\.?\s?([1-4])/i;
// e.g. "2.3", "section 2.3", matched separately from the bare chapter hint
// above so "chapter 2" alone doesn't get misread as section "2".
const SECTION_HINT = /\b(?:section\s+)?([1-4])\.([1-9])\b/i;
// Trailing question count, e.g. "/quiz 2.3 10" or "quiz me on chapter 2, 8 questions"
const COUNT_HINT = /\b(\d{1,2})\s*(?:questions?)?\s*$/i;

const DEFAULT_COUNT = 5;
const MAX_COUNT = 15; // reasonable cap per section 6 of the setup guide

function isQuizRequest(text) {
  return STAGE1_TRIGGER.test(text);
}

function extractChapterHint(text) {
  const sectionMatch = text.match(SECTION_HINT);
  if (sectionMatch) return sectionMatch[1];
  const m = text.match(CHAPTER_HINT);
  return m ? (m[1] || m[2]) : null;
}

function extractSectionHint(text) {
  const m = text.match(SECTION_HINT);
  return m ? `${m[1]}.${m[2]}` : null;
}

// Returns the raw requested count (unclamped), or null if none was given.
// Mask out anything already consumed as a chapter/section reference first,
// so e.g. "quiz me chapter 1" doesn't misread the "1" in "chapter 1" as a
// requested question count.
function extractRawCountHint(text) {
  const remainder = text.replace(SECTION_HINT, ' ').replace(CHAPTER_HINT, ' ');
  const m = remainder.match(COUNT_HINT);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function extractCountHint(text) {
  const n = extractRawCountHint(text);
  return n === null ? DEFAULT_COUNT : Math.min(n, MAX_COUNT);
}

// ---------- Session state (mirrors checkhw session Map) ----------

const SESSION_TTL_MS = 20 * 60 * 1000; // 20 min, same order as checkhw expiry
const quizSessions = new Map(); // key: chatId, value: { questions, index, score, expiresAt }

function getSession(chatId) {
  const s = quizSessions.get(chatId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    quizSessions.delete(chatId);
    return null;
  }
  return s;
}

function createSession(chatId, questions) {
  const session = {
    questions,
    index: 0,
    score: 0,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  quizSessions.set(chatId, session);
  return session;
}

// Tracks bank question ids recently served to each chat, so re-quizzing the
// same section doesn't immediately repeat the same questions. This is
// intentionally separate from quizSessions (which expires quickly) — this
// one persists a bit longer and just caps its size, it doesn't need a TTL.
const RECENTLY_SERVED_MAX = 60;
const recentlyServedIds = new Map(); // chatId -> Set<questionId>

function markServed(chatId, ids) {
  let set = recentlyServedIds.get(chatId);
  if (!set) {
    set = new Set();
    recentlyServedIds.set(chatId, set);
  }
  for (const id of ids) set.add(id);
  if (set.size > RECENTLY_SERVED_MAX) {
    // drop oldest entries (Sets preserve insertion order)
    const excess = set.size - RECENTLY_SERVED_MAX;
    const it = set.values();
    for (let i = 0; i < excess; i++) set.delete(it.next().value);
  }
}

function getRecentlyServed(chatId) {
  return recentlyServedIds.get(chatId) || new Set();
}

// ---------- quizBank_fys501.json access (cached, bank-first sourcing) ----------

let _bankCache = null;

function loadQuizBank({ forceReload = false } = {}) {
  if (_bankCache !== null && !forceReload) return _bankCache;
  try {
    const raw = fs.readFileSync(QUIZ_BANK_PATH, 'utf8');
    _bankCache = JSON.parse(raw);
  } catch (e) {
    console.warn(`quizGenerator: could not load quizBank_fys501.json (${e.message}) — bank is empty, all quizzes will be live-generated`);
    _bankCache = {};
  }
  return _bankCache;
}

function quizBankLooksHealthy() {
  const bank = loadQuizBank();
  return Object.keys(bank).length > 0 &&
    Object.values(bank).some((secs) => Object.values(secs).some((qs) => Array.isArray(qs) && qs.length > 0));
}

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Returns a copy of `q` with its options in random order and correctIndex
 * remapped, so students cannot exploit the position in which the bank (or the
 * live generator) happens to store the correct answer. Questions whose options
 * refer to each other by position ("all of the above", "option B", ...)
 * are returned unchanged.
 */
const POSITIONAL_OPTION_RE = /\b(?:all|none|any) of the above\b|\b(?:options?|answers?|choices?) [A-D]\b/i;
function randomizeOptions(q) {
  if (!q || !Array.isArray(q.options) || q.options.length < 2) return q;
  if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length) return q;
  if (q.options.some((o) => POSITIONAL_OPTION_RE.test(String(o)))) return q;
  const order = shuffle(q.options.map((_, i) => i));
  return {
    ...q,
    options: order.map((i) => q.options[i]),
    correctIndex: order.indexOf(q.correctIndex),
  };
}

/**
 * Draws up to `count` unused questions from quizBank_fys501.json for a given
 * chapter (+ optional section). No API call.
 *
 * - If `section` is given, samples only from that section's pool.
 * - If `section` is omitted, samples across the whole chapter (pooling all
 *   of that chapter's sections together before shuffling, so the result is
 *   naturally proportional to how many questions each section has).
 *
 * @returns {{ questions: object[], shortfall: number }} shortfall is how
 *   many more questions the caller still needs to reach `count` (0 if the
 *   bank fully satisfied the request).
 */
function sampleFromBank(chapter, section, count, excludeIds = []) {
  const bank = loadQuizBank();
  const chapterBank = bank[String(chapter)] || {};
  const exclude = new Set(excludeIds);

  let pool;
  if (section) {
    pool = (chapterBank[section] || []).slice();
  } else {
    pool = Object.values(chapterBank).flat();
  }

  const available = pool.filter((q) => !exclude.has(q.id));
  const picked = shuffle(available).slice(0, count);

  return {
    questions: picked,
    shortfall: Math.max(0, count - picked.length),
  };
}

// ---------- pending file — self-expansion capture ----------
//
// Live-generated (fallback) questions are captured here for HUMAN REVIEW and a later
// `node mergePending_fys501.js` run (see PENDING_QUESTIONS_fys501.md). They are never
// served from this file and never written into the quiz bank automatically.
//
// Location: QUIZ_PENDING_DIR (env) if set — point it at a mounted Railway volume (e.g.
// /data) so the file survives redeploys — otherwise the repo directory (ephemeral on
// Railway). Either way every question is also logged to stdout (QUIZ_PENDING_QUESTION lines),
// and the admin-only /pending command can export the file from the running container.

function writeJsonAtomic(p, data) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** Reads the pending file. A missing file is normal (empty); an unreadable one is flagged. */
function readPending() {
  let raw;
  try {
    raw = fs.readFileSync(QUIZ_BANK_PENDING_PATH, 'utf8');
  } catch (e) {
    return { entries: [], corrupt: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { entries: parsed, corrupt: false };
  } catch (e) { /* fall through */ }
  return { entries: [], corrupt: true };
}

/** Moves an unreadable pending file aside (never silently overwrite captured questions). */
function quarantineCorruptPending() {
  const backup = `${QUIZ_BANK_PENDING_PATH}.corrupt-${Date.now()}`;
  fs.renameSync(QUIZ_BANK_PENDING_PATH, backup);
  console.warn(`quizGenerator: pending file was unreadable — moved aside to ${backup}`);
}

function appendPendingQuestions(chapter, section, questions) {
  const generatedAt = new Date().toISOString();
  const entries = questions.map((q) => ({ chapter: String(chapter), section: section || null, question: q, generatedAt }));

  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const { entries: existing, corrupt } = readPending();
    if (corrupt) quarantineCorruptPending();
    if (existing.length + entries.length > PENDING_MAX) {
      console.warn(`quizGenerator: pending file is full (${existing.length}/${PENDING_MAX}) — not persisting ${entries.length} new question(s) to the file; the log lines below still capture them`);
    } else {
      writeJsonAtomic(QUIZ_BANK_PENDING_PATH, existing.concat(entries));
    }
  } catch (e) {
    console.warn(`quizGenerator: could not persist ${QUIZ_BANK_PENDING_PATH} (${e.message}) — relying on stdout log capture instead`);
  }

  // Structured log line, independent of the file write above, so a log-based capture
  // pipeline (Railway log export -> `node mergePending_fys501.js extract`) works even
  // if the filesystem doesn't persist.
  for (const entry of entries) {
    console.log(`QUIZ_PENDING_QUESTION ${JSON.stringify(entry)}`);
  }
}

/** Counts of captured-but-unreviewed questions, for /healthz and the admin /pending command. */
function pendingSummary() {
  const { entries, corrupt } = readPending();
  const bySection = {};
  for (const e of entries) {
    const k = e && e.section ? e.section : `ch${e && e.chapter}`;
    bySection[k] = (bySection[k] || 0) + 1;
  }
  return {
    total: entries.length,
    bySection,
    corrupt,
    path: QUIZ_BANK_PENDING_PATH,
    persistentDir: !!process.env.QUIZ_PENDING_DIR,
    max: PENDING_MAX,
  };
}

/** Empties the pending file (admin /pending clear). Returns how many entries were removed. */
function clearPending() {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const { entries, corrupt } = readPending();
  if (corrupt) quarantineCorruptPending();
  writeJsonAtomic(QUIZ_BANK_PENDING_PATH, []);
  return entries.length;
}

// ---------- Stage 2: generation (one LLM call, structured JSON out) ----------

const QUIZ_SYSTEM_PROMPT = `You generate multiple-choice quiz questions for a graduate laser physics
course, grounded STRICTLY in the provided corpus excerpt. Rules:
- Do NOT invent facts outside the excerpt.
- Do NOT use any homework problems or numeric answer keys as source material.
- Each question: 1 stem, 4 options, exactly 1 correct index (0-3), and a short
  (<40 word) explanation for the correct answer.
- Make all four options similar in length and level of detail, and make the
  wrong options plausible misconceptions. Never make the correct option
  systematically the longest or the most specific, and vary its index.
- Return ONLY valid JSON, no markdown fences, no preamble. Format:
  { "questions": [ { "stem": "...", "options": ["...","...","...","..."],
    "correctIndex": 0, "explanation": "..." } ] }`;

/**
 * Live-generates `count` questions, scoped to a chapter (and, if given, a
 * specific section) via getCorpusSection(chapter, section). Throws if the
 * corpus excerpt can't be found or the model's output can't be parsed —
 * callers should catch and degrade gracefully (see startQuiz).
 */
/** Structural validity of one single-select question; returns a cleaned copy or null. */
function normaliseQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  if (typeof q.stem !== 'string' || !q.stem.trim()) return null;
  if (!Array.isArray(q.options) || q.options.length !== 4) return null;
  if (!q.options.every((o) => typeof o === 'string' && o.trim())) return null;
  if (new Set(q.options.map((o) => o.trim().toLowerCase())).size !== 4) return null;
  if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) return null;
  return { ...q, explanation: typeof q.explanation === 'string' ? q.explanation : '' };
}

async function generateQuiz(chapter, section, count = 5) {
  const corpusExcerpt = getCorpusSection(chapter, section || undefined);

  const scopeLabel = section ? `Section ${section}` : `Chapter ${chapter}`;
  const response = await limiter.trackedCreate(anthropic, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system: QUIZ_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Generate ${count} MCQ questions from this excerpt (${scopeLabel}):\n\n${corpusExcerpt}`
      }
    ]
  });

  const raw = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (err) {
    throw new Error(`Quiz generation returned unparseable JSON: ${err.message}`);
  }

  if (!parsed.questions || !parsed.questions.length) {
    throw new Error('Quiz generation returned no questions');
  }

  // Defensive sanity check: a live LLM call can still produce a malformed question
  // (wrong option count, out-of-range correctIndex, duplicate options). Drop those so
  // they are neither served to the student nor written to the pending file.
  const sane = parsed.questions.map(normaliseQuestion).filter(Boolean);
  if (!sane.length) {
    throw new Error('Quiz generation returned no valid questions');
  }

  return sane;
}

/**
 * The main "give me N questions for chapter/section X" entry point used by
 * startQuiz(). Bank-first, live-generation fallback for the shortfall only,
 * with self-expansion of any freshly generated questions.
 */
async function getQuizQuestions(chatId, chapter, section, count, userId = chatId) {
  const excludeIds = getRecentlyServed(chatId);
  const { questions: rawBankQuestions, shortfall } = sampleFromBank(chapter, section, count, excludeIds);
  const bankQuestions = rawBankQuestions.map(randomizeOptions);

  markServed(chatId, bankQuestions.map((q) => q.id));

  if (shortfall === 0) {
    return bankQuestions;
  }

  // Top up the shortfall with a live call, scoped to just this
  // chapter/section — not the whole chapter's worth of sections — to keep
  // the excerpt (and cost) small.
  // Graceful degradation: live generation costs LLM credits (bank-served questions are
  // free). If the student's daily allowance or the shared daily backstop is used up,
  // serve the bank questions only and tell startQuiz() why via a flag.
  const gate = limiter.reserve(userId, 'quiz');
  if (!gate.ok) {
    console.log(`quizGenerator: live generation skipped (${gate.reason}) — serving ${bankQuestions.length}/${count} from the bank only`);
    bankQuestions.generationSkipped = gate.reason;
    return bankQuestions;
  }

  let generated = [];
  try {
    generated = await generateQuiz(chapter, section, shortfall);
  } catch (err) {
    limiter.refund(userId, gate.cost);
    console.warn(`quizGenerator: live fallback generation failed (${err.message}) — serving ${bankQuestions.length}/${count} from the bank only`);
    return bankQuestions;
  }

  // Tag with a synthetic id (bank questions already have one) so downstream
  // code can treat all questions uniformly.
  const stamped = generated.map((q, i) => randomizeOptions({
    ...q,
    id: `gen_${chapter}${section ? '.' + section.split('.')[1] : ''}_${Date.now()}_${i}`,
  }));

  appendPendingQuestions(chapter, section, stamped);

  return bankQuestions.concat(stamped);
}

// ---------- Telegram-facing helpers ----------

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function buildQuestionKeyboard(sessionIndex, question) {
  return {
    inline_keyboard: [
      question.options.map((opt, i) => ({
        text: OPTION_LETTERS[i] || String(i + 1),
        callback_data: `quiz:${sessionIndex}:${i}`
      }))
    ]
  };
}

function formatQuestionMessage(question, qNumber, total) {
  const optionsText = question.options
    .map((opt, i) => `<b>${OPTION_LETTERS[i] || i + 1})</b> ${opt}`)
    .join('\n');
  return `<b>Question ${qNumber}/${total}</b>\n\n${question.stem}\n\n${optionsText}`;
}

// Fallback used when the caller doesn't supply its own askWhichChapter
// (see the `askWhichChapter` param on startQuiz below). Just a plain text
// prompt — bot_fys501.js can inject a richer version (e.g. an inline-keyboard
// chapter picker) instead.
async function defaultAskWhichChapter(bot, chatId) {
  await bot.sendMessage(
    chatId,
    'Which chapter would you like to be quizzed on? Try "quiz me on chapter 2" or "quiz me on section 2.3".'
  );
  return null;
}

// Called from bot_fys501.js message handler when isQuizRequest(text) is true.
// `askWhichChapter(bot, chatId)` is called when the request doesn't name a
// chapter/section; it should prompt the student and return null (startQuiz
// then stops, since there's nothing more to do until they respond) or,
// if it can resolve one itself, return a chapter number/string directly.
async function startQuiz(bot, chatId, text, askWhichChapter = defaultAskWhichChapter, userId = chatId) {
  const chapter = extractChapterHint(text) || (await askWhichChapter(bot, chatId));
  if (!chapter) return; // askWhichChapter already sent a prompt (or startQuiz has nothing to do)

  const section = extractSectionHint(text); // null => chapter-wide request
  if (section && !corpusLoader.isValidSection(chapter, section)) {
    await bot.sendMessage(chatId, `I don't have section ${section} for chapter ${chapter} — try a chapter-wide quiz instead, e.g. "quiz me on chapter ${chapter}".`);
    return;
  }

  const rawCount = extractRawCountHint(text);
  const requestedCount = rawCount === null ? DEFAULT_COUNT : Math.min(rawCount, MAX_COUNT);
  if (rawCount !== null && rawCount > MAX_COUNT) {
    await bot.sendMessage(chatId, `Let's start with ${MAX_COUNT}, you can always ask for another round.`);
  }

  let questions;
  try {
    questions = await getQuizQuestions(chatId, chapter, section, requestedCount, userId);
  } catch (err) {
    console.error(`quizGenerator: startQuiz failed for chapter ${chapter}${section ? '.' + section : ''}: ${err.message}`);
    await bot.sendMessage(chatId, "Sorry, I couldn't put together a quiz for that right now — try again in a bit.");
    return;
  }

  if (!questions.length) {
    await bot.sendMessage(
      chatId,
      questions.generationSkipped
        ? "There are no ready-made questions for that section, and AI question generation is paused for today (daily allowance or shared capacity used up). Try another chapter/section, or come back tomorrow."
        : "I couldn't find or generate any questions for that section — try a different chapter/section."
    );
    return;
  }
  if (questions.generationSkipped && questions.length < requestedCount) {
    await bot.sendMessage(chatId, `Only ${questions.length} of ${requestedCount} questions are available right now — extra AI-generated questions are paused for today.`);
  }

  const session = createSession(chatId, questions);

  await bot.sendMessage(
    chatId,
    formatQuestionMessage(session.questions[0], 1, session.questions.length),
    { parse_mode: 'HTML', reply_markup: buildQuestionKeyboard(0, session.questions[0]) }
  );
}

// Called from bot_fys501.js's callback_query handler when data starts with "quiz:"
async function handleQuizAnswer(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const [, qIndexStr, answerIndexStr] = callbackQuery.data.split(':');
  const qIndex = parseInt(qIndexStr, 10);
  const answerIndex = parseInt(answerIndexStr, 10);

  const session = getSession(chatId);
  if (!session || qIndex !== session.index) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Quiz session expired — start a new one with /quiz.' });
    return;
  }

  const question = session.questions[qIndex];
  const correct = answerIndex === question.correctIndex;
  if (correct) session.score += 1;

  const feedback = correct
    ? `✅ Correct!\n${question.explanation}`
    : `❌ Not quite. Correct answer: <b>${OPTION_LETTERS[question.correctIndex]})</b> ${question.options[question.correctIndex]}\n${question.explanation}`;

  await bot.editMessageText(
    `${formatQuestionMessage(question, qIndex + 1, session.questions.length)}\n\n${feedback}`,
    { chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'HTML' }
  );
  await bot.answerCallbackQuery(callbackQuery.id);

  session.index += 1;
  if (session.index < session.questions.length) {
    const next = session.questions[session.index];
    await bot.sendMessage(
      chatId,
      formatQuestionMessage(next, session.index + 1, session.questions.length),
      { parse_mode: 'HTML', reply_markup: buildQuestionKeyboard(session.index, next) }
    );
  } else {
    await bot.sendMessage(chatId, `Quiz complete! Score: ${session.score}/${session.questions.length}`);
    quizSessions.delete(chatId);
  }
}

module.exports = {
  isQuizRequest,
  startQuiz,
  handleQuizAnswer,
  // exported for mergePending_fys501.js, /pending and tests
  generateQuiz,
  sampleFromBank,
  randomizeOptions,
  normaliseQuestion,
  pendingSummary,
  clearPending,
  readPending,
  getQuizQuestions,
  loadQuizBank,
  quizBankLooksHealthy,
  extractChapterHint,
  extractSectionHint,
  extractCountHint,
  extractRawCountHint,
};

/* INTEGRATION NOTES — this is now wired up in bot_fys501.js. Summary of how:
 *
 * bot_fys501.js talks to Telegram directly via axios, not node-telegram-bot-api,
 * so it passes a small adapter object (`quizBot`) in place of `bot` that
 * implements sendMessage/editMessageText/answerCallbackQuery on top of its
 * existing tg() helper.
 *
 * In the message handler, alongside the other STAGE1_TRIGGER checks:
 *   if (quizGenerator.isQuizRequest(question)) {
 *     return quizGenerator.startQuiz(quizBot, chatId, question, askWhichChapter);
 *   }
 *
 * bot_fys501.js has no EventEmitter-style `.on('callback_query', ...)` (it's a
 * plain webhook handler), so callback_query updates are dispatched directly
 * inside handleUpdate()/handleCallbackQuery() instead:
 *   if (data.startsWith('quiz:')) return quizGenerator.handleQuizAnswer(quizBot, cq);
 *
 * bot_fys501.js defines its own askWhichChapter(bot, chatId) — an inline-keyboard
 * chapter picker — and passes it into startQuiz() explicitly, overriding
 * the plain-text defaultAskWhichChapter() above. Tapping a chapter button
 * sends a "quizchapter:N" callback, which bot_fys501.js turns into a second
 * startQuiz() call with synthetic text ("quiz me on chapter N").
 *
 * /healthz includes `quizBankLooksHealthy: quizGenerator.quizBankLooksHealthy()`
 * and `corpusLooksHealthy: corpusLoader.corpusLooksHealthy()`.
 */
