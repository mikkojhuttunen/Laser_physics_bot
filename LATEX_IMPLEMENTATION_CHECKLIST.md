# LaTeX Implementation Checklist

Quick reference for integrating LaTeX rendering into your Telegram bot.

## Files to Change/Add

### Files to Replace
- [ ] `bot.js` → Replace with `bot_modified.js` (or manually apply changes below)

### Files to Add
- [ ] `latex-renderer.js` ← NEW utility module (copy directly)
- [ ] `.env.example` ← UPDATE with new `LATEX_ENABLED` option

### Documentation
- [ ] `SETUP_LATEX.md` ← Detailed guide (for reference/GitHub)
- [ ] `LATEX_IMPLEMENTATION_CHECKLIST.md` ← This file

---

## Quick Implementation Steps

### Step 1: Copy New Files
```bash
# Copy the LaTeX renderer module
cp latex-renderer.js ./

# Or if you modified bot.js manually:
cp bot.js bot.js.backup
cp bot_modified.js bot.js
```

### Step 2: Update Environment
```bash
# Edit your .env file
nano .env

# Add/update this line:
LATEX_ENABLED=true
LATEX_VERIFY_BEFORE_SEND=true
```

### Step 3: Install Dependencies (if needed)
```bash
npm install
# Should already have: axios, express
```

### Step 4: Test Locally
```bash
TELEGRAM_TOKEN=xxx ANTHROPIC_API_KEY=yyy node bot.js
# Should log: "LaTeX=ENABLED ✓"
```

### Step 5: Deploy
```bash
git add bot.js latex-renderer.js .env.example SETUP_LATEX.md
git commit -m "feat: add LaTeX rendering support"
git push origin main
# Restart bot on your server
```

---

## What Changed in bot.js?

| Section | Change | Details |
|---------|--------|---------|
| **Imports** | Added | `const { extractAndSendLatex } = require("./latex-renderer");` |
| **TA_INSTRUCTIONS** | Updated | Now tells Claude to use `$$..$$` for equations + LaTeX syntax |
| **Config** | Added | `LATEX_ENABLED` env variable (default: `true`) |
| **sendMessage()** | Modified | Now calls `extractAndSendLatex()` if `LATEX_ENABLED` is true |
| **Logging** | Updated | Shows `LaTeX=ENABLED ✓` or `LaTeX=disabled` on startup |
| **/healthz** | Updated | Returns `latexEnabled` status |

---

## How It Works (User-Facing)

### Before (Plain Text)
```
Bot: "The energy is: $$E = h\\nu$$"
```
Students see: Raw LaTeX text (ugly on mobile)

### After (With Rendering)
```
Bot: "The energy is:"
Bot: [IMAGE: E = hν]
Bot: "where h is Planck's constant"
```
Students see: Clean rendered equations (mobile-friendly)

---

## Disable LaTeX Anytime

If you need to turn off LaTeX rendering (fallback to plain text):

**Option 1: Environment variable**
```bash
LATEX_ENABLED=false
# Restart bot
```

**Option 2: Revert bot.js**
```bash
git checkout HEAD~1 bot.js
# Restart bot
```

---

## Environment Variables Reference

| Variable | Default | Purpose | When to Change |
|----------|---------|---------|-----------------|
| `LATEX_ENABLED` | `true` | Enable LaTeX rendering | Set to `false` to debug plain text |
| `LATEX_VERIFY_BEFORE_SEND` | `true` | Verify CodeCogs before sending | Set to `false` for speed (trade: may fail silently) |
| `TELEGRAM_TOKEN` | (required) | Your Telegram bot token | — |
| `ANTHROPIC_API_KEY` | (required) | Your Claude API key | — |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Which Claude model to use | Use `claude-sonnet-...` for better quality |
| `MAX_TOKENS` | `900` | Response length limit | Increase for longer equations |
| `CACHE_TTL` | `1h` | Prompt cache duration | — |

---

## Troubleshooting Quick Links

### Symptoms → Solutions

| Issue | Solution |
|-------|----------|
| Bot not responding | Check `TELEGRAM_TOKEN` in `.env` |
| Text not rendering as images | Verify `LATEX_ENABLED=true` in `.env`, check logs |
| Images not showing (just URL) | CodeCogs might be down, or LaTeX syntax invalid |
| Slow responses | Set `LATEX_VERIFY_BEFORE_SEND=false` |
| LaTeX looks garbled | Increase DPI (modify `latex-renderer.js`: line ~17) |
| Too many blank lines between text/images | Check Claude's response format in logs |

---

## Files Checklist for GitHub

### ✅ Commit These
```
bot.js                              # MODIFIED
latex-renderer.js                   # NEW
SETUP_LATEX.md                      # NEW (documentation)
.env.example                        # UPDATED
LATEX_IMPLEMENTATION_CHECKLIST.md  # NEW (this file)
```

### ❌ DO NOT Commit
```
.env                   # Contains secrets!
node_modules/          # Generated, huge
bot.js.backup          # Old version
*.log                  # Logs
```

### Ensure in .gitignore
```
.env
.env.local
node_modules/
*.log
bot_backup.js
*.swp
.DS_Store
```

---

## Testing Commands

### Test Parsing (without Telegram)
```bash
node -e "
const { parseLatexBlocks } = require('./latex-renderer');
const text = 'Energy: \$\$E = mc^2\$\$. Famous!';
console.log(parseLatexBlocks(text));
"
```

Expected output:
```json
[
  { type: "text", content: "Energy:" },
  { type: "latex", content: "E = mc^2" },
  { type: "text", content: "Famous!" }
]
```

### Test CodeCogs URL
```bash
# Test a simple equation renders
curl -I "https://latex.codecogs.com/png.image?\\dpi{150}\\bg{white}E=mc^2"

# Should return: HTTP 200 OK
```

### Check Bot Status
```bash
curl http://localhost:3000/healthz
# Should return: { ok: true, latexEnabled: true, ... }
```

---

## Common LaTeX Errors

### ❌ Wrong (Claude should NOT generate)
```
$$x = \frac{-b +- \sqrt{...}$$   # ± symbol not supported
$$\begin{array}...\end{array}$$  # Complex tables may fail
$$\tikz...$$                      # tikz package not available
```

### ✅ Right (Claude will generate)
```
$$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$  # Standard quadratic
$$A = \begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}$$  # Simple matrix
$$\int_0^\infty e^{-x} dx$$  # Integrals work
$$\frac{1}{1 + e^{-x}}$$  # Sigmoid/logistics
```

---

## Performance Notes

### Speed Impact

- **Without verification** (`LATEX_VERIFY_BEFORE_SEND=false`): No delay
- **With verification** (default): +200-300ms per equation
- **Per message**: If response has 3 equations: +600-900ms total

### Bandwidth

- Each rendered equation: ~5-20 KB image (negligible)
- Telegram API calls: Same as before

### API Costs

- **Claude API**: No change (LaTeX is Claude's output, no extra API calls)
- **CodeCogs**: Free tier allows unlimited use (no login required)

---

## Rollback Plan

If LaTeX rendering causes issues:

### Quick Disable
```bash
# Option 1: Environment variable
echo "LATEX_ENABLED=false" >> .env
# Restart bot

# Option 2: Git revert
git revert HEAD
git push
# Restart bot
```

### Restore Original bot.js
```bash
git checkout HEAD~1 bot.js
git commit -m "Revert LaTeX support"
git push
# Restart bot
```

---

## Questions?

- **Setup issues**: See `SETUP_LATEX.md` → Troubleshooting section
- **LaTeX syntax**: CodeCogs reference: https://www.codecogs.com/latex/about.php
- **Telegram API**: https://core.telegram.org/bots/api
- **Claude prompting**: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering

---

**Version**: 1.0  
**Last Updated**: 2025-09-06  
**Status**: Ready to Deploy ✓
