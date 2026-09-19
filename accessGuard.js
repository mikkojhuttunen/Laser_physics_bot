'use strict';
/**
 * accessGuard.js - thin helpers used from bot.js. Student-facing texts live here.
 */
const { isCourseMember } = require('./membership');
const limiter = require('./usageLimiter');

const MSG = {
  notMember:
    'This assistant is for FYS.501 students. Please join the course channel first, then send your message again.',

  userLimit:
    "You've used today's AI-assistant allowance. It resets at midnight (Finnish time). " +
    'Lecture links and commands still work in the meantime.',

  backstop:
    'The assistant has reached its shared daily capacity, so AI answers are paused until midnight ' +
    '(Finnish time). Lecture links and commands still work. Sorry for the inconvenience - please try again tomorrow.',

  lowRemaining: (n) => `ℹ️ ${n} AI answer${n === 1 ? '' : 's'} left today.`,
  usage: (used, limit) => `Today you have used ${used} of ${limit} AI credits. Resets at midnight (Finnish time).`,
  usageAdmin: 'Admin: no limits apply to you.',
};

/**
 * Call at the top of every message / callback_query handler. Returns true if allowed.
 * Pass { silent: true } in group chats so non-members don't trigger notices there.
 */
async function requireMember(bot, chatId, userId, { silent = false } = {}) {
  if (userId !== undefined && userId !== null && (await isCourseMember(bot, userId))) return true;
  if (!silent) await bot.sendMessage(chatId, MSG.notMember);
  return false;
}

/**
 * Call right before an LLM-backed action (Stage 2 answers, quiz, /checkhw).
 * Returns the reservation; if reservation.ok is false the student was already notified.
 */
async function requireLLMBudget(bot, chatId, userId, kind = 'chat') {
  const r = limiter.reserve(userId, kind);
  if (!r.ok) {
    await bot.sendMessage(chatId, r.reason === 'backstop' ? MSG.backstop : MSG.userLimit);
  }
  return r;
}

/** Optional "running low" note after a successful answer. */
async function maybeWarnLow(bot, chatId, reservation) {
  if (reservation.ok && !reservation.admin && reservation.remaining <= 2 && reservation.remaining >= 0) {
    await bot.sendMessage(chatId, MSG.lowRemaining(reservation.remaining));
  }
}

/** Text for a /usage command (free, no LLM). */
function usageText(userId) {
  const s = limiter.userStatus(userId);
  return s.admin ? MSG.usageAdmin : MSG.usage(s.used, s.limit);
}

/** Call when the LLM call failed, so the student is not charged. */
function refundLLM(userId, reservation) {
  if (reservation && reservation.ok) limiter.refund(userId, reservation.cost);
}

module.exports = { requireMember, requireLLMBudget, maybeWarnLow, usageText, refundLLM, MSG };
