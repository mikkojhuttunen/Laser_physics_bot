# Pending (live-generated) quiz questions — workflow

## What they are
Both quiz banks hold 8 reviewed questions per section. When a student asks for **more unseen questions than the bank can supply** (e.g. `/quiz 2.4 12`, or a second round on a section after most questions were served recently), the bot tops up with a live LLM call (costs 1 credit) scoped to that section's lecture notes. Those live questions are served to that student and **also captured as *pending* questions** so you can review them and, if good, add them to the banks. Pending questions are never served from the pending files and never enter the banks automatically.

Files (repo root, committed as empty `[]`):
- `quizBankPending_fys501.json` — single-select (`/quiz`)
- `multivalueQuizBankPending_fys501.json` — multi-select (`/mvquiz`)

Each entry: `{ chapter, section, question: {id: "gen_…" | "mvgen_…", stem, options, correctIndex | correctIndices, explanation}, generatedAt }`.
Live output is validated first (single: exactly 4 distinct options + valid `correctIndex`; multi: 4–8 options, ≥2 correct and ≥1 wrong); invalid questions are dropped, neither served nor stored.

## Getting them out of Railway
Railway's container filesystem is wiped on every redeploy. Pick one (A is the simplest, B is the safest):

**A. Export from Telegram (admin only).** Set `ADMIN_USER_IDS` (already used for limits). Send the bot:
- `/pending` — summary by section + the two pending files as Telegram documents
- `/pending clear` — empty both files on the server (do this *after* saving the export)

**B. Persistent volume.** In Railway add a Volume mounted at `/data` and set `QUIZ_PENDING_DIR=/data`. Pending files then survive redeploys (`/pending` and `/healthz` report `persistentDir`). Optional: `QUIZ_PENDING_MAX` (default 500 entries per file; beyond that the file stops growing but log lines are still emitted).

**C. Log capture.** Every captured question is also printed as a log line (`QUIZ_PENDING_QUESTION {…}` / `MVQUIZ_PENDING_QUESTION {…}`). After a redeploy you can export the Railway logs to a file and run `node mergePending_fys501.js extract railway-logs.txt` to rebuild the pending files (plain or JSON-wrapped log lines are both understood; duplicates are skipped).

`/healthz` shows `pendingQuestions: { single, multi, persistentDir }` so you can see at a glance whether anything is waiting.

## Reviewing and merging (on your computer, in the repo folder)
```bash
# 1. save the exported files over the (empty) pending files in the repo folder, then:
node mergePending_fys501.js review          # writes pending_review.md (git-ignored)
```
`pending_review.md` lists every question with a short key (`S-1a2b3c` single, `M-4d5e6f` multi), ✅ on the correct options and a status:
`OK` · `SIMILAR` (≥60 % word overlap with a bank question in the same section) · `DUPLICATE` (identical stem in the bank or earlier in the file) · `INVALID` (structure/section problem). Warnings flag a single-select correct option that is much longer than the distractors, and characters that could break Telegram HTML.

```bash
# 2. merge what you accept (everything else is discarded with --drop-rest)
node mergePending_fys501.js merge --accept S-1a2b3c,M-4d5e6f --reviewed --drop-rest
#    or: --all-valid (every OK question)      --dry-run (preview only)
#    --allow-similar to accept a SIMILAR one   --assign S-abc123=2.4 to give a section to a question that has none
```
Merged questions get the next free id in their section (`q2.4_009`, `mv3.1_009`, …), `source: "claude-live-generated"`, today's `addedAt`, and `reviewed: true` only if you pass `--reviewed`. Backups `quizBank_fys501.json.bak` / `multivalueQuizBank_fys501.json.bak` are written first. Then:
```bash
node e2e_quiz_test.js                       # optional regression run
git add quizBank_fys501.json multivalueQuizBank_fys501.json
git commit -m "Add reviewed live-generated quiz questions" && git push origin main
git checkout -- quizBankPending_fys501.json multivalueQuizBankPending_fys501.json   # keep the repo copies empty
# and in Telegram: /pending clear
```
Sections may grow beyond 8 questions; nothing requires exactly 8.

## Corpus used for live generation
`corpusLoader_fys501.js` now uses, in order: `QUIZ_CORPUS_FILE` (env) → `course_corpus_fys501_v2.txt` → `course_corpus_fys501.txt`, and reads the per-chapter `LECTURE NOTES` blocks of the v2 corpus by section number (1.1–4.4). `/healthz` `corpusLooksHealthy` is now `false` if the loaded file contains no lecture-note/textbook chapters (before, a homework-sheets-only file passed the check).

**Note:** `bot_fys501.js` still loads `course_corpus_fys501.txt` for normal Q&A. If that file is the ~24 KB homework-only version, `/healthz` `corpusChars` will be ≈ 24,000 instead of ≈ 334,000 — check it on the live bot.

## Tests
`node e2e_pending_test.js` — capture (single + multi), validation of live output, `QUIZ_PENDING_DIR`, size cap, corrupt-file quarantine, the admin module, and the extract/review/merge CLI (temp folders only).
