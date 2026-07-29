// The harvest engine: take one APIs.json, walk everything it points at, and
// collect every tag applied anywhere along the way.
//
// The walk has three tiers:
//   1. the root APIs.json          — collection tags, per-API tags, property tags
//   2. each provider's APIs.json   — the same three, one level down
//   3. each OpenAPI / AsyncAPI     — document tags, operation tags, channel/message tags
//
// Everything here is pure data + fetch; no DOM. Nothing in this file is allowed
// to throw out of a walk — a bad file is a logged failure, never a dead run.

import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where in the stack a tag was found. Ordered outermost → innermost. */
export type Level =
  | 'collection' // tags: on the root APIs.json
  | 'provider' // tags: on a provider's own APIs.json
  | 'api' // apis[].tags
  | 'property' // apis[].properties[].tags
  | 'document' // tags: on an OpenAPI / AsyncAPI document
  | 'operation' // an OpenAPI operation's tags
  | 'channel' // an AsyncAPI channel's tags
  | 'message'; // an AsyncAPI message's tags

export const LEVELS: Level[] = [
  'collection',
  'provider',
  'api',
  'property',
  'document',
  'operation',
  'channel',
  'message',
];

export const LEVEL_LABEL: Record<Level, string> = {
  collection: 'Collection',
  provider: 'Provider',
  api: 'API',
  property: 'Property',
  document: 'Document',
  operation: 'Operation',
  channel: 'Channel',
  message: 'Message',
};

/** One place a tag was applied. */
export interface Hit {
  level: Level;
  providerAid: string;
  providerName: string;
  apiName?: string;
  /** Human label for the artifact the tag sits on (spec title, file name…). */
  artifact?: string;
  artifactType?: string;
  /** e.g. "GET /v1/services" or "subscribe user/signedup". */
  detail?: string;
  /** Something to click through to. */
  href?: string;
}

export interface TagRecord {
  /** Case-folded identity. */
  key: string;
  /** Most common raw spelling, used for display. */
  label: string;
  /** Every raw spelling seen, for the "same tag, different case" case. */
  spellings: Map<string, number>;
  total: number;
  byLevel: Record<Level, number>;
  providers: Map<string, { name: string; count: number }>;
  hits: Hit[];
}

export interface ProviderRecord {
  aid: string;
  name: string;
  description?: string;
  image?: string;
  category?: string;
  humanURL?: string;
  apisJsonUrl?: string;
  /** True for the collection itself, which carries collection-level tags but is
      not a provider — it must not be counted or plotted as one. */
  isCollection?: boolean;
  /** Distinct tag keys seen anywhere under this provider. */
  tagKeys: Set<string>;
  apiCount: number;
  specsSeen: number;
  specsSkipped: number;
  failures: number;
}

export type LogStatus = 'running' | 'ok' | 'warn' | 'fail' | 'skip';
export type LogKind = 'catalog' | 'provider' | 'spec';

export interface LogRow {
  id: number;
  kind: LogKind;
  label: string;
  url?: string;
  status: LogStatus;
  /** Why it warned/failed/skipped, or what it found. */
  note?: string;
  tags?: number;
  ms?: number;
}

export interface Progress {
  phase: 'idle' | 'catalog' | 'providers' | 'specs' | 'done' | 'stopped';
  done: number;
  /** Nested provider APIs.json to fetch. Zero for a self-contained file. */
  providers: number;
  providersDone: number;
  /** Providers actually seen in the data — the honest headline count. */
  providersSeen: number;
  specs: number;
  specsDone: number;
  tagKeys: number;
  tagHits: number;
  failures: number;
  skipped: number;
}

export interface RunOptions {
  /** `index` stops at the provider APIs.json; `specs` opens every definition. */
  depth: 'index' | 'specs';
  /** Cap on specs opened per provider. 0 = no cap. */
  specsPerProvider: number;
  /** Cap on specs opened across the whole run. 0 = no cap. */
  maxSpecs: number;
  concurrency: number;
  timeoutMs: number;
}

export const DEFAULT_OPTIONS: RunOptions = {
  depth: 'specs',
  specsPerProvider: 12,
  maxSpecs: 400,
  concurrency: 6,
  timeoutMs: 15000,
};

export interface Handlers {
  onLog: (row: LogRow) => void;
  onProgress: (p: Progress) => void;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** github.com/o/r/blob/ref/path → raw.githubusercontent.com/o/r/ref/path. */
export function normalizeUrl(raw: string): string {
  const u = raw.trim();
  const m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  return u;
}

/** Resolve a possibly-relative property URL against the document that carried it. */
export function resolveUrl(url: string, base?: string): string | undefined {
  if (!url) return undefined;
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return normalizeUrl(u);
  if (!base) return undefined;
  try {
    return new URL(u, base).href;
  } catch {
    return undefined;
  }
}

/** YAML is a superset of JSON, so one parser handles both — but say which failed. */
export function parseDoc(text: string): any {
  const t = text.trim();
  if (!t) throw new Error('empty file');
  if (t.startsWith('<')) throw new Error('got HTML, not YAML/JSON');
  return t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : parseYaml(t);
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Tag values show up as strings, as {name}, and occasionally as junk. */
function tagNames(value: any): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const t of list) {
    const name = typeof t === 'string' ? t : t && typeof t === 'object' ? t.name || t.tag || t.title : null;
    if (typeof name === 'string' && name.trim()) out.push(name.trim());
  }
  return out;
}

const isObj = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const SPEC_TYPES = new Set(['openapi', 'swagger', 'asyncapi']);

/** Property types (and filenames) that mean "another APIs.json lives here". */
function isApisJsonPointer(type: string | undefined, url: string | undefined): boolean {
  const t = (type || '').replace(/^x-/i, '').replace(/[^a-z]/gi, '').toLowerCase();
  if (t === 'apisjson') return true;
  if (!url) return false;
  return /\/apis\.(ya?ml|json)(\?|#|$)/i.test(url);
}

// ---------------------------------------------------------------------------
// The tag index
// ---------------------------------------------------------------------------

/** Hits are what make the drawer useful, but an unbounded list eats memory. */
const MAX_HITS_PER_TAG = 400;

export class TagIndex {
  tags = new Map<string, TagRecord>();
  providers = new Map<string, ProviderRecord>();
  hitCount = 0;

  provider(aid: string, name: string): ProviderRecord {
    let p = this.providers.get(aid);
    if (!p) {
      p = { aid, name, tagKeys: new Set(), apiCount: 0, specsSeen: 0, specsSkipped: 0, failures: 0 };
      this.providers.set(aid, p);
    }
    if (name && p.name !== name) p.name = name;
    return p;
  }

  add(rawTag: string, hit: Hit): void {
    const key = norm(rawTag);
    if (!key) return;
    let rec = this.tags.get(key);
    if (!rec) {
      rec = {
        key,
        label: rawTag.trim(),
        spellings: new Map(),
        total: 0,
        byLevel: Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>,
        providers: new Map(),
        hits: [],
      };
      this.tags.set(key, rec);
    }
    rec.total++;
    rec.byLevel[hit.level]++;
    this.hitCount++;

    const spelling = rawTag.trim();
    const n = (rec.spellings.get(spelling) || 0) + 1;
    rec.spellings.set(spelling, n);
    // Display the spelling we have seen most often.
    if (n > (rec.spellings.get(rec.label) || 0)) rec.label = spelling;

    const prov = rec.providers.get(hit.providerAid);
    if (prov) prov.count++;
    else rec.providers.set(hit.providerAid, { name: hit.providerName, count: 1 });

    if (rec.hits.length < MAX_HITS_PER_TAG) rec.hits.push(hit);

    this.provider(hit.providerAid, hit.providerName).tagKeys.add(key);
  }

  /** Real providers only — the collection pseudo-entry is excluded. */
  providerCount(): number {
    let n = 0;
    for (const p of this.providers.values()) if (!p.isCollection) n++;
    return n;
  }

  /** Tags sorted by how many times they were applied, then alphabetically. */
  ranked(): TagRecord[] {
    return [...this.tags.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  }

  providerList(): ProviderRecord[] {
    return [...this.providers.values()]
      .filter((p) => !p.isCollection)
      .sort((a, b) => b.tagKeys.size - a.tagKeys.size || a.name.localeCompare(b.name));
  }
}

// ---------------------------------------------------------------------------
// Fetching — bounded concurrency, hard timeout, one retry, shared cache
// ---------------------------------------------------------------------------

export class Fetcher {
  private cache = new Map<string, Promise<string>>();
  private active = 0;
  private queue: (() => void)[] = [];
  aborted = false;

  constructor(private concurrency: number, private timeoutMs: number) {}

  abort(): void {
    this.aborted = true;
    // Release anything parked so the run can unwind.
    const q = this.queue.splice(0);
    for (const release of q) release();
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  text(url: string): Promise<string> {
    const hit = this.cache.get(url);
    if (hit) return hit;
    const p = this.slot(() => this.once(url).catch((e) => this.retryable(e, url)));
    this.cache.set(url, p);
    // A rejected cache entry is still a valid answer ("this URL is broken"), but
    // an unobserved rejection is a console error — keep one handler on it.
    p.catch(() => {});
    return p;
  }

  private retryable(err: any, url: string): Promise<string> {
    // Retry once, and only on the failures that are actually transient. A 404 is
    // an answer; a dropped connection is not.
    const msg = String(err?.message || err);
    if (this.aborted || /HTTP (4\d\d)/.test(msg)) throw err;
    return this.once(url);
  }

  private async once(url: string): Promise<string> {
    if (this.aborted) throw new Error('stopped');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      return await res.text();
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error(this.aborted ? 'stopped' : `timed out after ${this.timeoutMs / 1000}s`);
      // A cross-origin block surfaces as an opaque TypeError; say so plainly.
      if (e instanceof TypeError) throw new Error('network or CORS blocked');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Tag extraction, per document kind
// ---------------------------------------------------------------------------

interface SpecTarget {
  url?: string;
  /** platform.apicommons.org inlines merged specs under `data` — no fetch needed. */
  data?: any;
  type: string;
  name: string;
  apiName?: string;
  providerAid: string;
  providerName: string;
}

/**
 * Harvest an APIs.json document. Returns the pointers found in it — nested
 * APIs.json to follow, and specs to open — so the caller decides how deep to go.
 */
function harvestApisJson(
  doc: any,
  ctx: { level: 'collection' | 'provider'; providerAid: string; providerName: string; baseUrl?: string },
  index: TagIndex,
): { includes: { name: string; url: string; aid?: string; meta?: any }[]; specs: SpecTarget[] } {
  const includes: { name: string; url: string; aid?: string; meta?: any }[] = [];
  const specs: SpecTarget[] = [];
  if (!isObj(doc)) return { includes, specs };

  const collectionName = doc.name || ctx.providerName;
  if (ctx.level === 'collection') index.provider(ctx.providerAid, ctx.providerName).isCollection = true;

  // --- tags on the document itself
  for (const t of tagNames(doc.tags)) {
    index.add(t, {
      level: ctx.level,
      providerAid: ctx.providerAid,
      providerName: ctx.providerName,
      artifact: collectionName,
      artifactType: 'APIs.json',
      href: doc.url || ctx.baseUrl,
    });
  }

  // --- top-level include[] / network[] both mean "another APIs.json"
  for (const key of ['include', 'network'] as const) {
    for (const inc of Array.isArray(doc[key]) ? doc[key] : []) {
      const url = resolveUrl(inc?.url, ctx.baseUrl);
      // An `include` pointing at a docs site rather than an APIs.json is common
      // in the wild; only follow it when it actually looks like one.
      if (url && isApisJsonPointer(undefined, url)) {
        includes.push({ name: inc.name || url, url, meta: inc });
      }
    }
  }

  // --- shared property buckets (0.21: common / prompts / rules / workflows)
  for (const bucket of ['common', 'prompts', 'rules', 'workflows'] as const) {
    for (const prop of Array.isArray(doc[bucket]) ? doc[bucket] : []) {
      for (const t of tagNames(prop?.tags)) {
        index.add(t, {
          level: 'property',
          providerAid: ctx.providerAid,
          providerName: ctx.providerName,
          artifact: prop.name || prop.type,
          artifactType: prop.type,
          href: resolveUrl(prop.url, ctx.baseUrl),
        });
      }
    }
  }

  // --- each API in the collection
  for (const api of Array.isArray(doc.apis) ? doc.apis : []) {
    if (!isObj(api)) continue;
    const apiName = api.name || api.aid || api.slug || 'Unnamed API';
    // At collection level each `apis[]` entry IS a provider; one level down it is
    // an actual API belonging to the provider we are already inside.
    const isProviderEntry = ctx.level === 'collection';
    const aid = isProviderEntry ? api.aid || api.slug || norm(apiName) : ctx.providerAid;
    const pname = isProviderEntry ? apiName : ctx.providerName;

    if (isProviderEntry) {
      const p = index.provider(aid, pname);
      p.description = api.description;
      p.image = api.image;
      p.humanURL = api.humanURL;
      p.category = api['x-category'] || api['x-group'];
    } else {
      index.provider(aid, pname).apiCount++;
    }

    for (const t of tagNames(api.tags)) {
      index.add(t, {
        level: isProviderEntry ? 'provider' : 'api',
        providerAid: aid,
        providerName: pname,
        apiName: isProviderEntry ? undefined : apiName,
        artifact: apiName,
        artifactType: 'APIs.json',
        href: api.humanURL || api.baseURL,
      });
    }

    // --- properties: tags, nested APIs.json pointers, and specs to open
    const buckets = [api.properties, api.prompts, api.rules, api.workflows, api.overlays];
    for (const bucket of buckets) {
      for (const prop of Array.isArray(bucket) ? bucket : []) {
        if (!isObj(prop)) continue;
        const url = resolveUrl(prop.url, ctx.baseUrl);
        const type = String(prop.type || '');

        for (const t of tagNames(prop.tags)) {
          index.add(t, {
            level: 'property',
            providerAid: aid,
            providerName: pname,
            apiName: isProviderEntry ? undefined : apiName,
            artifact: prop.name || type,
            artifactType: type,
            href: url,
          });
        }

        if (isApisJsonPointer(type, url) && url) {
          includes.push({ name: apiName, url, aid, meta: api });
          continue;
        }

        const t = type.replace(/^x-/i, '').toLowerCase();
        if (SPEC_TYPES.has(t) && (url || prop.data)) {
          specs.push({
            url,
            data: prop.data,
            type: type || 'OpenAPI',
            name: prop.name || url?.split('/').pop() || `${apiName} (inline)`,
            apiName,
            providerAid: aid,
            providerName: pname,
          });
        }
      }
    }
  }

  return { includes, specs };
}

/** OpenAPI 2/3.x: document tags, operation tags, and 3.1 webhooks. */
function harvestOpenApi(doc: any, t: SpecTarget, index: TagIndex): number {
  let found = 0;
  const title = doc?.info?.title || t.name;
  const base = {
    providerAid: t.providerAid,
    providerName: t.providerName,
    apiName: t.apiName,
    artifact: title,
    artifactType: t.type,
    href: t.url,
  };

  for (const name of tagNames(doc?.tags)) {
    index.add(name, { ...base, level: 'document' });
    found++;
  }

  const walkPaths = (paths: any, prefix = '') => {
    if (!isObj(paths)) return;
    for (const p of Object.keys(paths)) {
      const item = paths[p];
      if (!isObj(item)) continue;
      for (const m of HTTP_METHODS) {
        const op = item[m];
        if (!isObj(op)) continue;
        for (const name of tagNames(op.tags)) {
          index.add(name, { ...base, level: 'operation', detail: `${m.toUpperCase()} ${prefix}${p}` });
          found++;
        }
      }
    }
  };
  walkPaths(doc?.paths);
  walkPaths(doc?.webhooks, 'webhook: ');
  return found;
}

/** AsyncAPI 2.x and 3.x: document, channel, operation, and message tags. */
function harvestAsyncApi(doc: any, t: SpecTarget, index: TagIndex): number {
  let found = 0;
  const title = doc?.info?.title || t.name;
  const base = {
    providerAid: t.providerAid,
    providerName: t.providerName,
    apiName: t.apiName,
    artifact: title,
    artifactType: t.type,
    href: t.url,
  };

  for (const name of tagNames(doc?.tags ?? doc?.info?.tags)) {
    index.add(name, { ...base, level: 'document' });
    found++;
  }

  const addMessage = (msg: any, where: string) => {
    if (!isObj(msg)) return;
    for (const name of tagNames(msg.tags)) {
      index.add(name, { ...base, level: 'message', detail: where });
      found++;
    }
  };

  const channels = isObj(doc?.channels) ? doc.channels : {};
  for (const addr of Object.keys(channels)) {
    const ch = channels[addr];
    if (!isObj(ch)) continue;
    const label = ch.address || addr;
    for (const name of tagNames(ch.tags)) {
      index.add(name, { ...base, level: 'channel', detail: label });
      found++;
    }
    // 2.x: operations hang off the channel. 3.x: messages do.
    for (const verb of ['subscribe', 'publish'] as const) {
      const op = ch[verb];
      if (!isObj(op)) continue;
      for (const name of tagNames(op.tags)) {
        index.add(name, { ...base, level: 'operation', detail: `${verb} ${label}` });
        found++;
      }
      addMessage(op.message, `${verb} ${label}`);
      for (const m of Array.isArray(op.message?.oneOf) ? op.message.oneOf : []) addMessage(m, `${verb} ${label}`);
    }
    for (const key of Object.keys(isObj(ch.messages) ? ch.messages : {})) addMessage(ch.messages[key], label);
  }

  // 3.x: a top-level operations map.
  const operations = isObj(doc?.operations) ? doc.operations : {};
  for (const key of Object.keys(operations)) {
    const op = operations[key];
    if (!isObj(op)) continue;
    for (const name of tagNames(op.tags)) {
      index.add(name, { ...base, level: 'operation', detail: `${op.action || 'operation'} ${key}` });
      found++;
    }
  }

  for (const key of Object.keys(isObj(doc?.components?.messages) ? doc.components.messages : {})) {
    addMessage(doc.components.messages[key], key);
  }
  return found;
}

function looksLikeOpenApi(doc: any): boolean {
  return isObj(doc) && (!!doc.openapi || !!doc.swagger || isObj(doc.paths) || isObj(doc.webhooks));
}
function looksLikeAsyncApi(doc: any): boolean {
  return isObj(doc) && (!!doc.asyncapi || isObj(doc.channels) || isObj(doc.operations));
}
function looksLikeApisJson(doc: any): boolean {
  return isObj(doc) && (Array.isArray(doc.apis) || Array.isArray(doc.include) || !!doc.specificationVersion);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunResult {
  index: TagIndex;
  progress: Progress;
  rootName: string;
  rootDescription?: string;
  categories: string[];
}

export class Harvester {
  index = new TagIndex();
  private fetcher: Fetcher;
  private logId = 0;
  private stopped = false;
  progress: Progress = {
    phase: 'idle',
    done: 0,
    providers: 0,
    providersDone: 0,
    providersSeen: 0,
    specs: 0,
    specsDone: 0,
    tagKeys: 0,
    tagHits: 0,
    failures: 0,
    skipped: 0,
  };

  constructor(private opts: RunOptions, private h: Handlers) {
    this.fetcher = new Fetcher(opts.concurrency, opts.timeoutMs);
  }

  stop(): void {
    this.stopped = true;
    this.fetcher.abort();
    this.progress.phase = 'stopped';
    this.emit();
  }

  private log(row: Omit<LogRow, 'id'>): number {
    const id = ++this.logId;
    this.h.onLog({ id, ...row });
    return id;
  }
  private update(id: number, row: Omit<LogRow, 'id'>): void {
    this.h.onLog({ id, ...row });
  }
  private emit(): void {
    this.progress.tagKeys = this.index.tags.size;
    this.progress.tagHits = this.index.hitCount;
    this.progress.providersSeen = this.index.providerCount();
    this.h.onProgress({ ...this.progress });
  }

  /**
   * Walk a catalog. `source` is either a URL to fetch or already-loaded text
   * (an uploaded file), in which case `baseUrl` is used to resolve relatives.
   */
  async run(source: { url?: string; text?: string; label: string }): Promise<RunResult> {
    this.progress.phase = 'catalog';
    this.emit();

    const rootUrl = source.url ? normalizeUrl(source.url) : undefined;
    const rowId = this.log({ kind: 'catalog', label: source.label, url: rootUrl, status: 'running' });

    let doc: any;
    const t0 = performance.now();
    try {
      const text = source.text ?? (await this.fetcher.text(rootUrl!));
      doc = parseDoc(text);
    } catch (e: any) {
      this.update(rowId, { kind: 'catalog', label: source.label, url: rootUrl, status: 'fail', note: e.message });
      this.progress.failures++;
      this.progress.phase = 'done';
      this.emit();
      return this.result(doc);
    }

    if (!looksLikeApisJson(doc)) {
      this.update(rowId, {
        kind: 'catalog',
        label: source.label,
        url: rootUrl,
        status: 'fail',
        note: 'not an APIs.json — no apis[], include[] or specificationVersion',
      });
      this.progress.failures++;
      this.progress.phase = 'done';
      this.emit();
      return this.result(doc);
    }

    const rootAid = doc.aid || doc.name || source.label;
    const before = this.index.hitCount;
    const { includes, specs } = harvestApisJson(
      doc,
      { level: 'collection', providerAid: rootAid, providerName: doc.name || source.label, baseUrl: rootUrl },
      this.index,
    );
    this.update(rowId, {
      kind: 'catalog',
      label: doc.name || source.label,
      url: rootUrl,
      status: 'ok',
      note: `${includes.length} provider index${includes.length === 1 ? '' : 'es'}, ${specs.length} definition${specs.length === 1 ? '' : 's'} inline`,
      tags: this.index.hitCount - before,
      ms: Math.round(performance.now() - t0),
    });

    // A file with no nested APIs.json is a provider index in its own right — walk
    // its specs directly rather than reporting an empty run.
    const pending: SpecTarget[] = [...specs];
    this.progress.providers = includes.length;
    this.progress.phase = includes.length ? 'providers' : 'specs';
    this.emit();

    // --- tier 2: every provider APIs.json, in parallel
    await Promise.all(includes.map((inc) => this.loadProvider(inc, pending)));
    if (this.stopped) return this.result(doc);

    // --- tier 3: the definitions
    if (this.opts.depth === 'specs') {
      this.progress.phase = 'specs';
      const budget = this.applyCaps(pending);
      this.progress.specs = budget.length;
      this.emit();
      await Promise.all(budget.map((s) => this.loadSpec(s)));
    } else {
      this.progress.skipped += pending.length;
      if (pending.length) {
        this.log({
          kind: 'spec',
          label: `${pending.length} definitions not opened`,
          status: 'skip',
          note: 'index-only depth — switch to "Definitions" to read their tags',
        });
      }
    }

    this.progress.phase = this.stopped ? 'stopped' : 'done';
    this.emit();
    return this.result(doc);
  }

  private result(doc: any): RunResult {
    return {
      index: this.index,
      progress: { ...this.progress },
      rootName: doc?.name || 'APIs.json',
      rootDescription: doc?.description,
      categories: Array.isArray(doc?.['x-categories']) ? doc['x-categories'] : [],
    };
  }

  /** Trim the spec list to the configured caps, round-robin so no provider is starved. */
  private applyCaps(pending: SpecTarget[]): SpecTarget[] {
    const { specsPerProvider, maxSpecs } = this.opts;

    // One document, one read. Providers routinely reference the same OpenAPI from
    // several APIs; harvesting it twice would double-count every tag inside it.
    const seen = new Set<string>();
    const unique: SpecTarget[] = [];
    for (const s of pending) {
      if (!s.url) {
        unique.push(s); // inline `data` — distinct by construction
        continue;
      }
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      unique.push(s);
    }
    const duplicates = pending.length - unique.length;
    if (duplicates) {
      this.log({
        kind: 'spec',
        label: `${duplicates} duplicate reference${duplicates === 1 ? '' : 's'} collapsed`,
        status: 'skip',
        note: 'the same definition URL was indexed by more than one API — read once, counted once',
      });
    }
    pending = unique;

    const byProvider = new Map<string, SpecTarget[]>();
    for (const s of pending) {
      const list = byProvider.get(s.providerAid) || [];
      list.push(s);
      byProvider.set(s.providerAid, list);
    }

    const kept: SpecTarget[] = [];
    const perProviderDropped = new Map<string, number>();
    for (const [aid, list] of byProvider) {
      const take = specsPerProvider > 0 ? list.slice(0, specsPerProvider) : list;
      if (take.length < list.length) perProviderDropped.set(aid, list.length - take.length);
      kept.push(...take);
    }

    // Round-robin the survivors so a global cap trims the tail evenly rather than
    // spending the whole budget on whoever happens to sort first.
    const queues = [...byProvider.keys()].map((aid) => kept.filter((s) => s.providerAid === aid));
    const ordered: SpecTarget[] = [];
    for (let i = 0; ordered.length < kept.length; i++) {
      for (const q of queues) if (q[i]) ordered.push(q[i]);
    }

    const final = maxSpecs > 0 ? ordered.slice(0, maxSpecs) : ordered;
    const dropped = pending.length - final.length;
    if (dropped > 0) {
      this.progress.skipped += dropped;
      for (const [aid, n] of perProviderDropped) {
        const p = this.index.providers.get(aid);
        if (p) p.specsSkipped += n;
      }
      // Never let a cap read as "we covered everything".
      this.log({
        kind: 'spec',
        label: `${dropped} definition${dropped === 1 ? '' : 's'} left unread`,
        status: 'skip',
        note:
          `capped at ${specsPerProvider || '∞'} per provider / ${maxSpecs || '∞'} total — ` +
          `${final.length} of ${pending.length} opened. Raise the caps for full coverage.`,
      });
    }
    return final;
  }

  private async loadProvider(
    inc: { name: string; url: string; aid?: string; meta?: any },
    pending: SpecTarget[],
  ): Promise<void> {
    if (this.stopped) return;
    const aid = inc.aid || inc.name;
    const rec = this.index.provider(aid, inc.meta?.name || inc.name);
    rec.apisJsonUrl = inc.url;

    const rowId = this.log({ kind: 'provider', label: inc.meta?.name || inc.name, url: inc.url, status: 'running' });
    const t0 = performance.now();
    try {
      const doc = parseDoc(await this.fetcher.text(inc.url));
      if (!looksLikeApisJson(doc)) throw new Error('not an APIs.json');

      const before = this.index.hitCount;
      const { specs, includes } = harvestApisJson(
        doc,
        { level: 'provider', providerAid: aid, providerName: rec.name, baseUrl: inc.url },
        this.index,
      );
      // A provider index that points at further indexes is legal; one hop is
      // enough here — deeper nesting is logged rather than silently dropped.
      if (includes.length) {
        this.log({
          kind: 'provider',
          label: `${rec.name}: ${includes.length} nested index${includes.length === 1 ? '' : 'es'} not followed`,
          status: 'skip',
          note: 'the walk goes one level deep from the catalog',
        });
        this.progress.skipped += includes.length;
      }
      pending.push(...specs);

      const gained = this.index.hitCount - before;
      this.update(rowId, {
        kind: 'provider',
        label: rec.name,
        url: inc.url,
        status: gained || specs.length ? 'ok' : 'warn',
        note: gained || specs.length
          ? `${rec.apiCount} API${rec.apiCount === 1 ? '' : 's'}, ${specs.length} definition${specs.length === 1 ? '' : 's'}`
          : 'no tags and no definitions in this index',
        tags: gained,
        ms: Math.round(performance.now() - t0),
      });
    } catch (e: any) {
      rec.failures++;
      this.progress.failures++;
      this.update(rowId, {
        kind: 'provider',
        label: rec.name,
        url: inc.url,
        status: e.message === 'stopped' ? 'skip' : 'fail',
        note: e.message,
        ms: Math.round(performance.now() - t0),
      });
    } finally {
      this.progress.providersDone++;
      this.progress.done++;
      this.emit();
    }
  }

  private async loadSpec(t: SpecTarget): Promise<void> {
    if (this.stopped) return;
    const label = `${t.providerName} · ${t.name}`;
    const rowId = this.log({ kind: 'spec', label, url: t.url, status: 'running' });
    const t0 = performance.now();
    const rec = this.index.provider(t.providerAid, t.providerName);
    try {
      const doc = t.data ?? parseDoc(await this.fetcher.text(t.url!));
      let found = 0;
      if (looksLikeAsyncApi(doc) && !looksLikeOpenApi(doc)) found = harvestAsyncApi(doc, t, this.index);
      else if (looksLikeOpenApi(doc)) found = harvestOpenApi(doc, t, this.index);
      else throw new Error('not an OpenAPI or AsyncAPI document');

      rec.specsSeen++;
      this.update(rowId, {
        kind: 'spec',
        label,
        url: t.url,
        // "Parsed fine, but nobody tagged anything" is a real finding, not an error.
        status: found ? 'ok' : 'warn',
        note: found ? undefined : 'no tags applied anywhere in this definition',
        tags: found,
        ms: Math.round(performance.now() - t0),
      });
    } catch (e: any) {
      rec.failures++;
      this.progress.failures++;
      this.update(rowId, {
        kind: 'spec',
        label,
        url: t.url,
        status: e.message === 'stopped' ? 'skip' : 'fail',
        note: e.message,
        ms: Math.round(performance.now() - t0),
      });
    } finally {
      this.progress.specsDone++;
      this.progress.done++;
      this.emit();
    }
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function toCsv(index: TagIndex): string {
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['tag', 'occurrences', 'providers', ...LEVELS].map(esc).join(',')];
  for (const t of index.ranked()) {
    rows.push([t.label, t.total, t.providers.size, ...LEVELS.map((l) => t.byLevel[l])].map(esc).join(','));
  }
  return rows.join('\n');
}

export function toJson(index: TagIndex, meta: Record<string, any>): string {
  return JSON.stringify(
    {
      ...meta,
      generatedBy: 'tags.apicommons.org',
      totals: { tags: index.tags.size, occurrences: index.hitCount, providers: index.providerCount() },
      tags: index.ranked().map((t) => ({
        tag: t.label,
        key: t.key,
        occurrences: t.total,
        spellings: [...t.spellings.keys()],
        byLevel: Object.fromEntries(LEVELS.filter((l) => t.byLevel[l]).map((l) => [l, t.byLevel[l]])),
        providers: [...t.providers.entries()].map(([aid, p]) => ({ aid, name: p.name, occurrences: p.count })),
      })),
      providers: index.providerList().map((p) => ({
        aid: p.aid,
        name: p.name,
        category: p.category,
        apisJson: p.apisJsonUrl,
        apis: p.apiCount,
        definitionsRead: p.specsSeen,
        definitionsSkipped: p.specsSkipped,
        failures: p.failures,
        distinctTags: p.tagKeys.size,
      })),
    },
    null,
    2,
  );
}
