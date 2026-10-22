// Verdict API: intents, forks, decision cards, merge sequencer, ledger, undo.
import { Env, ledger, now, uid, getIntent, activeIntents, heatFor, parsePaths } from './db';
import { runEvaluation } from './evaluate';

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function disposeAll(_handles: any[]) {
	// NOTE: do NOT call Symbol.asyncDispose on Artifacts handles — it can
	// crash the isolate with an uncatchable 1101. Handles are GC'd.
}

export async function handleApi(req: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
	const path = url.pathname;
	const method = req.method;

	// Require the agent secret for agent writes and a distinct human secret
	// for approval and undo operations.
	// Copilot audit fix: fail LOUD if INTERNAL_SECRET is not configured (not silent 401)
	if (!env.INTERNAL_SECRET) {
		console.error('[verdict] FATAL: INTERNAL_SECRET is not configured');
	}
	const requireAuth = (human = false) => {
		const secret = req.headers.get('x-verdict-secret');
		if (human) {
			if (!env.INTERNAL_SECRET || !env.HUMAN_SECRET || env.HUMAN_SECRET === env.INTERNAL_SECRET) {
				return json({ error: 'server misconfigured: distinct human secret not set' }, 500);
			}
			if (secret !== env.HUMAN_SECRET) {
				return json({ error: 'unauthorized: human x-verdict-secret required' }, 401);
			}
			return null;
		}
		if (!env.INTERNAL_SECRET) {
			return json({ error: 'server misconfigured: write secret not set' }, 500);
		}
		if (secret !== env.INTERNAL_SECRET) {
			return json({ error: 'unauthorized: x-verdict-secret required' }, 401);
		}
		return null;
	};
	const isHumanWrite = method === 'POST' && (
		path === '/api/decide' ||
		path === '/api/undo' ||
		path === '/api/undo/confirm' ||
		path === '/api/promotions/confirm'
	);
	const isWrite = isHumanWrite || (method === 'POST' && (
		path === '/api/intents' ||
		/\/api\/intents\/[^/]+\/fork$/.test(path) ||
		/\/api\/intents\/[^/]+\/submit$/.test(path)
	));
	if (isWrite) {
		const authErr = requireAuth(isHumanWrite);
		if (authErr) return authErr;
	}

	// --- Declare intent ---
	if (method === 'POST' && path === '/api/intents') {
		const body = (await req.json()) as { title: string; description?: string; paths: string[]; agent: string };
		if (!body.title || !Array.isArray(body.paths) || !body.agent) {
			return json({ error: 'title, paths[], agent required' }, 400);
		}
		// V10 fix: atomic cap via INSERT...SELECT — no race between check and insert
		const id = uid('intent');
		const result = await env.DB.prepare(
			`INSERT INTO intents (id, title, description, paths, agent, status, created_at)
			 SELECT ?, ?, ?, ?, ?, 'declared', ?
			 WHERE (SELECT COUNT(*) FROM intents WHERE status IN ('declared','forked','submitted')) < 5`,
		)
			.bind(id, body.title, body.description ?? '', JSON.stringify(body.paths), body.agent, now())
			.run();
		if ((result.meta?.changes ?? 0) === 0) {
			return json({ error: 'intent queue is full (5). Resolve or withdraw an intent first.' }, 409);
		}
		// Heat: query other active intents (excluding the one just inserted)
		const { results: otherActive } = await env.DB.prepare(
			`SELECT * FROM intents WHERE status IN ('declared','forked','submitted') AND id != ?`
		).bind(id).all();
		const heat = heatFor(body.paths, (otherActive ?? []).map((a: any) => ({ paths: parsePaths(a.paths) })));
		await ledger(env, 'intent.declared', id, { title: body.title, agent: body.agent, paths: body.paths, heat });
		return json({ id, title: body.title, agent: body.agent, paths: body.paths, heat, status: 'declared' });
	}

	// --- List intents with heat + candidate/eval state ---
	if (method === 'GET' && path === '/api/intents') {
		const { results } = await env.DB.prepare(`SELECT * FROM intents ORDER BY created_at DESC`).all();
		const intents = results ?? [];
		const active = intents.filter((i: any) => ['declared', 'forked', 'submitted'].includes(i.status));
		const out = [];
		for (const intent of intents as any[]) {
			const others = active.filter((a: any) => a.id !== intent.id);
			const candidate = await env.DB.prepare(`SELECT * FROM candidates WHERE intent_id = ?`).bind(intent.id).first();
			let evaluation = null;
			if (candidate) {
				evaluation = await env.DB.prepare(
					`SELECT * FROM evaluations WHERE candidate_id = ? ORDER BY evaluated_at DESC LIMIT 1`,
				)
					.bind((candidate as any).id)
					.first();
			}
			// V3 fix (round 2): strip testOutput from evaluation checks in /api/intents too
			let safeEvaluation = evaluation;
			if (evaluation && evaluation.checks) {
				try {
					const checks = JSON.parse(evaluation.checks);
					delete checks.testOutput;
					safeEvaluation = { ...evaluation, checks: JSON.stringify(checks) };
				} catch {}
			}
			out.push({
				...intent,
				paths: parsePaths(intent.paths),
				heat: heatFor(parsePaths(intent.paths), others.map((a: any) => ({ paths: parsePaths(a.paths) }))),
				candidate,
				evaluation: safeEvaluation,
			});
		}
		return json(out);
	}

	// --- Provision an isolated fork for an intent ---
	if (method === 'POST' && /^\/api\/intents\/[^/]+\/fork$/.test(path)) {
		const id = path.split('/')[3];
		const intent: any = await getIntent(env, id);
		if (!intent) return json({ error: 'intent not found' }, 404);
		if (intent.status !== 'declared') return json({ error: `intent already ${intent.status}` }, 409);
		const forkName = `intent-${id.replace('intent_', '').slice(-8)}`;
		let base: any = null;
		let forked: any = null;
		try {
			base = await env.ARTIFACTS.get(env.BASE_REPO);
			forked = await base.fork(forkName, { description: `Fork for intent: ${intent.title}` });
			const repoName = forked.name ?? forkName;
			// Pin the spec: record the base main HEAD this fork was cut from.
			// Evaluations are judged against this spec commit — the candidate
			// cannot move its own goalposts.
			let specCommit: string | null = null;
			try {
				const baseHead = await base.log({ ref: 'main', limit: 1 });
				specCommit = baseHead?.[0]?.hash ?? null;
			} catch {}
			await env.DB.prepare(`UPDATE intents SET spec_commit = ? WHERE id = ?`).bind(specCommit, id).run();
			const repoHandle: any = await env.ARTIFACTS.get(repoName);
			let token: string;
			try {
				const t = await repoHandle.createToken('write', 86400);
				token = t.plaintext;
			} finally {
				await repoHandle?.[Symbol.asyncDispose]?.();
			}
			const candidateId = uid('cand');
			await env.DB.prepare(`INSERT INTO candidates (id, intent_id, repo, commit_sha) VALUES (?, ?, ?, NULL)`)
				.bind(candidateId, id, repoName)
				.run();
			await env.DB.prepare(`UPDATE intents SET status = 'forked' WHERE id = ?`).bind(id).run();
			await ledger(env, 'fork.created', candidateId, { intent_id: id, repo: repoName, spec_commit: specCommit });
			return json({ candidate_id: candidateId, repo: repoName, remote: forked.remote, token, spec_commit: specCommit });
		} catch (e: any) {
			return json({ error: 'fork failed', detail: String(e?.message ?? e) }, 500);
		} finally {
			await disposeAll([forked, base]);
		}
	}

	// --- Submit a pushed candidate for evaluation ---
	if (method === 'POST' && /^\/api\/intents\/[^/]+\/submit$/.test(path)) {
		const id = path.split('/')[3];
		const intent: any = await getIntent(env, id);
		if (!intent) return json({ error: 'intent not found' }, 404);
		const body = (await req.json()) as { commit: string };
		if (!body.commit) return json({ error: 'commit sha required' }, 400);
		// V1 fix: validate commit SHA format to prevent shell injection
		if (!/^[0-9a-f]{7,40}$/i.test(body.commit)) {
			return json({ error: 'invalid commit sha format' }, 400);
		}
		const candidate: any = await env.DB.prepare(`SELECT * FROM candidates WHERE intent_id = ?`).bind(id).first();
		if (!candidate) return json({ error: 'no fork provisioned for this intent' }, 409);
		await env.DB.prepare(`UPDATE candidates SET commit_sha = ?, submitted_at = ? WHERE id = ?`)
			.bind(body.commit, now(), candidate.id)
			.run();
		await env.DB.prepare(`UPDATE intents SET status = 'submitted' WHERE id = ?`).bind(id).run();
		await env.EVAL_QUEUE.send({ candidate_id: candidate.id, repo: candidate.repo, ref: 'main', commit: body.commit });
		// Workaround: queue consumer doesn't fire (platform issue). Run eval directly via waitUntil.
		// waitUntil keeps the fetch context alive, so the Sandbox binding works.
		// The queue remains as backup; runEvaluation dedupes via the eval endpoint.
		if (ctx) {
			const evalParams = { candidate_id: candidate.id, repo: candidate.repo, ref: 'main', commit: body.commit };
			ctx.waitUntil((async () => {
				try {
					// Dedup check: skip if this commit was already evaluated (V4 fix)
					const existing: any = await env.DB.prepare(
						`SELECT id FROM evaluations WHERE candidate_id = ? AND commit_sha = ? LIMIT 1`
					).bind(candidate.id, body.commit).first();
					if (!existing) {
						await runEvaluation(env, evalParams);
					}
				} catch (e) {
					// Log to ledger on failure
					try {
						await ledger(env, 'evaluation.failed', candidate.id, { error: String(e).slice(0, 200) });
					} catch {}
				}
			})());
		}
		await ledger(env, 'candidate.submitted', candidate.id, { intent_id: id, commit: body.commit });
		return json({ queued: true, candidate_id: candidate.id });
	}

	// --- Decision cards: one per intent with evaluated candidate ---
	if (method === 'GET' && path === '/api/cards') {
		const { results } = await env.DB.prepare(
			`SELECT i.*, c.id AS candidate_id, c.repo AS candidate_repo, c.commit_sha,
			        e.id AS eval_id, e.checks, e.pass, e.held_out_pass, e.summary, e.evaluated_at,
			        e.cost_usd, e.cost_estimated
			 FROM intents i
			 LEFT JOIN candidates c ON c.intent_id = i.id
			 LEFT JOIN evaluations e ON e.id = (
			   SELECT id FROM evaluations WHERE candidate_id = c.id ORDER BY evaluated_at DESC LIMIT 1
			 )
			 WHERE i.status IN ('submitted','evaluated')
			 ORDER BY i.created_at ASC`,
		).all();
		const cards = (results ?? []).map((r: any) => {
			// V3 fix: strip raw test output from public responses (held-out test names/content must not leak)
			let checks: any = null;
			if (r.checks) {
				try {
					checks = JSON.parse(r.checks);
					delete checks.testOutput; // Remove raw sandbox output containing held-out details
				} catch {}
			}
			return {
				intent: { id: r.id, title: r.title, description: r.description, agent: r.agent, paths: parsePaths(r.paths), status: r.status },
				candidate: r.candidate_id ? { id: r.candidate_id, repo: r.candidate_repo, commit: r.commit_sha } : null,
				evaluation: r.eval_id
					? { checks, pass: !!r.pass, held_out_pass: r.held_out_pass == null ? null : !!r.held_out_pass, summary: r.summary, evaluated_at: r.evaluated_at, cost_usd: r.cost_usd, cost_estimated: !!r.cost_estimated }
					: null,
			};
		});
		return json(cards);
	}

	// --- Human decision + merge sequencer: FF check, mint 60s promotion token ---
	if (method === 'POST' && path === '/api/decide') {
		const body = (await req.json()) as { intent_id: string; candidate_id: string; rationale?: string };
		const intent: any = await getIntent(env, body.intent_id);
		const candidate: any = await env.DB.prepare(`SELECT * FROM candidates WHERE id = ?`).bind(body.candidate_id).first();
		if (!intent || !candidate || candidate.intent_id !== intent.id) {
			return json({ error: 'intent/candidate mismatch' }, 400);
		}
		const evaluation: any = await env.DB.prepare(
			`SELECT * FROM evaluations WHERE candidate_id = ? ORDER BY evaluated_at DESC LIMIT 1`,
		)
			.bind(candidate.id)
			.first();
		if (!evaluation || !evaluation.pass) {
			return json({ error: 'candidate has not passed evaluation gates' }, 409);
		}
		// V16 fix: if candidate touched test paths, require explicit human override.
		// The candidate may have modified its own judge.
		let evalChecks: any = {};
		try { evalChecks = JSON.parse(evaluation.checks || '{}'); } catch {}
		// V16 fix (round 2): check explicitly for true (not truthiness — "false" string would bypass)
		if (evalChecks.touched_tests && body.override_test_touch !== true) {
			return json({
				error: 'candidate touched test paths — human override required',
				guidance: 'The candidate modified test files. If this was intentional, resubmit with override_test_touch=true (boolean).',
				touched_tests: true,
			}, 409);
		}
		// V5/V14 fix: the evaluated commit must match the candidate's current commit.
		// If the agent pushed after evaluation, the tests didn't cover what's being promoted.
		const evaluatedCommit = evaluation.commit_sha;
		if (!evaluatedCommit || evaluatedCommit !== candidate.commit_sha) {
			return json({
				error: 'evaluation is stale: candidate was updated after evaluation',
				guidance: 'Resubmit the candidate to trigger a fresh evaluation of the current commit.',
				evaluated_commit: evaluatedCommit,
				current_commit: candidate.commit_sha,
			}, 409);
		}
		// V15 fix: reject if intent already has a decision (idempotency)
		const existingDecision: any = await env.DB.prepare(
			`SELECT id FROM decisions WHERE intent_id = ? LIMIT 1`
		).bind(intent.id).first();
		if (existingDecision) {
			return json({ error: 'intent already has a decision', decision_id: existingDecision.id }, 409);
		}
		let baseRepo: any = null;
		let forkRepo: any = null;
		try {
			baseRepo = await env.ARTIFACTS.get(env.BASE_REPO);
			forkRepo = await env.ARTIFACTS.get(candidate.repo);
			const mainLog = await baseRepo.log({ ref: 'main', limit: 1 });
			const forkLog = await forkRepo.log({ ref: 'main', limit: 200 });
			if (!mainLog.length || !forkLog.length) return json({ eligible: false, reason: 'empty history' }, 409);
			const mainHead: string = mainLog[0].hash;
			const forkHead: string = forkLog[0].hash;
			if (forkHead === mainHead) return json({ eligible: false, reason: 'nothing to promote' }, 409);
			// V5/V14 fix: fork head must equal the evaluated commit, not just contain main
			if (forkHead !== evaluatedCommit) {
				return json({
					eligible: false,
					reason: 'fork head does not match evaluated commit',
					guidance: 'The fork was updated after evaluation. Resubmit to re-evaluate the current head.',
					fork_head: forkHead,
					evaluated_commit: evaluatedCommit,
				}, 409);
			}
			if (!forkLog.some((c: any) => c.hash === mainHead)) {
				return json(
					{
						eligible: false,
						stale_base: true,
						reason: 'candidate is not rebased onto current main',
						guidance: 'Rebase the fork onto current main, push, and resubmit — the candidate will be re-evaluated before it can be promoted.',
						mainHead,
						forkHead,
					},
					409,
				);
			}
			const token = await baseRepo.createToken('write', 60);
			const decisionId = uid('dec');
			await env.DB.prepare(
				`INSERT INTO decisions (id, intent_id, winner_candidate_id, rationale, decided_at) VALUES (?, ?, ?, ?, ?)`,
			)
				.bind(decisionId, intent.id, candidate.id, body.rationale ?? '', now())
				.run();
			await env.DB.prepare(`UPDATE intents SET status = 'decided' WHERE id = ?`).bind(intent.id).run();
			await ledger(env, 'decision.made', decisionId, {
				intent_id: intent.id,
				winner: candidate.id,
				rationale: body.rationale ?? '',
				evidence: JSON.parse(evaluation.checks),
				mainHead,
				forkHead,
			});
			return json({ decision_id: decisionId, eligible: true, mainHead, forkHead, promotion_token: token.plaintext, expires_in: 60 });
		} finally {
			await disposeAll([forkRepo, baseRepo]);
		}
	}

	// --- Confirm a promotion after the agent fast-forward pushes ---
	if (method === 'POST' && path === '/api/promotions/confirm') {
		const body = (await req.json()) as { decision_id: string };
		const decision: any = await env.DB.prepare(`SELECT * FROM decisions WHERE id = ?`).bind(body.decision_id).first();
		if (!decision) return json({ error: 'decision not found' }, 404);
		// N3 fix: prevent double-record (idempotency)
		const existingPromo: any = await env.DB.prepare(`SELECT id FROM promotions WHERE decision_id = ? LIMIT 1`).bind(decision.id).first();
		if (existingPromo) {
			return json({ confirmed: true, promotion_id: existingPromo.id, note: 'already confirmed' });
		}
		const candidate: any = await env.DB.prepare(`SELECT * FROM candidates WHERE id = ?`).bind(decision.winner_candidate_id).first();
		// V5/V14 fix (round 2): confirm must verify main advanced to the EVALUATED commit, not just fork head
		const evaluation: any = await env.DB.prepare(
			`SELECT commit_sha FROM evaluations WHERE candidate_id = ? ORDER BY evaluated_at DESC LIMIT 1`
		).bind(candidate.id).first();
		const evaluatedCommit = evaluation?.commit_sha;
		if (!evaluatedCommit) {
			return json({ error: 'no evaluation found for candidate' }, 409);
		}
		let baseRepo: any = null;
		let forkRepo: any = null;
		try {
			baseRepo = await env.ARTIFACTS.get(env.BASE_REPO);
			forkRepo = await env.ARTIFACTS.get(candidate.repo);
			const mainHead = (await baseRepo.log({ ref: 'main', limit: 1 }))[0]?.hash;
			const forkHead = (await forkRepo.log({ ref: 'main', limit: 1 }))[0]?.hash;
			if (mainHead !== forkHead) {
				return json({ confirmed: false, reason: 'main has not advanced to the candidate head', mainHead, forkHead }, 409);
			}
			// Must match the evaluated commit — prevents post-eval push attacks
			if (mainHead !== evaluatedCommit) {
				return json({
					confirmed: false,
					reason: 'main head does not match evaluated commit',
					guidance: 'The promoted commit differs from what was evaluated. This is a security violation.',
					main_head: mainHead,
					evaluated_commit: evaluatedCommit,
				}, 409);
			}
			const prev = JSON.parse((await env.DB.prepare(`SELECT payload FROM ledger WHERE kind = 'decision.made' AND ref_id = ?`).bind(decision.id).first() as any)?.payload ?? '{}');
			const promotionId = uid('promo');
			await env.DB.prepare(
				`INSERT INTO promotions (id, base_repo, prev_head, new_head, candidate_id, decision_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(promotionId, env.BASE_REPO, prev.mainHead, mainHead, candidate.id, decision.id, now())
				.run();
			await env.DB.prepare(`UPDATE intents SET status = 'promoted' WHERE id = ?`).bind(decision.intent_id).run();
			await ledger(env, 'promotion.done', promotionId, { decision_id: decision.id, prev_head: prev.mainHead, new_head: mainHead });
			return json({ confirmed: true, promotion_id: promotionId, prev_head: prev.mainHead, new_head: mainHead });
		} finally {
			await disposeAll([forkRepo, baseRepo]);
		}
	}

	// --- One-click undo: mint a token; the operator push restores prev_head ---
	if (method === 'POST' && path === '/api/undo') {
		const body = (await req.json()) as { promotion_id: string };
		const promo: any = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(body.promotion_id).first();
		if (!promo || promo.undone) return json({ error: 'promotion not found or already undone' }, 404);
		let baseRepo: any = null;
		try {
			baseRepo = await env.ARTIFACTS.get(env.BASE_REPO);
			const token = await baseRepo.createToken('write', 300);
			// N4 fix: don't mark undone here — only in /api/undo/confirm after verified restore.
			// This allows retry if the push fails or token expires.
			await ledger(env, 'undo.done', promo.id, { prev_head: promo.prev_head, restored_to: promo.prev_head });
			return json({
				undone: true,
				restore_token: token.plaintext,
				expires_in: 300,
				restore_ref: promo.prev_head,
				note: 'Force-push main back to restore_ref using the token, then POST /api/undo/confirm with {promotion_id} to verify.',
			});
		} finally {
			await disposeAll([baseRepo]);
		}
	}

	// V7 fix: implement /api/undo/confirm (was referenced but missing)
	if (method === 'POST' && path === '/api/undo/confirm') {
		const body = (await req.json()) as { promotion_id: string };
		if (!body.promotion_id) return json({ error: 'promotion_id required' }, 400);
		const promo: any = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(body.promotion_id).first();
		if (!promo) return json({ error: 'promotion not found' }, 404);
		if (promo.undone) return json({ error: 'already undone' }, 409);
		let baseRepo: any = null;
		try {
			baseRepo = await env.ARTIFACTS.get(env.BASE_REPO);
			const mainLog = await baseRepo.log({ ref: 'main', limit: 1 });
			if (!mainLog.length) return json({ error: 'cannot read main' }, 500);
			const currentHead = mainLog[0].hash;
			if (currentHead === promo.prev_head) {
				// N4 fix: mark undone only here, after verified restore
				await env.DB.prepare(`UPDATE promotions SET undone = 1 WHERE id = ?`).bind(promo.id).run();
				await ledger(env, 'undo.confirmed', promo.id, { restored_to: currentHead });
				return json({ confirmed: true, head: currentHead });
			}
			return json({ confirmed: false, current_head: currentHead, expected: promo.prev_head }, 409);
		} finally {
			await disposeAll([baseRepo]);
		}
	}

	// --- Append-only ledger ---
	if (method === 'GET' && path === '/api/ledger') {
		// V17: include prev_hash/hash so external verifiers can check the chain
		const { results } = await env.DB.prepare(`SELECT seq, kind, ref_id, payload, prev_hash, hash, at FROM ledger ORDER BY seq ASC LIMIT 500`).all();
		return json((results ?? []).map((r: any) => ({ ...r, payload: JSON.parse(r.payload) })));
	}

	return json({ error: 'not found' }, 404);
}
