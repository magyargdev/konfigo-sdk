# konfigo-sdk

Official JavaScript/TypeScript SDK for Konfigo — feature flags and remote config.
Zero dependencies, works in Node 18+, Bun, Deno, edge runtimes and browsers (anything with `fetch`).

```bash
npm install konfigo-sdk
```

## Usage

```ts
import { Konfigo } from "konfigo-sdk";

const konfigo = new Konfigo({
  apiKey: process.env.KONFIGO_API_KEY!, // kfg_... (bound to one project + environment)
  baseUrl: "https://your-konfigo-host",
});

await konfigo.start(); // initial load + refresh every 30s

if (konfigo.isEnabled("new-checkout")) { /* ... */ }
const timeout = konfigo.get("api_timeout_ms", 3000);
```

Without background polling: `await konfigo.refresh()` when you want, or call `fetchFlags()` / `fetchConfig()` for uncached reads.

## API

| | |
|---|---|
| `new Konfigo({ apiKey, baseUrl, timeoutMs?, fetch? })` | Create a client |
| `start({ intervalMs?, onError? })` / `stop()` | Load and poll in the background |
| `refresh()` | Load flags + config into the cache |
| `isEnabled(key, fallback = false)` | Flag state from cache |
| `get(key, fallback?)` | Config value from cache (numbers stay numbers) |
| `onChange(fn)` | Subscribe to refreshes; returns unsubscribe |
| `fetchFlags()` / `fetchConfig()` | Uncached reads |
| `current` | Last snapshot `{ env, flags, config }` |

Failed background refreshes keep the last good values. Errors are `KonfigoError` with `status` and (on 429) `retryAfter` seconds.
The API allows 120 requests/min per key; the default polling uses 4.

Keys created as "Flags only" can be used in client-side code; pass `flagsOnly: true` so the SDK skips the config endpoint. `baseUrl` must be `https://` (plain `http://` is only accepted for `localhost`), and responses are type-checked before they reach your cache.

Don't ship a server API key to the browser — it grants read access to all values in that environment.
