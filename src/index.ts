import { Hono } from 'hono';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { Sandbox } from '@cloudflare/sandbox';
import { Env } from './db';
import { handleApi } from './api';
import { runEvaluation } from './evaluate';
import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

// Hono spike: Hono owns routing; the audited handleApi() logic is unchanged.
// Proves Hono boots in the Worker and all bindings (D1, Artifacts, AI,
// Sandbox) pass through Hono's context correctly.
const app = new Hono<{ Bindings: Env }>();

app.post('/api/internal/eval', async (c) => {
	const env = c.env;
	if (c.req.header('x-verdict-secret') !== env.INTERNAL_SECRET) {
		return c.json({ error: 'forbidden' }, 403);
	}
	const params = (await c.req.json().catch(() => ({}))) as any;
	if (new URL(c.req.url).searchParams.get('noop') === '1') {
		return c.json({ ok: true, noop: true, params });
	}
	// Dedup: skip if an evaluation already exists for this candidate+commit (V4 fix)
	if (params.candidate_id && params.commit) {
		const existing: any = await env.DB.prepare(
			`SELECT id FROM evaluations WHERE candidate_id = ? AND commit_sha = ? LIMIT 1`
		).bind(params.candidate_id, params.commit).first();
		if (existing) {
			return c.json({ ok: true, deduped: true, evaluation_id: existing.id });
		}
	}
	try {
		const result = await runEvaluation(env, params);
		return c.json({ ok: true, result });
	} catch (e: any) {
		return c.json({ ok: false, error: String(e?.message ?? e).slice(0, 500) }, 500);
	}
});

// Every other /api/* route delegates to the existing handler unchanged.
app.all('/api/*', (c) => handleApi(c.req.raw, c.env, new URL(c.req.url), c.executionCtx));

app.all('*', (c) =>
	c.text('Verdict (Hono spike) — API only. The UI lives on the main worker.', 200, {
		'content-type': 'text/plain',
	})
);

export default {
	fetch: app.fetch,

	async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
		for (const msg of batch.messages) {
			try {
				const workerUrl = (env as any).WORKER_URL || 'https://verdict-hono.hey-demo-827.workers.dev';
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
