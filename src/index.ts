import { WorkflowEntrypoint } from 'cloudflare:workers';
import { Sandbox } from '@cloudflare/sandbox';
import { Env } from './db';
import { handleApi } from './api';
import { runEvaluation } from './evaluate';
import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(req.url);
		// because the Sandbox binding only initializes in fetch context.
		if (url.pathname === '/api/internal/eval' && req.method === 'POST') {
			if (req.headers.get('x-verdict-secret') !== env.INTERNAL_SECRET) {
				return Response.json({ error: 'forbidden' }, 403);
			}
			const params = (await req.json()) as any;
			if (new URL(req.url).searchParams.get('noop') === '1') {
				return Response.json({ ok: true, noop: true, params });
			}
			// Dedup: skip if an evaluation already exists for this candidate+commit (V4 fix)
			// (prevents double-eval from waitUntil + queue consumer both firing).
			if (params.candidate_id && params.commit) {
				const existing: any = await env.DB.prepare(
					`SELECT id FROM evaluations WHERE candidate_id = ? AND commit_sha = ? LIMIT 1`
				).bind(params.candidate_id, params.commit).first();
				if (existing) {
					return Response.json({ ok: true, deduped: true, evaluation_id: existing.id });
				}
			}
			try {
				const result = await runEvaluation(env, params);
				return Response.json({ ok: true, result });
			} catch (e: any) {
				return Response.json({ ok: false, error: String(e?.message ?? e).slice(0, 500) }, 500);
			}
		}
		if (url.pathname.startsWith('/api/')) {
			return handleApi(req, env, url, ctx);
		}
		// UI is served as static assets; fall through to assets binding in production.
		// In the prototype the single index.html is inlined via [site] — see wrangler.toml.
		return new Response('Verdict — intent-led decision forge. UI at /.', {
			headers: { 'content-type': 'text/plain' },
		});
	},

	async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
		for (const msg of batch.messages) {
			try {
				// Self-fetch: the Sandbox binding only initializes in fetch
				// context, so the consumer delegates the heavy eval to an
				// internal HTTP endpoint instead of running it inline.
				// Copilot audit fix: use env.WORKER_URL instead of hardcoded URL
				const workerUrl = (env as any).WORKER_URL || 'https://verdict.hey-demo-827.workers.dev';
				const res = await fetch(`${workerUrl}/api/internal/eval`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-verdict-secret': env.INTERNAL_SECRET },
					body: JSON.stringify(msg.body),
				});
				if (res.ok) msg.ack();
				else msg.retry();
			} catch (e) {
				msg.retry();
			}
		}
	},
};
