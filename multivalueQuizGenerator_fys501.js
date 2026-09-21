/**
 * multivalueQuizGenerator_fys501.js
 * DATA_VERSION: 1.0.0
 * -----------------
 * Add-on "select all that apply" (multi-answer) quiz module for the
 * FYS.501 Laser Physics bot. Ported from the FYS.240 Optics bot's
 * multivalueQuizGenerator_fys240.js (same architecture, laser-specific
 * chapters/prompt/file names). Deliberately kept as a SEPARATE module from
 * quizGenerator_fys501.js (the single-correct-answer quiz flow) rather than
 * modifying it in place:
 *   - The grading contract is different (a SET of correct indices instead
 *     of one correctIndex), so the bank schema, generation prompt, session
 *     state, and callback_data namespace all differ.
 *   - Keeping it separate means the existing single-select /quiz flow is
 *     completely unaffected — this file can be wired in, tested, or ripped
 *     back out without touching quizGenerator_fys501.js or
 *     quizBank_fys501.json at all.
 *
 * Naming convention (mirrors the quizGenerator_fys501.js / quizBank_fys501.json pairing):
 *   - This file:                  multivalueQuizGenerator_fys501.js
 *   - Curated question bank:      multivalueQuizBank_fys501.json
 *   - Self-expansion capture:     multivalueQuizBankPending_fys501.json
 *   - callback_data namespace:    "mv:..." (never "quiz:...")
 *   - Trigger words:              "multiquiz" / "multi-select quiz" / "select all"
 *                                 (never bare "quiz", which stays reserved for
 *                                 the single-select flow)
 *
 * UI DESIGN NOTE:
 *   - Inline-keyboard buttons show ONLY the option letter (A, B, C, ...),
 *     toggled on/off with a checkmark prefix. Telegram truncates/concatenates
 *     long button labels, so the option TEXT is never put on a button — it is
 *     written into the question message body as a lettered list (see
 *     formatQuestionMessage), and the buttons just let the student pick which
 *     letters they mean.
 *   - A dedicated "Submit answer" button finalizes the selection; tapping a
 *     letter only toggles it and re-renders the keyboard via editMessageText
 *     (bot_fys501.js's quizBot.editMessageText adapter already forwards
 *     reply_markup, so no new adapter method is needed).
 *
 * Architecture (identical to quizGenerator_fys501.js — only the grading
 * contract and UI differ):
 *   - Bank-first: sampleFromBank() draws from multivalueQuizBank_fys501.json.
 *   - Generate-as-fallback: generateQuiz() live-generates the shortfall via
 *     Claude Haiku, scoped to the requested section's corpus excerpt.
 *   - Self-expanding: live-generated questions are appended to
 *     multivalueQuizBankPending_fys501.json (and logged to stdout as
 *     MVQUIZ_PENDING_QUESTION lines) for later human-reviewed merge into the
 *     real bank — never written there directly.
 *   - Grading is deterministic, in code (never the LLM).
 *
 * Grading rule (partial credit, floored at 0 per question):
 *   Let k = number of correct options, (n-k) = number of wrong options,
 *   c = how many correct options the student selected, w = how many wrong
 *   options they selected. Each question is scored out of 1 point as
 *     score = max(0, c/k - w/(n-k))
 *   Full credit (1) only for the exact correct set, partial credit for a
 *   correct-but-incomplete selection with no wrong picks, and exactly 0 if
 *   every option is ticked — so "just tick everything" is never a winning
 *   strategy, but one bad guess can never cost more than that question was
 *   worth. See gradeSelection() if this formula ever needs to change.
 *
 * Deviations from the FYS.240 original (all robustness fixes, none change
 * the student-visible design):
 *   1. All question text is HTML-escaped before being sent with parse_mode
 *      "HTML" (laser questions are full of "<", ">" and "&" in inequalities
 *      like N₂ > (g₂/g₁)N₁, which Telegram's HTML parser can reject).
 *   2. callback_data carries a short per-session id ("mv:<sid>:<q>:t:<i>"),
 *      so a stale keyboard from an abandoned quiz can't act on a newer quiz
 *      that happens to be on the same question number.
 *   3. The question index advances synchronously on Submit (before any
 *      await), so a double-tap can't double-count the score.
 *   4. Edits target the tapped message's own message_id (from the callback
 *      query) instead of a message_id stashed at send time.
 *   5. Session TTL slides on every valid tap, so a long quiz doesn't expire
 *      mid-way.
 *   6. Generated/banked questions are structurally validated (option count,
 *      index range, uniqueness) before being served.
 *   7. English-only: laser's single-select quiz and corpusLoader have no
 *      language layer, so the FYS.240 EN/FI machinery was not ported.
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const corpusLoader = require('./corpusLoader_fys501');
const limiter = require('./usageLimiter');
const { getCorpusSection } = corpusLoader;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const QUIZ_BANK_PATH = path.join(__dirname, 'multivalueQuizBank_fys501.json');
// Pending (unreviewed, live-generated) questions. QUIZ_PENDING_DIR lets a Railway volume hold them.
const PENDING_DIR = process.env.QUIZ_PENDING_DIR || __dirname;
const QUIZ_BANK_PENDING_PATH = path.join(PENDING_DIR, 'multivalueQuizBankPending_fys501.json');
const PENDING_MAX = Math.max(1, parseInt(process.env.QUIZ_PENDING_MAX || '500', 10) || 500);

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const MIN_OPTIONS = 4;
const MAX_OPTIONS = LETTERS.length;

// ---------- Stage 1: local trigger gate (no API call) ----------
// Deliberately NOT matching bare "quiz" — that stays reserved for
// quizGenerator_fys501.js's single-select flow. NOTE: "multi-select quiz",
// "multi quiz" and "multi-quiz" DO also contain a standalone word "quiz", so
// the single-select regex would match them too. bot_fys501.js therefore MUST
// check isMultivalueQuizRequest() BEFORE quizGenerator.isQuizRequest().
const STAGE1_TRIGGER = /\b(multi\s?-?quiz|multi\s?-?select\s?quiz|select all)\b/i;
// Same chapter/section/count grammar as quizGenerator_fys501.js (chapters 1-4).
const CHAPTER_HINT = /chapter\s?([1-4])|ch\.?\s?([1-4])/i;
const SECTION_HINT = /\b(?:section\s+)?([1-4])\.([1-9])\b/i;
const COUNT_HINT = /\b(\d{1,2})\s*(?:questions?)?\s*$/i;

const DEFAULT_COUNT = 5;
const MAX_COUNT = 15;

function isMultivalueQuizRequest(text) {
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
// so "multiquiz chapter 1" doesn't misread the "1" as a question count.
function extractRawCountHint(text) {
  const remainder = text.replace(SECTION_HINT, ' ').replace(CHAPTER_HINT, ' ');
  const m = remainder.match(COUNT_HINT);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// ---------- UI strings ----------
const UI = {
  askChapter: 'Which chapter would you like the multi-select quiz on? Try "multiquiz chapter 2" or "multiquiz section 2.3".',
  noSection: (section, chapter) =>
    `I don't have section ${section} for chapter ${chapter} — try "multiquiz chapter ${chapter}" instead.`,
  countCapped: (max) => `Let's start with ${max}, you can always ask for another round.`,
  startFailed: "Sorry, I couldn't put together a multi-select quiz for that right now — try again in a bit.",
  noQuestions: "I couldn't find or generate any multi-select questions for that section — try a different chapter/section.",
  generationPausedEmpty: "There are no ready-made multi-select questions for that section, and AI question generation is paused for today (daily allowance or shared capacity used up). Try another chapter/section, or come back tomorrow.",
  generationPausedPartial: (n, wanted) => `Only ${n} of ${wanted} questions are available right now — extra AI-generated questions are paused for today.`,
  question: (n, total) => `Question ${n}/${total}`,
  selectAllNote: 'Select ALL letters that apply, then tap Submit.',
  submitLabel: '\u2705 Submit answer',
  sessionExpired: 'Quiz session expired — start a new one with /mvquiz.',
  feedback: (score, lettersStr, explanation) => {
    if (score >= 1) return `\u2705 Correct! (${lettersStr})\n${explanation}`;
    if (score <= 0) return `\u274c 0.00/1.00 for this question. Correct answer(s): ${lettersStr}\n${explanation}`;
    return `\u2797 Partial credit: ${score.toFixed(2)}/1.00. Correct answer(s): ${lettersStr}\n${explanation}`;
  },
  complete: (score, total) =>
    `Multi-select quiz complete! Score: ${score.toFixed(2)}/${total.toFixed(2)} (${total > 0 ? Math.round((score / total) * 100) : 0}%)`,
  nothingSelected: 'Pick at least one letter before submitting.',
};

// Telegram HTML parse_mode requires <, > and & to be escaped. Laser physics
// question text is full of inequalities, so everything that comes from a
// question (stem, options, explanation) goes through this.
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Question validation ----------
// Structural check applied to both curated-bank and live-generated questions.
// Also normalises correctIndices (dedupe + sort) in place-safe fashion by
// returning a cleaned copy, or null if the question is unusable.
function normaliseQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  if (typeof q.stem !== 'string' || !q.stem.trim()) return null;
  if (!Array.isArray(q.options)) return null;
  if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) return null;
  if (!q.options.every((o) => typeof o === 'string' && o.trim())) return null;
  if (!Array.isArray(q.correctIndices)) return null;

  const idx = [...new Set(q.correctIndices)];
  if (!idx.every((i) => Number.isInteger(i) && i >= 0 && i < q.options.length)) return null;
  // Genuinely multi-valued: at least 2 correct, and at least 1 wrong option.
  if (idx.length < 2 || idx.length >= q.options.length) return null;

  return {
    ...q,
    correctIndices: idx.sort((a, b) => a - b),
    explanation: typeof q.explanation === 'string' ? q.explanation : '',
  };
}

// ---------- Session state ----------
// Separate Map from quizGenerator_fys501.js's quizSessions.
const SESSION_TTL_MS = 20 * 60 * 1000;
const mvQuizSessions = new Map(); // chatId -> { sid, questions, index, score, selected: Set, currentText, expiresAt }

function newSessionId() {
  return Math.random().toString(36).slice(2, 7);
}

function getSession(chatId) {
  const s = mvQuizSessions.get(chatId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    mvQuizSessions.delete(chatId);
    return null;
  }
  return s;
}

function createSession(chatId, questions) {
  const session = {
    sid: newSessionId(),
    questions,
    index: 0,
    score: 0,
    selected: new Set(), // selection for the CURRENT question only; cleared on advance
    currentText: '',
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  mvQuizSessions.set(chatId, session);
  return session;
}

// Tracks bank question ids recently served to each chat (separate from the
// single-select module's own tracking).
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
    const excess = set.size - RECENTLY_SERVED_MAX;
    const it = set.values();
    for (let i = 0; i < excess; i++) set.delete(it.next().value);
  }
}

function getRecentlyServed(chatId) {
  return recentlyServedIds.get(chatId) || new Set();
}

// ---------- bank access ----------
let _bankCache = null;

function loadQuizBank({ forceReload = false } = {}) {
  if (_bankCache !== null && !forceReload) return _bankCache;
  try {
    const raw = fs.readFileSync(QUIZ_BANK_PATH, 'utf8');
    _bankCache = JSON.parse(raw);
  } catch (e) {
    console.warn(`multivalueQuizGenerator_fys501: could not load multivalueQuizBank_fys501.json (${e.message}) — bank is empty, all quizzes will be live-generated`);
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
 * Draws up to `count` unused, structurally valid questions from
 * multivalueQuizBank_fys501.json for a chapter (+ optional section). No API call.
 * Bank schema: { "<chapter>": { "<chapter.section>": [ { id, stem, options,
 *   correctIndices, explanation, ... } ] } }
 * @returns {{ questions: object[], shortfall: number }}
 */
function sampleFromBank(chapter, section, count, excludeIds = []) {
  const bank = loadQuizBank();
  const chapterBank = bank[String(chapter)] || {};
  const exclude = new Set(excludeIds);

  const pool = section ? (chapterBank[section] || []).slice() : Object.values(chapterBank).flat();

  const available = pool
    .filter((q) => q && !exclude.has(q.id))
    .map(normaliseQuestion)
    .filter(Boolean);
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
// Railway). Either way every question is also logged to stdout (MVQUIZ_PENDING_QUESTION lines),
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
  console.warn(`multivalueQuizGenerator_fys501: pending file was unreadable — moved aside to ${backup}`);
}

function appendPendingQuestions(chapter, section, questions) {
  const generatedAt = new Date().toISOString();
  const entries = questions.map((q) => ({ chapter: String(chapter), section: section || null, question: q, generatedAt }));

  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const { entries: existing, corrupt } = readPending();
    if (corrupt) quarantineCorruptPending();
    if (existing.length + entries.length > PENDING_MAX) {
      console.warn(`multivalueQuizGenerator_fys501: pending file is full (${existing.length}/${PENDING_MAX}) — not persisting ${entries.length} new question(s) to the file; the log lines below still capture them`);
    } else {
      writeJsonAtomic(QUIZ_BANK_PENDING_PATH, existing.concat(entries));
    }
  } catch (e) {
    console.warn(`multivalueQuizGenerator_fys501: could not persist ${QUIZ_BANK_PENDING_PATH} (${e.message}) — relying on stdout log capture instead`);
  }

  // Structured log line, independent of the file write above, so a log-based capture
  // pipeline (Railway log export -> `node mergePending_fys501.js extract`) works even
  // if the filesystem doesn't persist.
  for (const entry of entries) {
    console.log(`MVQUIZ_PENDING_QUESTION ${JSON.stringify(entry)}`);
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
const QUIZ_SYSTEM_PROMPT = `You generate "select all that apply" multiple-choice quiz questions for a
graduate laser physics course (FYS.501 Laser Physics), grounded STRICTLY in the provided corpus excerpt. Rules:
- Do NOT invent facts outside the excerpt.
- Do NOT use any homework problems or numeric answer keys as source material.
- Each question must have MORE THAN ONE correct option, but NOT all options correct — mix
  true statements with plausible-but-wrong distractors (sign errors, swapped formulas,
  "always/never" overreach), 4-6 options total.
- Vary how many options are correct from question to question, and do not systematically
  put correct options first.
- End the stem with "(Select all that apply)".
- Write any mathematics as plain Unicode text, e.g. N₂ > (g₂/g₁)N₁ or |(A+D)/2| < 1 —
  no LaTeX, no dollar signs, no backslashes, no braces.
- Give a short (<50 word) explanation covering why each correct option is correct.
- Return ONLY valid JSON, no markdown fences, no preamble. Format:
  { "questions": [ { "stem": "... (Select all that apply)", "options": ["...","...","...","...","..."],
    "correctIndices": [0,2,3], "explanation": "..." } ] }`;

/**
 * Live-generates up to `count` multi-answer questions, scoped to a chapter
 * (and, if given, a section) via getCorpusSection(). Throws if the excerpt
 * can't be found or nothing usable comes back — callers catch and degrade
 * gracefully (see getQuizQuestions).
 */
async function generateQuiz(chapter, section, count = 5) {
  const corpusExcerpt = getCorpusSection(chapter, section || undefined);

  const scopeLabel = section ? `Section ${section}` : `Chapter ${chapter}`;
  const response = await limiter.trackedCreate(anthropic, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1800,
    system: QUIZ_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Generate ${count} "select all that apply" questions from this excerpt (${scopeLabel}):\n\n${corpusExcerpt}`,
      },
    ],
  });

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (err) {
    throw new Error(`Multivalue quiz generation returned unparseable JSON: ${err.message}`);
  }

  if (!parsed.questions || !parsed.questions.length) {
    throw new Error('Multivalue quiz generation returned no questions');
  }

  // Defensive sanity check: drop any generated question that isn't
  // structurally valid or genuinely multi-valued, since a live LLM call can
  // still slip up despite the system prompt's rules.
  const sane = parsed.questions.map(normaliseQuestion).filter(Boolean);
  if (!sane.length) {
    throw new Error('Multivalue quiz generation returned no valid multi-answer questions');
  }

  return sane;
}

/**
 * "Give me N questions for chapter/section X". Bank-first, live-generation
 * fallback for the shortfall only, with self-expansion of freshly generated
 * questions into the pending file.
 */
async function getQuizQuestions(chatId, chapter, section, count, userId = chatId) {
  const excludeIds = getRecentlyServed(chatId);
  const { questions: bankQuestions, shortfall } = sampleFromBank(chapter, section, count, excludeIds);

  markServed(chatId, bankQuestions.map((q) => q.id));

  if (shortfall === 0) {
    return bankQuestions;
  }

  // Graceful degradation: live generation costs LLM credits (bank-served questions are
  // free). If the student's daily allowance or the shared daily backstop is used up,
  // serve the bank questions only and tell startMultivalueQuiz() why via a flag.
  const gate = limiter.reserve(userId, 'quiz');
  if (!gate.ok) {
    console.log(`multivalueQuizGenerator_fys501: live generation skipped (${gate.reason}) — serving ${bankQuestions.length}/${count} from the bank only`);
    bankQuestions.generationSkipped = gate.reason;
    return bankQuestions;
  }

  let generated = [];
  try {
    generated = await generateQuiz(chapter, section, shortfall);
  } catch (err) {
    limiter.refund(userId, gate.cost);
    console.warn(`multivalueQuizGenerator_fys501: live fallback generation failed (${err.message}) — serving ${bankQuestions.length}/${count} from the bank only`);
    return bankQuestions;
  }

  const stamped = generated.map((q, i) => ({
    ...q,
    id: `mvgen_${chapter}${section ? '.' + section.split('.')[1] : ''}_${Date.now()}_${i}`,
  }));

  appendPendingQuestions(chapter, section, stamped);

  return bankQuestions.concat(stamped);
}

// ---------- Telegram-facing helpers ----------

// Buttons show ONLY the letter (A, B, C, ...), never the option text, so
// Telegram never truncates/concatenates long option wording onto a button.
// A checkmark prefix reflects the toggle state; the final row is Submit.
// callback_data: "mv:<sid>:<questionIndex>:t:<optionIndex>" (toggle) or
//                "mv:<sid>:<questionIndex>:s" (submit)  — well under 64 bytes.
function buildQuestionKeyboard(sid, questionIndex, question, selected) {
  const letterButtons = question.options.map((_, i) => ({
    text: selected.has(i) ? `\u2705 ${LETTERS[i]}` : LETTERS[i],
    callback_data: `mv:${sid}:${questionIndex}:t:${i}`,
  }));
  // Two letters per row keeps the keyboard compact for 4-6 options.
  const rows = [];
  for (let i = 0; i < letterButtons.length; i += 2) {
    rows.push(letterButtons.slice(i, i + 2));
  }
  rows.push([{ text: UI.submitLabel, callback_data: `mv:${sid}:${questionIndex}:s` }]);
  return { inline_keyboard: rows };
}

// The option TEXT lives here, in the message body, lettered A)/B)/C)/... —
// never on a button. HTML-escaped, since the message is sent with parse_mode HTML.
function formatQuestionMessage(question, qNumber, total) {
  const optionLines = question.options
    .map((opt, i) => `<b>${LETTERS[i]})</b> ${escapeHtml(opt)}`)
    .join('\n');
  return (
    `<b>${UI.question(qNumber, total)}</b>\n\n${escapeHtml(question.stem)}\n\n${optionLines}\n\n` +
    `<i>${UI.selectAllNote}</i>`
  );
}

// Fallback used when the caller doesn't supply its own askWhichChapter.
// bot_fys501.js injects an inline-keyboard picker (askWhichChapterMv) instead.
async function defaultAskWhichChapter(bot, chatId) {
  await bot.sendMessage(chatId, UI.askChapter);
  return null;
}

async function sendQuestion(bot, chatId, session) {
  session.selected = new Set(); // fresh selection for this question
  const question = session.questions[session.index];
  const text = formatQuestionMessage(question, session.index + 1, session.questions.length);
  // Keep the exact text we sent so toggle taps can re-render the keyboard via
  // editMessageText without changing the message body.
  session.currentText = text;
  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: buildQuestionKeyboard(session.sid, session.index, question, session.selected),
  });
}

// Called from bot_fys501.js when isMultivalueQuizRequest(text) is true, from
// the /mvquiz command (with text rewritten to "multiquiz <rest>"), and from
// the "mvquizchapter:N" picker callback (text "multiquiz chapter N").
// `askWhichChapter(bot, chatId)` is called when the request doesn't name a
// chapter/section; it should prompt the student and return null.
async function startMultivalueQuiz(bot, chatId, text, askWhichChapter = defaultAskWhichChapter, userId = chatId) {
  const chapter = extractChapterHint(text) || (await askWhichChapter(bot, chatId));
  if (!chapter) return;

  const section = extractSectionHint(text); // null => chapter-wide request
  if (section && !corpusLoader.isValidSection(chapter, section)) {
    await bot.sendMessage(chatId, UI.noSection(section, chapter));
    return;
  }

  const rawCount = extractRawCountHint(text);
  const requestedCount = rawCount === null ? DEFAULT_COUNT : Math.min(rawCount, MAX_COUNT);
  if (rawCount !== null && rawCount > MAX_COUNT) {
    await bot.sendMessage(chatId, UI.countCapped(MAX_COUNT));
  }

  let questions;
  try {
    questions = await getQuizQuestions(chatId, chapter, section, requestedCount, userId);
  } catch (err) {
    console.error(`multivalueQuizGenerator_fys501: startMultivalueQuiz failed for chapter ${chapter}${section ? '.' + section : ''}: ${err.message}`);
    await bot.sendMessage(chatId, UI.startFailed);
    return;
  }

  if (!questions.length) {
    await bot.sendMessage(chatId, questions.generationSkipped ? UI.generationPausedEmpty : UI.noQuestions);
    return;
  }
  if (questions.generationSkipped && questions.length < requestedCount) {
    await bot.sendMessage(chatId, UI.generationPausedPartial(questions.length, requestedCount));
  }

  const session = createSession(chatId, questions);
  await sendQuestion(bot, chatId, session);
}

// Partial-credit grading, floored at 0 per question (see file header).
function gradeSelection(selected, correctIndices, totalOptions) {
  const correctSet = new Set(correctIndices);
  const k = correctIndices.length;
  const wrongPoolSize = totalOptions - k;

  let c = 0;
  let w = 0;
  for (const idx of selected) {
    if (correctSet.has(idx)) c += 1;
    else w += 1;
  }

  const positiveTerm = k > 0 ? c / k : 0;
  const negativeTerm = wrongPoolSize > 0 ? w / wrongPoolSize : 0;
  return Math.max(0, positiveTerm - negativeTerm);
}

function lettersFromIndices(indices) {
  return indices
    .slice()
    .sort((a, b) => a - b)
    .map((i) => LETTERS[i])
    .join(', ');
}

// Called from bot_fys501.js's callback_query dispatch when data starts with "mv:".
async function handleMultivalueQuizAnswer(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const parts = callbackQuery.data.split(':'); // ["mv", sid, qIndexStr, action, optIdxStr?]
  const sid = parts[1];
  const qIndex = parseInt(parts[2], 10);
  const action = parts[3];

  const session = getSession(chatId);
  if (!session || session.sid !== sid) {
    // No live quiz, or this keyboard belongs to an earlier/replaced quiz.
    await bot.answerCallbackQuery(callbackQuery.id, { text: UI.sessionExpired });
    return;
  }
  if (qIndex !== session.index) {
    // Keyboard for a question that's already been graded (e.g. a double-tap
    // on Submit) — acknowledge silently.
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS; // sliding TTL
  const question = session.questions[qIndex];

  if (action === 't') {
    const optIdx = parseInt(parts[4], 10);
    if (!Number.isInteger(optIdx) || optIdx < 0 || optIdx >= question.options.length) {
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    if (session.selected.has(optIdx)) session.selected.delete(optIdx);
    else session.selected.add(optIdx);

    await bot.editMessageText(session.currentText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: buildQuestionKeyboard(session.sid, qIndex, question, session.selected),
    });
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (action === 's') {
    if (session.selected.size === 0) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: UI.nothingSelected });
      return;
    }

    const score = gradeSelection(session.selected, question.correctIndices, question.options.length);
    const answeredText = session.currentText;

    // Advance state SYNCHRONOUSLY, before any await, so a second rapid tap on
    // Submit fails the qIndex check above instead of double-counting.
    session.score += score;
    session.index += 1;
    const finished = session.index >= session.questions.length;
    const finalScore = session.score;
    const total = session.questions.length;
    if (finished) mvQuizSessions.delete(chatId);

    const feedback = UI.feedback(
      score,
      lettersFromIndices(question.correctIndices),
      escapeHtml(question.explanation)
    );

    await bot.editMessageText(`${answeredText}\n\n${feedback}`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }, // lock the keyboard once graded
    });
    await bot.answerCallbackQuery(callbackQuery.id);

    if (!finished) {
      await sendQuestion(bot, chatId, session);
    } else {
      await bot.sendMessage(chatId, UI.complete(finalScore, total));
    }
    return;
  }

  // Unknown action — ack silently so Telegram doesn't show a spinner forever.
  await bot.answerCallbackQuery(callbackQuery.id);
}

module.exports = {
  isMultivalueQuizRequest,
  startMultivalueQuiz,
  handleMultivalueQuizAnswer,
  // exported for mergePending_fys501.js, /pending and tests
  generateQuiz,
  sampleFromBank,
  getQuizQuestions,
  loadQuizBank,
  quizBankLooksHealthy,
  extractChapterHint,
  extractSectionHint,
  extractRawCountHint,
  gradeSelection,
  normaliseQuestion,
  pendingSummary,
  clearPending,
  readPending,
};

/* INTEGRATION NOTES — see MULTIVALUE_QUIZ_INTEGRATION_fys501.md for the full
 * checklist of bot_fys501.js changes. Summary:
 *
 *   const mvQuizGenerator = require('./multivalueQuizGenerator_fys501');
 *
 *   // message handler — MUST come BEFORE quizGenerator.isQuizRequest():
 *   if (mvQuizGenerator.isMultivalueQuizRequest(question)) {
 *     return mvQuizGenerator.startMultivalueQuiz(quizBot, chatId, question, askWhichChapterMv);
 *   }
 *
 *   // callback_query dispatch:
 *   if (data.startsWith('mv:')) return mvQuizGenerator.handleMultivalueQuizAnswer(quizBot, cq);
 *   if (data.startsWith('mvquizchapter:')) { ... startMultivalueQuiz(... `multiquiz chapter ${N}` ...) }
 *
 *   // /healthz:
 *   multivalueQuizBankLooksHealthy: mvQuizGenerator.quizBankLooksHealthy()
 */
