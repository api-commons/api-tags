// Wiring: pick a catalog, run the harvest, show the work while it happens, and
// render whichever view is active off the same index.

import './style.css';
import {
  DEFAULT_OPTIONS,
  Harvester,
  LEVELS,
  LEVEL_LABEL,
  normalizeUrl,
  toCsv,
  toJson,
  type Level,
  type LogRow,
  type Progress,
  type RunOptions,
  type TagIndex,
  type TagRecord,
} from './harvest';
import {
  GraphView,
  renderCloud,
  renderMatrix,
  renderProviderDetail,
  renderTable,
  renderTagDetail,
  type SortKey,
  type ViewContext,
} from './views';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

type View = 'cloud' | 'graph' | 'matrix' | 'table';

const state = {
  view: 'cloud' as View,
  search: '',
  levels: new Set<Level>(LEVELS),
  sort: 'total' as SortKey,
  sortDesc: true,
  cloudSort: 'count' as 'count' | 'alpha',
  selectedTag: undefined as string | undefined,
  index: undefined as TagIndex | undefined,
  running: false,
  problemsOnly: false,
  source: { label: 'API Management', url: '/catalogs/api-management.yml' } as { label: string; url?: string; text?: string },
};

/** Short names for the built-in catalogs, so a story link stays readable. */
const CATALOGS: Record<string, { path: string; label: string }> = {
  management: { path: '/catalogs/api-management.yml', label: 'API Management' },
  platform: { path: '/catalogs/api-platform.yml', label: 'API Platform' },
};
const VIEWS: View[] = ['cloud', 'graph', 'matrix', 'table'];

let harvester: Harvester | undefined;
let graph: GraphView | undefined;
const logRows = new Map<number, LogRow>();

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

let toastTimer: number | undefined;
function toast(msg: string): void {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3200);
}

function download(name: string, body: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// The work log
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<LogRow['status'], string> = {
  running: '·',
  ok: '✓',
  warn: '!',
  fail: '×',
  skip: '–',
};

function onLog(row: LogRow): void {
  logRows.set(row.id, row);
  const host = $('#log');
  const id = `log-${row.id}`;
  let node = document.getElementById(id);
  if (!node) {
    node = document.createElement('div');
    node.id = id;
    // Newest first: a run is watched from the top, not scrolled to the bottom.
    host.prepend(node);
  }
  node.className = `log-row st-${row.status} kind-${row.kind}`;
  node.hidden = state.problemsOnly && (row.status === 'ok' || row.status === 'running');

  // Status is never color alone — every row carries a glyph and a spelled-out kind.
  const bits = [
    `<span class="log-ico" aria-hidden="true">${STATUS_ICON[row.status]}</span>`,
    `<span class="log-kind">${row.kind}</span>`,
    `<span class="log-label">${escape(row.label)}</span>`,
  ];
  if (row.tags) bits.push(`<span class="log-tags">+${row.tags}</span>`);
  if (row.ms != null) bits.push(`<span class="log-ms">${row.ms}ms</span>`);
  node.innerHTML =
    bits.join('') +
    (row.note ? `<div class="log-note">${escape(row.note)}</div>` : '') +
    (row.url ? `<a class="log-url" href="${escape(row.url)}" target="_blank" rel="noopener">${escape(shorten(row.url))}</a>` : '');
  node.setAttribute('data-status', row.status);
}

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function shorten(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^raw\.githubusercontent\.com\/api-evangelist\//, 'api-evangelist/').replace(/refs\/heads\/main\//, '');
}

function onProgress(p: Progress): void {
  // Until the provider indexes are read we do not know how many definitions are
  // coming, so the bar tracks "work known so far" and is capped short of full.
  const expected = Math.max(1, p.providers + (p.specs || 0));
  const ratio = p.phase === 'done' ? 1 : Math.min(0.99, p.done / expected);
  $('#bar').style.width = `${(ratio * 100).toFixed(1)}%`;
  $('#bar').className = `bar${p.phase === 'done' ? ' is-done' : ''}${p.phase === 'stopped' ? ' is-stopped' : ''}`;
  $('#work-phase').textContent =
    p.phase === 'catalog'
      ? 'reading the catalog'
      : p.phase === 'providers'
        ? `provider indexes ${p.providersDone}/${p.providers}`
        : p.phase === 'specs'
          ? `definitions ${p.specsDone}/${p.specs}`
          : p.phase;

  $('#tallies').innerHTML = [
    tally(p.providersDone, 'indexes'),
    tally(p.specsDone, 'definitions'),
    tally(p.tagKeys, 'tags'),
    tally(p.tagHits, 'uses'),
    p.skipped ? tally(p.skipped, 'skipped', 'warn') : '',
    p.failures ? tally(p.failures, 'failed', 'bad') : '',
  ].join('');

  $('#counts').innerHTML = `<b>${p.tagKeys.toLocaleString()}</b> tags · <b>${p.tagHits.toLocaleString()}</b> uses · <b>${p.providersSeen}</b> providers`;
}

const tally = (n: number, label: string, cls = ''): string =>
  `<span class="tally ${cls}"><b>${n.toLocaleString()}</b>${label}</span>`;

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function readOptions(): RunOptions {
  const [per, max] = ($('#cap') as HTMLSelectElement).value.split(':').map(Number);
  return {
    ...DEFAULT_OPTIONS,
    depth: ($('#depth') as HTMLSelectElement).value as 'index' | 'specs',
    specsPerProvider: per,
    maxSpecs: max,
  };
}

async function run(): Promise<void> {
  if (state.running) return;
  const src = state.source;
  if (!src.url && !src.text) {
    toast('Pick a catalog, paste a URL, or upload a file first.');
    return;
  }

  state.running = true;
  state.selectedTag = undefined;
  logRows.clear();
  $('#log').replaceChildren();
  $('#run-btn').setAttribute('disabled', 'true');
  $('#stop-btn').hidden = false;
  $('#export-btn').setAttribute('disabled', 'true');
  closeDetail();

  harvester = new Harvester(readOptions(), { onLog, onProgress });
  state.index = harvester.index;
  renderView(); // the views fill in live as the index grows

  const ticker = window.setInterval(renderView, 900);
  try {
    const result = await harvester.run(src);
    state.index = result.index;
    const p = result.progress;
    toast(
      p.tagKeys
        ? `${p.tagKeys.toLocaleString()} tags from ${p.tagHits.toLocaleString()} uses across ${p.providersDone} providers.` +
            (p.failures ? ` ${p.failures} fetch failure${p.failures === 1 ? '' : 's'} — see the work log.` : '')
        : 'No tags found. Check the work log for what failed.',
    );
  } catch (e: any) {
    // Nothing in the walk should throw, but a surprise must not leave the UI stuck.
    toast(`Run failed: ${e?.message || e}`);
  } finally {
    clearInterval(ticker);
    state.running = false;
    $('#run-btn').removeAttribute('disabled');
    $('#stop-btn').hidden = true;
    if (state.index?.tags.size) $('#export-btn').removeAttribute('disabled');
    renderView();
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function visibleTags(): TagRecord[] {
  const idx = state.index;
  if (!idx) return [];
  const q = state.search.trim().toLowerCase();
  const allLevels = state.levels.size === LEVELS.length;
  return idx.ranked().filter((t) => {
    if (q && !t.key.includes(q)) return false;
    if (!allLevels && !LEVELS.some((l) => state.levels.has(l) && t.byLevel[l] > 0)) return false;
    return true;
  });
}

function context(): ViewContext {
  return {
    index: state.index!,
    visible: visibleTags(),
    selected: state.selectedTag,
    onTag: showTag,
    onProvider: showProvider,
  };
}

/** Single path for changing view — used by the tabs and by ?view=. */
function setView(view: View, render = true): void {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  for (const t of document.querySelectorAll<HTMLButtonElement>('.view-tab')) {
    t.classList.toggle('is-active', t.dataset.view === view);
  }
  $('#cloud-sort').hidden = view !== 'cloud';
  if (render) renderView();
}

function renderView(): void {
  const host = $('#view');
  if (!state.index) {
    host.innerHTML = `<div class="empty-state">Pick a catalog and press <b>Harvest tags</b>.</div>`;
    return;
  }
  const ctx = context();
  $('#scope').textContent = ctx.visible.length
    ? `${ctx.visible.length.toLocaleString()} of ${state.index.tags.size.toLocaleString()} tags in scope`
    : state.index.tags.size
      ? 'nothing matches the filters'
      : state.running
        ? 'harvesting…'
        : '';

  renderLevelChips();
  if (state.view !== 'graph') {
    graph?.destroy();
    graph = undefined;
  }

  switch (state.view) {
    case 'cloud':
      return renderCloud(host, ctx, state.cloudSort);
    case 'graph':
      // Rebuild rather than mutate — the sim is cheap and the filters change often.
      graph = new GraphView(host, ctx);
      return graph.render(40);
    case 'matrix':
      return renderMatrix(host, ctx, 45);
    case 'table':
      return renderTable(host, ctx, state.sort, state.sortDesc, (k) => {
        if (state.sort === k) state.sortDesc = !state.sortDesc;
        else {
          state.sort = k;
          state.sortDesc = k !== 'label';
        }
        renderView();
      });
  }
}

function renderLevelChips(): void {
  const host = $('#level-chips');
  const idx = state.index;
  if (!idx) return host.replaceChildren();
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
  for (const t of idx.tags.values()) for (const l of LEVELS) counts[l] += t.byLevel[l];

  host.replaceChildren();
  const all = document.createElement('button');
  all.className = `lchip${state.levels.size === LEVELS.length ? ' active' : ''}`;
  all.textContent = 'All levels';
  all.addEventListener('click', () => {
    state.levels = new Set(LEVELS);
    renderView();
  });
  host.append(all);

  for (const l of LEVELS) {
    if (!counts[l]) continue;
    const b = document.createElement('button');
    b.className = `lchip${state.levels.has(l) && state.levels.size !== LEVELS.length ? ' active' : ''}`;
    b.innerHTML = `${LEVEL_LABEL[l]}<span class="lchip-n">${counts[l].toLocaleString()}</span>`;
    b.title = `Tags applied at the ${LEVEL_LABEL[l].toLowerCase()} level`;
    b.addEventListener('click', (e) => {
      // Click = only this level; ⌘/ctrl-click = add to the selection.
      if (e.metaKey || e.ctrlKey) {
        if (state.levels.size === LEVELS.length) state.levels = new Set([l]);
        else if (state.levels.has(l)) state.levels.delete(l);
        else state.levels.add(l);
        if (!state.levels.size) state.levels = new Set(LEVELS);
      } else {
        state.levels = state.levels.size === 1 && state.levels.has(l) ? new Set(LEVELS) : new Set([l]);
      }
      renderView();
    });
    host.append(b);
  }
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function showTag(key: string): void {
  if (!state.index) return;
  state.selectedTag = key;
  $('#detail-title').textContent = renderTagDetail($('#detail-body'), state.index, key, showProvider);
  $('#detail').hidden = false;
  renderView();
}

function showProvider(aid: string): void {
  if (!state.index) return;
  $('#detail-title').textContent = renderProviderDetail($('#detail-body'), state.index, aid, showTag);
  $('#detail').hidden = false;
}

function closeDetail(): void {
  $('#detail').hidden = true;
  if (state.selectedTag) {
    state.selectedTag = undefined;
    if (state.index) renderView();
  }
}

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

function onSourceChange(): void {
  const sel = $('#source') as HTMLSelectElement;
  const urlInput = $<HTMLInputElement>('#source-url');
  urlInput.hidden = sel.value !== 'url';
  if (sel.value === 'file') {
    $<HTMLInputElement>('#source-file').click();
    return;
  }
  if (sel.value === 'url') {
    state.source = { label: urlInput.value || 'APIs.json', url: urlInput.value ? normalizeUrl(urlInput.value) : undefined };
    urlInput.focus();
    return;
  }
  state.source = { label: sel.options[sel.selectedIndex].text, url: sel.value };
}

function loadFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    state.source = { label: file.name, text: String(reader.result) };
    toast(`Loaded ${file.name} — press Harvest tags.`);
  };
  reader.onerror = () => toast(`Could not read ${file.name}.`);
  reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportVocabulary(): void {
  const idx = state.index;
  if (!idx?.tags.size) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const base = (state.source.label || 'apis').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  download(`${base}-tags-${stamp}.json`, toJson(idx, { source: state.source.url || state.source.label, generated: stamp }), 'application/json');
  download(`${base}-tags-${stamp}.csv`, toCsv(idx), 'text/csv');
  toast('Exported the vocabulary as JSON and CSV.');
}

async function downloadCatalog(): Promise<void> {
  const src = state.source;
  try {
    const text = src.text ?? (await (await fetch(src.url!)).text());
    const name = (src.url?.split('/').pop() || 'apis.yml').replace(/\?.*$/, '');
    download(name, text, 'text/yaml');
  } catch (e: any) {
    toast(`Could not download the catalog: ${e?.message || e}`);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(): void {
  $('#source').addEventListener('change', onSourceChange);
  $('#source-url').addEventListener('input', () => {
    const v = $<HTMLInputElement>('#source-url').value.trim();
    state.source = { label: v.split('/').slice(-2).join('/') || 'APIs.json', url: v ? normalizeUrl(v) : undefined };
  });
  $('#source-file').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadFile(f);
    else ($('#source') as HTMLSelectElement).selectedIndex = 0;
    (e.target as HTMLInputElement).value = '';
  });

  $('#run-btn').addEventListener('click', run);
  $('#stop-btn').addEventListener('click', () => {
    harvester?.stop();
    toast('Stopped — everything harvested so far is still on screen.');
  });
  $('#export-btn').addEventListener('click', exportVocabulary);
  $('#catalog-btn').addEventListener('click', downloadCatalog);

  $('#log-filter').addEventListener('click', () => {
    state.problemsOnly = !state.problemsOnly;
    $('#log-filter').classList.toggle('active', state.problemsOnly);
    $('#log-filter').textContent = state.problemsOnly ? 'Showing problems' : 'Problems only';
    for (const row of logRows.values()) onLog(row);
  });

  for (const tab of document.querySelectorAll<HTMLButtonElement>('.view-tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view as View));
  }

  let searchTimer: number | undefined;
  $('#tag-search').addEventListener('input', (e) => {
    state.search = (e.target as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(renderView, 160);
  });
  $('#cloud-sort').addEventListener('change', (e) => {
    state.cloudSort = (e.target as HTMLSelectElement).value as 'count' | 'alpha';
    renderView();
  });

  $('#detail-x').addEventListener('click', closeDetail);
  $('#nav-about').addEventListener('click', (e) => {
    e.preventDefault();
    $('#about-back').hidden = false;
  });
  $('#about-x').addEventListener('click', () => ($('#about-back').hidden = true));
  $('#about-back').addEventListener('click', (e) => {
    if (e.target === $('#about-back')) $('#about-back').hidden = true;
  });
  $('#engage-ae').addEventListener('click', () => {
    location.href =
      'mailto:info@apievangelist.com?subject=' + encodeURIComponent('Our API tag vocabulary — API Tags tool');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#about-back').hidden) $('#about-back').hidden = true;
    else if (!$('#detail').hidden) closeDetail();
  });
  window.addEventListener('resize', () => {
    if (state.view === 'graph') renderView();
  });

  // Deep links, for dropping a specific view straight into a story:
  //   ?catalog=management|platform   a built-in catalog by short name
  //   ?src=<url>                     any other APIs.json
  //   ?view=cloud|graph|matrix|table which view to open
  //   ?depth=index                   stop at the indexes
  //   ?run=0                         load the settings but do not harvest
  const params = new URLSearchParams(location.search);

  const alias = (params.get('catalog') || '').toLowerCase();
  const src = params.get('src');
  if (CATALOGS[alias]) {
    ($('#source') as HTMLSelectElement).value = CATALOGS[alias].path;
    state.source = { label: CATALOGS[alias].label, url: CATALOGS[alias].path };
  }
  if (src) {
    ($('#source') as HTMLSelectElement).value = 'url';
    $('#source-url').hidden = false;
    $<HTMLInputElement>('#source-url').value = src;
    state.source = { label: src.split('/').slice(-2).join('/'), url: normalizeUrl(src) };
  }

  const view = (params.get('view') || '').toLowerCase() as View;
  if (VIEWS.includes(view)) setView(view, false);

  if (params.get('depth') === 'index') ($('#depth') as HTMLSelectElement).value = 'index';

  renderView();
  // A link that names a source is meant to just go; ?run=0 opts out.
  const named = !!src || !!CATALOGS[alias];
  if (params.get('run') === '1' || (named && params.get('run') !== '0')) run();
}

init();
