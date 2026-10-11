import { describe, it, expect } from 'vitest';
import { createStore, shorten, resolve, isValidUrl } from '../src/store.js';

describe('linklet', () => {
	it('shortens and resolves a URL', () => {
		const store = createStore();
		const code = shorten(store, 'https://example.com/a-long-path');
		expect(typeof code).toBe('string');
		expect(resolve(store, code)).toBe('https://example.com/a-long-path');
	});

	it('generates unique codes', () => {
		const store = createStore();
		const a = shorten(store, 'https://example.com/1');
		const b = shorten(store, 'https://example.com/2');
		expect(a).not.toBe(b);
	});

	it('rejects invalid URLs', () => {
		const store = createStore();
		expect(() => shorten(store, 'not a url')).toThrow('invalid url');
		expect(() => shorten(store, 'ftp://example.com/x')).toThrow('invalid url');
	});

	it('returns null for unknown codes', () => {
		const store = createStore();
		expect(resolve(store, 'nope')).toBeNull();
	});

	it('validates protocols', () => {
		expect(isValidUrl('https://example.com')).toBe(true);
		expect(isValidUrl('http://example.com')).toBe(true);
		expect(isValidUrl('javascript:alert(1)')).toBe(false);
	});
});
