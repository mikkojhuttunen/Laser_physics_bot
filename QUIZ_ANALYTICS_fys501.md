# Quiz analytics (v1.6.0): which topics do students find hard?

The bot records one **pseudonymous event per graded quiz answer** (single- and multi-select). A small analysis turns the events into a briefing for the on-site discussion sessions: weakest sections and concepts, the most attractive wrong answers (misconceptions), and the hardest questions. No LLM is involved in logging or analysis. Everything is **off** until you set `ANALYTICS_HASH_SECRET`.

## Files

| File | Role |
|---|---|
| `quizAnalytics_fys501.js` | Logging, pseudonymisation, one-time notice, opt-out |
| `quizStats_fys501.js` | Aggregation, small-group suppression, Telegram/Markdown briefing, CLI |
| `quizAnalyticsCommands_fys501.js` | `/privacy`, `/optout`, `/optin`, admin `/quizstats` |
| `concepts_fys501.json` | Concept vocabulary (30 draft concepts, keyed to the 20 bank sections) |
| `misconceptions_fys501.json` | Misconception catalogue (20 starter entries) |
| `validateQuizTags_fys501.js` | Validates the tag fields in both banks and reports coverage |
| `tagQuizBank_fys501.js` | Offline tool: Claude proposes tags, you review, then apply |
| `e2e_analytics_test.js` | Regression test (temp folders, no network) |

Changed: `bot_fys501.js` (commands, `/healthz`, `/source_quizzes`, help, changelog), `quizGenerator_fys501.js` and `multivalueQuizGenerator_fys501.js` (one logging call and one notice each), `.gitignore`. No new npm dependencies.

## Bank fields (all optional, additive)

Existing questions keep working unchanged. Three optional fields are added to a question object:

```json
{
  "id": "q3.5_004",
  "stem": "...",
  "options": ["...", "...", "...", "..."],
  "correctIndex": 2,
  "explanation": "...",
  "concepts": ["res.stability"],
  "optionTags": ["M-STAB-03", "M-STAB-02", null, null],
  "version": 1
}
```

- `concepts`: 1 to 3 ids from `concepts_fys501.json`; the first is the main concept.
- `optionTags`: one entry per option, in **stored** order. `null` at correct options; at a wrong option, the id of the misconception it embodies (from `misconceptions_fys501.json`), or `null` if it matches none. Do not force a fit. Single-select serves shuffled options, so the bot maps each answer back to the stored option by its text before looking up the tag.
- `version`: integer, absent means 1. **Bump it whenever you edit the stem, the options, the correct answer or the tags** of a question that students have already answered; statistics keep versions apart. Pure typo or explanation fixes do not need a bump.

Live-generated questions (`gen_`, `mvgen_` ids) are never tagged. They are logged with `live: 1` and left out of the analysis unless you pass `live`. When you merge a reviewed pending question with `mergePending_fys501.js` it enters the bank untagged; tag it with the tool below.

## Event format

One JSON object per line in `quiz_events.jsonl` (and as a `QUIZ_EVENT {...}` line in the Railway log):

```json
{"v":1,"d":"2026-09-21","pid":"a1b2c3d4e5f6","kind":"single","qid":"q3.5_004","qv":1,"sec":"3.5","concepts":["res.stability"],"live":0,"pick":[1],"score":0,"wrong":[1],"wrongTags":["M-STAB-02"],"missed":[]}
```

`pid` is a keyed hash of the Telegram id; `d` is the date only (no time of day); `pick`, `wrong` and `missed` are stored-option indices; `score` is 0/1 for single-select and 0 to 1 (the existing partial-credit score) for multi-select.

## Railway variables

| Variable | Meaning |
|---|---|
| `ANALYTICS_HASH_SECRET` | 16+ characters. Required to switch analytics on. Keep it private; destroying it makes stored events unlinkable to people. |
| `QUIZ_ANALYTICS_DIR` | Directory on a Railway **volume** (for example `/data/analytics`). Events go to `quiz_events.jsonl`, the opt-out list to `quiz_optout.json`. The same volume mounted at `/data` can also hold `QUIZ_PENDING_DIR`. Without it, events exist only as log lines. |
| `ADMIN_USER_IDS` | Already used by `/pending`; the same ids may use `/quizstats`. |
| `QUIZ_STATS_MIN_N` | Minimum group size, default 5. |
| `QUIZ_ANALYTICS_RETENTION` | Optional wording for when the data is deleted, used in the student notice and `/privacy`. Default: "after the course end, specifically on 31 Dec 2026" (change `DEFAULT_RETENTION` in `quizAnalytics_fys501.js` or set this variable). |
| `LIMIT_TIMEZONE` | Already used by the limiter; also defines the date in events (default Europe/Helsinki). |

## Commands

| Command | Who | What |
|---|---|---|
| `/privacy` | everyone | What is recorded and why |
| `/optout`, `/optin` | everyone | Stop or resume recording; `/optout` also deletes the student's stored events |
| `/quizstats` | admin | Briefing: weakest sections, concepts, wrong answers, questions |
| `/quizstats sections` (or `concepts`, `misconceptions`, `questions`) | admin | One list, top 10 |
| `/quizstats live` | admin | Include live-generated questions |
| `/quizstats export` | admin | Sends `quiz_events.jsonl` as a document |
| `/quizstats clear confirm` | admin | Empties the events file (export first) |

The first time a student starts a quiz after a deploy, the bot shows a short data collection notice at the top of the first question message (one Telegram message, so the quiz starts immediately). It states the purpose (finding topics to discuss in class; no effect on grades), the pseudonymisation (scrambled ID, no name, username or message text), and when the data is deleted (default: on 31 Dec 2026), and points to `/privacy` and `/optout`. `/privacy` gives the same information in full.

## Tagging the banks (offline, on your computer)

```
export ANTHROPIC_API_KEY=sk-...
node tagQuizBank_fys501.js suggest --section 3.5 --kind single --limit 8
node tagQuizBank_fys501.js suggest
node tagQuizBank_fys501.js apply --all-valid --dry-run
node tagQuizBank_fys501.js apply --all-valid
node validateQuizTags_fys501.js
```

A step-by-step walkthrough using your Claude Console account (workspace, spend limit, API key, Workbench test, usage check) is in `TAGGING_WITH_CONSOLE_fys501.md`. `node tagQuizBank_fys501.js estimate` prints the expected size and cost, and `node tagQuizBank_fys501.js prompt --id q3.5_004` prints the exact prompt to try in the Workbench. `suggest` stops by itself after 3 consecutive API errors.

1. `suggest` asks Claude (model from `--model`, `TAG_MODEL`, default `claude-sonnet-5`) for tags, one question at a time, using only that section's concepts and misconceptions. It is resumable and writes `tag_suggestions.json` and `tag_review.md`. Start with one section to check quality and cost, then run the rest.
2. Read `tag_review.md`. Each wrong option shows the misconception it was matched to, or "no tag". Edit `tag_suggestions.json` for any tag you disagree with (set it to `null` or another id), or leave that question out of `--accept`.
3. `apply` writes the accepted tags into the bank files (backup `<bank>.bak`, and it refuses to write anything that would fail validation).
4. `tag_review.md` ends with **proposed new misconceptions**. Add the ones you recognise to `misconceptions_fys501.json`, then re-run `suggest --ids q3.5_004,...` for those questions.
5. `node validateQuizTags_fys501.js` prints coverage per section; `/source_quizzes` in Telegram shows the coverage on the live bot.

The catalogue is the part that needs your judgement. The starter entries are plausible common errors, not measured ones; prune and reword them, and add the mistakes you see in homework and exams.

## How the numbers are computed

- Each student's **first** answer to a question (per version) counts, so repeated practice does not inflate results.
- A group's score is the mean over students of that student's mean score in the group, so heavy users do not dominate. `n` is the number of distinct students.
- Events logged before a question was tagged are filled in at analysis time from the current bank (only if the question's `version` is unchanged), so you can switch logging on now and tag later.
- Groups with fewer than `QUIZ_STATS_MIN_N` students are hidden, and `/quizstats` says how many groups were hidden.
- **Sections** work for every question. **Concepts** and **misconceptions** only use tagged questions; the briefing states what share of answers came from tagged questions.
- "Most attractive wrong answers": share of the students who saw a question containing that misconception as an option and picked it. For multi-select, ticking a tagged wrong option counts as picking it.

Read it as a pointer for discussion, not a verdict: participation is self-selected, cohorts are small, and a single flawed question can drag a concept down (check the "hardest questions" list for that).

## Offline analysis

```
node quizStats_fys501.js quiz_events.jsonl --min 5 --top 10 > quiz_briefing.md
node quizStats_fys501.js railway-logs.txt
```

The tool accepts the events file or a Railway log export (plain or JSON-wrapped `QUIZ_EVENT` lines, several files at once, duplicates ignored). `--live` includes live-generated questions; `--json` prints the raw report.

## Privacy and retention

Pseudonymised data is still personal data: whoever holds `ANALYTICS_HASH_SECRET` and the list of Telegram ids can recompute the links. Keep the secret out of the repo, share only aggregate briefings, and decide a retention date up front (for example: end of course). To finish: `/quizstats export`, then `/quizstats clear confirm`, then remove `ANALYTICS_HASH_SECRET` from Railway (which also makes any retained copy unlinkable). Agree the student notice and the retention period with the university's data protection contact before collecting; this document is a technical description, not legal advice.

## Operating notes

- Without a volume, Railway wipes the events file on every redeploy, and an opt-out only lasts until the restart (the bot says so in its reply). Use a volume for a real course.
- Logging never blocks or breaks a quiz: every analytics call is wrapped, and a write failure falls back to the log line.
- `/healthz` reports `quizAnalytics: { enabled, persistentDir, eventsFileBytes }`.
- The FYS.240 Optics bot has the same quiz architecture; the four analytics modules are course-agnostic apart from the file names and can be copied over with the same one-line hooks.

## Tests

`node e2e_analytics_test.js` covers: off by default and with a weak secret, event contents (including the shuffle mapping back to stored options), tags, multi-select events, live ids, opt-out with purge and persistence, statistics and suppression, log parsing, the admin commands, the tag validator, and the tagging tool with a stubbed model. Run `node e2e_quiz_test.js` and `node e2e_pending_test.js` as before.
