# Deploying the FYS.501 Laser Physics Bot to Railway

This covers the bot **as it stands now**: Telegram Q&A, `/HW<n>.<m>` homework
hints, `/HW<n>` overviews, and photo-based "am I on the right track" checks.
If you followed the older `COMPLETE_SETUP_GUIDE.md` before, the flow below is
the same shape — this just reflects the current files and adds the two new
pieces (`homework_problems.json`, and the optional `VISION_MODEL` variable).

---

## 0. Files you need in the repo root

```
bot.js                   — the bot (Telegram webhook + Claude calls)
build_corpus.js          — regenerates the two files below from PDFs
course_corpus.txt        — pre-built course text, loaded at startup
homework_problems.json   — pre-built per-problem lookup, loaded at startup
package.json             — dependencies + start script
```

`course_corpus.txt` and `homework_problems.json` are already built from your
current PDFs (including the new combined `FYS_501_LaserPhysics_allHWs_2026.pdf`)
from our last step — use those unless you change the course material again.

---

## 1. Credentials you need before starting

| Credential | Where to get it |
|---|---|
| **Telegram bot token** | Message `@BotFather` on Telegram → `/newbot` → follow prompts |
| **Anthropic API key** | [console.anthropic.com/account/keys](https://console.anthropic.com/account/keys) → Create Key |
| **GitHub account** | [github.com/signup](https://github.com/signup) (Railway deploys from a GitHub repo) |

Quick sanity checks:
```bash
# Telegram token works?
curl https://api.telegram.org/bot<TELEGRAM_TOKEN>/getMe

# Anthropic key works?
curl https://api.anthropic.com/v1/models \
  -H "x-api-key: <ANTHROPIC_API_KEY>" \
  -H "anthropic-version: 2023-06-01"
```
Both should return `"ok": true` / a list of models.

---

## 2. Push the repo to GitHub

```bash
mkdir fys501-laser-bot && cd fys501-laser-bot
git init && git branch -M main

# copy in: bot.js, build_corpus.js, course_corpus.txt,
#          homework_problems.json, package.json

cat > .gitignore << 'EOF'
node_modules/
npm-debug.log
package-lock.json
.env
.env.local
EOF

git add .
git commit -m "initial: bot with HW commands + photo check"

# create the repo on github.com/new first, then:
git remote add origin https://github.com/<YOUR_USERNAME>/fys501-laser-bot.git
git push -u origin main
```

⚠️ Never commit `HW*_solutions.pdf` or a `.env` file with real keys.

---

## 3. Deploy on Railway

1. **railway.app** → sign up (GitHub login is easiest).
2. **+ New Project** → **Deploy from GitHub Repo** → authorize → pick
   `fys501-laser-bot`. Railway detects `package.json` and runs `npm install`
   + `npm start` automatically — no config file needed.
3. **Variables** tab → add:

   | Name | Required | Value |
   |---|---|---|
   | `TELEGRAM_TOKEN` | yes | from @BotFather |
   | `ANTHROPIC_API_KEY` | yes | from console.anthropic.com |
   | `BOT_USERNAME` | yes | your bot's username, no `@` |
   | `CLAUDE_MODEL` | no | default `claude-haiku-4-5-20251001` |
   | `VISION_MODEL` | no | model used for photo checks; defaults to `CLAUDE_MODEL` if unset. Only set this if you want a *different* (e.g. stronger) model just for reading handwritten photos. |
   | `CACHE_TTL` | no | default `1h` |
   | `MAX_TOKENS` | no | default `900` |

4. **Networking** tab → copy the public URL, e.g.
   `https://fys501-laser-bot-xyz.railway.app`.

---

## 4. Point Telegram at your Railway URL

```bash
TOKEN="<your telegram token>"
BOT_URL="https://fys501-laser-bot-xyz.railway.app"

curl -X POST https://api.telegram.org/bot${TOKEN}/setWebhook \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"${BOT_URL}/webhook\"}"
```
Expect `{"ok":true,"result":true,"description":"Webhook was set"}`.

Verify any time with:
```bash
curl https://api.telegram.org/bot${TOKEN}/getWebhookInfo
```

---

## 5. Test checklist

Open Telegram, find your bot, and try each of these:

| Test | Send | Expect |
|---|---|---|
| Basic help | `/help` | Help text listing HW commands, back in 2–3s |
| Overview | `/HW3` | Instant list of problems 3.1–3.4 (no API delay — served from `homework_problems.json`) |
| Hint | `/HW3.2` | A hint referencing the exact problem 3.2 text, not a solution |
| Minimal hint | `/HW_hint3.2` | One short guiding question only |
| Photo check | Send a photo of any worked math, caption `/HW3.2` | 2–3 sentence "right track / not quite" read, no full solution |
| Conceptual Q&A | `Explain stimulated emission` | Short answer, Unicode math (no `$...$` or LaTeX) |

Also hit `GET <BOT_URL>/healthz` in a browser — it should report
`corpusChars` and `homeworkProblemsLoaded: 24` (or however many problems
you've currently got). If `homeworkProblemsLoaded` is `0`, the JSON either
didn't get committed/pushed or wasn't picked up — check the Railway logs for
the "Loaded homework_problems.json" line at startup.

---

## 6. Updating course material later

Whenever the PDFs change (including re-numbering homework problems):

```bash
mkdir -p pdfs
cp Chapter_1.pdf Chapter_2.pdf Chapter_3.pdf Chapter_4.pdf pdfs/
cp Laser_Physics_Slides.pdf pdfs/                     # if you have it
cp FYS_501_LaserPhysics_allHWs_2026.pdf pdfs/         # the combined HW file
rm -f pdfs/*solution*                                 # never include solutions

npm install pdf-parse@1.1.1     # one-time, matches package.json devDependency
node build_corpus.js ./pdfs
```

Watch the console output — for each homework it prints the problems it found,
e.g. `(parsed 4 problems: 3.1, 3.2, 3.3, 3.4)`. A `WARNING: found 0 numbered
problems` means a problem in that PDF isn't starting its own line with
exactly `<hw>.<n>` — check the PDF text before committing.

```bash
git add course_corpus.txt homework_problems.json
git commit -m "update: refreshed course material"
git push origin main
```
Railway auto-redeploys in ~30 seconds; no webhook changes needed.

---

## 7. Troubleshooting quick hits

- **No response at all** → Railway → Logs tab for errors; Variables tab to
  confirm the three required vars are set; re-check webhook with
  `getWebhookInfo`.
- **Photo check errors / times out** → confirm `ANTHROPIC_API_KEY` has vision
  access (all current Claude models do) and the photo isn't unusually large;
  check Railway logs for `"Photo check failed:"`.
- **`/HW3` overview looks stale or wrong** → it's served straight from
  `homework_problems.json`, so rebuild and redeploy that file, not `bot.js`.
- **Slow first message of the day** → normal, that's the prompt-cache write;
  subsequent messages within the cache TTL are fast and cheap.
