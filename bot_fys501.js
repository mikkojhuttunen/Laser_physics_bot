/**
 * FYS.501 Laser Physics — Telegram teaching-assistant bot
 * ============================================================================
 * VERSION: see BOT_VERSION below. Bump it (semver: MAJOR.MINOR.PATCH) any
 * time you ship a change here, and add a line to the CHANGELOG block —
 * that's the whole versioning process, no build step needed. Convention
 * (matches the FYS.240 Optics bot): MAJOR = breaking change to a command's
 * behavior or removed a feature, MINOR = new command/feature, PATCH =
 * bugfix/content fix with no new command. BOT_VERSION is surfaced in
 * /healthz and the startup log line, so you can always confirm which
 * version is actually live on Railway.
 * ============================================================================
 *
 * CURRENT FUNCTIONALITY (v1.5.0):
 *   Key differences from the crashing version:
 *     1. Course material is sent as CACHED TEXT in the system prompt, not as 11 PDFs
 *        re-uploaded on every single message.
 *     2. Telegram is acknowledged (HTTP 200) IMMEDIATELY, before Claude is called.
 *        This is what stopped the webhook-retry storm that was killing the container.
 *     3. Duplicate updates, long replies, rate limits and API errors are all handled.
 *
 * HOMEWORK-HELPER COMMANDS:
 *   /HW3          — overview: lists the problems in Homework 3 (free — served
 *                   from homework_problems_fys501.json when available)
 *   /HW3.2        — hint on Homework 3, problem 2 (equation/section pointer + guiding
 *                   question; AI-backed, members only — see ACCESS CONTROL below)
 *   /HW_hint3.2   — minimal nudge: one guiding question, nothing else (AI-backed)
 *   photo message — quick "right track / wrong track" read on a work-in-progress photo
 *                   (AI-backed); caption it with a problem reference (e.g. "/HW3.2")
 *                   for best results.
 *   None of these reveal solutions — same no-solutions rule as the rest of the bot.
 *
 * QUIZ COMMANDS (AI-backed — members only, see ACCESS CONTROL below):
 *   /quiz [chapter N | N.M] [count]      — explicit command (added v1.5.0), same engine as
 *                                          the free-text trigger below (quizGenerator_fys501.js).
 *                                          "/quiz", "/quiz chapter 2", "/quiz 2.3", "/quiz 2 8"
 *                                          are all accepted (normalizeQuizArgs turns a bare
 *                                          "2" or "2 8" into "chapter 2"/"chapter 2 8" first).
 *   "quiz me on chapter 2" / "quiz me on section 2.3" — same thing as free text, no command needed
 *   /mvquiz [chapter N | N.M] [count]    — "select all that apply" multi-answer quiz, a SEPARATE
 *                                          add-on (multivalueQuizGenerator_fys501.js) with its own
 *                                          bank, session state and callback_data namespace
 *                                          ("mv:...", "mvquizchapter:..."). Also triggered by the
 *                                          phrases "multiquiz" / "multi-select quiz" / "select all".
 *   Grading taps (picking an answer / hitting Submit) are always free — no membership
 *   check, no credit cost — since they don't call Claude, only score against the
 *   question already served. Starting a NEW quiz (command, free-text trigger, or a
 *   chapter-picker tap) is the AI-backed step and is what's gated.
 *
 * LECTURE LISTING (free — deterministic, no Claude call):
 *   /lectures and /topics are identical aliases (full week-by-week video listing).
 *   /week1 ... /week6 (added v1.3.0) — a single week's videos, same data
 *   (lecture_data_fys501.json) and formatter (lectureLinks.formatWeekMessage) that
 *   /lectures uses for the full listing. Mirrors the FYS.240 Optics bot's /weekN.
 *   Free-text lecture lookups ("any video on gain saturation?", "recording for
 *   week 3?") are also free, including the Stage-2 LLM classifier call in
 *   lectureClassifier_fys501.js — that call is billed to the shared daily backstop,
 *   not to any student's personal credit allowance, same as it always has been.
 *
 * GLOSSARY (added v1.4.0 — free, deterministic, no Claude call):
 *   /define <term> — looks the term up in terminology_fys501.json (438 terms,
 *   auto-harvested from the lecture .tex sources) via corpusLoader_fys501.js's
 *   findGlossaryTerms(), and replies with the term's definition-in-context, the
 *   section it was introduced in, and a link to that lecture video. Mirrors the
 *   FYS.240 Optics bot's /define, including its course-mismatch guard
 *   (looksLikeWrongCourseGlossary/glossaryCourseMismatch, direction reversed —
 *   here the risk is FYS.240 Optics content leaking into this glossary, not the
 *   other way around). This was already wired up as far as corpusLoader_fys501.js
 *   (its own header comment says "backs the /define command in bot_fys501.js"),
 *   just never actually connected here until now.
 *
 * ACCESS CONTROL / COST LIMITS (membership.js, usageLimiter.js, accessGuard.js):
 *   - Open bot (v1.2.0): commands, lecture links (including keyword lookups and
 *     /weekN), /define (added v1.4.0), /HW overviews served from structured data, and
 *     quiz-answer grading taps all work for EVERYONE, member or not. Only the AI-backed actions — free-text
 *     Q&A, /HW hints, the photo work-check, and starting a quiz (command, free-text
 *     trigger, or chapter-picker tap) — require membership of the private course
 *     channel (COURSE_CHANNEL_ID; unset = everyone is a member).
 *   - Every AI-backed action that DOES check membership also costs credits from a
 *     per-student daily allowance (STUDENT_LLM_DAILY_USAGE) — except quiz starts,
 *     which are membership-gated but not yet credit-metered; see the KNOWN GAPS note
 *     below.
 *   - DAILY_BACKSTOP_EUR pauses all per-student LLM calls once the estimated daily
 *     spend is reached. The free-text lecture classifier keeps working even then —
 *     it just falls back to local keyword matching if the backstop is active.
 *   - /usage shows the student's remaining allowance (free, no LLM call).
 *
 * QUIZ ANALYTICS (added v1.6.0 — free, deterministic, no Claude call; OFF unless configured):
 *   Each graded quiz answer is recorded as one pseudonymous event (keyed hash of the Telegram id,
 *   question, chosen option(s), correct or not, date) so the instructor can see which sections,
 *   concepts and misconceptions are hard and focus on-site discussion sessions on them.
 *   /privacy, /optout, /optin — for everyone: what is recorded; stop recording + delete own events.
 *   /quizstats [sections|concepts|misconceptions|questions] [live] | export | clear confirm —
 *   ADMIN_USER_IDS only (silently ignored for everyone else, not listed in /help).
 *   Needs ANALYTICS_HASH_SECRET (16+ chars) to switch on; QUIZ_ANALYTICS_DIR (a Railway volume)
 *   to keep events across redeploys. Modules: quizAnalytics_fys501.js (logging),
 *   quizStats_fys501.js (analysis + CLI), quizAnalyticsCommands_fys501.js (the commands above),
 *   validateQuizTags_fys501.js / tagQuizBank_fys501.js (concept + misconception tags on banks).
 *   Full description: QUIZ_ANALYTICS_fys501.md.
 *
 * DEV INTROSPECTION (added v1.5.0 — free, deterministic, no Claude call):
 *   /source_materials, /source_HW, /source_quizzes — plain-text diagnostic reports on
 *   which data the running bot actually loaded (file sizes, mod-times, health checks,
 *   per-chapter question counts, course-content sanity scans). Not listed in HELP_TEXT
 *   or /start, but not access-restricted either — same as every other command here.
 *   Ported from the FYS.240 Optics bot's identically-named commands (CHANGELOG v2.6.1);
 *   see sendDiagnosticReport()'s comment for why these bypass the normal reply pipeline.
 *
 * KNOWN GAPS (not yet implemented):
 *   - Quiz generation has no bank-vs-live-generation credit split yet (unlike the
 *     FYS.240 Optics bot's v2.7.0 hooks-based reserve()/refund()): a live-generated
 *     quiz question costs the same nothing as a bank-served one, right now — only
 *     membership is checked before a quiz starts. Retrofitting quizGenerator_fys501.js
 *     and multivalueQuizGenerator_fys501.js with the same hooks contract as the Optics
 *     bot's generators would close this gap; deliberately left out of v1.2.0 to keep
 *     that change focused on the access-model split.
 *   - homework_problems_fys501.json has no course-mismatch guard (unlike terminology_fys501.json,
 *     which got one in v1.4.0) — /source_HW reports its problem counts but can't flag a
 *     wrong-course file the way /source_materials can for the corpus and glossary.
 *
 * CHANGELOG:
 *   v1.6.0 — Quiz analytics: records one pseudonymous event per graded answer (single- and
 *            multi-select), with /privacy, /optout, /optin for students and admin-only
 *            /quizstats (briefing, export, clear). Optional per-question `concepts`, per-option
 *            `optionTags` (misconception ids) and `version` fields in the quiz banks, checked by
 *            validateQuizTags_fys501.js and added with tagQuizBank_fys501.js; untagged questions
 *            keep working. Off unless ANALYTICS_HASH_SECRET is set. /healthz reports
 *            quizAnalytics, /source_quizzes reports tag coverage.
 *   v1.5.0 — Added /source_materials, /source_HW, /source_quizzes (ported from the
 *            FYS.240 Optics bot's v2.6.1 commands, adapted for this bot's data files —
 *            no bilingual dimension, no separate homework_solutions.json to report on).
 *            Also added an explicit /quiz command (previously only reachable via
 *            free-text "quiz me on..."), with a normalizeQuizArgs() helper so a bare
 *            "/quiz 2 8" is understood as chapter 2, 8 questions, matching the Optics
 *            bot's /quiz UX. Both new source_* commands and /quiz follow the same
 *            access-model rules already in place: source_* are free (read-only
 *            diagnostics), /quiz is membership-gated the same as /mvquiz and the
 *            free-text quiz triggers.
 *   v1.4.0 — Added /define <term>, wiring up corpusLoader_fys501.js's
 *            findGlossaryTerms()/glossaryLooksHealthy() against terminology_fys501.json
 *            (438 terms) — both already existed and were already exported (that file's
 *            own comment says "backs the /define command in bot_fys501.js"), just never
 *            actually connected here. Also added a course-mismatch guard
 *            (looksLikeWrongCourseGlossary/glossaryCourseMismatch) to corpusLoader_fys501.js,
 *            mirroring the FYS.240 Optics bot's v2.4.0/v2.6.1 guard, direction reversed —
 *            refuses to serve the glossary if it looks like FYS.240 Optics content instead
 *            of Laser Physics. Confirmed NOT firing on the current terminology_fys501.json
 *            (all 438 entries correctly tagged Laser Physics). Free — deterministic, no
 *            Claude call, no membership check, same as /lectures. /healthz now reports
 *            glossaryCourseMismatch alongside the existing health flags.
 *   v1.3.0 — Added /week1 ... /week6, deterministic (no Claude call), reusing
 *            lectureLinks.getWeekLectures()/formatWeekMessage() — the same data and
 *            formatter /lectures already uses for the full listing. Mirrors the
 *            FYS.240 Optics bot's /weekN. Free for everyone, same as /lectures.
 *   v1.2.0 — Opened the bot up (mirrors the FYS.240 Optics bot's v2.7.0/2.7.1 access
 *            model): removed the single blanket requireMember() check that used to run
 *            at the top of every message before anything else. Deterministic replies
 *            (start/help, reset, usage, lectures/topics, /HW overviews from structured
 *            data, /pending, quiz-answer grading taps) no longer require membership.
 *            Membership is now checked individually, right at each AI-backed call site:
 *            free-text Q&A, /HW hints (both full and minimal), the photo work-check,
 *            and quiz starts (the explicit /mvquiz command, the free-text "quiz me" /
 *            "multiquiz" triggers, and the two chapter-picker callback taps). Grading
 *            taps stay ungated since they don't call Claude. No change to what counts
 *            as a "member" or how credits are spent — this only relocates *where* the
 *            check happens, from "before every message" to "before every AI call."
 *   v1.1.0 — Added BOT_VERSION + this changelog (matching the FYS.240 Optics bot's
 *            v2.2.0 convention). No behavior change.
 *   (earlier history predates version tracking)
 */

const BOT_VERSION = "1.6.0";

const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const quizGenerator = require("./quizGenerator_fys501");
const mvQuizGenerator = require("./multivalueQuizGenerator_fys501");
const pendingAdmin = require("./pendingAdmin_fys501");
const corpusLoader = require("./corpusLoader_fys501");
const lectureLinks = require("./lectureLinks_fys501");
const limiter = require("./usageLimiter");
const quizAnalytics = require("./quizAnalytics_fys501");
const quizAnalyticsCommands = require("./quizAnalyticsCommands_fys501");
const { coverageSummary: quizTagCoverage } = require("./validateQuizTags_fys501");
const { requireMember, requireLLMBudget, maybeWarnLow, refundLLM, usageText, MSG } = require("./accessGuard");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------- config ----
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";        // optional, see README
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const CACHE_TTL = process.env.CACHE_TTL || "1h";                // "1h" or "5m"
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "900", 10);
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "").toLowerCase();

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ------------------------------------------------------- course material ----
// Loaded ONCE at startup. Regenerate with `node build_corpus.js` if the PDFs change.
const CORPUS_PATH = path.join(__dirname, "course_corpus_fys501.txt");
let COURSE_CORPUS = "";
try {
  COURSE_CORPUS = fs.readFileSync(CORPUS_PATH, "utf8");
  console.log(
    `Loaded course corpus: ${COURSE_CORPUS.length.toLocaleString()} chars ` +
    `(~${Math.round(COURSE_CORPUS.length / 3.7).toLocaleString()} tokens)`
  );
} catch (e) {
  console.error(`FATAL: could not read ${CORPUS_PATH} — ${e.message}`);
  console.error("The bot will still start but will have no course knowledge.");
}

// Exact per-problem text, keyed "<hw>" -> "<problem>" -> text, e.g. HOMEWORK_PROBLEMS["1"]["2"].
// Built by build_corpus.js from problems numbered "<hw>.<n>" in the HW PDFs.
// Optional: if missing/empty, /HW commands fall back to letting Claude search the full corpus.
const HW_PROBLEMS_PATH = path.join(__dirname, "homework_problems_fys501.json");
let HOMEWORK_PROBLEMS = {};
try {
  HOMEWORK_PROBLEMS = JSON.parse(fs.readFileSync(HW_PROBLEMS_PATH, "utf8"));
  const total = Object.values(HOMEWORK_PROBLEMS).reduce((n, hw) => n + Object.keys(hw).length, 0);
  console.log(`Loaded homework_problems_fys501.json: ${total} problems across ${Object.keys(HOMEWORK_PROBLEMS).length} homeworks`);
} catch (e) {
  console.log(`No homework_problems_fys501.json found (${e.code || e.message}) — /HW commands will fall back to full-corpus search.`);
}

// Paths referenced only by /source_materials, /source_HW, /source_quizzes
// (v1.5.0) — each generator/loader module keeps its own copy of these
// internally (needed to actually read the files); these are just for the
// diagnostic reports below to stat() the same files.
const TERMINOLOGY_PATH = path.join(__dirname, "terminology_fys501.json");
const LECTURE_DATA_PATH = path.join(__dirname, "lecture_data_fys501.json");
const QUIZ_PENDING_DIR = process.env.QUIZ_PENDING_DIR || __dirname;
const QUIZ_BANK_PATH = path.join(__dirname, "quizBank_fys501.json");
const QUIZ_BANK_PENDING_PATH = path.join(QUIZ_PENDING_DIR, "quizBankPending_fys501.json");
const MV_QUIZ_BANK_PATH = path.join(__dirname, "multivalueQuizBank_fys501.json");
const MV_QUIZ_BANK_PENDING_PATH = path.join(QUIZ_PENDING_DIR, "multivalueQuizBankPending_fys501.json");

// Lecture video links, keyed by week (lecture_data-2.json). Loaded once at
// startup, same pattern as the corpus and homework problems above.
lectureLinks.loadLectureData();


const TA_INSTRUCTIONS = `You are the teaching assistant bot for FYS.501 Laser Physics, answering in Telegram.

WHAT YOU KNOW
Course material: lecture slides, textbook Chapters 1–4, homework assignment sheets. Ground answers in this material and cite which chapter/section. You do NOT have homework solutions.

HOW TO ANSWER — ABSOLUTE RULES
1. **LENGTH**: ONE OR TWO SHORT SENTENCES/PARAGRAPH ONLY. Never use section headers, bullets, tables, or sub-points. No "Step 1, Step 2". No "Key insight:". Just talk to them like a person.

2. **HOMEWORK**: Give hints, not answers. Name the relevant equation or concept, point to the section, ask ONE guiding question. Example: "That uses the lensmaker's equation from Chapter 3.2. What happens when you set d→0?" Don't explain the whole path.

3. **CONCEPTUAL**: Answer directly and briefly. Full but concise. If someone asks "what is stimulated emission?", answer it in 2 sentences.

4. **MATH NOTATION** — CRITICAL:
   - Use UNICODE SYMBOLS ONLY: α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω
   - Use superscript ¹²³⁴ for exponents, subscript ₁₂₃₄ for indices
   - Write fractions as: a/b or use ÷
   - Write as inline text: "q = hc(1/λₚ - 1/λ₀)" NOT "q = hc\\left(\\frac{1}{\\lambda_p}..."
   - NO dollar signs $...$ anywhere, NO backslashes, NO braces {}
   - Acceptable for complex expressions: "N₂ > (g₂/g₁)N₁" or "(ω - ω₀)/Δω"

5. **STUDENT ATTEMPTS**: If they show work, check it quickly, point at one specific error if there is one. Don't rewrite the whole thing.

6. **REDIRECT**: If it's outside course scope, say "That's beyond FYS.501, ask Mikko" (don't lecture).

7. **LANGUAGE**: Respond in the language they use (English or Finnish).

WHEN TO SUGGEST VIDEOS
If a student asks a conceptual or homework question that's covered in a lecture video, weave in the relevant one:
- Check the <video_lectures> list below for a title matching the topic
- Write it as a Markdown link with the video title as the clickable label, e.g.:
  "That's covered in [Laser Physics 3.2 — Cavity Modes](https://youtube.com/watch?v=abc123)."
- ALWAYS use this exact [Title](URL) format — never write the raw URL on its own, after a colon, or after a dash
- Don't force a link where none genuinely fits; one relevant link is usually enough

TONE: Encouraging, conversational, brief. These are hard topics; students asking are doing the right thing.`;

/**
 * Format the lecture video database for inclusion in the system prompt, so
 * Claude can weave a relevant [Title](URL) link into an ordinary conceptual
 * answer — same pattern as the FYS.240 bot's formatVideoDatabase(). This is
 * separate from lectureLinks.js's own STAGE1_TRIGGER path, which still
 * handles explicit "any video on X?" / "/lectures" requests deterministically
 * without involving Claude.
 */
function formatVideoDatabase() {
  const weeks = lectureLinks.getAllWeeks();
  if (!weeks.length) return "";
  let context = "\n<video_lectures>\n";
  context += "## FYS.501 Laser Physics - Lecture Videos\n\n";
  weeks.forEach((week) => {
    week.lectures.forEach((lec) => {
      context += `Week ${week.week} (${week.topic}): ${lec.title} - ${lec.url}\n`;
    });
  });
  context += "\n</video_lectures>\n";
  return context;
}

function buildSystemBlocks() {
  const blocks = [{ type: "text", text: TA_INSTRUCTIONS }];

  const videoContext = formatVideoDatabase();
  if (videoContext) {
    blocks.push({ type: "text", text: videoContext });
  }

  if (COURSE_CORPUS) {
    blocks.push({
      // The big, unchanging block goes LAST and carries the cache breakpoint,
      // so it is billed at the cheap cache-read rate on every subsequent call.
      type: "text",
      text: `<course_material>\n${COURSE_CORPUS}\n</course_material>`,
      cache_control:
        CACHE_TTL === "1h"
          ? { type: "ephemeral", ttl: "1h" }
          : { type: "ephemeral" },
    });
  }
  return blocks;
}
const SYSTEM_BLOCKS = buildSystemBlocks();

const ANTHROPIC_HEADERS = {
  "x-api-key": ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
  ...(CACHE_TTL === "1h" ? { "anthropic-beta": "extended-cache-ttl-2025-04-11" } : {}),
};

// ------------------------------------------------------- tiny state store ----
const seenUpdates = new Set();           // de-duplicate Telegram retries
const history = new Map();               // chatId -> [{role, content}, ...]
const lastCall = new Map();              // userId -> timestamp (rate limit)
const HISTORY_TURNS = 6;                 // 3 exchanges
const MIN_INTERVAL_MS = 4000;

function remember(chatId, role, content) {
  const h = history.get(chatId) || [];
  h.push({ role, content });
  history.set(chatId, h.slice(-HISTORY_TURNS));
}

// ------------------------------------------------------------- telegram -----
async function tg(method, payload) {
  return axios.post(`${TELEGRAM_API}/${method}`, payload, { timeout: 15000 });
}

// Sends a local file as a Telegram document (multipart upload; Node >= 18 provides
// fetch / FormData / Blob globally). Used by the admin-only /pending export.
async function tgSendDocument(chatId, filePath, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([fs.readFileSync(filePath)], { type: "application/json" }), filename);
  const res = await fetch(`${TELEGRAM_API}/sendDocument`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Telegram sendDocument failed: HTTP ${res.status}`);
}

// Converts one run of Unicode Mathematical Alphanumeric characters for a
// given style. Digits have no dedicated "italic" codepoints in Unicode, so
// italic digits are left as plain ASCII; lowercase italic "h" has no
// codepoint of its own either (Unicode reserves that slot), so it maps to
// the pre-existing PLANCK CONSTANT compatibility character (ℎ, U+210E)
// instead, which is the standard workaround.
function toMathUnicode(inner, style) {
  let out = "";
  for (const ch of inner) {
    const code = ch.codePointAt(0);
    if (style === "bold") {
      if (code >= 0x41 && code <= 0x5a) out += String.fromCodePoint(0x1d400 + (code - 0x41));      // A-Z
      else if (code >= 0x61 && code <= 0x7a) out += String.fromCodePoint(0x1d41a + (code - 0x61)); // a-z
      else if (code >= 0x30 && code <= 0x39) out += String.fromCodePoint(0x1d7ce + (code - 0x30)); // 0-9
      else out += ch;
    } else if (style === "italic") {
      if (ch === "h") out += "\u210e";                                                             // italic h exception
      else if (code >= 0x41 && code <= 0x5a) out += String.fromCodePoint(0x1d434 + (code - 0x41));  // A-Z
      else if (code >= 0x61 && code <= 0x7a) out += String.fromCodePoint(0x1d44e + (code - 0x61));  // a-z
      else out += ch;                                                                               // no italic digits exist
    } else { // "bolditalic"
      if (code >= 0x41 && code <= 0x5a) out += String.fromCodePoint(0x1d468 + (code - 0x41));      // A-Z
      else if (code >= 0x61 && code <= 0x7a) out += String.fromCodePoint(0x1d482 + (code - 0x61)); // a-z
      else if (code >= 0x30 && code <= 0x39) out += String.fromCodePoint(0x1d7ce + (code - 0x30)); // 0-9 (reuses bold digits)
      else out += ch;
    }
  }
  return out;
}

// Converts Claude's Markdown emphasis into real Unicode styled characters,
// since Telegram is sent parse_mode "HTML" here and asterisks otherwise show
// up literally to students. Claude reaches for both "*single*" (italic) and
// "**double**" (bold) inconsistently for emphasizing symbols/variable names
// (e.g. *N_i*, **A**, **B**), so both are handled, plus "***triple***" for
// completeness. Order matters: match longest marker first, since by the time
// we get to the single-* pass, all ** and *** runs have already been
// replaced with plain Unicode characters (no asterisks left to confuse it).
function markdownEmphasisToUnicode(text) {
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_, inner) => toMathUnicode(inner, "bolditalic"));
  text = text.replace(/\*\*(.+?)\*\*/g, (_, inner) => toMathUnicode(inner, "bold"));
  text = text.replace(/\*(.+?)\*/g, (_, inner) => toMathUnicode(inner, "italic"));
  return text;
}

// Escapes text for safe use inside a Telegram HTML parse_mode message.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Converts any "[label](url)" Markdown links in Claude's text into real
// Telegram HTML <a> tags, and HTML-escapes everything else in the chunk so
// it's safe to send with parse_mode: "HTML". Links are pulled out into
// placeholders BEFORE escaping so neither the label nor the URL get their
// &/</> characters mangled, then the <a> tags are spliced back in after.
// NOTE: Claude is never given lecture video URLs in this bot (that's kept
// deterministic via lectureLinks.js/lectureClassifier.js on purpose), so
// this is a safety net for any incidental link Claude's text ends up with
// (e.g. quoting something from the corpus) rather than a video-suggestion
// feature — it just means such a link renders as clickable text instead of
// literal brackets, same fix as the FYS.240 bot.
function convertLinksAndEscape(text) {
  const links = [];
  const withPlaceholders = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => {
      links.push({ label, url });
      return `\u0000${links.length - 1}\u0000`;
    }
  );
  let escaped = escapeHtml(withPlaceholders);
  links.forEach((link, i) => {
    const anchor = `<a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`;
    escaped = escaped.replace(`\u0000${i}\u0000`, anchor);
  });
  return escaped;
}

async function sendMessage(chatId, text, replyTo, parseMode) {
  // Callers that already built final HTML themselves (lectureLinks output,
  // etc.) pass parseMode: "HTML" explicitly and are sent as-is below. Any
  // other call is raw text (Claude's replies, plain status strings) that
  // may contain a Markdown "[label](url)" link — convert + escape it and
  // force parse_mode "HTML" so a link renders as clickable text rather than
  // literal brackets. Harmless no-op for text with no links or HTML chars.
  if (!parseMode) {
    text = markdownEmphasisToUnicode(text);
    text = convertLinksAndEscape(text);
    parseMode = "HTML";
  }

  // Telegram hard-caps messages at 4096 characters.
  const chunks = [];
  let rest = text.trim();
  while (rest.length > 4000) {
    let cut = rest.lastIndexOf("\n\n", 4000);
    if (cut < 2000) cut = rest.lastIndexOf(" ", 4000);
    if (cut < 2000) cut = 4000;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  chunks.push(rest);

  for (const chunk of chunks) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: parseMode,
      reply_to_message_id: replyTo,
      allow_sending_without_reply: true,
      disable_web_page_preview: true,
    }).catch((e) =>
      console.error("Telegram sendMessage failed:", e.response?.status, JSON.stringify(e.response?.data))
    );
  }
}

// ---------------------------------------------------- quiz bot adapter -----
// quizGenerator.js expects a small node-telegram-bot-api-shaped `bot`
// object (sendMessage/editMessageText/answerCallbackQuery). This bot_fys501.js
// talks to Telegram directly via axios (tg()) rather than that library, so
// this adapter bridges the two without adding a new dependency.
const quizBot = {
  async sendMessage(chatId, text, opts = {}) {
    return tg("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: opts.parse_mode,
      reply_markup: opts.reply_markup,
    }).catch((e) =>
      console.error("Telegram sendMessage (quiz) failed:", e.response?.status, JSON.stringify(e.response?.data))
    );
  },
  async editMessageText(text, opts = {}) {
    return tg("editMessageText", {
      chat_id: opts.chat_id,
      message_id: opts.message_id,
      text,
      parse_mode: opts.parse_mode,
      reply_markup: opts.reply_markup,
    }).catch((e) =>
      console.error("Telegram editMessageText (quiz) failed:", e.response?.status, JSON.stringify(e.response?.data))
    );
  },
  async answerCallbackQuery(callbackQueryId, opts = {}) {
    return tg("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: opts.text,
    }).catch((e) =>
      console.error("Telegram answerCallbackQuery failed:", e.response?.status, JSON.stringify(e.response?.data))
    );
  },
  // Used by membership.js. Unlike the methods above this one must THROW on failure
  // (with Telegram's description in the message) so membership.js can tell
  // "user not found" apart from network/permission errors.
  async getChatMember(chatId, userId) {
    try {
      const res = await tg("getChatMember", { chat_id: chatId, user_id: userId });
      return res.data.result;
    } catch (e) {
      const desc = e.response?.data?.description || e.message;
      throw new Error(`ETELEGRAM: ${e.response?.status || ""} ${desc}`.trim());
    }
  },
};

// Called by quizGenerator.startQuiz() when the student didn't name a
// chapter/section (e.g. just typed "quiz me"). Presents an inline-keyboard
// chapter picker; the actual quiz is kicked off from the "quizchapter:N"
// callback handled in handleCallbackQuery() below. Returning null here tells
// startQuiz() to stop — there's nothing more for it to do until the student
// taps a button.
async function askWhichChapter(bot, chatId) {
  await bot.sendMessage(chatId, "Which chapter would you like to be quizzed on?", {
    reply_markup: {
      inline_keyboard: corpusLoader.listChapters().map((ch) => ([
        { text: `Chapter ${ch} — ${corpusLoader.getChapterTitle(ch)}`, callback_data: `quizchapter:${ch}` },
      ])),
    },
  });
  return null;
}

// Same idea as askWhichChapter() above, but for the multivalue ("select all
// that apply") quiz add-on. A SEPARATE function with its own callback_data
// prefix ("mvquizchapter:N") rather than reusing askWhichChapter()/"quizchapter:"
// — a tap on this picker must route to mvQuizGenerator.startMultivalueQuiz(),
// not quizGenerator.startQuiz(), and handleCallbackQuery() tells the two apart
// by prefix alone.
async function askWhichChapterMv(bot, chatId) {
  await bot.sendMessage(chatId, "Which chapter would you like the multi-select quiz on?", {
    reply_markup: {
      inline_keyboard: corpusLoader.listChapters().map((ch) => ([
        { text: `Chapter ${ch} — ${corpusLoader.getChapterTitle(ch)}`, callback_data: `mvquizchapter:${ch}` },
      ])),
    },
  });
  return null;
}

// --------------------------------------------------------------- claude -----
async function askClaude(chatId, question) {
  const messages = [...(history.get(chatId) || []), { role: "user", content: question }];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.post(
        "https://api.anthropic.com/v1/messages",
        { model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_BLOCKS, messages },
        { headers: ANTHROPIC_HEADERS, timeout: 120000 }
      );

      const u = res.data.usage || {};
      limiter.recordUsage(MODEL, u);
      console.log(
        `Claude ok | in=${u.input_tokens} cache_write=${u.cache_creation_input_tokens || 0} ` +
        `cache_read=${u.cache_read_input_tokens || 0} out=${u.output_tokens}`
      );

      return res.data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    } catch (err) {
      const status = err.response?.status;
      console.error(
        `Claude attempt ${attempt + 1} failed | status=${status} |`,
        JSON.stringify(err.response?.data || err.message)
      );
      // Retry only on transient failures.
      if (status === 429 || status === 500 || status === 529 || err.code === "ECONNABORTED") {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Claude unavailable after 3 attempts");
}

// ----------------------------------------------------------- claude vision --
// Separate from askClaude(): image checks are one-off (not multi-turn history),
// use a fixed low token budget, and never get logged/stored as chat history.
const VISION_MODEL = process.env.VISION_MODEL || MODEL;
const VISION_MAX_TOKENS = 300;

async function askClaudeVision(imageBase64, mediaType, directive) {
  const messages = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
        { type: "text", text: directive },
      ],
    },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.post(
        "https://api.anthropic.com/v1/messages",
        { model: VISION_MODEL, max_tokens: VISION_MAX_TOKENS, system: SYSTEM_BLOCKS, messages },
        { headers: ANTHROPIC_HEADERS, timeout: 120000 }
      );
      limiter.recordUsage(VISION_MODEL, res.data.usage);
      return res.data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    } catch (err) {
      const status = err.response?.status;
      console.error(
        `Claude vision attempt ${attempt + 1} failed | status=${status} |`,
        JSON.stringify(err.response?.data || err.message)
      );
      if (status === 429 || status === 500 || status === 529 || err.code === "ECONNABORTED") {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Claude vision unavailable after 3 attempts");
}

// ------------------------------------------------------ telegram file fetch -
async function fetchTelegramPhotoAsBase64(fileId) {
  const fileRes = await tg("getFile", { file_id: fileId });
  const filePath = fileRes.data.result.file_path; // e.g. "photos/file_123.jpg"
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const binRes = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 20000 });
  const ext = (filePath.split(".").pop() || "jpg").toLowerCase();
  const mediaType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return { base64: Buffer.from(binRes.data).toString("base64"), mediaType };
}

// -------------------------------------------------------------- routing -----
function shouldAnswer(message) {
  const type = message.chat.type;
  const text = message.text || message.caption || "";
  if (type === "private") return true;                                  // DMs: always
  if (message.photo) return true;                                       // photos: always answer, same as DMs/commands
  if (/^\//.test(text)) return true;                                    // commands
  if (BOT_USERNAME && text.toLowerCase().includes("@" + BOT_USERNAME)) return true;
  if (message.reply_to_message?.from?.is_bot) return true;              // replying to us
  return false;                                                          // otherwise stay quiet
}

// --------------------------------------------------------- HW commands ------
// Matches:  /HW3          (overview of Homework 3)
//           /HW3.2        (hint on Homework 3, problem 2)
//           /HW_hint3.2   (minimal one-line nudge on Homework 3, problem 2)
const HW_COMMAND_RE = /^\/HW(_hint)?(\d+)(?:\.(\d+))?(@\S+)?\b/i;

function buildHwOverviewDirective(hwNum) {
  return (
    `[HOMEWORK OVERVIEW REQUEST]\n` +
    `The student wants an overview of Homework ${hwNum}. Find "HOMEWORK ${hwNum}" in the course ` +
    `material and list each top-level numbered problem with a one-line topic description only ` +
    `(no sub-parts, no hints, no solutions, no point values needed). Keep the whole reply short — ` +
    `one line per problem. End with: "Ask /HW${hwNum}.<problem number> for a hint on a specific one."`
  );
}

// Free, deterministic version — used when homework_problems_fys501.json has this homework,
// so it costs no API call and can't hallucinate a problem list.
function buildHwOverviewFromStructuredData(hwNum) {
  const problems = HOMEWORK_PROBLEMS[hwNum];
  const nums = Object.keys(problems).sort((a, b) => Number(a) - Number(b));
  const lines = nums.map((n) => {
    const firstLine = problems[n]
      .split("\n")[0]
      .trim()
      .replace(new RegExp(`^${hwNum}\\.${n}\\b\\.?\\s*`), "") // strip the leading "hw.n" header itself
      .replace(/\s*\(\d+\s*points?\)\s*$/i, "");
    return `${hwNum}.${n} — ${firstLine}`;
  });
  return (
    `Homework ${hwNum}:\n` +
    lines.join("\n") +
    `\n\nAsk /HW${hwNum}.<problem number> for a hint on a specific one.`
  );
}

function buildHwHintDirective(hwNum, problemNum) {
  const exactText = HOMEWORK_PROBLEMS[hwNum]?.[problemNum];
  const problemBlock = exactText
    ? `Here is the exact text of problem ${hwNum}.${problemNum}, verbatim from the assignment sheet:\n"""\n${exactText}\n"""\n`
    : `Find problem ${hwNum}.${problemNum} in Homework ${hwNum} in the course material below. ` +
      `If you can't find it, say so plainly instead of guessing.\n`;
  return (
    `[HOMEWORK HINT REQUEST]\n` +
    `The student is asking for help with Homework ${hwNum}, problem ${problemNum}. ${problemBlock}` +
    `Give ONE hint per your standing homework rules: name the relevant equation or concept, point ` +
    `to where it's covered, and ask one guiding question. Do not solve the problem or give the final answer.`
  );
}

function buildHwMinimalHintDirective(hwNum, problemNum) {
  const exactText = HOMEWORK_PROBLEMS[hwNum]?.[problemNum];
  const problemBlock = exactText
    ? `Here is the exact text of problem ${hwNum}.${problemNum}, verbatim from the assignment sheet:\n"""\n${exactText}\n"""\n`
    : `Find problem ${hwNum}.${problemNum} in Homework ${hwNum} in the course material below. ` +
      `If you can't find it, say so plainly instead of guessing.\n`;
  return (
    `[HOMEWORK MINIMAL HINT REQUEST]\n` +
    `The student wants just a nudge for Homework ${hwNum}, problem ${problemNum} — no explanation. ${problemBlock}` +
    `Reply with ONE short guiding question only (a single sentence), optionally naming one equation ` +
    `or concept. No further explanation, no solution.`
  );
}

function buildPhotoCheckDirective(caption) {
  return (
    `[HOMEWORK PHOTO CHECK — QUICK DIRECTION READ ONLY]\n` +
    `The student sent a photo of their in-progress work` +
    (caption ? ` with this caption: "${caption}"` : " with no caption — infer the problem from what's visible") +
    `. Give ONLY a quick preliminary read, 2-3 sentences total: ` +
    `(1) one line saying whether the overall approach looks like it's heading in the right direction ` +
    `or has a likely wrong turn, and (2) if something looks off, name the ONE most likely issue and ` +
    `point to the relevant concept/section — do NOT solve it, do NOT write out corrected math, do NOT ` +
    `give the final answer. If the photo is unreadable or you can't tell what problem it's for, say so ` +
    `and ask them to retake it or add a caption with the problem number (e.g. "/HW3.2").`
  );
}

// ------------------------------------------------------------- glossary ----
// Formats a /define reply from corpusLoader.findGlossaryTerms(). Fully
// deterministic — no Claude API call — same design as the FYS.240 Optics
// bot's /define (this bot has no Finnish, so no bilingual branch needed).
// Every terminology_fys501.json entry already carries its own url +
// introducedInTitle from the harvest, so (unlike the Optics bot, which
// cross-references a separate video database) this just uses those fields
// directly — there's no "booklet-only, no video" case here either, since
// this glossary isn't booklet-derived.
function formatGlossaryReply(query) {
  if (!corpusLoader.glossaryLooksHealthy()) {
    return "The glossary isn't available right now — please check back later.";
  }

  const matches = corpusLoader.findGlossaryTerms(query, 3);
  if (!matches.length) {
    return (
      `I couldn't find "${query}" in the glossary. It's auto-extracted from highlighted terms in the ` +
      `course material, so it doesn't cover everything — try asking me directly instead.`
    );
  }

  return matches
    .map((g) => {
      const revisit = g.revisitedIn && g.revisitedIn.length ? ` (also covered in ${g.revisitedIn.join(", ")})` : "";
      const label = g.introducedInTitle || g.introducedInLecture || "Watch video";
      const videoLine = g.url ? `\n[${label}](${g.url})` : "";
      return `**${g.term}** — introduced in section ${g.introducedIn}${revisit}\n${g.context}${videoLine}`;
    })
    .join("\n\n");
}

// -------------------------------------------------------- dev introspection ----
// Backs /source_materials, /source_HW, /source_quizzes (added v1.5.0) —
// plain-text, deterministic, no Claude API call (same design as /healthz,
// just more human-readable). Dev/instructor tools for verifying which data
// the running bot actually loaded; not listed in HELP_TEXT or /start, but
// not access-restricted either — same as every other command here. Ported
// from the FYS.240 Optics bot's identically-named commands (CHANGELOG v2.6.1).

function fileInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString().replace("T", " ").slice(0, 16) + " UTC",
    };
  } catch (e) {
    return { exists: false, sizeBytes: 0, modified: null };
  }
}

function firstNonEmptyLine(text) {
  const line = (text || "").split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim() : "(empty)";
}

// Informational only — never blocks anything from being served (unlike
// corpusLoader_fys501.js's looksLikeWrongCourseGlossary(), which does). Reuses
// the same laser-vs-optics keyword heuristic as the Optics bot's
// corpusCourseSignal(), direction reversed: there, the risk was Laser content
// contaminating the Optics corpus; here it's the other way around. This is
// exactly the failure mode that's already hit data files in this repo before
// (homework_problems.json, terminology.json on the Optics side) — /source_materials
// lets you catch a stale/wrong-course course_corpus_fys501.txt before a student does.
function corpusCourseSignal(text) {
  const lower = (text || "").toLowerCase();
  const laserHits = (lower.match(/laser|cavity|cavities|gain medium|population inversion|nd:yag|ti:sapph|pumping|resonator/g) || []).length;
  const opticsHits = (lower.match(/thin lens|diffraction|interference|refraction|refractive index|wavefront|polarization|interferometer|grating/g) || []).length;
  let verdict;
  if (opticsHits >= 10 && opticsHits > laserHits * 3) verdict = "⚠ LOOKS LIKE FYS.240 OPTICS, not FYS.501 Laser Physics";
  else if (laserHits === 0 && opticsHits === 0) verdict = "❓ no course-specific keywords matched — can't confirm either way";
  else verdict = "✓ looks like FYS.501 Laser Physics content";
  return { laserHits, opticsHits, verdict };
}

// Sends a plain-text diagnostic report straight through, HTML-escaped but
// bypassing sendMessage()'s markdownEmphasisToUnicode()/convertLinksAndEscape()
// pipeline — that pipeline is built for Claude's chat replies (styling
// *emphasis*, converting [label](url) links) and diagnostic report text is
// only ever literal filenames/counts/status strings, so it skips that
// pipeline entirely and just HTML-escapes for safe parse_mode: "HTML" delivery.
async function sendDiagnosticReport(chatId, text, replyTo) {
  await sendMessage(chatId, escapeHtml(text), replyTo, "HTML");
}

function buildSourceMaterialsReport() {
  const corpusInfo = fileInfo(CORPUS_PATH);
  const signal = corpusCourseSignal(COURSE_CORPUS);

  const lines = [];
  lines.push(`SOURCE: course materials — bot v${BOT_VERSION}`);
  lines.push("");
  lines.push("course_corpus_fys501.txt (free-text Q&A, /HW hints, quiz live-generation)");
  lines.push(`- Loaded: ${COURSE_CORPUS ? "yes" : "NO — file missing or empty"}`);
  lines.push(`- Size: ${COURSE_CORPUS.length.toLocaleString()} chars (~${Math.round(COURSE_CORPUS.length / 3.7).toLocaleString()} tokens)`);
  lines.push(`- On disk: ${corpusInfo.exists ? `${corpusInfo.sizeBytes.toLocaleString()} bytes, modified ${corpusInfo.modified}` : "file not found"}`);
  lines.push(`- First line: "${firstNonEmptyLine(COURSE_CORPUS)}"`);
  lines.push(`- Health check (corpusLooksHealthy): ${corpusLoader.corpusLooksHealthy() ? "ok" : "FAILED"}`);
  lines.push(`- Course-content scan: ${signal.laserHits} laser-terms vs ${signal.opticsHits} optics-terms -> ${signal.verdict}`);
  lines.push("");

  const lectureInfo = fileInfo(LECTURE_DATA_PATH);
  const weeks = lectureLinks.getAllWeeks();
  lines.push("lecture_data_fys501.json (video links in /lectures, /topics, /weekN)");
  lines.push(`- Loaded: ${weeks.length ? "yes" : "NO"}`);
  lines.push(`- Weeks: ${weeks.length}`);
  lines.push(`- Health check (lectureDataLooksHealthy): ${lectureLinks.lectureDataLooksHealthy() ? "ok" : "FAILED"}`);
  lines.push(`- On disk: ${lectureInfo.exists ? `modified ${lectureInfo.modified}` : "file not found"}`);
  lines.push("");

  const glossary = corpusLoader._loadGlossary();
  const termInfo = fileInfo(TERMINOLOGY_PATH);
  lines.push("terminology_fys501.json (glossary — backs /define, no Claude call)");
  lines.push(`- Terms loaded: ${Array.isArray(glossary) ? glossary.length : 0}`);
  lines.push(`- Health check (glossaryLooksHealthy): ${corpusLoader.glossaryLooksHealthy() ? "ok" : "FAILED"}`);
  lines.push(
    `- Course-mismatch guard: ${
      corpusLoader.glossaryCourseMismatch()
        ? "⚠ FIRED — refusing to serve, /define reports unavailable"
        : "clear"
    }`
  );
  lines.push(`- On disk: ${termInfo.exists ? `modified ${termInfo.modified}` : "file not found"}`);
  lines.push("");
  lines.push("See /source_HW and /source_quizzes for homework and quiz data.");
  return lines.join("\n");
}

function buildSourceHwReport() {
  const probInfo = fileInfo(HW_PROBLEMS_PATH);
  const hwNums = Object.keys(HOMEWORK_PROBLEMS).sort((a, b) => Number(a) - Number(b));
  const perHw = hwNums.map((hw) => `HW${hw}: ${Object.keys(HOMEWORK_PROBLEMS[hw]).length}`).join(", ") || "none";
  const totalProblems = Object.values(HOMEWORK_PROBLEMS).reduce((n, hw) => n + Object.keys(hw).length, 0);

  const lines = [];
  lines.push(`SOURCE: homework data — bot v${BOT_VERSION}`);
  lines.push("");
  lines.push("homework_problems_fys501.json (served via /HW, /HW_hint)");
  lines.push(`- Status: ${totalProblems ? "loaded" : "not loaded / empty — /HW commands fall back to full-corpus search"}`);
  lines.push(`- Problems: ${totalProblems} total (${perHw})`);
  lines.push(`- On disk: ${probInfo.exists ? `modified ${probInfo.modified}` : "file not found"}`);
  lines.push(`- Source pipeline: HW#_FYS501_ModelSolutions.tex -> clean_fys240.js's cleanTex() -> build_homework_fys501.js`);
  lines.push("");
  lines.push("(This bot has no separate homework_solutions.json — unlike the FYS.240 Optics");
  lines.push(" bot, there's no instructor-only answer-key file to report on here.)");
  return lines.join("\n");
}

function buildSourceQuizzesReport() {
  const ALL_CHAPTERS = [1, 2, 3, 4];

  const bank = quizGenerator.loadQuizBank();
  const bankInfo = fileInfo(QUIZ_BANK_PATH);
  const pendingInfo = fileInfo(QUIZ_BANK_PENDING_PATH);

  const chapters = Object.keys(bank).sort((a, b) => Number(a) - Number(b));
  let totalQuestions = 0;
  const chapterLines = chapters.map((ch) => {
    const secs = bank[ch] || {};
    const secCounts = Object.keys(secs)
      .sort()
      .map((s) => {
        const n = Array.isArray(secs[s]) ? secs[s].length : 0;
        totalQuestions += n;
        return `${s} (${n})`;
      });
    return `   Chapter ${ch}: ${secCounts.join(", ") || "no sections"}`;
  });
  const missingChapters = ALL_CHAPTERS.filter((c) => !chapters.includes(String(c)));

  let pendingCount = 0;
  if (pendingInfo.exists) {
    try {
      const pending = JSON.parse(fs.readFileSync(QUIZ_BANK_PENDING_PATH, "utf8"));
      pendingCount = Array.isArray(pending) ? pending.length : 0;
    } catch (e) {
      pendingCount = 0;
    }
  }

  const lines = [];
  lines.push(`SOURCE: quiz data — bot v${BOT_VERSION}`);
  lines.push("");
  lines.push("quizBank_fys501.json (pre-built bank, tried before live generation)");
  lines.push(`- Status: ${bankInfo.exists ? "loaded" : "NOT FOUND — every quiz live-generates via the Claude API"}`);
  lines.push(`- Health check (quizBankLooksHealthy): ${quizGenerator.quizBankLooksHealthy() ? "ok" : "FAILED"}`);
  lines.push(`- Coverage: ${chapters.length ? `chapters ${chapters.join(", ")} — ${totalQuestions} questions total` : "none"}`);
  chapterLines.forEach((l) => lines.push(l));
  lines.push(`- Missing chapters (live-generate every time): ${missingChapters.length ? missingChapters.join(", ") : "none"}`);
  lines.push(`- On disk: ${bankInfo.exists ? `modified ${bankInfo.modified}` : "file not found"}`);
  lines.push("");
  lines.push("quizBankPending_fys501.json (live-generated questions saved for later curation)");
  lines.push(`- Present: ${pendingInfo.exists ? "yes" : "no — none saved yet"}`);
  if (pendingInfo.exists) {
    lines.push(`- Pending questions saved: ${pendingCount}`);
    lines.push(`- On disk: modified ${pendingInfo.modified}`);
  }
  lines.push("");
  lines.push(`Live generation model (used for any chapter not in the bank): ${MODEL}`);
  lines.push("");
  const cov = quizTagCoverage();
  lines.push("Analytics tags (concepts / misconception tags, see QUIZ_ANALYTICS_fys501.md)");
  for (const [k, c] of Object.entries(cov)) {
    lines.push(`- ${k === "single" ? "Single-select" : "Multi-select"}: ${c.withConcepts}/${c.questions} questions with concepts, ${c.taggedDistractors}/${c.distractors} wrong options tagged`);
  }
  const qa = quizAnalytics.status();
  lines.push(`- Answer logging: ${qa.enabled ? "ON" : "OFF (set ANALYTICS_HASH_SECRET)"}; stored events file: ${qa.persistentDir ? "on the QUIZ_ANALYTICS_DIR volume" : "none (log lines only)"}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push('multivalueQuizBank_fys501.json ("select all that apply" add-on, separate from the above)');
  const mvBank = mvQuizGenerator.loadQuizBank();
  const mvBankInfo = fileInfo(MV_QUIZ_BANK_PATH);
  const mvPendingInfo = fileInfo(MV_QUIZ_BANK_PENDING_PATH);
  const mvChapters = Object.keys(mvBank).sort((a, b) => Number(a) - Number(b));
  let mvTotalQuestions = 0;
  const mvChapterLines = mvChapters.map((ch) => {
    const secs = mvBank[ch] || {};
    const secCounts = Object.keys(secs)
      .sort()
      .map((s) => {
        const n = Array.isArray(secs[s]) ? secs[s].length : 0;
        mvTotalQuestions += n;
        return `${s} (${n})`;
      });
    return `   Chapter ${ch}: ${secCounts.join(", ") || "no sections"}`;
  });
  const mvMissingChapters = ALL_CHAPTERS.filter((c) => !mvChapters.includes(String(c)));
  let mvPendingCount = 0;
  if (mvPendingInfo.exists) {
    try {
      const pending = JSON.parse(fs.readFileSync(MV_QUIZ_BANK_PENDING_PATH, "utf8"));
      mvPendingCount = Array.isArray(pending) ? pending.length : 0;
    } catch (e) {
      mvPendingCount = 0;
    }
  }
  lines.push(`- Status: ${mvBankInfo.exists ? "loaded" : "NOT FOUND — every multivalue quiz live-generates via the Claude API"}`);
  lines.push(`- Health check (multivalueQuizBankLooksHealthy): ${mvQuizGenerator.quizBankLooksHealthy() ? "ok" : "FAILED"}`);
  lines.push(`- Coverage: ${mvChapters.length ? `chapters ${mvChapters.join(", ")} — ${mvTotalQuestions} questions total` : "none"}`);
  mvChapterLines.forEach((l) => lines.push(l));
  lines.push(`- Missing chapters (live-generate every time): ${mvMissingChapters.length ? mvMissingChapters.join(", ") : "none"}`);
  lines.push(`- On disk: ${mvBankInfo.exists ? `modified ${mvBankInfo.modified}` : "file not found"}`);
  lines.push(`- multivalueQuizBankPending_fys501.json: ${mvPendingInfo.exists ? `${mvPendingCount} question(s) saved for curation` : "no — none saved yet"}`);
  return lines.join("\n");
}

// Converts a bare "N" or "N M" (chapter + optional count) into "chapter N M"
// so /quiz's own CHAPTER_HINT regex (which requires a "chapter"/"ch." prefix)
// picks it up — a dotted section reference like "2.3" or "2.3 8" is left
// untouched since SECTION_HINT already matches that directly, no "chapter"
// prefix needed. Mirrors the FYS.240 Optics bot's normalizeQuizArgs(),
// restricted to this course's chapter range (1-4).
function normalizeQuizArgs(rest) {
  const r = (rest || "").trim();
  const m = r.match(/^([1-4])(?:\s+(\d{1,2}))?$/);
  return m ? `chapter ${m[1]}${m[2] ? " " + m[2] : ""}` : r;
}

function stripMention(text) {
  return text
    .replace(new RegExp(`@${BOT_USERNAME}`, "ig"), "")
    .replace(/^\/(ask|help|start|reset)(@\S+)?\s*/i, "")
    .trim();
}

const HELP_TEXT =
  "Hi! I'm the FYS.501 Laser Physics assistant. I know the lecture slides, " +
  "textbook Chapters 1-4 and the six homework sheets.\n\n" +
  "Ask me things like:\n" +
  "- What is the difference between a stable and unstable resonator?\n" +
  "- Explain the ABCD matrix for a thick lens\n\n" +
  "Homework commands:\n" +
  "- /HW3 — list the problems in Homework 3\n" +
  "- /HW3.2 — get a hint on Homework 3, problem 2\n" +
  "- /HW_hint3.2 — just a one-line nudge, no explanation\n" +
  "- Send a photo of your work-in-progress (caption it with the problem, e.g. \"/HW3.2\") " +
  "and I'll give a quick read on whether you're headed the right way.\n\n" +
  "Quizzes:\n" +
  "- \"quiz me\" — I'll ask which chapter\n" +
  "- \"quiz me on chapter 2\" or \"quiz me on section 2.3\" — multiple choice, tap an answer to grade it\n" +
  "- /quiz chapter 2 (or /quiz 2.3) — same thing, as a command\n" +
  "- add a number for how many questions, e.g. \"quiz me on chapter 2, 10 questions\" or \"/quiz 2 10\"\n" +
  "- /mvquiz chapter 2 (or /mvquiz 2.3) — a \"select all that apply\" quiz: tap every letter that is correct, then Submit. Partial credit is given.\n\n" +
  "Usage:\n" +
  "- /usage — how many AI answers you have left today (quizzes, lecture links and commands are free)\n\n" +
  "Privacy:\n" +
  "- /privacy — what quiz data is recorded (anonymously) and why; /optout stops it and deletes your data\n\n" +
  "Lecture videos:\n" +
  "- /lectures (or /topics) — full listing, week by week\n" +
  "- /week1 ... /week6 — just that week's videos\n" +
  "- \"is there a video on gain saturation?\" or \"recording for week 3?\" — I'll find the right one(s)\n\n" +
  "Glossary:\n" +
  "- /define <term> — e.g. \"/define population inversion\"\n\n" +
  "I'll give you hints and point you to the right section, but I won't hand you " +
  "finished homework solutions.\n\n" +
  "/reset clears our conversation history.";

// ------------------------------------------------------------- webhook ------
app.get("/", (_req, res) => res.send(`Laser Physics bot v${BOT_VERSION} is running`));
app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    version: BOT_VERSION,
    corpusChars: COURSE_CORPUS.length,
    corpusLooksHealthy: corpusLoader.corpusLooksHealthy(),
    homeworkProblemsLoaded: Object.values(HOMEWORK_PROBLEMS).reduce((n, hw) => n + Object.keys(hw).length, 0),
    quizBankLooksHealthy: quizGenerator.quizBankLooksHealthy(),
    multivalueQuizBankLooksHealthy: mvQuizGenerator.quizBankLooksHealthy(),
    pendingQuestions: {
      single: quizGenerator.pendingSummary().total,
      multi: mvQuizGenerator.pendingSummary().total,
      persistentDir: !!process.env.QUIZ_PENDING_DIR,
    },
    lectureDataLooksHealthy: lectureLinks.lectureDataLooksHealthy(),
    glossaryLooksHealthy: corpusLoader.glossaryLooksHealthy(),
    glossaryCourseMismatch: corpusLoader.glossaryCourseMismatch(),
    membershipGate: !!process.env.COURSE_CHANNEL_ID,
    quizAnalytics: quizAnalytics.status(),
    usage: limiter.status(),
  })
);

app.post("/webhook", (req, res) => {
  // 1) Acknowledge Telegram FIRST. Everything below runs after the response.
  if (WEBHOOK_SECRET && req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  // 2) Handle the update asynchronously.
  handleUpdate(req.body).catch((e) => console.error("handleUpdate crashed:", e.message));
});

async function handleUpdate(update) {
  if (!update || update.update_id === undefined) return;

  if (seenUpdates.has(update.update_id)) return;
  seenUpdates.add(update.update_id);
  if (seenUpdates.size > 1000) seenUpdates.clear();

  // Quiz answer taps and chapter-picker taps arrive as callback_query
  // updates, not message updates — handle those separately, before we ever
  // look for update.message (which callback_query updates don't have).
  if (update.callback_query) {
    return handleCallbackQuery(update.callback_query);
  }

  const message = update.message;
  if (!message || (!message.text && !message.photo)) return;

  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = (message.text || "").trim();

  if (!shouldAnswer(message)) return;

  // ---- access control (v1.2.0): OPEN bot — no blanket membership check here.
  // Deterministic replies below (commands, lecture links, /HW overviews from
  // structured data, /pending) work for everyone. Membership is checked
  // individually, right at each AI-backed call site instead — see the
  // CHANGELOG v1.2.0 note in the header comment for the full list of those
  // sites. `isPrivate` is still computed here since several of those
  // call-site checks need it (silent denial in group chats).
  const isPrivate = message.chat.type === "private";

  // /usage is free (no LLM call).
  if (/^\/usage\b/i.test(text)) return sendMessage(chatId, usageText(userId), message.message_id);

  // Quiz analytics (v1.6.0) — free, deterministic, no Claude call, no membership check.
  if (/^\/privacy(@\S+)?\b/i.test(text)) return sendMessage(chatId, quizAnalyticsCommands.privacyReply(), message.message_id);
  if (/^\/optout(@\S+)?\b/i.test(text)) return sendMessage(chatId, quizAnalyticsCommands.optOutReply(userId), message.message_id);
  if (/^\/optin(@\S+)?\b/i.test(text)) return sendMessage(chatId, quizAnalyticsCommands.optInReply(userId), message.message_id);
  // /quizstats (ADMIN_USER_IDS only): admin-gated internally, silently ignored for everyone else.
  const quizStatsMatch = text.match(/^\/quizstats(@\S+)?\b\s*(.*)$/i);
  if (quizStatsMatch) {
    return quizAnalyticsCommands
      .handleQuizStatsCommand({
        chatId,
        userId,
        arg: quizStatsMatch[2],
        sendText: (c, t) => sendMessage(c, t, message.message_id),
        sendDocument: tgSendDocument,
      })
      .catch((e) => console.error("/quizstats crashed:", e.message));
  }

  // ---- dev-only data-source introspection (v1.5.0) — not in /help/start,
  // but not access-restricted either — same as every other command here.
  // Ported from the FYS.240 Optics bot's identically-named commands.
  if (/^\/source_materials/i.test(text)) {
    return sendDiagnosticReport(chatId, buildSourceMaterialsReport(), message.message_id);
  }
  if (/^\/source_HW/i.test(text)) {
    return sendDiagnosticReport(chatId, buildSourceHwReport(), message.message_id);
  }
  if (/^\/source_quizzes/i.test(text)) {
    return sendDiagnosticReport(chatId, buildSourceQuizzesReport(), message.message_id);
  }

  // /pending (ADMIN_USER_IDS only): export / clear the live-generated quiz questions awaiting
  // review. Silently ignored for everyone else — admin-gated internally by
  // pendingAdmin_fys501.js, so no membership check is needed here. See PENDING_QUESTIONS_fys501.md.
  const pendingMatch = text.match(/^\/pending(@\S+)?\b\s*(.*)$/i);
  if (pendingMatch) {
    return pendingAdmin
      .handlePendingCommand({
        chatId,
        userId,
        arg: pendingMatch[2],
        sendText: (c, t) => sendMessage(c, t, message.message_id),
        sendDocument: tgSendDocument,
      })
      .catch((e) => console.error("/pending crashed:", e.message));
  }

  // ---- photo submission: quick direction check (AI-backed — members only)
  if (message.photo && message.photo.length) {
    if (!shouldAnswer(message)) return;

    const now0 = Date.now();
    if (now0 - (lastCall.get(userId) || 0) < MIN_INTERVAL_MS) return;
    lastCall.set(userId, now0);

    const caption = (message.caption || "").trim();
    console.log(`[${message.chat.type}:${chatId}] photo submitted, caption="${caption.slice(0, 80)}"`);

    if (!(await requireMember(quizBot, chatId, userId, { silent: !isPrivate }))) return;
    const photoBudget = await requireLLMBudget(quizBot, chatId, userId, "photo");
    if (!photoBudget.ok) return;

    await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

    try {
      // Largest resolution is the last entry in Telegram's photo size array.
      const best = message.photo[message.photo.length - 1];
      const { base64, mediaType } = await fetchTelegramPhotoAsBase64(best.file_id);
      const directive = buildPhotoCheckDirective(caption);
      const reply = await askClaudeVision(base64, mediaType, directive);
      await sendMessage(chatId, reply, message.message_id);
      await maybeWarnLow(quizBot, chatId, photoBudget);
    } catch (e) {
      refundLLM(userId, photoBudget);
      console.error("Photo check failed:", e.message);
      await sendMessage(
        chatId,
        "Sorry, I couldn't read that photo just now. Please try again, ideally with good lighting and " +
          "a caption naming the problem (e.g. \"/HW3.2\").",
        message.message_id
      );
    }
    return;
  }

  if (/^\/(start|help)/i.test(text)) return sendMessage(chatId, HELP_TEXT);
  if (/^\/reset/i.test(text)) {
    history.delete(chatId);
    return sendMessage(chatId, "Conversation history cleared. Ask me anything.");
  }
  // /topics is an alias of /lectures (same handler, same output) for students
  // who are more familiar with that wording. Free — deterministic, no Claude call.
  if (/^\/(lectures|topics)/i.test(text)) {
    return sendMessage(chatId, lectureLinks.formatFullListing(), message.message_id, "HTML");
  }
  // /week1 ... /week6 (added v1.3.0) — a single week's videos, reusing the
  // same lookup + formatter /lectures uses for the full listing. Free —
  // deterministic, no Claude call. Mirrors the FYS.240 Optics bot's /weekN.
  const weekMatch = text.match(/^\/week(\d+)/i);
  if (weekMatch) {
    const weekNum = parseInt(weekMatch[1], 10);
    const week = lectureLinks.getWeekLectures(weekNum);
    const reply = week
      ? lectureLinks.formatWeekMessage(week)
      : `I don't have a Week ${weekNum} — this course has ${lectureLinks.getAllWeeks().length} weeks of lecture videos. Try /lectures for the full listing.`;
    return sendMessage(chatId, reply, message.message_id, "HTML");
  }

  // ---- /define <term> (added v1.4.0) — deterministic glossary lookup, no
  // Claude call. Mirrors the FYS.240 Optics bot's /define. Free — same
  // treatment as /lectures/topics/week above.
  if (/^\/define/i.test(text)) {
    const term = text.replace(/^\/define(@\S+)?\s*/i, "").trim();
    if (!term) {
      return sendMessage(chatId, 'Usage: /define <term> — e.g. "/define population inversion"', message.message_id);
    }
    return sendMessage(chatId, formatGlossaryReply(term), message.message_id);
  }

  // ---- /quiz — explicit command for the single-answer multiple-choice
  // quiz ("quiz me on chapter 2" as a command instead of free text).
  // "/quiz", "/quiz chapter 2", "/quiz 2.3", "/quiz 2 8" (chapter/section +
  // optional question count) are all accepted — bare "N" or "N M" is
  // normalized to "chapter N M" first since quizGenerator's own CHAPTER_HINT
  // regex requires a "chapter"/"ch." prefix (a dotted "2.3" needs no such
  // normalization — SECTION_HINT already matches it directly).
  // AI-backed (a quiz start may need live generation) — members only.
  const quizMatch = text.match(/^\/quiz(@\S+)?\b\s*(.*)$/i);
  if (quizMatch) {
    const rest = normalizeQuizArgs(quizMatch[2]);
    const quizText = rest ? `quiz ${rest}` : "quiz";

    const nowQ = Date.now();
    if (nowQ - (lastCall.get(userId) || 0) < MIN_INTERVAL_MS) return;
    lastCall.set(userId, nowQ);

    console.log(`[${message.chat.type}:${chatId}] /quiz command: ${text.slice(0, 60)}`);

    if (!(await requireMember(quizBot, chatId, userId, { silent: !isPrivate }))) return;

    return quizGenerator
      .startQuiz(quizBot, chatId, quizText, askWhichChapter, userId)
      .catch((e) => console.error("quizGenerator.startQuiz (/quiz) crashed:", e.message));
  }

  // ---- /mvquiz — explicit command for the multivalue ("select all that
  // apply") quiz add-on. "/mvquiz", "/mvquiz chapter 2", "/mvquiz 2.3",
  // "/mvquiz 2.3 8" (chapter/section + optional question count, same
  // hint-parsing as the free-text trigger further down) are all accepted.
  // AI-backed (a quiz start may need live generation) — members only.
  const mvQuizMatch = text.match(/^\/mvquiz(@\S+)?\b\s*(.*)$/i);
  if (mvQuizMatch) {
    const rest = (mvQuizMatch[2] || "").trim();
    const mvQuizText = rest ? `multiquiz ${rest}` : "multiquiz";

    const nowMv = Date.now();
    if (nowMv - (lastCall.get(userId) || 0) < MIN_INTERVAL_MS) return;
    lastCall.set(userId, nowMv);

    console.log(`[${message.chat.type}:${chatId}] /mvquiz command: ${text.slice(0, 60)}`);

    if (!(await requireMember(quizBot, chatId, userId, { silent: !isPrivate }))) return;

    return mvQuizGenerator
      .startMultivalueQuiz(quizBot, chatId, mvQuizText, askWhichChapterMv, userId)
      .catch((e) => console.error("mvQuizGenerator.startMultivalueQuiz (/mvquiz) crashed:", e.message));
  }

  // ---- /HW3, /HW3.2, /HW_hint3.2
  const hwMatch = text.match(HW_COMMAND_RE);
  if (hwMatch) {
    const isMinimalHint = !!hwMatch[1];
    const hwNum = hwMatch[2];
    const problemNum = hwMatch[3];

    const now1 = Date.now();
    if (now1 - (lastCall.get(userId) || 0) < MIN_INTERVAL_MS) return;
    lastCall.set(userId, now1);

    console.log(`[${message.chat.type}:${chatId}] HW command: ${text.slice(0, 60)}`);

    // Overview with no problem number: answer for free/instantly if we have
    // structured data for this homework, no need to call Claude at all.
    if (!problemNum && HOMEWORK_PROBLEMS[hwNum] && Object.keys(HOMEWORK_PROBLEMS[hwNum]).length) {
      await sendMessage(chatId, buildHwOverviewFromStructuredData(hwNum), message.message_id);
      return;
    }

    const directive = !problemNum
      ? buildHwOverviewDirective(hwNum)
      : isMinimalHint
      ? buildHwMinimalHintDirective(hwNum, problemNum)
      : buildHwHintDirective(hwNum, problemNum);

    if (!(await requireMember(quizBot, chatId, userId, { silent: !isPrivate }))) return;
    const hwBudget = await requireLLMBudget(quizBot, chatId, userId, "chat");
    if (!hwBudget.ok) return;

    await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

    try {
      const reply = await askClaude(chatId, directive);
      remember(chatId, "user", text);
      remember(chatId, "assistant", reply);
      await sendMessage(chatId, reply, message.message_id);
      await maybeWarnLow(quizBot, chatId, hwBudget);
    } catch (e) {
      refundLLM(userId, hwBudget);
      await sendMessage(
        chatId,
        "Sorry, I couldn't reach my brain just now. Please try again in a moment.",
        message.message_id
      );
    }
    return;
  }

  const question = stripMention(text);
  if (question.length < 3) return;

  const now = Date.now();
  if (now - (lastCall.get(userId) || 0) < MIN_INTERVAL_MS) return;
  lastCall.set(userId, now);

  console.log(`[${message.chat.type}:${chatId}] ${question.slice(0, 120)}`);

  // ---- "multiquiz" / "multi-select quiz" / "select all" — the SEPARATE
  // multi-answer quiz add-on. MUST be checked BEFORE the single-select
  // trigger below: phrases like "multi-select quiz" also contain a standalone
  // word "quiz", so the single-select regex would otherwise claim them.
  // AI-backed (a quiz start may need live generation) — members only.
  if (mvQuizGenerator.isMultivalueQuizRequest(question)) {
    if (!(await requireMember(quizBot, chatId, userId, { silent: !isPrivate }))) return;
    return mvQuizGenerator
      .startMultivalueQuiz(quizBot, chatId, question, askWhichChapterMv, userId)
      .catch((e) => console.error("mvQuizGenerator.startMultivalueQuiz crashed:", e.message));
  }

  // ---- "quiz me" / "quiz me on chapter 2" / "quiz me on section 2.3" ----
  // AI-backed (a quiz start may need live generation) — members only.
  if (quizGenerator.isQuizRequest(question)) {
    if (!(await requireMember(quizBot, chatId, userId, { silent: !isPrivate }))) return;
    return quizGenerator
      .startQuiz(quizBot, chatId, question, askWhichChapter, userId)
      .catch((e) => console.error("quizGenerator.startQuiz crashed:", e.message));
  }

  // ---- "any lecture video about X?" / "where's the recording for week 3?"
  // Free — deterministic keyword match, or the Stage-2 classifier call (billed
  // to the shared daily backstop, not to this student's personal allowance).
  if (lectureLinks.STAGE1_TRIGGER.test(question)) {
    try {
      const reply = await lectureLinks.handleLectureQuery(question);
      await sendMessage(chatId, reply, message.message_id, "HTML");
    } catch (e) {
      console.error("lectureLinks.handleLectureQuery crashed:", e.message);
      await sendMessage(chatId, "Sorry, I couldn't look up lecture videos just now.", message.message_id);
    }
    return;
  }

  // ---- free-text Q&A (AI-backed — members only)
  if (!(await requireMember(quizBot, chatId, userId, { silent: !isPrivate }))) return;
  const chatBudget = await requireLLMBudget(quizBot, chatId, userId, "chat");
  if (!chatBudget.ok) return;

  await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  try {
    const reply = await askClaude(chatId, question);
    remember(chatId, "user", question);
    remember(chatId, "assistant", reply);
    await sendMessage(chatId, reply, message.message_id);
    await maybeWarnLow(quizBot, chatId, chatBudget);
  } catch (e) {
    refundLLM(userId, chatBudget);
    await sendMessage(
      chatId,
      "Sorry, I couldn't reach my brain just now. Please try again in a moment.",
      message.message_id
    );
  }
}

// callback_query updates: answer-option taps ("quiz:...") from
// quizGenerator's inline keyboards, chapter-picker taps ("quizchapter:N")
// from askWhichChapter() above, and the multivalue add-on's own namespace:
// toggle/submit taps ("mv:...") and its chapter-picker taps
// ("mvquizchapter:N") from askWhichChapterMv().
async function handleCallbackQuery(cq) {
  const data = cq.data || "";

  // ---- multivalue ("select all that apply") quiz add-on — its own
  // callback_data namespace, kept separate from "quiz:"/"quizchapter:" ----
  // Grading taps are free — no membership check, no credit cost — since
  // this only scores an already-served question, no Claude call involved.
  if (data.startsWith("mv:")) {
    return mvQuizGenerator
      .handleMultivalueQuizAnswer(quizBot, cq)
      .catch((e) => console.error("mvQuizGenerator.handleMultivalueQuizAnswer crashed:", e.message));
  }

  // Chapter-picker taps START a new quiz (same AI-backed step as /mvquiz or
  // the free-text "multiquiz" trigger) — members only.
  if (data.startsWith("mvquizchapter:")) {
    const chapter = data.split(":")[1];
    const chatId = cq.message?.chat?.id;
    const cbUserId = cq.from?.id;
    if (!(await requireMember(quizBot, chatId, cbUserId, { silent: true }))) {
      await quizBot.answerCallbackQuery(cq.id, { text: MSG.notMember }).catch(() => {});
      return;
    }
    await quizBot.answerCallbackQuery(cq.id);
    if (!chatId) return;
    return mvQuizGenerator
      .startMultivalueQuiz(quizBot, chatId, `multiquiz chapter ${chapter}`, askWhichChapterMv, cbUserId)
      .catch((e) => console.error("mvQuizGenerator.startMultivalueQuiz (chapter pick) crashed:", e.message));
  }

  // Grading tap — same free treatment as "mv:" above.
  if (data.startsWith("quiz:")) {
    return quizGenerator
      .handleQuizAnswer(quizBot, cq)
      .catch((e) => console.error("quizGenerator.handleQuizAnswer crashed:", e.message));
  }

  // Chapter-picker tap — same AI-backed treatment as "mvquizchapter:" above.
  if (data.startsWith("quizchapter:")) {
    const chapter = data.split(":")[1];
    const chatId = cq.message?.chat?.id;
    const cbUserId = cq.from?.id;
    if (!(await requireMember(quizBot, chatId, cbUserId, { silent: true }))) {
      await quizBot.answerCallbackQuery(cq.id, { text: MSG.notMember }).catch(() => {});
      return;
    }
    await quizBot.answerCallbackQuery(cq.id);
    if (!chatId) return;
    return quizGenerator
      .startQuiz(quizBot, chatId, `quiz me on chapter ${chapter}`, askWhichChapter, cbUserId)
      .catch((e) => console.error("quizGenerator.startQuiz (chapter pick) crashed:", e.message));
  }

  // Unknown callback data — acknowledge anyway so Telegram stops showing a
  // loading spinner on the button.
  await quizBot.answerCallbackQuery(cq.id).catch(() => {});
}

// ---------------------------------------------------------------- start -----
if (!TELEGRAM_TOKEN) console.error("WARNING: TELEGRAM_TOKEN is not set");
if (!ANTHROPIC_API_KEY) console.error("WARNING: ANTHROPIC_API_KEY is not set");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const glossaryStatus = corpusLoader.glossaryCourseMismatch() ? "⚠ COURSE MISMATCH" : "✓";
  console.log(
    `FYS.501 Laser bot v${BOT_VERSION} listening on port ${PORT} | model=${MODEL} | cache=${CACHE_TTL} | ` +
    `Glossary=${glossaryStatus} | QuizAnalytics=${quizAnalytics.isEnabled() ? "on" : "off"}`
  );
});
