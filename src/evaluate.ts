// Full candidate evaluation, run in the queue consumer (normal Worker
// context — the Sandbox binding works here; it does not inside Workflows).
import { getSandbox } from '@cloudflare/sandbox';
import { Env, ledger, now, uid } from './db';
import { judgeCandidate } from './judge';

export interface EvalParams {
	candidate_id: string;
	repo: string;
	ref: string;
	commit: string;
}

async function dispose(_h: any) {
	// NOTE: do NOT call Symbol.asyncDispose on Artifacts handles — it can
	// crash the isolate with an uncatchable 1101. Handles are GC'd.
}

export async function runEvaluation(env: Env, params: EvalParams) {
	const { candidate_id, repo, commit } = params;

	// V1 defense-in-depth: validate commit SHA format (api.ts also validates)
	if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
		throw new Error('invalid commit sha format');
	}

	// Gate 1: static checks via the Artifacts binding (fast, deterministic).
	const r: any = await env.ARTIFACTS.get(repo);
	let staticChecks: any;
	try {
		const log = await r.log({ ref: commit, limit: 1 });
		if (!log.length) {
			staticChecks = { commitFound: false };
		} else {
			const tree = await r.readTree(log[0].treeHash);
			const names: string[] = (tree ?? []).map((e: any) => e.name);
			let pkg: any = null;
			try {
				const blob = await r.readFile({ ref: commit, path: 'package.json' });
				if (blob) pkg = JSON.parse(await blob.text());
			} catch {}
			staticChecks = {
				commitFound: true,
				hasPackageJson: names.includes('package.json'),
				hasTestScript: !!pkg?.scripts?.test,
				hasSrc: names.includes('src'),
				fileCount: names.length,
			};
		}
	} finally {
		await dispose(r);
	}

	// Gates 2+3: real test runs in an isolated Sandbox (visible + held-out).
	const r2: any = await env.ARTIFACTS.get(repo);
	let readToken = '';
	try {
		readToken = (await r2.createToken('read', 3600)).plaintext;
	} finally {
		await dispose(r2);
	}
	const tokenSecret = readToken.split('?expires=')[0];
	// Copilot follow-up: sanitize token for shell interpolation (defense-in-depth).
	// Artifacts tokens should be URL-safe, but strip anything unexpected.
	const safeToken = tokenSecret.replace(/[^A-Za-z0-9\-_.~]/g, '');
	const remote = `https://${env.ACCOUNT_HOST}/git/${env.NAMESPACE}/${repo}.git`;
	const authRemote = remote.replace('https://', `https://x:${safeToken}@`);

	// Post-submission hardening (review #2, L6): sandboxes used to be created
	// per run (eval-<candidate>-<timestamp>) and never destroyed, accumulating
	// toward the max_instances cap. Names are now drawn from a bounded pool of
	// 10 derived from the candidate id; the per-run `rm -rf /workspace/cand`
	// in the clone step below resets the workspace between reuses.
	let poolHash = 0;
	for (let i = 0; i < candidate_id.length; i++) poolHash = (poolHash * 31 + candidate_id.charCodeAt(i)) >>> 0;
	const sandbox = getSandbox(env.SANDBOX, `eval-pool-${poolHash % 10}`);
	const out: any = { clone: null, install: null, visible: null, heldOut: null };
	try {
		// Copilot audit fix: defense-in-depth on shell interpolation.
		// commit is regex-validated (^[0-9a-f]{7,40}$) but we strip shell metachars anyway,
		// and use -- to separate refs from options.
		const safeCommit = commit.replace(/[^0-9a-f]/gi, '');
		const clone = await sandbox.exec(
			`rm -rf /workspace/cand && git clone ${authRemote} /workspace/cand 2>&1 && cd /workspace/cand && git checkout -- . 2>&1 && git checkout ${safeCommit} 2>&1 | tail -1`,
		);
		out.clone = { ok: clone.exitCode === 0, output: (clone.stdout + clone.stderr).slice(-500) };
		if (out.clone.ok) {
			// Post-submission hardening (review #2, L5): the clone URL embeds
			// the fork's read token, which git persists in .git/config. Point
			// the remote back at the unauthenticated URL NOW — before npm ci
			// lifecycle scripts or any test run executes candidate code — so
			// the live token is not sitting in the tree while that code runs.
			await sandbox.exec(`cd /workspace/cand && git remote set-url origin ${remote} 2>&1`);
			const install = await sandbox.exec(`cd /workspace/cand && npm ci --no-audit --no-fund 2>&1 | tail -3`);
			out.install = { ok: install.exitCode === 0, output: (install.stdout + install.stderr).slice(-500) };
			if (out.install.ok) {
				// Post-submission hardening (review #2, M7): run the suite
				// directly with vitest instead of the candidate's own
				// `npm test` script — scripts.test is candidate-definable
				// ("test": "true" would have passed this gate without running
				// anything). hasTestScript remains a static presence check.
				const visible = await sandbox.exec(`cd /workspace/cand && npx vitest run 2>&1 | tail -25`);
				out.visible = { ok: visible.exitCode === 0, output: (visible.stdout + visible.stderr).slice(-2000) };
				// Held-out tests: agents never see these; they live only in the Worker env.
				// Post-submission hardening (review #2, H1 + I2): the file is
				// staged OUTSIDE the candidate tree, in /workspace/heldout,
				// under an evaluator-owned vitest config, and run with an
				// explicit --config/--root there — the candidate's own
				// vitest.config, setup files, and package.json never
				// participate. The suite imports './src/store.js' relative to
				// itself, so the harness exposes the candidate's src (and its
				// installed node_modules, for the 'vitest' import) through
				// symlinks; the held-out file itself never enters /workspace/cand.
				// Base64 is computed over TextEncoder bytes: btoa() alone
				// throws on any non-Latin1 character in the test source.
				const toB64 = (s: string) => {
					const bytes = new TextEncoder().encode(s);
					let bin = '';
					for (const b of bytes) bin += String.fromCharCode(b);
					return btoa(bin);
				};
				const heldB64 = toB64(env.HELD_OUT_TESTS);
				const heldConfig = `export default { test: { include: ['heldout.test.js'] } };\n`;
				const heldConfigB64 = toB64(heldConfig);
				const writeHeld = await sandbox.exec(
					`mkdir -p /workspace/heldout && echo '${heldB64}' | base64 -d > /workspace/heldout/heldout.test.js && echo '${heldConfigB64}' | base64 -d > /workspace/heldout/vitest.config.mjs && ln -sfn /workspace/cand/src /workspace/heldout/src && ln -sfn /workspace/cand/node_modules /workspace/heldout/node_modules && ls /workspace/heldout/heldout.test.js`,
				);
				if (writeHeld.exitCode === 0) {
					const held = await sandbox.exec(`cd /workspace/cand && npx vitest run --config /workspace/heldout/vitest.config.mjs --root /workspace/heldout 2>&1 | tail -25`);
					out.heldOut = { ok: held.exitCode === 0, output: (held.stdout + held.stderr).slice(-2000) };
				} else {
					out.heldOut = { ok: false, output: 'could not stage held-out tests' };
				}
			}
		}
	} catch (e: any) {
		out.infraError = String(e?.message ?? e).slice(0, 300);
	}
	// NOTE: no sandbox.destroy() — it can crash the isolate uncatchably.

	// Scope-creep detection: diff the candidate commit against current base
	// main and compare the changed files to the intent's declared paths.
	// Files outside the declared scope are flagged (they cannot silently
	// widen the blast radius of a promotion).
	let changedFiles: string[] = [];
	let scopeChecked = false;
	try {
		const baseHandle: any = await env.ARTIFACTS.get(env.BASE_REPO);
		let baseReadToken = '';
		try {
			baseReadToken = (await baseHandle.createToken('read', 3600)).plaintext;
		} finally {
			await dispose(baseHandle);
		}
		const baseSecret = baseReadToken.split('?expires=')[0];
		const baseAuthRemote = `https://${env.ACCOUNT_HOST}/git/${env.NAMESPACE}/${env.BASE_REPO}.git`.replace(
			'https://',
			`https://x:${baseSecret}@`,
		);
		if (out.clone?.ok) {
			const diffOut = await sandbox.exec(
				`cd /workspace/cand && git remote add verdict-base ${baseAuthRemote} 2>/dev/null; git fetch verdict-base main --depth=50 >/dev/null 2>&1 && git diff --name-only verdict-base/main HEAD 2>/dev/null`,
			);
			if (diffOut.exitCode === 0) {
				changedFiles = diffOut.stdout
					.split('\n')
					.map((s: string) => s.trim())
					.filter((s: string) => s && !s.startsWith('fatal'));
				scopeChecked = true;
			}
		}
	} catch (e: any) {
		console.error('[scope] diff failed:', String(e?.message ?? e).slice(0, 200));
	}
	const intentRow: any = await env.DB.prepare(
		`SELECT paths, spec_commit FROM intents WHERE id = (SELECT intent_id FROM candidates WHERE id = ?)`,
	)
		.bind(candidate_id)
		.first();
	let declaredPaths: string[] = [];
	try {
		declaredPaths = JSON.parse(intentRow?.paths ?? '[]');
	} catch {}
	const normPath = (p: string) => p.replace(/\/+$/, '');
	const inDeclaredScope = (f: string) =>
		declaredPaths.map(normPath).some((d) => {
			const nf = normPath(f);
			return nf === d || nf.startsWith(d + '/');
		});
	const undeclaredFiles = changedFiles.filter((f) => !inDeclaredScope(f));
	const scopeCreep = scopeChecked ? undeclaredFiles.length > 0 : null;
	// Candidate must never edit its own judge: flag diffs that touch test/spec paths.
	// Post-submission hardening (review #2, M4): tri-state, like scope_creep —
	// when the scope check didn't run, this is null (UNVERIFIED), never a
	// confident false. Decide treats null/absent as unverified (see api.ts).
	const touchedTests = scopeChecked
		? changedFiles.some(
				(f) => f.startsWith('test/') || f.endsWith('.test.js') || f.includes('heldout'),
			)
		: null;
	const specCommit = intentRow?.spec_commit ?? null;

	const checks = {
		// V3 fix (round 2): NEVER store raw test output — held-out test names/content
		// must not persist in checks or leak via ledger/API. Store only pass/fail booleans.
		commitFound: !!staticChecks.commitFound,
		hasPackageJson: !!staticChecks.hasPackageJson,
		hasTestScript: !!staticChecks.hasTestScript,
		installOk: !!out.install?.ok,
		visibleTestsPass: !!out.visible?.ok,
		heldOutTestsPass: out.heldOut ? !!out.heldOut.ok : null,
		changed_files: changedFiles,
		scope_checked: scopeChecked,
		scope_creep: scopeCreep,
		undeclared_files: undeclaredFiles,
		touched_tests: touchedTests,
		spec_commit: specCommit,
	};
	const pass =
		checks.commitFound && checks.hasPackageJson && checks.installOk && checks.visibleTestsPass && checks.heldOutTestsPass === true;

	// Advisory judge (Clef): only runs if deterministic gates passed.
	// Never gates — just adds quality signal to the decision card.
	let judgeResult = null;
	if (pass) {
		try {
			// Read the candidate's implementation via Artifacts binding (not sandbox).
			let code = '';
			try {
				const repoHandle: any = await env.ARTIFACTS.get(repo);
				try {
					const blob = await repoHandle.readFile({ ref: commit, path: 'src/store.js' });
					if (blob) {
						const text = await blob.text();
						if (text && text.length > 100) code = text.slice(0, 6000);
					}
				} finally {
					// Do not call Symbol.asyncDispose — it crashes the isolate (see AGENTS.md)
				}
			} catch (e: any) {
				console.error('[judge] Artifacts readFile failed:', e?.message ?? e);
			}
			if (code.length > 100) {
				// Get the task description from the intent
				const intent = await env.DB.prepare(
					`SELECT title, description FROM intents WHERE id = (SELECT intent_id FROM candidates WHERE id = ?)`,
				).bind(candidate_id).first() as any;
				const taskDesc = intent ? `${intent.title}: ${intent.description}` : 'Implement the task';
				judgeResult = await judgeCandidate(env, code, taskDesc);
			} else {
				console.error('[judge] Could not read candidate code via Artifacts');
			}
		} catch (e: any) {
			console.error('Judge step failed:', e?.message ?? e);
		}
	}
	if (judgeResult) {
		(checks as any).judge = judgeResult;
	}

	// Cost attribution: the Clef judge call is the measurable AI cost.
	// clef-flash lists ~$0.038/1M tokens; a judge call is a few thousand
	// tokens, so we record a flat $0.002 estimate, clearly labeled as
	// estimated until AI Gateway metering is wired in.
	const costUsd = judgeResult ? 0.002 : 0;
	const costEstimated = 1;
	(checks as any).cost = { usd: costUsd, estimated: true, source: judgeResult ? 'clef-flash' : 'none' };

	const summary = [
		`commit ${commit.slice(0, 8)} found`,
		`install ${checks.installOk ? 'ok' : 'FAILED'}`,
		`visible tests ${checks.visibleTestsPass ? 'pass' : 'FAIL'}`,
		`held-out tests ${checks.heldOutTestsPass === true ? 'pass' : checks.heldOutTestsPass === false ? 'FAIL' : 'n/a'}`,
	].join(' · ');

	await env.DB.prepare(
		`INSERT INTO evaluations (id, candidate_id, commit_sha, checks, pass, held_out_pass, summary, cost_usd, cost_estimated, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			uid('eval'),
			candidate_id,
			commit,
			JSON.stringify(checks),
			pass ? 1 : 0,
			checks.heldOutTestsPass == null ? null : checks.heldOutTestsPass ? 1 : 0,
			summary,
			costUsd,
			costEstimated,
			now(),
		)
		.run();
	// Post-submission hardening (review #2, L4): conditional status update —
	// a late-finishing evaluation must not regress an intent that has since
	// advanced (decided/promoted). Only submitted/evaluated intents move.
	await env.DB.prepare(`UPDATE intents SET status = 'evaluated' WHERE id = (SELECT intent_id FROM candidates WHERE id = ?) AND status IN ('submitted','evaluated')`)
		.bind(candidate_id)
		.run();
	await ledger(env, 'evaluation.done', candidate_id, {
		pass,
		summary,
		scope_creep: scopeCreep,
		undeclared_files: undeclaredFiles,
		touched_tests: touchedTests,
		spec_commit: specCommit,
		cost_usd: costUsd,
		cost_estimated: !!costEstimated,
	});

	return { pass, summary, checks };
}
