# LaTeX Rendering Setup Guide

This guide explains how to integrate LaTeX equation rendering into your FYS.501 Laser Physics Telegram bot.

## Overview

The bot now supports automatic rendering of LaTeX equations as readable images using CodeCogs. Instead of sending raw `$$..$$` text, equations are:
- Automatically detected in Claude's responses
- Rendered as clean, readable PNG images
- Sent to students with proper formatting

### Example

**Before (plain text):**
```
The energy is: $$E = h\\nu$$
```

**After (with LaTeX rendering):**
- Text message: "The energy is:"
- Image message: [rendered equation showing E = hν]

---

## Installation & Setup

### 1. Update Your Files

Replace your current `bot.js` with `bot_modified.js`:
```bash
cp bot.js bot_backup.js
cp bot_modified.js bot.js
```

### 2. Add the LaTeX Renderer Module

Copy the new `latex-renderer.js` to your project root:
```bash
# Already provided in this directory
ls latex-renderer.js
```

Your project structure should look like:
```
your-bot-repo/
├── bot.js                    # MODIFIED
├── latex-renderer.js         # NEW
├── course_corpus.txt
├── build_corpus.js
├── package.json
├── .env
├── .env.example              # UPDATED
└── README.md
```

### 3. Verify Dependencies

Your `package.json` already has what you need. Verify:
```json
{
  "dependencies": {
    "express": "^4.x",
    "axios": "^0.x"
  }
}
```

If missing, run:
```bash
npm install axios express
```

### 4. Update Your Environment

Edit your `.env` file (or `.env.local` for development):
```bash
# Add or update this line:
LATEX_ENABLED=true
LATEX_VERIFY_BEFORE_SEND=true
```

If you want to test without LaTeX (fall back to plain text):
```bash
LATEX_ENABLED=false
```

---

## How It Works

### For Claude (Prompt)

The bot now instructs Claude:
> "Write EQUATIONS in LaTeX between double dollar signs: $$E = mc^2$$ or $$\\frac{1}{f} = (n-1)(\\frac{1}{R_1} - \\frac{1}{R_2})$$"

Claude will respond with proper LaTeX syntax. Examples:
```
$$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$

$$A = \begin{pmatrix} 1 & L/n \\ 0 & 1 \end{pmatrix}$$

$$E = h\nu$$
```

### For the Bot (Processing)

1. Claude returns: `"The quadratic formula is: $$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$"`
2. Bot detects `$$ ... $$` blocks using `latex-renderer.js`
3. For each block:
   - Extracts the LaTeX code
   - Builds a CodeCogs URL
   - Verifies it renders (optional)
   - Sends it to Telegram as a photo
4. Regular text is sent as normal messages

---

## Key Files Explained

### `latex-renderer.js`

New utility module with 5 exported functions:

**`extractAndSendLatex(tg, chatId, responseText, replyToMessageId)`**
- Main function: parses response and sends text + images
- Called from `bot.js` in place of plain `sendMessage()`

**`parseLatexBlocks(text)`**
- Splits text by `$$` delimiters
- Returns array of `{type: 'text'|'latex', content: string}`

**`buildCodecogsUrl(latexCode, dpi, bg)`**
- Constructs CodeCogs URL from LaTeX code
- Default: 150 DPI, white background

**`verifyLatexUrl(url)`**
- Pings CodeCogs to check if URL renders
- Optional (set `LATEX_VERIFY_BEFORE_SEND=false` to skip)
- Returns `true`/`false`

**`sendLatexImage(tg, chatId, latexCode, replyToMessageId)`**
- Sends single LaTeX equation as image
- Falls back to text `[Equation: ...]` if rendering fails

### Modified `bot.js` Changes

**New import:**
```javascript
const { extractAndSendLatex } = require("./latex-renderer");
```

**Updated `TA_INSTRUCTIONS`:**
- Tells Claude to use `$$..$$` for equations
- Explains LaTeX syntax (backslashes, grouping, etc.)

**Modified `sendMessage()` function:**
```javascript
if (LATEX_ENABLED) {
  await extractAndSendLatex(tg, chatId, text, replyTo);
} else {
  // Original plain-text behavior
}
```

**New environment variable:**
- `LATEX_ENABLED` (default: `true`)

---

## Configuration Options

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LATEX_ENABLED` | `true` | Enable/disable LaTeX rendering |
| `LATEX_VERIFY_BEFORE_SEND` | `true` | Verify CodeCogs URLs before sending (adds ~200ms delay) |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude model to use |
| `MAX_TOKENS` | `900` | Max tokens in response |
| `CACHE_TTL` | `1h` | Prompt cache duration |

### Disabling LaTeX

To temporarily disable LaTeX rendering (fall back to plain text):
```bash
LATEX_ENABLED=false
```

Then restart the bot. Claude will still use `$$` in responses, but they'll be sent as plain text.

### Performance Tuning

**Faster responses (skip verification):**
```bash
LATEX_VERIFY_BEFORE_SEND=false
```
Risk: Invalid LaTeX may be sent, users see "failed to render" image.

**Slower but more reliable:**
```bash
LATEX_VERIFY_BEFORE_SEND=true
```
Each equation adds ~200ms but catches failures early.

---

## Telegram Formatting Notes

### How Images Appear

Each equation is sent as a separate Telegram photo message:
- Text: "The quadratic formula is:"
- Photo: [rendered image of equation]
- Text: "Have you tried applying this?"

### Size & Quality

- **DPI**: 150 (crisp on mobile)
- **Format**: PNG
- **Background**: White
- **Source**: CodeCogs API (https://latex.codecogs.com)

### Fallback Behavior

If CodeCogs fails:
1. If `LATEX_VERIFY_BEFORE_SEND=true`: detected and sent as `[Equation: x = \frac{...}]` text
2. If `LATEX_VERIFY_BEFORE_SEND=false`: Telegram receives image URL, displays error

---

## Common LaTeX Syntax

Students may wonder what LaTeX Claude will use. Here are examples:

| Concept | LaTeX | Claude Response |
|---------|-------|-----------------|
| Greek letters | `\alpha, \beta, \gamma` | α, β, γ |
| Fractions | `\frac{a}{b}` | a/b (fraction bar) |
| Superscripts | `x^2` | x² |
| Subscripts | `n_1` | n₁ |
| Square root | `\sqrt{x}` | √x |
| Matrix | `\begin{pmatrix}...\end{pmatrix}` | [rectangular grid] |
| Integral | `\int` | ∫ |

---

## Troubleshooting

### Images Not Rendering?

**Check 1: Is `LATEX_ENABLED` set to `true`?**
```bash
grep LATEX_ENABLED .env
```
Should output: `LATEX_ENABLED=true`

**Check 2: Is Claude outputting `$$` blocks?**
Ask the bot a math question. Look at logs:
```
[group:123456] "What is energy?"
```
Then check the response in the bot output or Telegram.

**Check 3: Can CodeCogs reach the internet?**
Test manually:
```bash
curl -I "https://latex.codecogs.com/png.image?\\dpi{150}\\bg{white}E=mc^2"
# Should return HTTP 200
```

### Why is there a delay?

If `LATEX_VERIFY_BEFORE_SEND=true` (default), the bot verifies each equation before sending (~200ms per equation).

Disable for faster responses:
```bash
LATEX_VERIFY_BEFORE_SEND=false
```

### Text not sending?

If you see images but no text around them:

1. Check that text is on separate lines with blank line before `$$`:
   ```
   Here's the formula:

   $$E = mc^2$$

   This is important because...
   ```

2. Check logs for `sendMessage failed` errors

3. If Telegram is rate-limiting, wait a moment between questions

---

## GitHub / Deployment

### What to Commit

Add these files to your repo:
```bash
git add bot.js latex-renderer.js .env.example SETUP_LATEX.md
git commit -m "feat: add LaTeX equation rendering via CodeCogs"
```

### What NOT to Commit

- `.env` (contains secrets)
- `node_modules/`
- `bot_backup.js` (your old version)

### .gitignore Update

Ensure `.gitignore` has:
```
.env
.env.local
node_modules/
*.log
bot_backup.js
```

### Deployment

No changes needed to:
- Dockerfile
- docker-compose.yml
- GitHub Actions / CI/CD
- Environment variables in cloud platform (AWS, Heroku, etc.)

Just:
1. Upload new files (`bot.js`, `latex-renderer.js`)
2. Restart the bot
3. It will auto-enable LaTeX rendering

---

## Testing

### Test Locally

1. Start the bot:
   ```bash
   TELEGRAM_TOKEN=... ANTHROPIC_API_KEY=... node bot.js
   ```

2. Send a test question to your bot:
   ```
   What is the energy of a photon?
   ```

3. Expected response:
   - Text message: "The energy of a photon is..."
   - Image message: [rendered equation E = hν]
   - Text message (if there's more): "...where h is Planck's constant"

### Test Without Sending

To test LaTeX parsing without Telegram:

Create a test file `test_latex.js`:
```javascript
const { parseLatexBlocks, buildCodecogsUrl } = require("./latex-renderer");

const response = `
The quadratic formula is:
$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$

This solves ax² + bx + c = 0.
`;

const parts = parseLatexBlocks(response);
console.log(JSON.stringify(parts, null, 2));

// Should show:
// [
//   { type: "text", content: "The quadratic formula is:" },
//   { type: "latex", content: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}" },
//   { type: "text", content: "This solves ax² + bx + c = 0." }
// ]
```

Run:
```bash
node test_latex.js
```

---

## Limitations & Known Issues

### CodeCogs Limitations

- **Size limit**: URLs must be < 2000 chars (should be fine for normal equations)
- **Rendering speed**: ~200-500ms per equation
- **Requires internet**: Won't work if CodeCogs API is down

### Telegram Limitations

- **File size**: Each image is ~5-20 KB (well under 20 MB limit)
- **Rate limits**: Telegram may slow down if many equations are sent rapidly
- **Display**: Images scale to phone screen width

### LaTeX Syntax

- Claude must use valid LaTeX syntax
- Complex equations (matrices, multi-line) should work
- Some special packages (`tikz`, `pgfplots`) may not work via CodeCogs

---

## Next Steps

1. **Deploy**: Replace `bot.js` with `bot_modified.js`
2. **Copy**: Add `latex-renderer.js` to your repo
3. **Configure**: Update `.env` with `LATEX_ENABLED=true`
4. **Restart**: Restart the bot
5. **Test**: Ask it a math question
6. **Commit**: Push changes to GitHub

Questions? Check logs with:
```bash
tail -f bot.log | grep -i latex
```

---

## Credits

- **CodeCogs**: Free LaTeX rendering API
- **Node.js**: `node-telegram-bot-api`, `axios`
- **Anthropic Claude**: Generating clean LaTeX syntax

---

**Version**: 1.0  
**Last Updated**: 2025-09-06  
**Status**: Production Ready ✓
