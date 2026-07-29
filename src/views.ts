// The four ways to look at a harvested vocabulary: a cloud (what is big), a
// graph (who shares what), a matrix (provider × tag coverage), and a table (the
// numbers). All four read the same TagIndex and all four route clicks to the
// same detail drawer.
//
// Color follows the data-viz method: magnitude is one hue, light→dark, stepped
// and validated against this tool's #1e1e1e surface. The graph's two node kinds
// are the first two categorical slots. Nothing is colored by rank.

import { LEVELS, LEVEL_LABEL, type Level, type TagIndex, type TagRecord, type ProviderRecord } from './harvest';

// --- palette (validated: scripts/validate_palette.js, dark, surface #1e1e1e) ---
/** Magnitude ramp for text marks — darkest step clears 3.78:1 so words stay legible. */
export const RAMP_TEXT = ['#2a78d6', '#5598e7', '#86b6ef', '#b7d3f6'];
/** Magnitude ramp for filled cells — an ordinal ramp, so the low end may recede. */
export const RAMP_FILL = ['#184f95', '#2a78d6', '#5598e7', '#86b6ef', '#b7d3f6'];
/** Categorical slots 1 and 2 — the graph's only two node kinds. */
export const C_TAG = '#3987e5';
export const C_PROVIDER = '#d95926';

/** Bin a value onto a ramp. Uses sqrt so a long tail is not flattened to one step. */
function step(value: number, max: number, ramp: string[]): number {
  if (max <= 1) return ramp.length - 1;
  const t = Math.sqrt(Math.max(value, 1)) / Math.sqrt(max);
  return Math.min(ramp.length - 1, Math.floor(t * ramp.length));
}

export interface ViewContext {
  index: TagIndex;
  /** Only these tag keys are in scope (search + level filters already applied). */
  visible: TagRecord[];
  onTag: (key: string) => void;
  onProvider: (aid: string) => void;
  selected?: string;
}

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function emptyState(host: HTMLElement, msg: string): void {
  host.replaceChildren(el('div', 'empty-state', msg));
}

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

export function renderCloud(host: HTMLElement, ctx: ViewContext, sort: 'count' | 'alpha'): void {
  const tags = ctx.visible;
  if (!tags.length) return emptyState(host, 'No tags match the current filters.');

  const max = tags[0] ? Math.max(...tags.map((t) => t.total)) : 1;
  const ordered = sort === 'alpha' ? [...tags].sort((a, b) => a.key.localeCompare(b.key)) : tags;

  const wrap = el('div', 'cloud');
  for (const t of ordered) {
    const s = step(t.total, max, RAMP_TEXT);
    const size = 0.82 + (s / (RAMP_TEXT.length - 1)) * 1.5; // 0.82rem → 2.32rem
    const b = el('button', 'cloud-tag', t.label) as HTMLButtonElement;
    b.style.fontSize = `${size.toFixed(2)}rem`;
    b.style.color = RAMP_TEXT[s];
    b.style.fontWeight = String(500 + s * 100);
    b.dataset.key = t.key;
    b.title = `${t.label} — ${t.total} occurrence${t.total === 1 ? '' : 's'} across ${t.providers.size} provider${t.providers.size === 1 ? '' : 's'}`;
    if (ctx.selected === t.key) b.classList.add('is-selected');
    b.addEventListener('click', () => ctx.onTag(t.key));
    wrap.append(b);
  }

  host.replaceChildren(rampLegend('Occurrences', RAMP_TEXT, max), wrap);
}

/** A legend is not optional — the ramp has to say what its steps mean. */
function rampLegend(title: string, ramp: string[], max: number): HTMLElement {
  const wrap = el('div', 'legend');
  wrap.append(el('span', 'legend-title', title));
  const bar = el('div', 'legend-bar');
  for (const c of ramp) {
    const sw = el('span', 'legend-swatch');
    sw.style.background = c;
    bar.append(sw);
  }
  wrap.append(el('span', 'legend-end', '1'), bar, el('span', 'legend-end', String(max)));
  return wrap;
}

// ---------------------------------------------------------------------------
// Graph — providers and the tags they share
// ---------------------------------------------------------------------------

interface Node {
  id: string;
  kind: 'tag' | 'provider';
  label: string;
  weight: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}
interface Edge {
  a: Node;
  b: Node;
}

export class GraphView {
  private canvas = document.createElement('canvas');
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private raf = 0;
  private ticks = 0;
  private settled = false;
  private degree = new Map<Node, number>();
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private drag: { node?: Node; panX?: number; panY?: number; sx: number; sy: number } | null = null;
  private hover: Node | null = null;
  private tip = el('div', 'graph-tip');

  constructor(private host: HTMLElement, private ctx: ViewContext) {}

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** `limit` keeps the simulation honest — a 3,000-node hairball tells you nothing. */
  render(limit: number): void {
    this.destroy();
    const tags = this.ctx.visible.slice(0, limit);
    if (!tags.length) return emptyState(this.host, 'No tags match the current filters.');

    const byId = new Map<string, Node>();
    const mk = (id: string, kind: Node['kind'], label: string, weight: number): Node => {
      let n = byId.get(id);
      if (!n) {
        // Seed on a ring so the layout unfolds instead of exploding from a point.
        const a = (byId.size * 2.399) % (Math.PI * 2);
        const rad = 60 + byId.size * 1.6;
        n = { id, kind, label, weight, x: Math.cos(a) * rad, y: Math.sin(a) * rad, vx: 0, vy: 0, r: 4 };
        byId.set(id, n);
      }
      n.weight = Math.max(n.weight, weight);
      return n;
    };

    this.edges = [];
    for (const t of tags) {
      const tn = mk(`t:${t.key}`, 'tag', t.label, t.total);
      for (const [aid, p] of t.providers) {
        this.edges.push({ a: tn, b: mk(`p:${aid}`, 'provider', p.name, p.count) });
      }
    }
    this.nodes = [...byId.values()];
    const maxW = Math.max(1, ...this.nodes.map((n) => n.weight));
    for (const n of this.nodes) n.r = 3.5 + Math.sqrt(n.weight / maxW) * (n.kind === 'provider' ? 12 : 9);
    this.degree = new Map();
    for (const e of this.edges) {
      this.degree.set(e.a, (this.degree.get(e.a) ?? 0) + 1);
      this.degree.set(e.b, (this.degree.get(e.b) ?? 0) + 1);
    }
    this.settled = false;
    this.scale = 1;

    const info = el('div', 'graph-info');
    info.append(
      legendSwatch(C_TAG, 'Tag'),
      legendSwatch(C_PROVIDER, 'Provider'),
      el('span', 'muted small', `${this.nodes.length} nodes · ${this.edges.length} links · top ${tags.length} tags`),
      el('span', 'muted small', 'drag to pan · scroll to zoom · click a node'),
    );
    this.host.replaceChildren(info, this.canvas);
    this.canvas.className = 'graph-canvas';
    this.host.append(this.tip);
    this.tip.hidden = true;

    this.bind();
    this.fit();
    this.ticks = 0;
    this.loop();
  }

  private fit(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth;
    const h = Math.max(320, this.host.clientHeight - 40);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ox = w / 2;
    this.oy = h / 2;
  }

  private bind(): void {
    const c = this.canvas;
    c.onwheel = (e) => {
      e.preventDefault();
      const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.scale = Math.min(4, Math.max(0.2, this.scale * k));
    };
    c.onmousedown = (e) => {
      const n = this.at(e);
      this.drag = n ? { node: n, sx: e.offsetX, sy: e.offsetY } : { panX: this.ox, panY: this.oy, sx: e.offsetX, sy: e.offsetY };
    };
    c.onmousemove = (e) => {
      if (this.drag?.node) {
        this.drag.node.x = (e.offsetX - this.ox) / this.scale;
        this.drag.node.y = (e.offsetY - this.oy) / this.scale;
        this.ticks = Math.min(this.ticks, 220); // wake the sim back up
        return;
      }
      if (this.drag) {
        this.ox = this.drag.panX! + (e.offsetX - this.drag.sx);
        this.oy = this.drag.panY! + (e.offsetY - this.drag.sy);
        return;
      }
      const n = this.at(e);
      this.hover = n;
      c.style.cursor = n ? 'pointer' : 'grab';
      if (n) {
        this.tip.textContent = `${n.label} — ${n.weight} ${n.kind === 'tag' ? 'occurrences' : 'tagged items'}`;
        this.tip.style.left = `${e.offsetX + 14}px`;
        this.tip.style.top = `${e.offsetY + 46}px`;
        this.tip.hidden = false;
      } else this.tip.hidden = true;
    };
    const end = (e: MouseEvent) => {
      const moved = this.drag && (Math.abs(e.offsetX - this.drag.sx) > 3 || Math.abs(e.offsetY - this.drag.sy) > 3);
      const node = this.drag?.node;
      this.drag = null;
      if (node && !moved) {
        if (node.kind === 'tag') this.ctx.onTag(node.id.slice(2));
        else this.ctx.onProvider(node.id.slice(2));
      }
    };
    c.onmouseup = end;
    c.onmouseleave = () => {
      this.drag = null;
      this.hover = null;
      this.tip.hidden = true;
    };
  }

  private at(e: MouseEvent): Node | null {
    const x = (e.offsetX - this.ox) / this.scale;
    const y = (e.offsetY - this.oy) / this.scale;
    let best: Node | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < n.r + 6 && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  /** Barnes-Hut is overkill at this size; a capped O(n²) pass with cooling is fine. */
  private tick(): void {
    const alpha = Math.max(0, 1 - this.ticks / 320) * 0.6;
    if (alpha <= 0) {
      if (!this.settled) {
        this.settled = true;
        this.zoomToFit();
      }
      return;
    }
    const n = this.nodes;
    // Repulsion has to grow with the node count or a big run collapses into a blob.
    const repel = 900 + n.length * 34;
    for (let i = 0; i < n.length; i++) {
      for (let j = i + 1; j < n.length; j++) {
        const a = n[i];
        const b = n[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = (i - j) * 0.5 + 0.1;
          dy = (j - i) * 0.5 + 0.1;
          d2 = dx * dx + dy * dy;
        }
        const f = (repel * alpha) / d2;
        const d = Math.sqrt(d2);
        a.vx -= (dx / d) * f;
        a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f;
        b.vy += (dy / d) * f;
      }
    }
    // Widely-shared tags pull on many providers at once; softening the spring by
    // degree stops them dragging the whole graph into the middle.
    for (const e of this.edges) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const soften = 1 / Math.sqrt(Math.max(this.degree.get(e.a) ?? 1, this.degree.get(e.b) ?? 1));
      const f = (d - 150) * 0.014 * alpha * soften;
      e.a.vx += (dx / d) * f;
      e.a.vy += (dy / d) * f;
      e.b.vx -= (dx / d) * f;
      e.b.vy -= (dy / d) * f;
    }
    for (const node of n) {
      node.vx -= node.x * 0.0022 * alpha; // gentle pull to centre
      node.vy -= node.y * 0.0022 * alpha;
      node.x += node.vx;
      node.y += node.vy;
      node.vx *= 0.82;
      node.vy *= 0.82;
    }
    this.ticks++;
  }

  /** Once the layout stops moving, scale it so it actually fills the canvas. */
  private zoomToFit(): void {
    if (!this.nodes.length) return;
    const pad = 46;
    const xs = this.nodes.map((n) => n.x);
    const ys = this.nodes.map((n) => n.y);
    const w = Math.max(1, Math.max(...xs) - Math.min(...xs));
    const h = Math.max(1, Math.max(...ys) - Math.min(...ys));
    const cw = this.canvas.clientWidth - pad * 2;
    const ch = this.canvas.clientHeight - pad * 2;
    this.scale = Math.min(2.2, Math.max(0.25, Math.min(cw / w, ch / h)));
    this.ox = this.canvas.clientWidth / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * this.scale;
    this.oy = this.canvas.clientHeight / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * this.scale;
  }

  private draw(): void {
    const ctx2 = this.canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx2.save();
    ctx2.translate(this.ox, this.oy);
    ctx2.scale(this.scale, this.scale);

    const focus = this.hover;
    const linked = new Set<Node>();
    if (focus) for (const e of this.edges) if (e.a === focus || e.b === focus) linked.add(e.a === focus ? e.b : e.a);

    ctx2.lineWidth = 1 / this.scale;
    for (const e of this.edges) {
      const on = !focus || e.a === focus || e.b === focus;
      ctx2.strokeStyle = on ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.05)';
      ctx2.beginPath();
      ctx2.moveTo(e.a.x, e.a.y);
      ctx2.lineTo(e.b.x, e.b.y);
      ctx2.stroke();
    }

    for (const n of this.nodes) {
      const dim = focus && n !== focus && !linked.has(n);
      ctx2.globalAlpha = dim ? 0.25 : 1;
      ctx2.fillStyle = n.kind === 'tag' ? C_TAG : C_PROVIDER;
      ctx2.beginPath();
      ctx2.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx2.fill();
      // A 2px surface ring keeps overlapping marks readable.
      ctx2.lineWidth = 2 / this.scale;
      ctx2.strokeStyle = '#1e1e1e';
      ctx2.stroke();
    }
    ctx2.restore();

    // Labels are drawn last, unscaled, and only where they fit — a canvas of
    // overlapping words is worse than a canvas of none. Biggest nodes win.
    const fontPx = 11;
    ctx2.font = `${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx2.textAlign = 'center';
    const taken: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const candidates = [...this.nodes].sort((a, b) => (a === focus ? -1 : b === focus ? 1 : b.r - a.r));
    for (const n of candidates) {
      if (focus && n !== focus && !linked.has(n)) continue;
      if (n.r < 6 && n !== focus && this.scale < 1.5) continue;
      const text = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
      const w = ctx2.measureText(text).width;
      const cx = n.x * this.scale + this.ox;
      const cy = n.y * this.scale + this.oy - n.r * this.scale - 5;
      if (cx < -w || cy < 8 || cx > this.canvas.clientWidth + w || cy > this.canvas.clientHeight) continue;
      const box = { x1: cx - w / 2 - 2, y1: cy - fontPx, x2: cx + w / 2 + 2, y2: cy + 3 };
      if (taken.some((t) => box.x1 < t.x2 && box.x2 > t.x1 && box.y1 < t.y2 && box.y2 > t.y1)) continue;
      taken.push(box);
      // A surface halo keeps the word readable wherever it lands.
      ctx2.lineWidth = 3;
      ctx2.strokeStyle = '#1a1a1a';
      ctx2.strokeText(text, cx, cy);
      ctx2.fillStyle = n === focus ? '#ffffff' : '#e6e6e6';
      ctx2.fillText(text, cx, cy);
    }
    ctx2.globalAlpha = 1;
  }

  private loop = (): void => {
    this.tick();
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };
}

function legendSwatch(color: string, label: string): HTMLElement {
  const w = el('span', 'legend-item');
  const dot = el('span', 'legend-dot');
  dot.style.background = color;
  w.append(dot, el('span', undefined, label));
  return w;
}

// ---------------------------------------------------------------------------
// Matrix — provider × tag coverage
// ---------------------------------------------------------------------------

export function renderMatrix(host: HTMLElement, ctx: ViewContext, tagLimit: number): void {
  const tags = ctx.visible.slice(0, tagLimit);
  if (!tags.length) return emptyState(host, 'No tags match the current filters.');

  const providers = ctx.index
    .providerList()
    .filter((p) => tags.some((t) => t.providers.has(p.aid)))
    .slice(0, 80);
  if (!providers.length) return emptyState(host, 'No providers carry the tags in scope.');

  let max = 1;
  for (const t of tags) for (const p of providers) max = Math.max(max, t.providers.get(p.aid)?.count ?? 0);

  const table = el('table', 'matrix');
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', 'matrix-corner', `${providers.length} providers × ${tags.length} tags`));
  for (const t of tags) {
    const th = el('th', 'matrix-col');
    const span = el('span', undefined, t.label);
    th.append(span);
    th.title = `${t.label} — ${t.total} occurrences`;
    th.addEventListener('click', () => ctx.onTag(t.key));
    hr.append(th);
  }
  thead.append(hr);

  const tbody = el('tbody');
  for (const p of providers) {
    const tr = el('tr');
    const th = el('th', 'matrix-row', p.name);
    th.title = `${p.name} — ${p.tagKeys.size} distinct tags`;
    th.addEventListener('click', () => ctx.onProvider(p.aid));
    tr.append(th);
    for (const t of tags) {
      const n = t.providers.get(p.aid)?.count ?? 0;
      const td = el('td', 'matrix-cell');
      if (n) {
        td.style.background = RAMP_FILL[step(n, max, RAMP_FILL)];
        td.title = `${p.name} × ${t.label} — ${n} occurrence${n === 1 ? '' : 's'}`;
        td.classList.add('on');
        td.addEventListener('click', () => ctx.onTag(t.key));
      } else {
        td.title = `${p.name} × ${t.label} — none`;
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);

  const scroller = el('div', 'matrix-scroll');
  scroller.append(table);
  host.replaceChildren(rampLegend('Occurrences per provider', RAMP_FILL, max), scroller);
}

// ---------------------------------------------------------------------------
// Table — the numbers, sortable
// ---------------------------------------------------------------------------

export type SortKey = 'total' | 'label' | 'providers' | Level;

export function renderTable(host: HTMLElement, ctx: ViewContext, sort: SortKey, desc: boolean, onSort: (k: SortKey) => void): void {
  if (!ctx.visible.length) return emptyState(host, 'No tags match the current filters.');

  const val = (t: TagRecord, k: SortKey): number | string =>
    k === 'total' ? t.total : k === 'label' ? t.key : k === 'providers' ? t.providers.size : t.byLevel[k];
  const rows = [...ctx.visible].sort((a, b) => {
    const x = val(a, sort);
    const y = val(b, sort);
    const c = typeof x === 'string' ? String(x).localeCompare(String(y)) : (y as number) - (x as number);
    return desc ? c : -c;
  });

  const table = el('table', 'data-table');
  const head = el('tr');
  const cols: { key: SortKey; label: string; cls?: string }[] = [
    { key: 'label', label: 'Tag' },
    { key: 'total', label: 'Uses', cls: 'num' },
    { key: 'providers', label: 'Providers', cls: 'num' },
    ...LEVELS.map((l) => ({ key: l as SortKey, label: LEVEL_LABEL[l], cls: 'num' })),
  ];
  for (const c of cols) {
    const th = el('th', c.cls, c.label);
    th.classList.add('sortable');
    if (c.key === sort) th.classList.add(desc ? 'sort-desc' : 'sort-asc');
    th.addEventListener('click', () => onSort(c.key));
    head.append(th);
  }

  const body = el('tbody');
  for (const t of rows.slice(0, 1500)) {
    const tr = el('tr');
    if (ctx.selected === t.key) tr.classList.add('is-selected');
    const name = el('td');
    const btn = el('button', 'link-btn', t.label);
    btn.addEventListener('click', () => ctx.onTag(t.key));
    name.append(btn);
    if (t.spellings.size > 1) name.append(el('span', 'muted small', ` ${t.spellings.size} spellings`));
    tr.append(name, el('td', 'num', String(t.total)), el('td', 'num', String(t.providers.size)));
    for (const l of LEVELS) {
      const n = t.byLevel[l];
      tr.append(el('td', n ? 'num' : 'num zero', n ? String(n) : '·'));
    }
    body.append(tr);
  }

  const thead = el('thead');
  thead.append(head);
  table.append(thead, body);
  const scroller = el('div', 'matrix-scroll');
  scroller.append(table);
  const note =
    rows.length > 1500 ? el('p', 'muted small', `Showing the first 1,500 of ${rows.length} tags — narrow with search.`) : null;
  host.replaceChildren(scroller, ...(note ? [note] : []));
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

export function renderTagDetail(body: HTMLElement, index: TagIndex, key: string, onProvider: (aid: string) => void): string {
  const t = index.tags.get(key);
  if (!t) {
    body.replaceChildren(el('p', 'muted', 'That tag is no longer in the current run.'));
    return 'Tag';
  }

  const frag = document.createDocumentFragment();
  const stats = el('div', 'stat-row');
  stats.append(stat(String(t.total), 'occurrences'), stat(String(t.providers.size), 'providers'));
  frag.append(stats);

  if (t.spellings.size > 1) {
    const s = el('p', 'muted small');
    s.append(el('strong', undefined, 'Spellings: '), document.createTextNode([...t.spellings.keys()].join(' · ')));
    frag.append(s);
  }

  frag.append(el('h4', undefined, 'Where it is applied'));
  const levelWrap = el('div', 'chip-row');
  for (const l of LEVELS) {
    if (!t.byLevel[l]) continue;
    levelWrap.append(el('span', 'chip', `${LEVEL_LABEL[l]} · ${t.byLevel[l]}`));
  }
  frag.append(levelWrap);

  frag.append(el('h4', undefined, `Providers (${t.providers.size})`));
  const plist = el('div', 'detail-list');
  for (const [aid, p] of [...t.providers.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const row = el('button', 'detail-row');
    row.append(el('span', 'detail-row-name', p.name), el('span', 'detail-row-num', String(p.count)));
    row.addEventListener('click', () => onProvider(aid));
    plist.append(row);
  }
  frag.append(plist);

  frag.append(el('h4', undefined, 'Applied on'));
  const hits = el('div', 'detail-list');
  for (const h of t.hits.slice(0, 120)) {
    const row = el(h.href ? 'a' : 'div', 'detail-row static');
    if (h.href) {
      (row as HTMLAnchorElement).href = h.href;
      (row as HTMLAnchorElement).target = '_blank';
      (row as HTMLAnchorElement).rel = 'noopener';
    }
    const main = el('span', 'detail-row-name', h.detail || h.artifact || h.apiName || h.providerName);
    const meta = el('span', 'detail-row-meta', [h.providerName, h.apiName, LEVEL_LABEL[h.level]].filter(Boolean).join(' · '));
    const col = el('span', 'detail-row-col');
    col.append(main, meta);
    row.append(col);
    hits.append(row);
  }
  frag.append(hits);
  if (t.total > t.hits.length) {
    frag.append(el('p', 'muted small', `Showing ${t.hits.length} of ${t.total} occurrences.`));
  }

  body.replaceChildren(frag);
  return t.label;
}

export function renderProviderDetail(
  body: HTMLElement,
  index: TagIndex,
  aid: string,
  onTag: (key: string) => void,
): string {
  const p = index.providers.get(aid);
  if (!p) {
    body.replaceChildren(el('p', 'muted', 'That provider is no longer in the current run.'));
    return 'Provider';
  }
  const frag = document.createDocumentFragment();

  const stats = el('div', 'stat-row');
  stats.append(
    stat(String(p.tagKeys.size), 'distinct tags'),
    stat(String(p.apiCount), 'APIs'),
    stat(String(p.specsSeen), 'definitions read'),
  );
  frag.append(stats);

  if (p.description) frag.append(el('p', 'small', p.description));
  if (p.category) frag.append(el('p', 'muted small', p.category));

  const links = el('div', 'chip-row');
  for (const [label, href] of [
    ['Provider page', p.humanURL],
    ['APIs.json', p.apisJsonUrl],
  ] as const) {
    if (!href) continue;
    const a = el('a', 'chip link', label) as HTMLAnchorElement;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    links.append(a);
  }
  if (p.specsSkipped) links.append(el('span', 'chip warn', `${p.specsSkipped} definitions not opened (cap)`));
  if (p.failures) links.append(el('span', 'chip bad', `${p.failures} fetch failure${p.failures === 1 ? '' : 's'}`));
  frag.append(links);

  frag.append(el('h4', undefined, 'Tags carried'));
  const list = el('div', 'detail-list');
  const rows = [...p.tagKeys]
    .map((k) => index.tags.get(k))
    .filter((t): t is TagRecord => !!t)
    .map((t) => ({ t, n: t.providers.get(aid)?.count ?? 0 }))
    .sort((a, b) => b.n - a.n);
  for (const { t, n } of rows) {
    const row = el('button', 'detail-row');
    row.append(el('span', 'detail-row-name', t.label), el('span', 'detail-row-num', String(n)));
    row.addEventListener('click', () => onTag(t.key));
    list.append(row);
  }
  frag.append(list);

  body.replaceChildren(frag);
  return p.name;
}

function stat(value: string, label: string): HTMLElement {
  const w = el('div', 'stat');
  w.append(el('span', 'stat-value', value), el('span', 'stat-label', label));
  return w;
}

export type { ProviderRecord };
