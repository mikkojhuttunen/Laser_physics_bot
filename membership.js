'use strict';
/**
 * membership.js - on-demand course-channel membership check (getChatMember + short cache).
 *
 * Railway variables:
 *   COURSE_CHANNEL_ID          e.g. -1001234567890 (bot must be admin of the channel).
 *                              If unset, the membership check is DISABLED (a warning is logged).
 *   MEMBERSHIP_CACHE_SECONDS   cache lifetime per user            (default 300)
 *   MEMBERSHIP_FAIL_OPEN       "true" = allow users when Telegram cannot be reached and
 *                              no cached answer exists            (default false = deny)
 *   ADMIN_USER_IDS             comma-separated Telegram IDs that always pass
 */

const cache = new Map(); // userId -> { ok, ts }
let warnedDisabled = false;

function ttlMs() {
  const s = Number(process.env.MEMBERSHIP_CACHE_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : 300) * 1000;
}

function isAdmin(userId) {
  return (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(userId));
}

function statusIsMember(m) {
  if (['creator', 'administrator', 'member'].includes(m.status)) return true;
  if (m.status === 'restricted') return m.is_member === true;
  return false; // 'left' | 'kicked'
}

async function isCourseMember(bot, userId) {
  if (isAdmin(userId)) return true;

  const channel = process.env.COURSE_CHANNEL_ID;
  if (!channel) {
    if (!warnedDisabled) {
      console.warn('[membership] COURSE_CHANNEL_ID not set - membership check is DISABLED');
      warnedDisabled = true;
    }
    return true;
  }

  const key = String(userId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs()) return hit.ok;

  try {
    const member = await bot.getChatMember(channel, userId);
    const ok = statusIsMember(member);
    cache.set(key, { ok, ts: Date.now() });
    return ok;
  } catch (err) {
    const msg = String((err && (err.message || err.response?.body?.description)) || err);

    // Telegram says the user is unknown to the chat -> not a member.
    if (/user not found|PARTICIPANT_ID_INVALID/i.test(msg)) {
      cache.set(key, { ok: false, ts: Date.now() });
      return false;
    }

    // Anything else (network, 429, 5xx, bot not admin / chat not found) is a problem on our side.
    console.error(`[membership] getChatMember failed for ${key}: ${msg}`);
    if (hit) return hit.ok; // stale answer is better than none
    return process.env.MEMBERSHIP_FAIL_OPEN === 'true';
  }
}

module.exports = { isCourseMember };
