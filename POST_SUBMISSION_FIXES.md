# Post-submission hardening — what this branch is, and what it is not

**`main` @ `366e3490` is the exact version submitted** to the Cloudflare
"Build the Next-Gen Git Platform" competition on **2026-10-13**
(submission ID `4d1aaa4c-e856-4636-a775-fd5e444c4744`, team **Ctrl+Git+Win**).

This branch — `post-submission-hardening` — is **post-submission work**. It
responds to two independent full-repo code reviews conducted after the
submission: review #1 (2026-10-13) and review #2 (2026-10-14). **Nothing on
this branch was part of the submission.** The submitted code is untouched on
`main`, and:

- the live demo still runs the submitted code — **this branch has NOT been
  deployed**;
- the live D1 database has **NOT been migrated** — the migration SQL is
  included for the record (`migrations/2026-10-14-hardening.sql`).

The point of doing this on a branch, in the open, is the same as the point of
Verdict itself: the record should show what actually happened, in order.

## Fixes

Severity and finding IDs are from review #2 unless marked (R1) for review #1.

| Finding | Fix | Files |
|---|---|---|
| H2 — `POST /api/internal/eval` returned Cloudflare 1101 on every request in production; queue path dead | Defensive hardening: whole handler wrapped to always answer JSON (400 on malformed body, JSON 500 on throw, never a platform 1101); unguarded body parse removed; unused imports removed. Root cause is **not** fixed because it is **not proven** — see "Not verified" | `src/index.ts` |
| I3 (part) — comment at `src/api.ts` blamed a queue-consumer "platform issue" | Comment rewritten: evaluations trigger in the submit request lifecycle; the endpoint was found dead in production (verified 2026-10-13/14), the consumer code reviewed as correct, root cause unproven | `src/api.ts` |
| H1 — held-out tests staged inside the candidate's tree and run under candidate-controlled vitest config | Held-out file staged **outside** the candidate tree (`/workspace/heldout/`) with an evaluator-owned config, run via explicit `--config`/`--root`; candidate `src` and `node_modules` exposed to the harness via symlinks only. Checks JSON unchanged (booleans only) | `src/evaluate.ts` |
| L5 — clone's `.git/config` held a live read token while candidate code ran | Remote rewritten to the unauthenticated URL immediately after clone, before `npm ci`/tests | `src/evaluate.ts` |
| I2 — `btoa()` on held-out tests throws on non-Latin1 | TextEncoder-based base64 encode | `src/evaluate.ts` |
| M7 — visible-test gate ran the candidate's own `npm test` script | Suite runs directly: `npx vitest run`. `hasTestScript` remains a static presence check only | `src/evaluate.ts` |
| M4 — `touched_tests` failed open when the scope check didn't run (and for legacy evals with no scope fields) | `touched_tests` is tri-state (`null` = unverified); decide returns 409 requiring explicit human confirmation for null/absent — never reads it as clean | `src/evaluate.ts`, `src/api.ts` |
| L4 (part) — late-finishing evaluation could regress intent status | Evaluation completion update is conditional (`WHERE status IN ('submitted','evaluated')`) | `src/evaluate.ts` |
| L6 — evaluation sandboxes created per run, never destroyed, accumulating toward the instance cap | Sandbox names drawn from a bounded pool of 10 (hash of candidate id); existing per-run workspace reset reused | `src/evaluate.ts` |
| M1 — ledger append was read-then-insert; concurrent writers could fork the hash chain | `UNIQUE INDEX` on `ledger(prev_hash)`; append retries on the new tip a bounded number of times on a uniqueness violation and throws if it still cannot append — a fork now fails loudly instead of corrupting verifiability. (The hash is computed in JS; D1 SQL cannot SHA-256 the payload, so read-compute-insert stays, guarded by the index.) | `src/db.ts`, `schema.sql`, `migrations/2026-10-14-hardening.sql` |
| M2 — decide/confirm idempotency was check-then-insert, no unique indexes | `UNIQUE INDEX` on `decisions(intent_id)` and `promotions(decision_id)`; insert violations are treated as the existing 409 / already-confirmed responses | `schema.sql`, `src/api.ts`, `migrations/2026-10-14-hardening.sql` |
| M2 — promotion token was minted **before** the decision row was inserted (orphaned live token on insert failure) | Decide inserts the decision row first; the token is minted only after the insert succeeds | `src/api.ts` |
| M5 — ledger recorded `undo.done` (and API returned `undone: true`) at restore-token **mint** time | Mint-time entry is `undo.requested`; response returns `undone: false, restore_pending: true`. `undo.done` is written only in `/api/undo/confirm`, alongside `undo.confirmed`, after the restore is verified | `src/api.ts` |
| M5 / L2 (R1) — Promotions panel never rendered an undone state; scrubber read payload field `restored` (actual: `restored_to`); ledger line printed a promotion-ID fragment as if it were a SHA | Promotions render UNDONE from `undo.confirmed`; scrubber/ledger renderers handle `undo.requested`/`undo.done`/`undo.confirmed` and read `restored_to` | `public/index.html` |
| M8 — fork handler called `Symbol.asyncDispose` on an Artifacts handle — the call the codebase itself warns can crash the isolate | Call removed; handle follows the same deliberate no-op disposal pattern as the rest of the codebase | `src/api.ts` |
| L4 (part) — `/submit` accepted any intent status | Submit accepts only `forked`/`submitted` intents | `src/api.ts` |
| L2 — unguarded JSON body parsing in API handlers; no top-level handler catch | Guarded body parsing (invalid JSON → JSON 400) on all POST handlers; `handleApi` wrapped to answer JSON 500 | `src/api.ts` |
| L3 — `GET /api/ledger` silently capped at the **oldest** 500 rows | Default returns the **latest** 500 (same bare-array shape) with `x-ledger-total`/`x-ledger-truncated` headers; `?after=<seq>` forward pagination returns `{ entries, total, truncated, next_after }` | `src/api.ts` |
| L1 — judge prompt boundary was a fixed, content-escapable `<candidate_code>` tag; task text undelimited | Randomized per-call delimiters for both the code block and the task text; closing-delimiter-shaped sequences stripped from the code | `src/judge.ts` |
| M6 — MCP `declare_intent` and CLI `intent` could not authenticate (writes 401) | Both read `VERDICT_SECRET` from the environment and send `x-verdict-secret` on POSTs; documented in `mcp/README.md` and the CLI header | `mcp/server.js`, `cli/verdict.js`, `mcp/README.md` |
| M5 (R1) / I4 — README overstated three mechanisms | Corrected **on this branch only**: the secret guards **all** write endpoints; undo described as the real mint-token → operator force-push → verify flow (no "one click"); architecture text states evaluations trigger in the submit request lifecycle with the queue consumer as a secondary path. Schema status comment now includes `promoted` | `README.md`, `schema.sql` |

Findings intentionally **not** addressed on this branch: M3 (`spec_commit`
recorded but not enforced as the scope-diff base — a behavior change to the
evaluation semantics that deserves its own design pass, not a hardening
patch), I1 (non-constant-time secret comparison — negligible for a
single-operator prototype), and the root cause of H2 (see below).

## Not verified

- **H2's root cause is still unproven.** The 1101 was verified live
  (2026-10-13 and 2026-10-14, every POST, all auth states), and the fix here
  is defensive: whatever throws, the handler now answers JSON. Pinning the
  actual throw needs the deployed Worker's logs or a `wrangler dev`
  reproduction with production bindings.
- **This branch is not deployed and not live-tested.** The code has been
  typechecked/syntax-checked locally only. In particular, the held-out
  isolation layout (evaluator-owned config + symlinked `src`/`node_modules`)
  and the ledger-pagination response shapes have not run against a live
  Worker, D1, or Sandbox.
- **The migration has not been run** against the live database (by design —
  see above). The unique index on `ledger(prev_hash)` assumes no existing
  duplicate `prev_hash` values; the live chain was verified fork-free by
  both reviews, and the migration file notes the pre-checks to run first.
