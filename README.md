# Verdict — the intent-led decision forge

**Agents declare intent. Evidence decides. Humans approve.**

Verdict is a prototype Git platform for the agent era, built on **Cloudflare Workers + Artifacts** for the [Build the Next-Gen Git Platform](https://www.cloudflare.com/git-competition/) competition.

The core idea: instead of agents racing to push to the same branch and creating merge conflicts, each agent **declares its intent** (what it plans to change) *before* editing. Verdict provisions an **isolated Artifacts fork per intent**, runs **deterministic evaluations** (real test suites + held-out tests the agents never see) in isolated Cloudflare Sandbox containers, and presents the human with **one evidence-backed decision card per intent**. The human approves; the merge sequencer promotes via fast-forward only. Every decision lands in an **append-only ledger**, losing approaches are retained, and any promotion can be undone in one click.

What Verdict deliberately does NOT do: claim semantic conflict detection (path overlap is a *risk badge*, not a conflict claim), let LLMs gate merges (deterministic tests decide; LLMs only explain), or auto-merge (humans approve every promotion).

## Media

**Demo video (9:30):** the full competition walkthrough — four agents declare intent on the same task, deterministic evaluations run, one candidate is stopped at the test-touch gate, a single decision is promoted to main and then undone, all recorded in the ledger. [Watch / download the submitted cut](https://github.com/Mike-Demo/verdict/releases/download/submission-video-v1/verdict-submission-live-vo.mp4) (release: [submission-video-v1](https://github.com/Mike-Demo/verdict/releases/tag/submission-video-v1)).

The 44-second sizzle cut (with August v2 voiceover, music-only, 4K, and vertical editions) lives on the [media page](https://verdict.hey-demo-827.workers.dev/media) — watch in the browser or download from the [sizzle-media-v1 release](https://github.com/Mike-Demo/verdict/releases/tag/sizzle-media-v1).

## Architecture

```
Agent declares intent → Verdict provisions isolated fork (Artifacts)
  → Agent pushes to its fork → submit → Queue → Sandbox eval
  → Decision card (evidence: test results, held-out results)
  → Human approves → 60s promotion token → agent fast-forward pushes
  → Promotion confirmed → append-only ledger → one-click undo
```

- **Worker** (`src/`): REST API, intent registry, fork provisioning, merge sequencer, ledger.
- **Queue** (`verdict-eval-q`): buffers submitted candidates for evaluation.
- **Sandbox** (`@cloudflare/sandbox`): isolated container per evaluation — clones the candidate, runs `npm ci`, runs visible tests, stages and runs held-out tests.
- **D1** (`verdict-db`): intents, candidates, evaluations, decisions, promotions, ledger.
- **UI** (`public/index.html`): single-file decision forge — declare intents, watch heat badges, review decision cards, approve, undo.
- **Sample project** (`sample/`): `linklet`, a tiny URL shortener. Demo task: add expiring links (TTL).

## Run instructions

### Prerequisites
- A Cloudflare account with Workers Paid (Artifacts requires it)
- `wrangler` 4.x and the `cf` CLI
- Node 18+

### Deploy
1. Create the Artifacts namespace and D1 database:
   ```bash
   cf artifacts namespaces create --namespace verdict-prototype --jurisdiction us
   wrangler d1 create verdict-db
   ```
   Put the returned `database_id` in `wrangler.toml`, and set `ACCOUNT_HOST` to `<your-account-id>.artifacts.cloudflare.net`.
2. Apply the schema:
   ```bash
   wrangler d1 execute verdict-db --file schema.sql --remote
   ```
3. Create the queue:
   ```bash
   wrangler queues create verdict-eval-q
   ```
4. Set secrets (held-out tests are never in the repo; agents cannot see them):
   ```bash
   wrangler secret put HELD_OUT_TESTS < your-heldout.test.js
   wrangler secret put INTERNAL_SECRET   # any random string; guards the internal eval endpoint
   ```
   Write your own held-out tests for the demo task — they should test the requirements in ways the visible tests do not, so agents cannot pass by overfitting to the visible suite.

   > [!CAUTION]
   > Never commit your held-out tests file to the repository. The evaluation model depends on agents never seeing these tests. Keep the file outside the repo and load it only through the Worker secret.
5. Push the sample project to Artifacts (see `sample/`), then deploy:
   ```bash
   wrangler deploy
   ```
6. Open the Worker URL — the decision forge UI loads.

### Demo flow
1. Declare two or three intents (agents) with overlapping `paths` — watch the heat badges.
2. Each agent: `POST /api/intents/<id>/fork` → clone with the returned token → implement → push → `POST /api/intents/<id>/submit {"commit": "<sha>"}`.
3. Evaluations run automatically (Sandbox: install, visible tests, held-out tests).
4. Review decision cards at the UI. Approve one: `POST /api/decide` → use the 60s token to fast-forward-push base main → `POST /api/promotions/confirm`.
5. Undo anytime via the UI.

## Key design decisions
- **Intent before edit**: coordination happens at declaration time, not at merge time.
- **Fork per candidate**: agents never touch each other's work or main.
- **Deterministic gates**: tests pass/fail in a sandbox; no LLM judges the code.
- **Held-out tests**: stored as a Worker secret, staged only inside the eval sandbox — agents cannot game them.
- **Heat, not conflicts**: path overlap is shown as a badge; Verdict never claims to understand semantics.
- **Human in the loop**: every promotion needs a human decision with a rationale.
- **Fast-forward only**: the sequencer rejects stale forks; history stays linear and auditable.
- **Append-only ledger**: every intent, fork, evaluation, decision, promotion, and undo is recorded. The ledger is hash-chained from seq 92 onward; the current tip hash is anchored in [LEDGER_ANCHOR.md](LEDGER_ANCHOR.md) so the chain can be verified against a value outside the database.

## License
MIT — see [LICENSE](LICENSE).

## Third-party attribution
The UI uses four brand icons from [Font Awesome Free](https://github.com/FortAwesome/Font-Awesome) (Copyright Fonticons, Inc.), licensed under [CC BY 4.0](https://fontawesome.com/license/free). The SVG paths are inlined without modification. Brand icons are trademarks of their respective owners and appear only to represent the company, product, or service they refer to.

## Security audit triage — 2026-10-21

Parent: [Mike-Demo/verdict#1](https://github.com/Mike-Demo/verdict/issues/1).
This is a triage backlog, not a remediation or a new runtime audit. The supplied audit used static source inspection only; no code was executed or deployed endpoint probed for this triage. Issue creation is unavailable in this session, so the six titles and bodies below are ready to file in this repository. No child issues have been created and none of these findings is fixed by this document.

### Priority and grouping

Order considers severity first, then reachability from a lower-trust caller, then fix size and safety.

| Order | Severity | Finding | Risk and fix rationale |
| --- | --- | --- | --- |
| 1 | high | Shared agent/human write secret | Every agent write-secret holder can cross the human approval boundary, including undoing another agent's promotion. A separate human credential is a relatively small containment change. |
| 2 | high | Unbound promotion/restore tokens | A token holder can write arbitrary base-repo content or refs during the token lifetime, bypassing the approved commit. Currently reachable by agents through finding 1; it remains independently exploitable by a token recipient after that fix. Worker-owned ref updates require more integration work. |
| 3 | medium | Externally callable internal evaluator | Any external write-secret holder can request evaluations for arbitrary candidate/repo/commit tuples without a legitimate submission. Separate internal authentication plus database binding closes this broader evaluation entry point. |
| 4 | medium | Duplicate/unbounded evaluations | Any write-secret holder with an intent can repeatedly submit and race the two evaluation triggers to consume the ten-container pool. Atomic claiming, submission state, and rate limiting require more coordinated changes than finding 3. |
| 5 | medium | Hardcoded queue destination | Secret and candidate disclosure requires a deployment to retain the shipped origin or lose its URL setting, rather than only an agent credential. Removing the fallback is small and safe, so schedule it alongside the first containment work despite its conditional reachability. |

Keep five separate remediation issues: there is no single fix that resolves multiple findings completely. Findings 1 and 3 share credential reuse as a contributing cause, but protect different trust boundaries, and finding 3 also requires candidate-record validation. Fix them together operationally without merging their acceptance criteria. Promotion and restore token issuance belong in one issue because they share the same unbound delegation root cause; duplicate queue and `waitUntil` execution likewise belong in one evaluation-claim issue. Fixing findings 1 or 3 does not resolve findings 2 or 4.

### Ready-to-file remediation issues

Each heading below is the exact issue title; the text beneath it, up to the next issue heading, is its body.

#### [security][high] Separate human approval authority from agent writes

Parent: https://github.com/Mike-Demo/verdict/issues/1

**Priority:** 1. **Fingerprint:** `shared-secret-agent-can-self-approve-promotion`.

**Evidence:** [`src/api.ts:17–45`](src/api.ts#L17-L45) compares `x-verdict-secret` with `env.INTERNAL_SECRET` in `requireAuth`. The same `isWrite` check covers declare/fork/submit and `/api/decide`, `/api/undo`, `/api/undo/confirm`, `/api/promotions/confirm`. There is no separate human credential, role, or identity check. An agent holding the required write secret can approve its own passing candidate or initiate undo of another agent's promotion.

**Root cause:** One credential represents both lower-trust agents and human decision-makers.

**Smallest fix:** Require a distinct `HUMAN_SECRET` (or role-scoped credentials) for all four human endpoints, retaining the agent write credential only for agent operations. Fail closed when the human credential is absent or equals the agent credential. Never distribute the human credential to agents or agent-facing MCP/CLI clients; update the human UI and deployment instructions to use it.

**Acceptance checks:**
- [ ] An agent-only credential is rejected by all four human endpoints, including confirmation endpoints.
- [ ] A distinct human credential permits authorized approval/undo flows; absent or identical credentials fail closed.
- [ ] Declare/fork/submit still work with the agent credential, and agent clients receive no human secret.

#### [security][high] Bind promotion and restore authority to the approved update

Parent: https://github.com/Mike-Demo/verdict/issues/1

**Priority:** 2. **Fingerprint:** `unbound-base-repo-write-promotion-tokens`.

**Evidence:** [`src/api.ts:279–329`](src/api.ts#L279-L329) creates a base-repo `createToken('write', 60)` and returns its plaintext from decide. [`src/api.ts:389–406`](src/api.ts#L389-L406) similarly issues a 300-second restore token. Neither call binds authority to a ref or commit; a holder can write arbitrary content/refs within that window. [`src/api.ts:335–372`](src/api.ts#L335-L372) checks the result only after the external push, so rejection does not prevent or repair a bad write. `undo.done` is appended at token issuance (line 400), before the restore check at [`src/api.ts:413–432`](src/api.ts#L413-L432).

**Root cause:** Both operations delegate generic base-repo write authority to the caller rather than executing one approved update inside the Worker. Undo also records completion prematurely.

**Smallest fix:** Perform the approved fast-forward or restore inside the Worker via the Artifacts binding, without returning a base-repo write token. Pin the expected old head and approved target and reject intervening ref changes. Move `undo.done` to `/api/undo/confirm`, after verified restoration, as with `undo.confirmed`. Update UI/client flows to remove token-based push instructions. Verify binding support before choosing an implementation; if tokens must remain, require enforceable repo/ref scope and approved-target restrictions plus verify-and-revert in confirmation. Repo/ref scope alone does not bind a token to an approved commit, and post-write checks alone are not prevention.

**Acceptance checks:**
- [ ] Promotion changes only base `main` to the evaluated, approved commit; restore changes only that ref to the recorded previous head.
- [ ] No caller receives generic base-repo write authority; arbitrary commits, other refs, stale heads, and replayed operations are rejected.
- [ ] Failed or unverified restores never append `undo.done` or mark a promotion undone; successful confirmation records completion once.

#### [security][medium] Restrict internal evaluation and bind requests to submitted candidates

Parent: https://github.com/Mike-Demo/verdict/issues/1

**Priority:** 3. **Fingerprint:** `internal-eval-endpoint-callable-by-write-secret-holders`.

**Evidence:** [`src/index.ts:14–34`](src/index.ts#L14-L34) authenticates `/api/internal/eval` with the external write `INTERNAL_SECRET`, then passes caller JSON to `runEvaluation` after a non-atomic dedup lookup. [`src/evaluate.ts:19–28`](src/evaluate.ts#L19-L28) validates only SHA format before opening the caller-selected repo; it does not load and bind the submitted candidate record before executing work.

**Root cause:** Internal delegation shares external authentication and trusts caller-provided candidate identity, repository, and commit.

**Smallest fix:** Use a distinct, Worker-only `INTERNAL_EVAL_SECRET`, a service binding, or an authenticated queue delegation mechanism. External agent and human credentials must not authorize this endpoint. In `runEvaluation`, load the candidate and submitted state from D1 before any Artifacts/Sandbox work; derive or verify repo and commit against that record and validate the intended ref policy rather than trusting caller JSON. Apply this validation to both the HTTP and direct evaluation paths.

**Acceptance checks:**
- [ ] External write credentials cannot invoke the internal evaluator.
- [ ] Unknown/unsubmitted candidates and mismatched repo/commit/ref requests fail before expensive work.
- [ ] Valid queue and direct evaluations still work using database-bound candidate parameters.

#### [security][medium] Atomically claim evaluations and limit repeated submissions

Parent: https://github.com/Mike-Demo/verdict/issues/1

**Priority:** 4. **Fingerprint:** `submit-spawns-unbounded-sandbox-evaluations`.

**Evidence:** [`src/api.ts:171–193`](src/api.ts#L171-L193) sends a queue message and independently starts `waitUntil` evaluation on submit. Its dedup lookup and the one in [`src/index.ts:22–34`](src/index.ts#L22-L34) are SELECT-then-run checks. [`src/evaluate.ts:69–92`](src/evaluate.ts#L69-L92) creates a uniquely named sandbox and runs install/two test suites before inserting the evaluation at [`src/evaluate.ts:234–249`](src/evaluate.ts#L234-L249). The unique candidate/commit index in [`schema.sql:23–36`](schema.sql#L23-L36) therefore acts too late to prevent duplicate expensive work. [`wrangler.toml:44–48`](wrangler.toml#L44-L48) caps the pool at ten instances.

**Root cause:** Two independent triggers and repeatable submits have no shared atomic work claim, per-intent in-flight guard, or submit rate limit.

**Smallest fix:** Atomically insert a pending evaluation using the existing `UNIQUE(candidate_id, commit_sha)` constraint before spawning a sandbox; treat a constraint conflict as deduped in both paths. Add the minimal schema/state support for pending/running/completed/failed work (the current evaluation fields are required), keeping pending rows out of completed decision evidence. Add an atomic per-intent in-flight guard and submit rate limit. Define bounded retry/recovery for failed or abandoned claims so a crash does not permanently block evaluation, and ensure duplicate deliveries cannot release another worker's claim.

**Acceptance checks:**
- [ ] Concurrent queue/direct requests for one candidate/commit start at most one sandbox.
- [ ] Repeated submits of completed work do not rerun it; concurrent commits for one intent respect the in-flight guard and submit limit.
- [ ] Failed/abandoned claims recover safely with bounded retries; pending work cannot count as passing evaluation evidence.

#### [security][medium] Remove the queue's hardcoded external Worker destination

Parent: https://github.com/Mike-Demo/verdict/issues/1

**Priority:** 5. **Fingerprint:** `queue-fallback-sends-internal-secret-to-hardcoded-origin`.

**Evidence:** [`src/index.ts:85–101`](src/index.ts#L85-L101) falls back to the original author's Worker origin when `WORKER_URL` is unset, then sends `env.INTERNAL_SECRET` and the queued candidate JSON there. [`wrangler.toml:13–16`](wrangler.toml#L13-L16) also ships that origin as its configured value. A fork retaining that configuration, or a deployment losing the variable, discloses its own credential/candidate data and routes evaluations to the wrong deployment.

**Root cause:** Secret-bearing self-fetch trusts a configured or hardcoded external destination rather than a deployment-local binding.

**Smallest fix:** Remove the hardcoded fallback and the shipped third-party URL default. Require an explicitly configured deployment-local HTTPS destination; on missing/invalid configuration, log a non-secret diagnostic and retry/fail without making a request. Prefer a Worker service binding to avoid external URL/secret transport entirely. If HTTP remains, validate the destination against a trusted deployment origin and refuse redirects rather than forwarding the credential to another origin. Coordinate with the separate internal-auth issue; changing the credential alone does not make a wrong destination safe.

**Acceptance checks:**
- [ ] Unset/invalid URL configuration causes no outbound request and no credential-bearing logs.
- [ ] A fresh fork cannot silently send secrets or payloads to the original deployment, including via the shipped configuration or redirects.
- [ ] Correctly configured local delegation still evaluates work and preserves queue acknowledgment/retry behavior.

### Ready-to-file validation checklist issue

#### [security][needs-validation] Audit leads to validate

Parent: https://github.com/Mike-Demo/verdict/issues/1

These are leads, not confirmed vulnerabilities. No severity is assigned. Validate only in an authorized test deployment with synthetic fixtures; record runtime/model configuration and reproducible evidence, then confirm or reject each lead. Static inspection alone does not establish the missing facts.

- [ ] **Held-out tests are staged as a plain file in the same sandbox that executes candidate code**
  - **Fingerprint:** `heldout-tests-readable-by-candidate-code-in-sandbox`.
  - **Claimed root cause:** Held-out tests are staged as a readable file at a predictable path inside the same sandbox filesystem and execution context as untrusted candidate code, without a source-visible isolation boundary between candidate execution and the staged secret file.
  - **Evidence:** [`src/evaluate.ts:69–92`](src/evaluate.ts#L69-L92) uses the same sandbox for candidate tests and `/workspace/cand/heldout.test.js`.
  - **Exact missing fact (as supplied):** “The Cloudflare Sandbox runtime's actual filesystem and network isolation for candidate processes: whether code imported by the held-out vitest run executes under a uid/permission/seccomp policy that denies reading the sibling /workspace/cand/heldout.test.js staged by sandbox.exec, and whether outbound network remains available during the held-out …”
  - **Validation:** Record the actual process identity, permissions, isolation policy, attempted read of a synthetic sibling fixture, and outbound connectivity during held-out execution. The parent text ends with an ellipsis; obtain the omitted wording from the audit owner rather than treating this quotation as complete.

- [ ] **Candidate code string literals can steer the Clef judge summary shown to the human approver**
  - **Fingerprint:** `judge-prompt-injection-via-candidate-code-strings`.
  - **Claimed root cause:** Candidate code is interpolated into the Clef judge context with only comment stripping, leaving string and template literals that can carry natural-language instructions into the model context.
  - **Evidence:** [`src/judge.ts:35–77`](src/judge.ts#L35-L77) strips comments, labels/delimits candidate code, and asks three fixed choice questions; [`src/judge.ts:106–116`](src/judge.ts#L106-L116) derives the human-facing summary.
  - **Exact missing fact:** “Whether the Clef model choice probabilities for the three fixed questions actually move in response to natural-language instructions embedded in candidate_code string literals, despite the UNTRUSTED labelling and candidate_code delimiting.”
  - **Validation:** Compare repeated baseline and instruction-bearing string/template-literal variants with otherwise equivalent behavior, retaining the actual labels/delimiters and model configuration. Record probability distributions and distinguish reproducible shifts from normal model variability; the judge remains advisory, not a deterministic gate.

- [ ] **Ledger hash chain is built with a non-atomic read-then-insert, so concurrent writes can fork the chain**
  - **Fingerprint:** `ledger-hash-chain-non-atomic-read-then-insert`.
  - **Claimed root cause:** The ledger append performs a non-atomic read-then-insert across two separate awaited D1 statements without a transaction, batch, serialising construct, or UNIQUE constraint on prev_hash.
  - **Evidence:** [`src/db.ts:18–36`](src/db.ts#L18-L36) reads the previous hash and later inserts; [`schema.sql:58–71`](schema.sql#L58-L71) has no unique `prev_hash` constraint.
  - **Exact missing fact:** “Whether the deployed Cloudflare Workers and D1 execution model serialises the two awaited statements of concurrent ledger() calls in practice, or whether two simultaneous write requests can interleave between the SELECT and the INSERT and produce two rows with the same prev_hash.”
  - **Validation:** Exercise synchronized concurrent writes against a disposable deployed Worker/D1 instance and inspect predecessor hashes and chain verification. Record interleaving evidence or a documented serialization guarantee; lack of reproduction alone is not proof of serialization.
