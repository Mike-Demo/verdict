-- Post-submission hardening migration — branch `post-submission-hardening`.
-- Source: independent code review #2 (2026-10-14), findings M1 + M2.
--
-- STATUS: NOT applied to the live verdict-db. The live demo still runs the
-- submitted schema. This file documents the step for the record; apply it
-- deliberately, in a maintenance window, with:
--   wrangler d1 execute verdict-db --file migrations/2026-10-14-hardening.sql --remote
--
-- Before applying: verify no duplicates exist that would violate the new
-- unique indexes (SELECT intent_id, COUNT(*) FROM decisions GROUP BY 1
-- HAVING COUNT(*) > 1; same for promotions.decision_id and ledger.prev_hash).

CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_intent ON decisions(intent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_promotions_decision ON promotions(decision_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_prev_hash ON ledger(prev_hash);
