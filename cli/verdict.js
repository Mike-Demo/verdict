#!/usr/bin/env node
// verdict CLI — minimal REST client for the Verdict Worker API. Node 18+, zero dependencies.
//
//   verdict intent --title "Add TTL" --paths src/store.js --agent atlas [--description "..."]
//   verdict cards
//   verdict ledger
//
// Env: VERDICT_API (default https://verdict.hey-demo-827.workers.dev)

const BASE = process.env.VERDICT_API || 'https://verdict.hey-demo-827.workers.dev';

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const k = a.slice(2);
			const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
			out[k] = v;
		} else {
			out._.push(a);
		}
	}
	return out;
}

async function api(path, opts = {}) {
	const res = await fetch(BASE + path, { headers: { 'content-type': 'application/json' }, ...opts });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		console.error(`error: HTTP ${res.status} — ${data.error || data.reason || JSON.stringify(data)}`);
		process.exit(1);
	}
	return data;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0];

	if (cmd === 'intent') {
		const { title, description, paths, agent } = args;
		if (!title || !paths || !agent) {
			console.error('usage: verdict intent --title T --paths a,b --agent NAME [--description D]');
			process.exit(1);
		}
		const r = await api('/api/intents', {
			method: 'POST',
			body: JSON.stringify({
				title,
				description: description === 'true' ? '' : description || '',
				paths: String(paths).split(',').map((s) => s.trim()).filter(Boolean),
				agent,
			}),
		});
		console.log(JSON.stringify(r, null, 2));
	} else if (cmd === 'cards') {
		const cards = await api('/api/cards');
		if (!cards.length) {
			console.log('No decision cards.');
			return;
		}
		for (const c of cards) {
			const ev = c.evaluation;
			const gates = ev ? (ev.pass ? 'PASS' : 'FAIL') : 'pending';
			const cost = ev && ev.cost_usd != null ? ` — $${Number(ev.cost_usd).toFixed(4)}${ev.cost_estimated ? ' (est)' : ''}` : '';
			const scope = ev && ev.checks && ev.checks.scope_creep ? ' — ⚠ scope expanded' : '';
			const tests = ev && ev.checks && ev.checks.touched_tests ? ' — ⚠ test paths touched' : '';
			console.log(`${c.intent.id} [${c.intent.status}] ${c.intent.title} — gates: ${gates}${cost}${scope}${tests}`);
		}
	} else if (cmd === 'ledger') {
		const rows = await api('/api/ledger');
		for (const r of rows.slice(-25)) {
			console.log(`#${r.seq} ${r.kind} ${r.ref_id || ''}`);
		}
	} else {
		console.error('usage: verdict <intent|cards|ledger> [options]');
		process.exit(1);
	}
}

main().catch((e) => {
	console.error('error:', e.message || e);
	process.exit(1);
});
