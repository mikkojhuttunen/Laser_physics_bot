# Deployment Guide: LaTeX Rendering for Laser Physics Bot

Step-by-step instructions for deploying LaTeX support to production.

---

## Pre-Deployment Checklist

- [ ] All files copied locally
- [ ] `.env` updated with `LATEX_ENABLED=true`
- [ ] Bot tested locally (equations render as images)
- [ ] Git working directory clean
- [ ] Backup of current `bot.js` exists

---

## Deployment Steps

### 1. Local Testing (5 min)

```bash
# Copy new files
cp latex-renderer.js ./
cp bot_modified.js bot.js

# Update .env
echo "LATEX_ENABLED=true" >> .env
echo "LATEX_VERIFY_BEFORE_SEND=true" >> .env

# Test locally
TELEGRAM_TOKEN="your_token" \
ANTHROPIC_API_KEY="your_key" \
node bot.js

# In another terminal, test with your bot (ask math question)
# Check that images render
```

Expected log:
```
Bot listening on port 3000 | model=claude-haiku-4-5-20251001 | cache=1h | LaTeX=ENABLED ✓
```

### 2. Version Control (5 min)

```bash
# Review changes
git diff bot.js | head -50

# Stage new files
git add latex-renderer.js SETUP_LATEX.md LATEX_IMPLEMENTATION_CHECKLIST.md DEPLOY_LATEX.md
git add bot.js

# Update .gitignore if needed
echo "bot_backup.js" >> .gitignore

# Update .env.example
git add .env.example

# Check what you're about to commit
git status
```

Should show:
```
New file:   latex-renderer.js
New file:   SETUP_LATEX.md
New file:   LATEX_IMPLEMENTATION_CHECKLIST.md
New file:   DEPLOY_LATEX.md
Modified:   bot.js
Modified:   .env.example
```

### 3. Commit

```bash
git commit -m "feat: add LaTeX equation rendering via CodeCogs

- New latex-renderer.js module for parsing and sending rendered equations
- Updated bot.js to use LaTeX rendering (default enabled)
- Updated TA_INSTRUCTIONS to guide Claude in using LaTeX syntax
- Added SETUP_LATEX.md with detailed documentation
- Support for fallback to plain text if rendering fails

Resolves: Better equation readability for students"
```

### 4. Push to Remote

```bash
# For main branch (production)
git push origin main

# Or for a staging branch first
git push origin feature/latex-rendering
# Then create PR for review
```

### 5. Deploy to Server

#### Option A: Docker Container

```bash
# SSH into your server
ssh your-server

# Pull latest code
cd /path/to/bot
git pull origin main

# Rebuild container
docker build -t fys501-bot:latest .
docker-compose down
docker-compose up -d

# Check logs
docker logs -f fys501-bot
```

Expected output:
```
Bot listening on port 3000 | ... | LaTeX=ENABLED ✓
```

#### Option B: Heroku

```bash
# If using Heroku:
git push heroku main

# Monitor deployment
heroku logs --tail

# Verify
heroku open /healthz
# Should show: { "latexEnabled": true, ... }
```

#### Option C: Direct Node.js (PM2/systemd)

```bash
# SSH to server
ssh your-server

# Update code
cd /path/to/bot
git pull origin main

# Restart bot
systemctl restart fys501-bot
# OR
pm2 restart bot.js

# Verify
curl http://localhost:3000/healthz
```

#### Option D: Manual Deployment

```bash
# If manual:
# 1. Upload new files (bot.js, latex-renderer.js) via SCP/SFTP
# 2. Update .env with LATEX_ENABLED=true
# 3. Restart bot process manually
# 4. Test in Telegram
```

### 6. Post-Deployment Verification (5 min)

```bash
# Check health endpoint
curl https://your-bot-domain/healthz
# Should show: { "ok": true, "latexEnabled": true }

# Test with bot in Telegram
# Send: "What is the energy of a photon?"
# Expect: Text + rendered equation image + text

# Check logs for errors
# Look for: "Claude ok" and no "sendMessage failed"
```

### 7. Rollback Plan (if needed)

If LaTeX rendering causes issues:

```bash
# Option 1: Quick disable via environment
ssh your-server
# Edit .env: LATEX_ENABLED=false
# Restart bot
systemctl restart fys501-bot

# Option 2: Git revert (if serious issues)
git revert HEAD --no-edit
git push origin main
# Restart bot on server

# Option 3: Restore from backup
git checkout HEAD~1 bot.js
git commit -am "Revert LaTeX support"
git push origin main
# Restart bot
```

---

## Environment Setup per Platform

### AWS EC2

```bash
# SSH in
ssh -i your-key.pem ubuntu@your-instance.compute.amazonaws.com

# Update and restart
cd /home/ubuntu/laser-bot
git pull origin main
sudo systemctl restart laser-bot

# View logs
sudo journalctl -u laser-bot -f
```

### Google Cloud Run

```bash
# Update code
git push origin main

# Build and deploy
gcloud run deploy fys501-bot \
  --source . \
  --region us-central1 \
  --set-env-vars LATEX_ENABLED=true

# View logs
gcloud functions logs read fys501-bot
```

### Render / Railway / Similar

```bash
# Just push to GitHub
git push origin main
# Service auto-redeploys from main branch
# Check deployment logs in service dashboard
```

### Docker Compose (Local/Staging)

```bash
# Ensure Dockerfile has Node.js deps
docker build -t fys501-bot:latest .

# Update docker-compose.yml if needed:
# environment:
#   - LATEX_ENABLED=true

docker-compose up -d

# Verify
curl http://localhost:3000/healthz
```

---

## Configuration After Deployment

### Enable/Disable LaTeX Remotely

Without restarting bot, you can toggle via environment:

```bash
# Disable (emergency fallback)
export LATEX_ENABLED=false
# Restart bot
systemctl restart fys501-bot

# Re-enable
export LATEX_ENABLED=true
systemctl restart fys501-bot
```

### Performance Tuning

**If responses are slow:**
```bash
# Edit .env
LATEX_VERIFY_BEFORE_SEND=false
# Restart

# Trade-off: Slightly faster, but may show error if LaTeX syntax invalid
```

**If images look blurry:**
```bash
# Edit latex-renderer.js line 17
# Change: const DEFAULT_DPI = 150;
# To:     const DEFAULT_DPI = 200;
# Restart bot
```

---

## Monitoring

### Health Check

```bash
# Periodic health check
watch -n 60 'curl -s http://localhost:3000/healthz | jq .'

# Should consistently show:
# {
#   "ok": true,
#   "corpusChars": 123456,
#   "latexEnabled": true
# }
```

### Error Monitoring

```bash
# Watch for LaTeX-specific errors
tail -f bot.log | grep -i "latex\|codecogs"

# Should be rare. If many errors:
# 1. Check CodeCogs API status
# 2. Verify Telegram token valid
# 3. Check Anthropic API status
```

### Performance Metrics

```bash
# Log parsing (example)
tail -f bot.log | grep "Claude ok"

# Should see:
# Claude ok | in=150 cache_write=0 cache_read=1200 out=45
```

---

## Common Issues During Deployment

| Issue | Solution |
|-------|----------|
| `latex-renderer.js: MODULE NOT FOUND` | Ensure `latex-renderer.js` is in same directory as `bot.js` |
| `LATEX_ENABLED` undefined | Add to `.env` file: `LATEX_ENABLED=true` |
| Images don't render | Verify CodeCogs is accessible from your server (check firewall) |
| Slow responses | Set `LATEX_VERIFY_BEFORE_SEND=false` in `.env` |
| Bot doesn't start | Check `node bot.js` runs locally first |
| Git commit fails | Ensure `.git/` repo exists, not just code copy |

---

## Rollback Procedure

### 1-Click Rollback (Simple)

```bash
# Disable LaTeX feature flag
LATEX_ENABLED=false
# Restart bot
systemctl restart fys501-bot

# Bot now works exactly as before (plain text)
# Students see $$ ... $$ but as text, not images
```

### Full Rollback (if needed)

```bash
# Go to previous commit
git log --oneline | head -5
# Find commit before LaTeX addition

git reset --hard <PREVIOUS_COMMIT_SHA>
git push origin main --force

# Restart bot on server
systemctl restart fys501-bot

# Verify
curl http://localhost:3000/healthz
# Should show: { "latexEnabled": false } (if old code)
```

---

## Deployment Checklist

```bash
# Pre-deployment
- [ ] Local testing passed
- [ ] All new files copied
- [ ] .env updated
- [ ] git status clean
- [ ] Backup of current bot.js exists

# During deployment
- [ ] Files committed and pushed
- [ ] Server updated (git pull / docker rebuild)
- [ ] Bot restarted
- [ ] Health check passes

# Post-deployment
- [ ] Test in Telegram (send math question)
- [ ] Verify equation renders as image
- [ ] Check logs for errors
- [ ] Monitor for 24 hours

# Rollback readiness
- [ ] Understand how to disable LATEX_ENABLED
- [ ] Know previous commit SHA (git log)
- [ ] Have admin access to server
```

---

## Support & Troubleshooting

**Still having issues?**

1. **Check logs**: `tail -f /path/to/bot.log`
2. **Test locally**: `TELEGRAM_TOKEN=... node bot.js`
3. **Check CodeCogs**: Visit https://www.codecogs.com/latex/about.php
4. **Verify Telegram**: Send `/start` to bot, expect HELP_TEXT

**Document the issue with:**
```bash
# Collect debug info
node --version
npm --version
curl http://localhost:3000/healthz
tail -n 50 bot.log
```

---

**Deployment Version**: 1.0  
**Last Updated**: 2025-09-06  
**Status**: Production Ready ✓
