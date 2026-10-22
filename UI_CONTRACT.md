# Verdict UI — API contract

Base: same origin as the UI. All JSON.

## Endpoints

### POST /api/intents — declare intent
Request: `{ "title": string, "description": string, "paths": string[], "agent": string }`
- `paths`: path prefixes the agent intends to touch, e.g. `["src/links", "src/validation"]`
- Response 200: `{ "id", "title", "agent", "paths", "heat": 0|1|2+, "status": "declared" }`
- Response 409: `{ "error": "intent queue is full (5)..." }` — queue capped at 5 active intents

### GET /api/intents — list all intents
Response: array of `{ id, title, description, agent, paths[], status, heat, candidate: {id, repo, commit_sha} | null, evaluation: {...} | null }`
- `status`: declared | forked | submitted | evaluated | decided | promoted
- `heat`: number of other active intents with overlapping paths (badge only, not a conflict claim)

### POST /api/intents/:id/fork — provision isolated fork
Response: `{ "candidate_id", "repo", "remote", "token" }` (24h write token for the agent)

### POST /api/intents/:id/submit — submit pushed candidate for evaluation
Request: `{ "commit": "<sha>" }`
Response: `{ "queued": true, "candidate_id" }`

### GET /api/cards — decision queue (one card per intent with an evaluated candidate)
Response: array of `{ intent: {id, title, description, agent, paths[], status}, candidate: {id, repo, commit} | null, evaluation: { checks: {...}, pass: bool, held_out_pass: bool|null, summary: string } | null }`
- `checks` keys: commitFound, hasPackageJson, hasTestScript, installOk, visibleTestsPass, heldOutTestsPass

### POST /api/decide — human decision + merge sequencer
Request: `{ "intent_id", "candidate_id", "rationale": string }`
- Response 200: `{ "decision_id", "eligible": true, "mainHead", "forkHead", "promoted": true }`
- Response 409: `{ "eligible": false, "reason": "candidate has not passed evaluation gates" | "candidate is not rebased onto current main" | "nothing to promote", ... }`
- Verdict applies the approved fast-forward to base `main` using a Worker-held credential, conditional on the recorded old head.

### POST /api/promotions/confirm — confirm the Worker-applied promotion
Request: `{ "decision_id" }`
- Response: `{ "confirmed": true, "promotion_id", "prev_head", "new_head" }` or 409 `{ confirmed: false, reason }`

### POST /api/undo — one-click undo of a promotion
Request: `{ "promotion_id" }`
- Response: `{ "restored": true, "restore_ref" }` or 409 if `main` no longer matches the promotion.
- Verdict restores only base `main`, conditional on its current head matching the recorded promoted commit.

### POST /api/undo/confirm — confirm the verified restore
Request: `{ "promotion_id" }`
- Response: `{ "confirmed": true, "head" }`; only a verified restore records `undo.done`.

### GET /api/ledger — append-only decision ledger
Response: array of `{ seq, kind, ref_id, payload, at }`, kinds include intent.declared, fork.created, candidate.submitted, evaluation.done, decision.made, promotion.done, undo.done, undo.confirmed

## UI requirements
Single `index.html` (inline CSS/JS, no build step) served from the Worker. Dark, sharp, modern "decision forge" aesthetic.
Sections:
1. Header: Verdict + one-line concept ("Agents declare intent. Evidence decides. Humans approve.")
2. Declare intent form (title, description, paths as comma-separated, agent name) → shows heat badge on create; 409 shows queue-full message.
3. Active intents list: title, agent, paths, status pill, heat badge (0=clear "no overlap", 1=warm "1 overlap", 2+=hot "N overlaps"), candidate repo/commit when present.
4. Decision queue: one card per intent from /api/cards. Card shows: intent title/agent, candidate repo + short commit, evidence checklist (each check ✓/✗), held-out result (pass/fail/pending), summary line, rationale text input, Promote button → Verdict applies the approved commit and shows Confirm promotion.
5. Ledger: live feed of ledger entries, newest first, human-readable one-liners per kind.
6. Promotions: list confirmed promotions with an Undo button each.
Poll GET /api/intents, /api/cards, /api/ledger every 3 seconds. Handle 409s with inline messages, not alerts.
