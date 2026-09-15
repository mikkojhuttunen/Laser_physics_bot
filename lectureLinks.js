// lectureLinks.js
// Handles lookup and formatting of lecture video links for the TA bot.
// Data source: lecture_data.json (weeks -> topics -> keywords -> lectures)

const fs = require('fs');
const path = require('path');
const { classifyLectureQuery } = require('./lectureClassifier');

let lectureData = null;

/**
 * Stage 1 gate: cheap, local, no network call. Only messages matching this
 * get sent on to the Stage 2 LLM classifier — keeps the classifier call
 * rare and cheap rather than firing on every message.
 */
const STAGE1_TRIGGER = /\b(video|lecture|recording|watch|rewatch|stream)\b/i;

/**
 * Loads lecture_data.json once at startup. Mirrors the corpus-loading
 * pattern used elsewhere in the bot: load once, keep in memory, and expose
 * a health flag rather than failing silently.
 */
function loadLectureData(dataPath = path.join(__dirname, 'lecture_data.json')) {
  try {
    const raw = fs.readFileSync(dataPath, 'utf8');
    lectureData = JSON.parse(raw);
    console.log(`[lectureLinks] Loaded ${lectureData.weeks.length} weeks of lecture data.`);
    return true;
  } catch (err) {
    console.error('[lectureLinks] Failed to load lecture_data.json:', err.message);
    lectureData = { weeks: [] };
    return false;
  }
}

/** Simple health check, same spirit as corpusLooksHealthy in bot.js */
function lectureDataLooksHealthy() {
  return !!lectureData && Array.isArray(lectureData.weeks) && lectureData.weeks.length > 0;
}

/** Escape a string for safe use inside a RegExp */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds weeks whose topic/keywords match the query text.
 * Scoring: +2 for topic phrase match, +1 per keyword match. Returns weeks
 * sorted by score, highest first. Only weeks with score > 0 are returned.
 */
function findLecturesByTopic(query) {
  if (!lectureDataLooksHealthy()) return [];
  const q = query.toLowerCase();

  const scored = lectureData.weeks.map((week) => {
    let score = 0;
    if (q.includes(week.topic.toLowerCase())) score += 2;
    for (const kw of week.keywords) {
      const re = new RegExp(`\\b${escapeRegex(kw.toLowerCase())}\\b`);
      if (re.test(q)) score += 1;
    }
    return { week, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.week);
}

/** Returns the week object for a given week number, or null */
function getWeekLectures(weekNumber) {
  if (!lectureDataLooksHealthy()) return null;
  return lectureData.weeks.find((w) => w.week === weekNumber) || null;
}

/** Returns all weeks (for a "list everything" request) */
function getAllWeeks() {
  if (!lectureDataLooksHealthy()) return [];
  return lectureData.weeks;
}

/**
 * Minimal context for the Stage 2 classifier: week number, topic, keywords.
 * Deliberately excludes URLs and lecture titles — "inject minimally per
 * call", same principle as only sending one answer-key entry per grading call.
 */
function getTopicsSummary() {
  if (!lectureDataLooksHealthy()) return [];
  return lectureData.weeks.map((w) => ({
    week: w.week,
    topic: w.topic,
    keywords: w.keywords,
  }));
}

/** Matches "week 2", "week #2", "wk2", etc. Deliberately doesn't require
 * the word "lecture(s)" alongside it — "/lectures week 2" already carries
 * that intent from the command itself. */
const WEEK_NUMBER_RE = /\bwe?e?k\s*#?\s*(\d{1,2})\b/i;

/** Pulls an explicit week number out of a query, or null if none is present. */
function extractWeekNumber(query) {
  const m = query.match(WEEK_NUMBER_RE);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Two-stage entry point for bot.js.
 * Stage 1 (regex, STAGE1_TRIGGER) should already have fired before this is
 * called. Stage 2 asks the classifier LLM which week(s) match; the LLM only
 * ever returns week numbers, never URLs. This function then looks those
 * weeks up locally and formats the real links. If the classifier call fails
 * for any reason, it falls back to the local keyword matcher so the bot
 * still responds instead of erroring out.
 */
async function handleLectureQuery(query) {
  if (!lectureDataLooksHealthy()) {
    return "Lecture listing isn't available right now — please check back later.";
  }

  // Fast path: an explicit "week N" mention is unambiguous, so resolve it
  // locally and skip the LLM call entirely — cheaper and instant, and it
  // still works if the classifier API is ever unreachable/misconfigured.
  const explicitWeek = extractWeekNumber(query);
  if (explicitWeek !== null) {
    const week = getWeekLectures(explicitWeek);
    if (week) return formatWeekMessage(week);
    return `I don't have a Week ${explicitWeek} — this course has ${lectureData.weeks.length} weeks of lecture videos. Try /lectures for the full listing.`;
  }

  const topicsSummary = getTopicsSummary();
  const classification = await classifyLectureQuery(query, topicsSummary);

  if (classification === null) {
    // Stage 2 unavailable/errored — fall back to local keyword matching.
    return formatTopicMatches(query);
  }

  if (classification.matchedWeeks.length > 0) {
    const weeks = classification.matchedWeeks.map((w) => getWeekLectures(w)).filter(Boolean);
    if (weeks.length > 0) {
      return weeks.map(formatWeekMessage).join('\n\n');
    }
  }

  if (classification.clarificationNeeded) {
    return classification.clarificationQuestion || "Could you tell me which topic or week you're asking about?";
  }

  return `I couldn't find a lecture matching "${query}". Try /lectures to see the full listing, or rephrase with a topic like "resonator stability" or "gain saturation".`;
}

/**
 * Formats a single week's lectures as Telegram HTML (matches the bot's
 * existing HTML parse_mode convention — no LaTeX/Markdown here).
 */
function formatWeekMessage(week) {
  if (!week) return "I couldn't find lectures for that week.";
  const lines = [`<b>Week ${week.week} — ${escapeHtml(week.topic)}</b>`];
  for (const lec of week.lectures) {
    lines.push(`• <a href="${lec.url}">${escapeHtml(lec.title)}</a> (${lec.duration})`);
  }
  return lines.join('\n');
}

/** Formats a full-course listing, grouped by week */
function formatFullListing() {
  const weeks = getAllWeeks();
  if (weeks.length === 0) return "Lecture listing isn't available right now — please check back later.";
  return weeks.map(formatWeekMessage).join('\n\n');
}

/** Formats topic-search results (one or more matching weeks) */
function formatTopicMatches(query) {
  const matches = findLecturesByTopic(query);
  if (matches.length === 0) {
    return `I couldn't find a lecture specifically matching "${query}". Try asking for a specific week (e.g. "week 5 lectures") or check the full listing with /lectures.`;
  }
  return matches.map(formatWeekMessage).join('\n\n');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  loadLectureData,
  lectureDataLooksHealthy,
  findLecturesByTopic,
  getWeekLectures,
  getAllWeeks,
  getTopicsSummary,
  formatWeekMessage,
  formatFullListing,
  formatTopicMatches,
  STAGE1_TRIGGER,
  handleLectureQuery,
};
