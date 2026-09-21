'use strict';
/**
 * quizAnalyticsCommands_fys501.js
 * -------------------------------
 * Telegram-facing wrappers for the quiz analytics (bot_fys501.js only calls these).
 *
 *   /privacy          (everyone)  what is recorded and why
 *   /optout, /optin   (everyone)  stop / resume recording; /optout also deletes stored events
 *   /quizstats ...    (ADMIN_USER_IDS only, silently ignored for everyone else)
 *        /quizstats                 briefing: weakest sections, concepts, wrong answers, questions
 *        /quizstats sections|concepts|misconceptions|questions   one list, top 10
 *        /quizstats live            include live-generated (unreviewed) questions
 *        /quizstats export          send quiz_events.jsonl as a document (needs QUIZ_ANALYTICS_DIR)
 *        /quizstats clear confirm   empty the events file (after exporting)
 */

const analytics = require('./quizAnalytics_fys501');
const stats = require('./quizStats_fys501');
const limiter = require('./usageLimiter');

const FOCUS = new Set(['sections', 'concepts', 'misconceptions', 'questions']);

function privacyReply() {
  return analytics.privacyText();
}

function optOutReply(userId) {
  const r = analytics.optOut(userId);
  if (!r.ok) return 'Sorry, I could not process that right now - please try again later.';
  if (!r.enabled) return 'Quiz analytics are switched off, so nothing is being recorded about you.';
  return r.persistent
    ? `Done. I have stopped recording your quiz answers and deleted the ${r.purged} stored answer(s) linked to you. /optin turns recording back on.`
    : 'Done. I have stopped recording your quiz answers. (This server keeps no stored answer file, so there is nothing stored to delete. Your choice lasts until the bot restarts, so please repeat /optout after a restart.) /optin turns recording back on.';
}

function optInReply(userId) {
  const r = analytics.optIn(userId);
  if (!r.ok) return 'Sorry, I could not process that right now - please try again later.';
  if (!r.enabled) return 'Quiz analytics are switched off, so nothing is being recorded about you.';
  return 'Recording of anonymous quiz answers is on again. /optout stops it and deletes your stored answers.';
}

/**
 * @param {object} p
 * @param {number|string} p.chatId
 * @param {number|string} p.userId
 * @param {string} p.arg                    text after "/quizstats"
 * @param {(chatId, text) => Promise} p.sendText
 * @param {(chatId, filePath, filename, caption) => Promise} p.sendDocument
 * @returns {Promise<boolean>} false if the caller is not an admin (nothing was sent)
 */
async function handleQuizStatsCommand({ chatId, userId, arg, sendText, sendDocument }) {
  if (!limiter.isAdmin(userId)) return false;
  const words = String(arg || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (!analytics.isEnabled()) {
    await sendText(chatId, 'Quiz analytics are OFF. Set ANALYTICS_HASH_SECRET (16+ characters) on Railway, and QUIZ_ANALYTICS_DIR to a mounted volume so events survive redeploys. See QUIZ_ANALYTICS_fys501.md.');
    return true;
  }

  if (words[0] === 'export') {
    const p = analytics.eventsPath();
    if (!p || !analytics.readEventsText().trim()) {
      await sendText(chatId, p ? 'The events file is empty.' : 'No events file: QUIZ_ANALYTICS_DIR is not set. Recover events from the Railway logs (QUIZ_EVENT lines) with: node quizStats_fys501.js railway-logs.txt');
      return true;
    }
    try {
      await sendDocument(chatId, p, 'quiz_events.jsonl', 'Quiz events. Analyse with: node quizStats_fys501.js quiz_events.jsonl');
    } catch (e) {
      await sendText(chatId, `Could not send the events file: ${e.message}`);
    }
    return true;
  }

  if (words[0] === 'clear') {
    if (words[1] !== 'confirm') {
      await sendText(chatId, 'This empties the stored quiz events. Export first (/quizstats export), then send: /quizstats clear confirm');
      return true;
    }
    const n = analytics.clearEvents();
    await sendText(chatId, `Cleared ${n} stored quiz event(s).`);
    return true;
  }

  const includeLive = words.includes('live');
  const focus = words.find((w) => FOCUS.has(w)) || null;
  if (words.length && !focus && !includeLive) {
    await sendText(chatId, 'Usage: /quizstats [sections|concepts|misconceptions|questions] [live] | /quizstats export | /quizstats clear confirm');
    return true;
  }

  const events = stats.parseEvents(analytics.readEventsText());
  const report = stats.analyse(events, { includeLive }, stats.loadMeta());
  let text = stats.formatTelegram(report, { top: focus ? 10 : 5, focus });
  if (!analytics.persistentDir()) {
    text += '\n\nNote: QUIZ_ANALYTICS_DIR is not set, so no events are stored on this server; this report is empty. Use the Railway logs (QUIZ_EVENT lines) with node quizStats_fys501.js.';
  }
  await sendText(chatId, text);
  return true;
}

module.exports = { handleQuizStatsCommand, privacyReply, optOutReply, optInReply };
