# Verdict UI — notes & API assumptions

Single self-contained file: `index.html` (inline CSS/JS, no build step, no external
dependencies — system font stack + monospace only). Polls `GET /api/intents`,
`GET /api/cards`, `GET /api/ledger` every 3 s. All 409s and fetch failures render as
dismissible inline messages; `alert()` is never used. All interpolated strings are
HTML-escaped.

## Assumptions that go beyond / differ from UI_CONTRACT.md

1. **No `GET /api/promotions` in the contract.** The Promotions section is derived
   from `GET /api/ledger` entries with `kind === "promotion.done"`, newest first.
   `promotion_id` is read from `payload.promotion_id`, falling back to `ref_id`,
   then to the entry `seq`. `prev_head` / `new_head` are read from the payload.
   If the API later adds a promotions endpoint, point the Promotions section at it.

2. **Ledger payload shapes are defensive.** The contract types `payload` loosely, so
   each `kind` renders from best-effort fields (`payload.title`, `payload.agent`,
   `payload.repo`, `payload.commit_sha`/`payload.commit`, `payload.pass`,
   `payload.intent_id`, `payload.rationale`, `payload.prev_head`,
   `payload.new_head`, `payload.restore_ref`) and falls back to `ref_id`/kind name.
   `at` is parsed as an ISO string or epoch seconds.

3. **Promotion and undo writes.** The Worker applies approved promotions and
   restores using its Artifacts binding; no base-repository write token or
   push command is returned to the UI. The UI calls the confirmation endpoints
   only after the corresponding ref update succeeds.

4. **Rationale is required client-side** before Promote (contract marks it required
   in the request; the UI blocks empty rationale with an inline nudge).

5. **Held-out display:** `evaluation.held_out_pass === null` renders as "pending";
   `true`/`false` render as pass/fail. `evaluation.checks` keys are rendered in the
   fixed contract order; unknown keys fall back to the raw key name.

6. **Heat badge** follows the contract text: 0 → "no overlap" (grey), 1 → "1 overlap"
   (amber), 2+ → "N overlaps" (red).

7. **Polling resilience:** if any of the three GETs fails, a slim "API unreachable"
   banner shows and polling continues; sections keep their last rendered state.

8. **Re-render focus guard:** if the user is typing in a rationale textarea when a
   poll returns, that render pass is skipped so focus/text is not lost.
