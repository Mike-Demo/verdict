#!/usr/bin/env node
// Verdict MCP server (stdio) — minimal, zero dependencies.
// Exposes: declare_intent, list_cards, get_ledger → proxied to the Verdict Worker API.
// Configure: VERDICT_API (default https://verdict.hey-demo-827.workers.dev)
//            VERDICT_SECRET — the Worker's write secret. REQUIRED for
//            declare_intent: all API writes need the x-verdict-secret header
//            (post-submission hardening, review #2 M6 — without it, writes 401).
//            Reads (list_cards, get_ledger) work without it.

const BASE = process.env.VERDICT_API || 'https://verdict.hey-demo-827.workers.dev';
const SECRET = process.env.VERDICT_SECRET || '';

async function api(path, opts = {}) {
	const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
	if (opts.method === 'POST' && SECRET) headers['x-verdict-secret'] = SECRET;
	const res = await fetch(BASE + path, { ...opts, headers });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || data.reason || JSON.stringify(data)}`);
	return data;
}

const TOOLS = [
	{
		name: 'declare_intent',
		description: 'Declare a new agent intent on Verdict. Path-overlap heat is computed against active intents.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Short intent title' },
				description: { type: 'string', description: 'What the agent plans to do' },
				paths: { type: 'array', items: { type: 'string' }, description: 'Path prefixes the agent intends to touch' },
				agent: { type: 'string', description: 'Agent identifier' },
			},
			required: ['title', 'paths', 'agent'],
		},
	},
	{
		name: 'list_cards',
		description: 'List decision cards — one per intent with an evaluated candidate, including gates, judge scores, cost, and scope flags.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'get_ledger',
		description: 'Read the append-only decision ledger (intents, forks, submissions, evaluations, decisions, promotions, undos).',
		inputSchema: { type: 'object', properties: {} },
	},
];

async function callTool(name, args) {
	if (name === 'declare_intent') {
		const r = await api('/api/intents', { method: 'POST', body: JSON.stringify(args) });
		return [{ type: 'text', text: JSON.stringify(r, null, 2) }];
	}
	if (name === 'list_cards') {
		const r = await api('/api/cards');
		return [{ type: 'text', text: JSON.stringify(r, null, 2) }];
	}
	if (name === 'get_ledger') {
		const r = await api('/api/ledger');
		return [{ type: 'text', text: JSON.stringify(r, null, 2) }];
	}
	throw new Error(`unknown tool: ${name}`);
}

// --- minimal JSON-RPC 2.0 over stdio (newline-delimited) ---
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
	buf += chunk;
	let idx;
	while ((idx = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, idx).trim();
		buf = buf.slice(idx + 1);
		if (!line) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		await handle(msg);
	}
});

async function handle(msg) {
	const { id, method, params } = msg || {};
	const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
	const fail = (code, message) =>
		process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
	try {
		if (method === 'initialize') {
			reply({
				protocolVersion: '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'verdict', version: '0.1.0' },
			});
		} else if (method === 'tools/list') {
			reply({ tools: TOOLS });
		} else if (method === 'tools/call') {
			const content = await callTool(params.name, params.arguments || {});
			reply({ content });
		} else if (method === 'notifications/initialized') {
			// notifications get no reply
		} else {
			fail(-32601, `method not found: ${method}`);
		}
	} catch (e) {
		fail(-32603, String((e && e.message) || e));
	}
}
