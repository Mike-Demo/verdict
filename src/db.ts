// D1 helpers + append-only ledger for Verdict.

export interface Env {
	ARTIFACTS: any;
	DB: D1Database;
	EVAL_QUEUE: Queue;
	SANDBOX: DurableObjectNamespace;
	AI: any;
	HELD_OUT_TESTS: string;
	INTERNAL_SECRET: string;
	BASE_REPO: string;
}

export const now = () => Math.floor(Date.now() / 1000);
export const uid = (p: string) =>
	`${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export async function ledger(
	env: Env,
	kind: string,
	ref_id: string | null,
	payload: unknown,
): Promise<void> {
	// V17: hash chain for tamper detection
	const at = now();
	const payloadStr = JSON.stringify(payload);
	const last: any = await env.DB.prepare(
		`SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1`
	).first();
	const prevHash = last?.hash ?? 'GENESIS';
	const hashInput = `${prevHash}|${kind}|${ref_id ?? ''}|${payloadStr}|${at}`;
	const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput));
	const hash = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
	await env.DB.prepare(
		`INSERT INTO ledger (kind, ref_id, payload, prev_hash, hash, at) VALUES (?, ?, ?, ?, ?, ?)`,
	).bind(kind, ref_id, payloadStr, prevHash, hash, at).run();
}

export async function getIntent(env: Env, id: string) {
	return env.DB.prepare(`SELECT * FROM intents WHERE id = ?`).bind(id).first();
}

export async function activeIntents(env: Env) {
	const { results } = await env.DB.prepare(
		`SELECT * FROM intents WHERE status IN ('declared','forked','submitted') ORDER BY created_at ASC`,
	).all();
	return results ?? [];
}

/** Path-overlap heat: how many other active intents touch overlapping paths. Badge only. */
export function heatFor(intentPaths: string[], others: { paths: string[] }[]): number {
	const norm = (p: string) => p.replace(/\/+$/, '');
	const mine = intentPaths.map(norm);
	let heat = 0;
	for (const o of others) {
		const theirs = o.paths.map(norm);
		const overlap = mine.some((m) => theirs.some((t) => m === t || m.startsWith(t + '/') || t.startsWith(m + '/')));
		if (overlap) heat++;
	}
	return heat;
}

export function parsePaths(raw: string): string[] {
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}
