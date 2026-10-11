// Full candidate evaluation, run in the queue consumer (normal Worker
// context — the Sandbox binding works here; it does not inside Workflows).
import { getSandbox } from '@cloudflare/sandbox';
import { Env, ledger, now, uid } from './db';

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
	const steps: string[] = [];
	const mark = (s: string) => steps.push(`${Date.now()}: ${s}`);

	try {
	// Gate 1: static checks via the Artifacts binding (fast, deterministic).
	mark('artifacts.get#1');
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
	const remote = `https://${env.ACCOUNT_HOST}/git/${env.NAMESPACE}/${repo}.git`;
	const authRemote = remote.replace('https://', `https://x:${tokenSecret}@`);

	const sandbox = getSandbox(env.SANDBOX, `eval-${candidate_id}-${Date.now().toString(36)}`);
	const out: any = { clone: null, install: null, visible: null, heldOut: null };
	try {
		const clone = await sandbox.exec(
			`rm -rf /workspace/cand && git clone ${authRemote} /workspace/cand 2>&1 && cd /workspace/cand && git checkout ${commit} 2>&1 | tail -1`,
		);
		out.clone = { ok: clone.exitCode === 0, output: (clone.stdout + clone.stderr).slice(-500) };
		if (out.clone.ok) {
			const install = await sandbox.exec(`cd /workspace/cand && npm ci --no-audit --no-fund 2>&1 | tail -3`);
			out.install = { ok: install.exitCode === 0, output: (install.stdout + install.stderr).slice(-500) };
			if (out.install.ok) {
				const visible = await sandbox.exec(`cd /workspace/cand && npm test 2>&1 | tail -25`);
				out.visible = { ok: visible.exitCode === 0, output: (visible.stdout + visible.stderr).slice(-2000) };
				// Held-out tests: agents never see these; they live only in the Worker env.
				const b64 = btoa(env.HELD_OUT_TESTS);
				const writeHeld = await sandbox.exec(
					`echo '${b64}' | base64 -d > /workspace/cand/heldout.test.js && ls /workspace/cand/heldout.test.js`,
				);
				if (writeHeld.exitCode === 0) {
					const held = await sandbox.exec(`cd /workspace/cand && npx vitest run heldout.test.js 2>&1 | tail -25`);
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

	const checks = {
		commitFound: !!staticChecks.commitFound,
		hasPackageJson: !!staticChecks.hasPackageJson,
		hasTestScript: !!staticChecks.hasTestScript,
		installOk: !!out.install?.ok,
		visibleTestsPass: !!out.visible?.ok,
		heldOutTestsPass: out.heldOut ? !!out.heldOut.ok : null,
		testOutput: out,
	};
	const pass =
		checks.commitFound && checks.hasPackageJson && checks.installOk && checks.visibleTestsPass && checks.heldOutTestsPass === true;

	const summary = [
		`commit ${commit.slice(0, 8)} found`,
		`install ${checks.installOk ? 'ok' : 'FAILED'}`,
		`visible tests ${checks.visibleTestsPass ? 'pass' : 'FAIL'}`,
		`held-out tests ${checks.heldOutTestsPass === true ? 'pass' : checks.heldOutTestsPass === false ? 'FAIL' : 'n/a'}`,
	].join(' · ');

	await env.DB.prepare(
		`INSERT INTO evaluations (id, candidate_id, checks, pass, held_out_pass, summary, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			uid('eval'),
			candidate_id,
			JSON.stringify(checks),
			pass ? 1 : 0,
			checks.heldOutTestsPass == null ? null : checks.heldOutTestsPass ? 1 : 0,
			summary,
			now(),
		)
		.run();
	await env.DB.prepare(`UPDATE intents SET status = 'evaluated' WHERE id = (SELECT intent_id FROM candidates WHERE id = ?)`)
		.bind(candidate_id)
		.run();
	await ledger(env, 'evaluation.done', candidate_id, { pass, summary });

	return { pass, summary, checks };
}
