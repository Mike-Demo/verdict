// Advisory judge agent powered by Cloudflare Clef (Workers AI decision model).
//
// The judge is ADVISORY ONLY — it never gates. Deterministic tests decide
// pass/fail; the judge writes structured quality assessments onto the
// decision card to help the human choose between passing candidates.
//
// Clef returns probabilities per option (no free-form text to parse).

import { Env } from './db';

export interface JudgeResult {
	quality: { option: string; probability: number }[];
	edge_cases: { option: string; probability: number }[];
	idiomatic: { option: string; probability: number }[];
	summary: string;
}

/**
 * Run the Clef judge on a candidate's implementation.
 * @param code The candidate's changed source code
 * @param taskDescription What the task was
 */
export async function judgeCandidate(
	env: Env,
	code: string,
	taskDescription: string,
): Promise<JudgeResult | null> {
	try {
		// Clef takes a state description + typed questions, returns probabilities.
		// Using clef-flash for speed (38ms median) and cost ($0.038/million tokens).
		// NOTE: the `model` field must match the model ID.
		const response: any = await env.AI.run('@cf/cloudflare/clef-flash', {
			model: 'clef-flash',
			state: `Task: ${taskDescription}\n\nCandidate implementation:\n\`\`\`js\n${code.slice(0, 6000)}\n\`\`\``,
			questions: {
				quality: {
					type: 'choice',
					instructions: 'How clean and maintainable is this implementation?',
					criteria: {
						excellent: 'Clean, well-structured, easy to understand and modify',
						good: 'Solid implementation with minor issues',
						adequate: 'Works but has notable code quality issues',
						poor: 'Hard to read, poorly structured, or hacky',
					},
				},
				edge_cases: {
					type: 'choice',
					instructions: 'How well does this handle edge cases?',
					criteria: {
						thoroughly: 'All edge cases handled correctly',
						partially: 'Some edge cases handled, others missed',
						poorly: 'Edge cases largely ignored',
					},
				},
				idiomatic: {
					type: 'choice',
					instructions: 'Is this approach idiomatic and appropriate?',
					criteria: {
						yes: 'Follows best practices, fits the codebase well',
						mostly: 'Generally good with minor deviations',
						no: 'Unidiomatic or inappropriate approach',
					},
				},
			},
		});

		// Clef returns { answers: { quality: { choice, confidence, probabilities }, ... } }
		const answers = response.answers ?? {};
		const getOpts = (id: string) => {
			const a = answers[id];
			if (!a) return [];
			// probabilities is { option: prob } or array
			if (Array.isArray(a.probabilities)) return a.probabilities;
			if (a.probabilities && typeof a.probabilities === 'object') {
				return Object.entries(a.probabilities).map(([option, probability]) => ({
					option,
					probability: probability as number,
				}));
			}
			// Fallback: just the top choice
			return a.choice ? [{ option: a.choice, probability: a.confidence ?? 1 }] : [];
		};

		const quality = getOpts('quality');
		const edge_cases = getOpts('edge_cases');
		const idiomatic = getOpts('idiomatic');

		if (!quality.length && !edge_cases.length && !idiomatic.length) {
			console.error('Judge: no usable answers in Clef response');
			return null;
		}

		// Build a human-readable summary from the top options
		const top = (opts: any[]) => opts.sort((a, b) => b.probability - a.probability)[0];
		const q = top(quality);
		const e = top(edge_cases);
		const i = top(idiomatic);
		const parts = [];
		if (q) parts.push(`Quality: ${q.option} (${Math.round(q.probability * 100)}%)`);
		if (e) parts.push(`Edge cases: ${e.option} (${Math.round(e.probability * 100)}%)`);
		if (i) parts.push(`Idiomatic: ${i.option} (${Math.round(i.probability * 100)}%)`);
		const summary = parts.join(', ') || 'Judge completed';

		return { quality, edge_cases, idiomatic, summary };
	} catch (err: any) {
		// Judge failure is non-fatal — the deterministic eval already passed.
		console.error('Judge failed:', err?.message ?? err);
		return null;
	}
}
