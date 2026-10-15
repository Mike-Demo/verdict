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
