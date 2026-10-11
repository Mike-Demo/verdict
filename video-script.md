# Verdict — Demo Video Script (5–10 min)

## Opening (0:00–0:45)
**[Show: Verdict UI homepage]**

"When multiple AI agents work on the same codebase, they step on each other. They push to the same branch, create merge conflicts, and someone — usually a human — has to untangle the mess.

Verdict is a Git platform for the agent era. Instead of coordinating at merge time, agents coordinate *before* they write a single line of code. They declare intent. Evidence decides. Humans approve."

## The Problem (0:45–1:30)
**[Show: diagram or split-screen of agents colliding]**

"Today, if three agents work on the same task, you get three branches, three PRs, and a merge conflict. The human becomes the merge bot.

Verdict flips this: each agent declares *what it intends to change* before editing. The forge gives each intent an isolated fork — a full tournament bracket. Agents never touch each other's work. They never touch main."

## Live Demo: Three Agents, One Task (1:30–5:30)

**[Show: Verdict UI — declare three intents]**

"Watch. Three agents — Atlas, Bolt, and Cipher — all take the same task: add expiring links to this URL shortener library. They declare their intent, including the paths they'll touch.

Notice the heat badges. All three plan to touch `src/store.js`. Verdict doesn't claim that's a conflict — it can't know semantics — but it surfaces the overlap as a risk badge so the human goes in with eyes open."

**[Show: forks provisioned, agents working]**

"Each agent gets an isolated Artifacts fork and a scoped write token. They work in parallel — Atlas uses expiresAt timestamps, Bolt builds a separate expiry index, Cipher computes expiry on read."

**[Show: decision cards appearing with test results]**

"When they submit, Verdict evaluates each candidate in an isolated sandbox: it clones the fork, installs dependencies, runs the visible test suite — and then stages *held-out tests* the agents never saw. The agents can't game what they can't see.

Look at the evidence cards. Atlas: all green. Bolt: all green. Cipher... the held-out tests caught it. Cipher treated `ttlMs: 0` as 'no expiry' instead of 'already expired.' The deterministic gate did its job — no LLM needed to judge the code."

## The Decision (5:30–7:00)
**[Show: clicking Promote on Atlas]**

"One card per intent. The human reads the evidence, writes a rationale, and approves. Verdict mints a 60-second promotion token. The winning agent fast-forward pushes to main — but only if its fork is rebased onto the current main. Stale forks are rejected automatically.

The promotion is confirmed and written to an append-only ledger. Every intent, every evaluation, every decision — recorded."

**[Show: ledger]**

## Undo (7:00–7:45)
**[Show: clicking Undo]**

"And if the human changes their mind? One click. Verdict mints a restore token, the main branch moves back, and the ledger records the undo. The losing approaches are retained — nothing is lost."

## Architecture (7:45–8:45)
**[Show: architecture diagram]**

"Under the hood: Cloudflare Workers serve the API and UI. Artifacts provides the Git-compatible versioned filesystem — one fork per candidate. A Queue buffers submissions. Isolated Sandbox containers run the test suites. D1 stores intents, evaluations, and the append-only ledger.

The key design choices: deterministic tests gate merges, not LLMs. Path overlap is a badge, not a conflict claim. Humans approve every promotion. History stays fast-forward only."

## Closing (8:45–9:30)
"Verdict doesn't try to outsmart merge conflicts with AI. It makes them structurally impossible: declare intent, compete in isolation, prove it with tests, and let a human decide.

Agents declare intent. Evidence decides. Humans approve."

**[Show: verdict.hey-demo-827.workers.dev + GitHub repo]**
