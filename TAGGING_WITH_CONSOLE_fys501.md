# Tagging the quiz banks with your Claude Console account

> **Alternative without an API key:** the tags can also be decided in a Claude chat (claude.ai, for example a chat in the FYS.501 project). Claude reads a section's questions, writes a compact spec, and `tagFromSpec_fys501.js` turns it into `tag_suggestions.json`, after which the same review and `apply` steps below are used:
> `node tagFromSpec_fys501.js spec_3.5.json`, then `node tagQuizBank_fys501.js apply --all-valid --dry-run` and `apply --all-valid`. The rest of this guide describes the API route.

The Claude Console (platform.claude.com) is where you manage the account side: workspaces, API keys, spend limits, usage reports and the Workbench for trying prompts. The tagging itself runs in your terminal (`tagQuizBank_fys501.js`) and calls the API with a key you create in the Console. The bot on Railway keeps using its own key and is not affected.

Menu names below follow Anthropic's current documentation on workspaces; if a label differs in your Console, look for the same word (Workspaces, Spend limits or Limits, API keys, Usage or Cost).

## 1. Console setup (once, about 10 minutes)

1. Sign in to the Console and open **Settings > Workspaces**. Create a workspace named `fys501-tagging`. A separate workspace keeps this work's cost and keys apart from the bot's.
2. Open the workspace and its **Spend limits** (or **Limits**) tab. Set a monthly spend limit of 10 USD and add a notification at 5 USD. The full run is estimated at about 2 USD (`node tagQuizBank_fys501.js estimate` prints the current estimate), so this leaves room for re-runs. A workspace limit can only be lower than your organisation's limit.
3. Create an API key **in that workspace** (keys belong to the workspace where they are created and cannot be moved). Name it `fys501-tagging`. Choose a short expiry (for example 30 days), because you only need it for this task. Copy the key when it is shown; it is not displayed again.
4. Check that you have permission: workspace developers and admins can create keys, and organisation admins have access to every workspace.

## 2. Try the prompt in the Workbench (optional, recommended, a few cents)

The Workbench lets you judge the tagging quality on single questions before running the batch.

```
node tagQuizBank_fys501.js prompt --id q3.5_004
```

1. Open the **Workbench** in the Console and switch to the `fys501-tagging` workspace.
2. Paste the block under `SYSTEM PROMPT` into the system prompt box, and the block under `USER MESSAGE` as the user turn.
3. Pick the model you will use (the tool default is `claude-sonnet-5`; the same id goes in `TAG_MODEL` if you choose another) and run it.
4. The answer should be one JSON object with `concepts`, `optionTags` and possibly `proposed`. Check it against your own judgement for 3 to 5 questions from different sections. If the tags look wrong in a systematic way, stop here and improve `misconceptions_fys501.json` first (section 5).

## 3. First run in the terminal: one section

Enter the key without leaving it in your shell history, and check the estimate:

```
read -rs ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY
node tagQuizBank_fys501.js estimate
node tagQuizBank_fys501.js suggest --section 3.5 --kind single --limit 8
```

The tool stops by itself after 3 consecutive API errors (wrong key, unknown model id, spend limit reached) and keeps its progress. Then read `tag_review.md`:

- Concepts: is the first concept really what the question tests?
- Each wrong option shows the misconception it was matched to, or "no tag". A tag is only right if a student who holds that belief would pick that option. "No tag" is a good answer for arbitrary distractors.
- "Proposed new misconception" lines are suggestions for the catalogue, not applied automatically.

To change a tag, edit it in `tag_suggestions.json` (set it to `null` or another catalogue id). Then apply:

```
node tagQuizBank_fys501.js apply --all-valid --dry-run
node tagQuizBank_fys501.js apply --all-valid
node validateQuizTags_fys501.js
```

## 4. Tag everything, then commit

```
node tagQuizBank_fys501.js suggest
node tagQuizBank_fys501.js apply --all-valid --dry-run
node tagQuizBank_fys501.js apply --all-valid
node validateQuizTags_fys501.js
node e2e_quiz_test.js
node e2e_pending_test.js
git add quizBank_fys501.json multivalueQuizBank_fys501.json
git commit -m "Tag quiz banks with concepts and misconceptions"
git push origin main
```

Expect concept tags on nearly all 320 questions but misconception tags on only a minority of wrong options: the current banks were written as recall questions, so most distractors are not misconceptions. Section and concept analysis still work.

## 5. Follow-up: curate the vocabulary and re-tag

1. Prune `concepts_fys501.json` until each concept has enough questions for a group of students to reach the minimum group size (about 10 questions per concept).
2. Rewrite `misconceptions_fys501.json` into the errors you actually see, and add the good "proposed new misconception" lines from `tag_review.md`.
3. Re-tag the questions that should change:

```
node tagQuizBank_fys501.js suggest --ids q3.5_004,q3.5_005
node tagQuizBank_fys501.js apply --accept q3.5_004,q3.5_005
node validateQuizTags_fys501.js
git add concepts_fys501.json misconceptions_fys501.json quizBank_fys501.json multivalueQuizBank_fys501.json
git commit -m "Curate concepts and misconception catalogue"
git push origin main
```

`suggest --ids` re-tags the named questions even if they already have tags. If a question's tags change after students have answered it, bump that question's `version` by one.

## 6. Check the cost, then close the account side

1. In the Console open **Usage** or **Cost** reports and filter to the `fys501-tagging` workspace. The total should be close to the estimate.
2. When tagging is finished, revoke or archive the `fys501-tagging` API key. Archiving the whole workspace also disables all its keys and cannot be undone; it keeps the historical usage data.
3. Clear the key from your shell:

```
unset ANTHROPIC_API_KEY
```

New questions come in later through `mergePending_fys501.js`. Tag them by repeating sections 1 (a new key, or an unexpired one) and 3: `suggest` only processes questions that have no tags yet.

## Troubleshooting

| Message or symptom | Likely cause and fix |
|---|---|
| `401` or `invalid x-api-key` | Wrong or expired key, or the workspace was archived. Create a new key in the workspace. |
| `404` or "model not found" | The model id is not available to your account. Set `TAG_MODEL` to a model you can use, for example after checking it in the Workbench. |
| `429` | Rate limit. The SDK retries automatically; if it persists, wait a minute and run `suggest` again (it resumes). |
| Stops with "3 consecutive errors" | Read the quoted last error. A reached spend limit shows up here too: raise the workspace limit in the Console and run `suggest` again. |
| Some entries marked `ERROR` in `tag_review.md` | The model answer was not valid JSON. Run `node tagQuizBank_fys501.js suggest --ids <those ids>`. |
