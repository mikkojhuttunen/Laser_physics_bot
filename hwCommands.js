/**
 * Homework-helper commands — /HW3, /HW3.2, /HW_hint3.2
 *
 * Extracted verbatim (logic-for-logic) from bot_v1_working_but_no_lecture_links.js
 * so it can be dropped into the current main-branch bot.js (the course_corpus_v2 /
 * /define glossary branch) without touching that file's corpus-v2 or glossary code.
 *
 * This module does NOT talk to Telegram or Claude directly — it hands back plain
 * strings/directives and lets your existing sendMessage()/askClaude() do the work,
 * so it doesn't care how the new bot.js wires those up.
 *
 * ---------------------------------------------------------------------------
 * INTEGRATION (edit bot.js):
 *
 * 1. Near your other requires:
 *      const hw = require("./hwCommands");
 *
 * 2. At startup, alongside your other file loads (corpus, glossary, etc.):
 *      hw.load();   // reads homework_problems.json once; logs how many problems loaded
 *
 * 3. Inside handleUpdate(), BEFORE the generic question/glossary/Claude fallback
 *    (put it next to your other slash-command checks like /reset, /lectures, /define):
 *
 *      const hwMatch = text.match(hw.HW_COMMAND_RE);
 *      if (hwMatch) {
 *        const { hwNum, problemNum, isMinimalHint } = hw.parseMatch(hwMatch);
 *
 *        // rate-limit exactly like your other commands do
 *        const now1 = Date.now();
 *        if (now1 - (lastCall.get(userId) || 0) < MIN_INTERVAL_MS) return;
 *        lastCall.set(userId, now1);
 *
 *        // free/instant path — no Claude call needed if we have structured data
 *        const overview = hw.getStructuredOverview(hwNum, problemNum);
 *        if (overview) {
 *          await sendMessage(chatId, overview, message.message_id);
 *          return;
 *        }
 *
 *        const directive = hw.buildDirective(hwNum, problemNum, isMinimalHint);
 *        await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
 *        try {
 *          const reply = await askClaude(chatId, directive);
 *          remember(chatId, "user", text);
 *          remember(chatId, "assistant", reply);
 *          await sendMessage(chatId, reply, message.message_id);
 *        } catch (e) {
 *          await sendMessage(chatId, "Sorry, I couldn't reach my brain just now. Please try again in a moment.", message.message_id);
 *        }
 *        return;
 *      }
 *
 * 4. Add the homework lines to your /help text (see hw.HELP_SNIPPET below).
 *
 * 5. Make sure homework_problems.json is present in the new repo layout (same file,
 *    unchanged format: { "<hw>": { "<problem>": "<verbatim text>" } }). If the v2
 *    corpus pipeline renamed/relocated it, pass the new path to hw.load(path).
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

// Matches:  /HW3          (overview of Homework 3)
//           /HW3.2        (hint on Homework 3, problem 2)
//           /HW_hint3.2   (minimal one-line nudge on Homework 3, problem 2)
const HW_COMMAND_RE = /^\/HW(_hint)?(\d+)(?:\.(\d+))?(@\S+)?\b/i;

let HOMEWORK_PROBLEMS = {};

function load(customPath) {
  const hwPath = customPath || path.join(__dirname, "homework_problems.json");
  try {
    HOMEWORK_PROBLEMS = JSON.parse(fs.readFileSync(hwPath, "utf8"));
    const total = Object.values(HOMEWORK_PROBLEMS).reduce((n, hw) => n + Object.keys(hw).length, 0);
    console.log(`[hwCommands] Loaded ${hwPath}: ${total} problems across ${Object.keys(HOMEWORK_PROBLEMS).length} homeworks`);
  } catch (e) {
    console.log(`[hwCommands] No homework_problems.json found (${e.code || e.message}) — /HW commands will fall back to full-corpus search.`);
  }
}

function parseMatch(hwMatch) {
  return {
    isMinimalHint: !!hwMatch[1],
    hwNum: hwMatch[2],
    problemNum: hwMatch[3],
  };
}

// Free, deterministic overview — no Claude call, can't hallucinate a problem list.
// Returns null if there's no structured data (caller should fall back to
// buildDirective() + askClaude in that case) OR if a specific problemNum was asked
// for (that always needs a hint via Claude, not a listing).
function getStructuredOverview(hwNum, problemNum) {
  if (problemNum) return null;
  const problems = HOMEWORK_PROBLEMS[hwNum];
  if (!problems || !Object.keys(problems).length) return null;

  const nums = Object.keys(problems).sort((a, b) => Number(a) - Number(b));
  const lines = nums.map((n) => {
    const firstLine = problems[n]
      .split("\n")[0]
      .trim()
      .replace(new RegExp(`^${hwNum}\\.${n}\\b\\.?\\s*`), "")
      .replace(/\s*\(\d+\s*points?\)\s*$/i, "");
    return `${hwNum}.${n} — ${firstLine}`;
  });
  return `Homework ${hwNum}:\n${lines.join("\n")}\n\nAsk /HW${hwNum}.<problem number> for a hint on a specific one.`;
}

function buildDirective(hwNum, problemNum, isMinimalHint) {
  if (!problemNum) {
    return (
      `[HOMEWORK OVERVIEW REQUEST]\n` +
      `The student wants an overview of Homework ${hwNum}. Find "HOMEWORK ${hwNum}" in the course ` +
      `material and list each top-level numbered problem with a one-line topic description only ` +
      `(no sub-parts, no hints, no solutions, no point values needed). Keep the whole reply short — ` +
      `one line per problem. End with: "Ask /HW${hwNum}.<problem number> for a hint on a specific one."`
    );
  }

  const exactText = HOMEWORK_PROBLEMS[hwNum]?.[problemNum];
  const problemBlock = exactText
    ? `Here is the exact text of problem ${hwNum}.${problemNum}, verbatim from the assignment sheet:\n"""\n${exactText}\n"""\n`
    : `Find problem ${hwNum}.${problemNum} in Homework ${hwNum} in the course material below. ` +
      `If you can't find it, say so plainly instead of guessing.\n`;

  if (isMinimalHint) {
    return (
      `[HOMEWORK MINIMAL HINT REQUEST]\n` +
      `The student wants just a nudge for Homework ${hwNum}, problem ${problemNum} — no explanation. ${problemBlock}` +
      `Reply with ONE short guiding question only (a single sentence), optionally naming one equation ` +
      `or concept. No further explanation, no solution.`
    );
  }

  return (
    `[HOMEWORK HINT REQUEST]\n` +
    `The student is asking for help with Homework ${hwNum}, problem ${problemNum}. ${problemBlock}` +
    `Give ONE hint per your standing homework rules: name the relevant equation or concept, point ` +
    `to where it's covered, and ask one guiding question. Do not solve the problem or give the final answer.`
  );
}

function homeworkProblemsCount() {
  return Object.values(HOMEWORK_PROBLEMS).reduce((n, hw) => n + Object.keys(hw).length, 0);
}

const HELP_SNIPPET =
  "Homework commands:\n" +
  "- /HW3 — list the problems in Homework 3\n" +
  "- /HW3.2 — get a hint on Homework 3, problem 2\n" +
  "- /HW_hint3.2 — just a one-line nudge, no explanation";

module.exports = {
  HW_COMMAND_RE,
  load,
  parseMatch,
  getStructuredOverview,
  buildDirective,
  homeworkProblemsCount,
  HELP_SNIPPET,
};
