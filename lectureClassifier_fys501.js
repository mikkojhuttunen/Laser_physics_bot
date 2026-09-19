// lectureClassifier.js
// Stage 2 of the lecture-link flow: given free text that Stage 1 has already
// flagged as "probably asking about lecture videos", ask a small/cheap model
// to pick which week(s) it matches. The model NEVER sees or returns URLs —
// it only returns week numbers, which the caller then looks up locally in
// lecture_data-2.json. This keeps link generation deterministic and
// hallucination-free, same as keeping checkNumeric out of the LLM's hands.

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const limiter = require('./usageLimiter');

/**
 * @param {string} userText - the student's raw message
 * @param {Array<{week:number, topic:string, keywords:string[]}>} topicsSummary
 * @returns {Promise<{matchedWeeks:number[], clarificationNeeded:boolean, clarificationQuestion:string|null}|null>}
 *          Returns null if the API call/parse fails, signaling the caller to fall back.
 */
async function classifyLectureQuery(userText, topicsSummary) {
  // Shared daily backstop reached: skip the (optional) LLM classifier. Returning null makes
  // the caller fall back to the local keyword scoring, so lecture links keep working.
  if (limiter.isPaused()) return null;

  const systemPrompt = buildSystemPrompt(topicsSummary);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userText }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API returned ${response.status}`);
    }

    const data = await response.json();
    limiter.recordUsage(CLASSIFIER_MODEL, data.usage);
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) throw new Error('No text block in classifier response');

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const validWeeks = new Set(topicsSummary.map((t) => t.week));
    const matchedWeeks = Array.isArray(parsed.matched_weeks)
      ? parsed.matched_weeks.filter((w) => validWeeks.has(w))
      : [];

    return {
      matchedWeeks,
      clarificationNeeded: !!parsed.clarification_needed,
      clarificationQuestion: parsed.clarification_question || null,
    };
  } catch (err) {
    console.error('[lectureClassifier] Classification failed, caller should fall back:', err.message);
    return null;
  }
}

function buildSystemPrompt(topicsSummary) {
  const topicsList = topicsSummary
    .map((t) => `Week ${t.week}: ${t.topic} (keywords: ${t.keywords.join(', ')})`)
    .join('\n');

  return `You are a classifier for a laser physics course TA bot. A student has sent a free-text message that may be asking for lecture video links.

Available weeks/topics:
${topicsList}

Given the student's message, decide which week(s), if any, they are asking about. Respond with ONLY a JSON object — no preamble, no markdown fences, nothing else:

{
  "matched_weeks": [<week numbers as integers, empty array if none>],
  "clarification_needed": <true if the request is too vague to pick a week confidently>,
  "clarification_question": "<a short clarifying question if clarification_needed is true, otherwise null>"
}

Rules:
- Only include a week number if you are reasonably confident it matches the topic being asked about.
- If the student is asking about multiple related topics, you may include multiple week numbers.
- If the message isn't actually asking about lecture content (e.g. small talk, a homework question with no video request), return an empty matched_weeks array and clarification_needed: false.
- Never invent a week number that isn't in the list above.
- You are choosing a topic, not answering the physics question itself.`;
}

module.exports = { classifyLectureQuery };
