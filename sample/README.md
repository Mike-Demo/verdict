# linklet

A tiny in-memory URL shortener library.

```js
import { createStore, shorten, resolve } from './src/store.js';

const store = createStore();
const code = shorten(store, 'https://example.com/a-long-path');
console.log(resolve(store, code)); // https://example.com/a-long-path
```

## Demo task

Add **expiring links (TTL)**:

- `shorten(store, url, { ttlMs })` — `ttlMs` optional, milliseconds until expiry.
- `resolve(store, code)` — returns the URL, or `null` when unknown **or expired**.
- `ttlMs = 0` means already expired. Negative `ttlMs` throws.
- Links without a TTL never expire (backwards compatible).
