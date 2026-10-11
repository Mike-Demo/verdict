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

	// V2 fix: require shared secret on all write endpoints.
	// The UI prompts for it once and stores in sessionStorage.
	const requireAuth = () => {
		const secret = req.headers.get('x-verdict-secret');
		if (!env.INTERNAL_SECRET || secret !== env.INTERNAL_SECRET) {
			return json({ error: 'unauthorized: x-verdict-secret required' }, 401);
		}
		return null;
	};
	const isWrite = method === 'POST' && (
		path === '/api/intents' ||
		/\/api\/intents\/[^/]+\/fork$/.test(path) ||
		/\/api\/intents\/[^/]+\/submit$/.test(path) ||
		path === '/api/decide' ||
		path === '/api/undo' ||
		path === '/api/promotions/confirm'
	);
	if (isWrite) {
		const authErr = requireAuth();
		if (authErr) return authErr;
	}

	// --- Declare intent ---
	if (method === 'POST' && path === '/api/intents') {
		const body = (await req.json()) as { title: string; description?: string; paths: string[]; agent: string };
		if (!body.title || !Array.isArray(body.paths) || !body.agent) {
			return json({ error: 'title, paths[], agent required' }, 400);
		}
		const active = await activeIntents(env);
		if (active.length >= 5) {
			return json({ error: 'intent queue is full (5). Resolve or withdraw an intent first.' }, 409);
		}
		const id = uid('intent');
		await env.DB.prepare(
			`INSERT INTO intents (id, title, description, paths, agent, status, created_at) VALUES (?, ?, ?, ?, ?, 'declared', ?)`,
		)
			.bind(id, body.title, body.description ?? '', JSON.stringify(body.paths), body.agent, now())
			.run();
		const heat = heatFor(body.paths, active.map((a: any) => ({ paths: parsePaths(a.paths) })));
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
			out.push({
				...intent,
				paths: parsePaths(intent.paths),
				heat: heatFor(parsePaths(intent.paths), others.map((a: any) => ({ paths: parsePaths(a.paths) }))),
				candidate,
				evaluation,
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
		const candidate: any = await env.DB.prepare(`SELECT * FROM candidates WHERE id = ?`).bind(decision.winner_candidate_id).first();
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
			await env.DB.prepare(`UPDATE promotions SET undone = 1 WHERE id = ?`).bind(promo.id).run();
			await ledger(env, 'undo.done', promo.id, { prev_head: promo.prev_head, restored_to: promo.prev_head });
			return json({
				undone: true,
				restore_token: token.plaintext,
				expires_in: 300,
				restore_ref: promo.prev_head,
				note: 'Force-push the restore token to move main back to restore_ref, then confirm via /api/undo/confirm.',
			});
		} finally {
			await disposeAll([baseRepo]);
		}
	}

	// --- Append-only ledger ---
	if (method === 'GET' && path === '/api/ledger') {
		const { results } = await env.DB.prepare(`SELECT seq, kind, ref_id, payload, at FROM ledger ORDER BY seq ASC LIMIT 500`).all();
		return json((results ?? []).map((r: any) => ({ ...r, payload: JSON.parse(r.payload) })));
	}

	return json({ error: 'not found' }, 404);
}
