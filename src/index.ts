export type Environment = "development" | "staging" | "production";
export type ConfigValue = string | number;
export type Flags = Record<string, boolean>;
export type Config = Record<string, ConfigValue>;

export interface KonfigoOptions {
  /** API key (`kfg_...`). Each key is bound to one project and environment. */
  apiKey: string;
  /** Base URL of your Konfigo host, e.g. `https://konfigo.example.com`. */
  baseUrl: string;
  /** Request timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Only load flags (for keys created as "Flags only"); `config` stays empty. */
  flagsOnly?: boolean;
  /** Custom fetch implementation (defaults to global `fetch`). */
  fetch?: typeof fetch;
}

export interface Snapshot {
  env: Environment;
  flags: Flags;
  config: Config;
}

const ENVIRONMENTS: readonly string[] = ["development", "staging", "production"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Rejects plain-http hosts (the API key would travel in clear text), except loopback for local development. */
function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Konfigo: `baseUrl` is not a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error("Konfigo: `baseUrl` must use https:// (http:// is only allowed for localhost)");
  }
  return raw.replace(/\/+$/, "");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Copies a server map into a prototype-less object, keeping only values of the expected type. */
function sanitize<T>(what: string, v: unknown, ok: (x: unknown) => x is T): Record<string, T> {
  if (!isRecord(v)) throw new KonfigoError(`Unexpected response: \`${what}\` is not an object`);
  const out = Object.create(null) as Record<string, T>;
  for (const [k, x] of Object.entries(v)) {
    if (!ok(x)) throw new KonfigoError(`Unexpected response: \`${what}.${k}\` has an invalid type`);
    out[k] = x;
  }
  return out;
}

const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const isValue = (x: unknown): x is ConfigValue => typeof x === "string" || (typeof x === "number" && Number.isFinite(x));

function parseEnv(v: unknown): Environment {
  if (typeof v !== "string" || !ENVIRONMENTS.includes(v)) throw new KonfigoError("Unexpected response: invalid `env`");
  return v as Environment;
}

export class KonfigoError extends Error {
  constructor(
    message: string,
    /** HTTP status, or undefined for network errors and timeouts. */
    readonly status?: number,
    /** Seconds to wait before retrying (set on 429). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "KonfigoError";
  }
}

export class Konfigo {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly flagsOnly: boolean;
  private readonly fetchImpl: typeof fetch;
  private snapshot: Snapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: Snapshot) => void>();

  constructor(options: KonfigoOptions) {
    if (!options.apiKey) throw new Error("Konfigo: `apiKey` is required");
    if (!options.baseUrl) throw new Error("Konfigo: `baseUrl` is required");
    this.apiKey = options.apiKey;
    this.baseUrl = checkBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.flagsOnly = options.flagsOnly ?? false;
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new Error("Konfigo: no global `fetch` found; pass `options.fetch`");
    this.fetchImpl = f.bind(globalThis);
  }

  /** Fetches all flags for this key's environment (no caching). */
  async fetchFlags(): Promise<Flags> {
    return sanitize("flags", (await this.request<{ flags: unknown }>("/api/v1/flags")).flags, isBool);
  }

  /** Fetches all config values for this key's environment (no caching). */
  async fetchConfig(): Promise<Config> {
    return sanitize("config", (await this.request<{ config: unknown }>("/api/v1/config")).config, isValue);
  }

  /** Loads flags and config into the local cache. Throws on failure; the previous snapshot is kept. */
  async refresh(): Promise<Snapshot> {
    const [f, c] = await Promise.all([
      this.request<{ env: unknown; flags: unknown }>("/api/v1/flags"),
      this.flagsOnly ? null : this.request<{ env: unknown; config: unknown }>("/api/v1/config"),
    ]);
    // Validate everything before touching the cache so a bad response can't leave a half-updated snapshot.
    this.snapshot = {
      env: parseEnv(f.env),
      flags: sanitize("flags", f.flags, isBool),
      config: c ? sanitize("config", c.config, isValue) : (Object.create(null) as Config),
    };
    for (const l of this.listeners) l(this.snapshot);
    return this.snapshot;
  }

  /**
   * Loads the initial snapshot and refreshes it every `intervalMs` (default 30s).
   * Background refresh errors are swallowed and the last good snapshot stays in use;
   * pass `onError` to observe them. The timer does not keep the Node process alive.
   */
  async start(opts: { intervalMs?: number; onError?: (e: unknown) => void } = {}): Promise<void> {
    this.stop();
    await this.refresh();
    const timer = setInterval(() => this.refresh().catch((e) => opts.onError?.(e)), opts.intervalMs ?? 30_000);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  /** Stops background refreshing. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Calls `fn` after every successful refresh. Returns an unsubscribe function. */
  onChange(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Last loaded snapshot, or null before the first `refresh()`/`start()`. */
  get current(): Snapshot | null {
    return this.snapshot;
  }

  /** Whether a flag is on in the cached snapshot. Unknown flags return `fallback` (default false). */
  isEnabled(key: string, fallback = false): boolean {
    return this.snapshot?.flags[key] ?? fallback;
  }

  /** Cached config value, or `fallback` when missing. */
  get<T extends ConfigValue = ConfigValue>(key: string, fallback: T): T;
  get<T extends ConfigValue = ConfigValue>(key: string): T | undefined;
  get(key: string, fallback?: ConfigValue): ConfigValue | undefined {
    return this.snapshot?.config[key] ?? fallback;
  }

  private async request<T>(path: string): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new KonfigoError(ctrl.signal.aborted ? `Request timed out after ${this.timeoutMs}ms` : `Network error: ${(e as Error).message}`);
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const retry = Number(res.headers.get("retry-after"));
      throw new KonfigoError(body?.error ?? `HTTP ${res.status}`, res.status, retry > 0 ? retry : undefined);
    }
    const body: unknown = await res.json().catch(() => {
      throw new KonfigoError("Unexpected response: body is not valid JSON", res.status);
    });
    if (!isRecord(body)) throw new KonfigoError("Unexpected response: body is not an object", res.status);
    return body as T;
  }
}
