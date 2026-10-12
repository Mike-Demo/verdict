# Verdict — Demo Video Script (5–10 min)

## Opening (0:00–0:45)
**[Show: Verdict UI homepage]**

"When multiple AI agents work on the same codebase, they step on each other. They push to the same branch, create merge conflicts, and someone — usually a human — has to untangle the mess.

Verdict compresses many agent forks into one reversible, evidence-backed decision. Agents declare intent *before* they write code. Evidence decides. Humans approve."

## The Problem (0:45–1:30)
**[Show: diagram or split-screen of agents colliding]**

"Today, three agents on the same task means three branches, three PRs, and a merge conflict. The human becomes the merge bot.

Verdict flips this: each agent declares *what it intends to change* before editing. The forge gives each an isolated fork. Agents never touch each other's work. They never touch main."

## Live Demo: Three Agents, One Task (1:30–5:30)

**[Show: Verdict UI — declare three intents, Live Map]**

"Three agents — Atlas, Bolt, Cipher — take the same task: add expiring links to this URL shortener. They declare intent, including the paths they'll touch.

See the Live Map: all three overlap on `src/store.js`. Verdict is honest — path overlap isn't a semantic conflict, it can't know that — but the heat badge surfaces the risk, and if an agent touches files *outside* its declared paths, the evaluation flags scope creep directly on its decision card. That's the heat badge tied to a consequence."

**[Show: forks provisioned, agents working]**

"Each agent gets an isolated Artifacts fork and a scoped write token. They work in parallel — different designs, same task."

**[Show: decision cards appearing with test results]**

"On submit, Verdict evaluates each candidate in an isolated sandbox: clone, install, visible tests — then *held-out tests* the agents never saw, staged from a Worker secret only inside the sandbox. Agents can't game what they can't see.

All three pass here. But watch what happens when one doesn't — [show a failed card or describe]. The deterministic gate rejects it. No LLM needed. The judge you see on each card — that's Clef, and it's advisory only. It scores style; it never decides. Tests decide."

**[Show: stale-base rejection — optional if time]**

"If an agent's fork falls behind main, promotion is rejected automatically. Rebase, resubmit, re-evaluate. The system never merges stale code."

## The Decision (5:30–7:00)
**[Show: clicking Promote on a winner]**

"One card per intent. The human reads the evidence — test results, scope check, judge scores, cost — optionally clicks Ask Why for an evidence-grounded explanation, writes a rationale, and approves. Verdict mints a 60-second promotion token. The winner fast-forward pushes — but only if the evaluated commit matches the fork head. Anything else is rejected.

Confirmed in the hash-chained ledger. Every intent, evaluation, decision — recorded, replayable via the time scrubber."

**[Show: ledger + provenance drawer]**

## Undo (7:00–7:45)
**[Show: clicking Undo]**

"Changed your mind? One click. Verdict mints a restore token, main moves back, the ledger records it. Losers are retained — nothing is lost."

## Architecture (7:45–8:45)
**[Show: architecture diagram]**

"Cloudflare Workers serve the API and UI. Artifacts provides the Git-compatible filesystem — one fork per candidate, repo-scoped tokens. Queues buffer submissions. Sandbox containers run tests in isolation. D1 stores everything.

Honest notes: evaluation currently runs in `ctx.waitUntil` — it works, and a Durable Object is the planned control plane for production. The ledger is hash-chained and tamper-evident, not cryptographically signed. The judge is advisory and can be gamed — that's why it never gates. Path overlap is a risk badge, not semantic conflict detection."

## Closing (8:45–9:30)
"Verdict doesn't try to outsmart merge conflicts with AI. It makes them structurally unlikely: declare intent, compete in isolation, prove it with tests, and let a human decide on evidence.

Agents declare intent. Evidence decides. Humans approve."

**[Show: verdict.hey-demo-827.workers.dev + github.com/Mike-Demo/verdict]**
