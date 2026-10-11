// linklet — a tiny in-memory URL shortener.
//
// Demo task for Verdict: add expiring links (TTL).
// Requirements:
//   - shorten(store, url, { ttlMs }) — ttlMs optional, milliseconds until expiry.
//   - resolve(store, code) — returns the URL, or null when unknown OR expired.
//   - ttlMs = 0 means already expired. Negative ttlMs throws.
//   - Links without a TTL never expire (backwards compatible).

export function createStore() {
	return { links: new Map(), counter: 0 };
}

export function isValidUrl(url) {
	try {
		const u = new URL(url);
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
}

export function shorten(store, url) {
	if (!isValidUrl(url)) throw new Error('invalid url');
	const code = (++store.counter).toString(36);
	store.links.set(code, { url, createdAt: Date.now() });
	return code;
}

export function resolve(store, code) {
	const entry = store.links.get(code);
	return entry ? entry.url : null;
}
