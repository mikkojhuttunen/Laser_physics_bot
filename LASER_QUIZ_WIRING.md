# Laser types quiz: wiring guide

## Files

| File | Purpose |
|---|---|
| `laserQuiz.js` | The module: question engine, grading, XP store, session flow, rendering |
| `laser_types.json` | Laser data bank (source of truth for every question) |
| `laser_quiz_names.js` | Hidden XP level ladder and the anonymous alias pool (both editable) |
| `test_laserQuiz.js` | `node test_laserQuiz.js`: data checks, scoring, ISO weeks, alias balance, full fake-Telegram quiz run |

Copy the first three next to `bot.js`. No new npm dependencies.

## bot.js wiring

```js
const { createLaserQuiz } = require('./laserQuiz');

// isCourseMember = your existing getChatMember-based access check (optional)
const laserQuiz = createLaserQuiz(bot, { isAllowed: (userId) => isCourseMember(userId) });

// Stage 0: before any LLM routing
bot.on('message', async (msg) => {
  if (laserQuiz.handleCommand(msg)) return;   // handles /lasers
  // ... existing routing
});

bot.on('callback_query', (q) => {
  if (laserQuiz.handleCallback(q)) return;    // handles callback_data starting with "lq:"
  // ... existing callback handling
});

// In your SIGTERM/shutdown handler (Railway sends SIGTERM on redeploy):
laserQuiz.shutdown();                          // flushes XP to disk
```

If `bot.js` already has one `callback_query` and one `message` handler, add the two `if` lines at the top of each.
The module never calls the LLM, so it does not touch `STUDENT_LLM_DAILY_USAGE` or the EUR backstop.
Also add `/lasers` to your `setMyCommands` list.

## Railway variables

| Variable | Default | Meaning |
|---|---|---|
| `WEEKLY_XP_ENABLED` | off | Collect mastery scores. Turns on the permanent level ladder and the header mastery counter. Requires `QUIZ_SALT`. Name kept for backward compatibility — there is no weekly reset; see "Mastery model" below. |
| `LEADERBOARD_VISIBLE` | off | Show the anonymous all-time top 10 after each quiz. Needs `WEEKLY_XP_ENABLED`; otherwise it is ignored with a startup warning. |
| `LASER_QUIZ_DAILY_XP_CAP` | 300 | Max mastery XP a student can GAIN per day (anti-cram, not anti-replay — replays of an already-mastered laser cost nothing to begin with). `0` = no cap. |
| `LASER_QUIZ_POINTS_PER_QUESTION` | 6 | XP for a fully-correct answer, before the streak bonus. |
| `LASER_QUIZ_STREAK_MIN` | 3 | Perfect answers in a row before the streak bonus kicks in. |
| `LASER_QUIZ_STREAK_BONUS` | 3 | Live-quiz bonus XP per perfect answer once the streak threshold is hit. Flavor only — excluded from mastery, see below. |
| `QUIZ_SALT` | none | Secret for hashing Telegram IDs. Generate once (`openssl rand -hex 32`) and never change it, or everyone gets a new identity. |
| `QUIZ_DATA_DIR` | `./data` | Set to your Railway volume mount path (e.g. `/data`), otherwise mastery data is lost on each deploy. |
| `QUIZ_TZ` | `Europe/Helsinki` | Time zone for day boundaries (daily mastery-gain cap resets at local midnight). |
| `LASER_QUIZ_SESSION_TTL_MIN` | 30 | Idle session timeout. |
| `LASER_QUIZ_LOG` | on | Append an anonymized per-step answer log (`laser_quiz_log.jsonl`) for finding hard topics. Needs `QUIZ_SALT`. |
| `LASER_QUIZ_REQUIRE_REVIEW` | off | Only serve lasers with `"reviewed": true` in `laser_types.json`. |

Flag behaviour:

| `WEEKLY_XP_ENABLED` | `LEADERBOARD_VISIBLE` | Students see |
|---|---|---|
| off | any | XP for the current session only. Nothing is stored. |
| on | off | Permanent mastery total, hidden level. Data is still collected, so the board can be switched on later. |
| on | on | All of the above plus the all-time top 10. |

## Mastery model

Mastery is **not** a running total of everything ever earned. For each laser, only your **best-ever round score** counts; total mastery = sum of your best score per laser, across every laser you've played. There is no weekly (or any) reset — a personal best, once banked, is permanent.

Practical effect: replaying a laser you've already aced adds nothing (a worse round never lowers the stored best; a matching or worse round is simply not a new best). The only way to raise your total is to improve on a laser you haven't yet maxed, or to play a laser for the first time. Reaching the top of the level ladder therefore genuinely requires close to 100% correct on every laser at least once — grinding one easy laser repeatedly does not substitute for that.

The streak bonus (`LASER_QUIZ_STREAK_BONUS`) is deliberately excluded from what counts toward mastery — it only affects the live "this quiz" flavor number shown during play. This keeps mastery immune to session-order luck: a hot streak carried over from an earlier laser in the same sitting can never inflate a specific laser's permanent best.

## What is stored

- `laser_xp.json`: per user an HMAC of the Telegram ID (never the raw ID), an alias, and `bestByLaser` — a map of laser id to that laser's best-ever round score. Total mastery is the sum of `bestByLaser`'s values, computed on read, not stored separately. `day`/`dayGain` track today's mastery-gain cap only, not mastery itself.
- `laser_quiz_log.jsonl`: `{ts, u (hashed), laser, step, pts, perfect}` per answered question, plus one `{..., kind:"round", pts, max, xp, isNewBest, masteryDelta}` event per completed laser. `masteryDelta` is what was actually banked (0 unless `isNewBest` is true) — sum that, not `xp`, for an accurate "total mastery gained" figure; see `laserStats_fys501.js` / `/laserstats`.
- Students only ever see alias plus their mastery total. The level ladder is never sent in full; the next level shows as `???`.

## Names

- Alias pool: 20 women and 20 men, disjoint from the ladder. Aliases are assigned to keep the class balanced: the next new student gets a name from whichever gender has been assigned fewer, so classes of up to 40 are exactly 50/50. Beyond 40 students, names get a numeral (`Ada Lovelace II`).
- Ladder: 15 levels, 7 women and 8 men (an odd number of levels cannot split evenly). Level bands are 50 XP wide from 0 to 350, so a first round already unlocks a level or two, and 100 XP wide from 400 up to the top level at 1000.

## Upper-state lifetime step

Each laser can carry a `lifetime: { bucket }` field, where `bucket` is one of the five order-of-magnitude labels in the top-level `lifetimeBuckets` array (ns → µs → 100s of µs → ms → 10s of ms). If present, a single-choice "what is the approximate upper-state lifetime?" step is inserted right after the level-scheme step, with 3 other buckets drawn as distractors. The explanation note (`notes.lifetime`) is where the "why it matters" payload lives — e.g. tying Ti:Sapph's ~3.2 µs lifetime to why it can't be flashlamp-pumped, or Nd:YAG's ~230 µs to why Q-switching works.

Lasers where a single clean lifetime number doesn't really exist (currently the two gas lasers, HeNe and CO₂) simply omit the `lifetime` field, and the step is skipped — the same pattern already used for `pumpWavelength` on electrically pumped lasers.

## Lasers without a level scheme

`level` is nullable. A gain medium whose physics doesn't map onto the 3-level/quasi-3-level/4-level framework at all can omit `level` (or set it to `null`) and the "level scheme" step is skipped entirely, the same way `pumpWavelength` is skipped for gas lasers.

The diode laser entry takes a different approach: rather than skipping the question, `levelSchemes` has a 4th option, `"N/A – semiconductor (no discrete atomic levels)"`, and diode's `level` points at it. That 4th option is also a legitimate wrong answer for every other laser's level-scheme question — a useful "trick" distractor that reminds students the atomic framework has limits.

## Before students see it

1. Every laser has `"reviewed": false`. Check each number and note in `laser_types.json`, then set it to `true` (and optionally set `LASER_QUIZ_REQUIRE_REVIEW=true`).
2. Startup validation throws with a list of problems if a laser is malformed (missing note, too few distractors, unknown pump key, lifetime bucket not in `lifetimeBuckets`, and so on).
3. Adding a laser: append an object to `lasers` following an existing entry. You need at least 4 lasers, because the "which transition" distractors come from other lasers.
4. This patch adds four new lasers, all `"reviewed": false`: **Ruby** (fills the one real gap in the level-scheme coverage — it's the only pure 3-level laser in the set), **Er:YAG** (2940 nm, self-terminating transition — its level-scheme step is skipped entirely; see "Freeform nuance questions" below), **Thulium/Tm:YAG** (~2010 nm, eye-safe, cross-relaxation), and **Diode** (the electrically-pumped semiconductor that pumps most of the other lasers in this set — no pump-wavelength step, and its own level-scheme answer is "N/A").

## Freeform nuance questions

A laser can carry an `extraQuestions` array for a laser-specific wrinkle that doesn't fit any of the standard fields above. Each entry supplies its own `id`, `title` (shown in place of the usual `STEP_TITLES` lookup), `q`, `multi`, `options` (`{t, ok}` pairs, 2–6 of them), and `note`. These are inserted right after the lifetime step.

Er:YAG uses this instead of the level-scheme question: its 2940 nm transition is self-terminating (the lower laser level outlives the upper one, the opposite of the usual 3-level/4-level assumption), which a 3-option multiple-choice doesn't represent well. Its `level` field is `null` (skipping the level-scheme step, the same nullable pattern the diode entry introduced) and `extraQuestions` carries a dedicated multi-select question — "which of the following are true about this transition?" — instead. That's a template for any future laser whose physics doesn't fit the standard fields cleanly.

Thulium uses the same mechanism differently: it keeps its normal level-scheme step (quasi-3-level is a clean fit) and *adds* an `extraQuestions` entry on top, testing the "two-for-one" cross-relaxation process — one absorbed pump photon exciting two Tm³⁺ ions, which is what makes its quantum defect so low despite the huge pump/laser wavelength gap. `extraQuestions` is additive, not a replacement, unless you also null out `level` the way Er:YAG does.

## Tuning notes

- A full single-sitting 100%-correct cycle through all current lasers (112 questions as of the 13-laser set) banks close to the top of the ladder (1000 XP) at the default `LASER_QUIZ_POINTS_PER_QUESTION=6` — by design, so reaching the top requires something close to mastering the whole set, not just playing a lot. Recompute this pairing (see the comment above `readConfig()` in `laserQuiz.js`) whenever the laser count changes meaningfully, and retune the ladder in `laser_quiz_names.js` if it starts feeling too easy or too grindy once you see real usage.
- Callback data format: `lq:s`, `lq:t:<step>:<option>`, `lq:c:<step>`, `lq:n:<step>`, `lq:l`, `lq:x` (all under 64 bytes). Buttons carrying an old step number are ignored, so stale messages cannot double-count XP.
