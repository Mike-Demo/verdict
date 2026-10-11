-- Verdict: intent-led decision forge schema

CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  paths TEXT NOT NULL,          -- JSON array of path prefixes the agent intends to touch
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'declared', -- declared|forked|submitted|evaluated|decided
  spec_commit TEXT,               -- sample main HEAD pinned at fork time (the spec the candidate is judged against)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(id),
  repo TEXT NOT NULL,            -- fork repo name in Artifacts
  commit_sha TEXT,               -- pushed head sha (null until submit)
  submitted_at INTEGER,
  FOREIGN KEY (intent_id) REFERENCES intents(id)
);

CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  commit_sha TEXT,               -- commit evaluated (for dedup)
  checks TEXT NOT NULL,          -- JSON: named deterministic checks
  pass INTEGER NOT NULL,         -- 0/1: all gates passed
  held_out_pass INTEGER,         -- 0/1/null
  summary TEXT DEFAULT '',       -- human-readable evidence summary
  cost_usd REAL,                 -- AI cost for this eval (null = unknown)
  cost_estimated INTEGER NOT NULL DEFAULT 0, -- 1 = estimated, 0 = metered
  evaluated_at INTEGER NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluations_candidate_commit ON evaluations(candidate_id, commit_sha);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(id),
  winner_candidate_id TEXT REFERENCES candidates(id),
  rationale TEXT DEFAULT '',
  decided_at INTEGER NOT NULL,
  decided_by TEXT NOT NULL DEFAULT 'human'
);

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  base_repo TEXT NOT NULL,
  prev_head TEXT NOT NULL,
  new_head TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  at INTEGER NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);

-- Append-only decision ledger. Rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- intent.declared|fork.created|candidate.submitted|evaluation.done|decision.made|promotion.done|undo.done
  ref_id TEXT,
  payload TEXT NOT NULL,         -- JSON
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidates_intent ON candidates(intent_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_candidate ON evaluations(candidate_id);
CREATE INDEX IF NOT EXISTS idx_ledger_kind ON ledger(kind);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
