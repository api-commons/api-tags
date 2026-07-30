# API Tags

**[tags.apicommons.org](https://tags.apicommons.org)** — point it at an APIs.json and see the
whole tag vocabulary hiding underneath it.

Tags are the only vocabulary most APIs actually publish. They sit on the
[APIs.json](https://apisjson.org) collection, on each API within it, on the properties that
describe it, and then again — usually written by a different team, years apart — on every
OpenAPI document and on each individual operation inside it. Nobody ever sees all of them at
once.

This tool walks the whole chain:

```
APIs.json  ──▶  each provider's APIs.json  ──▶  every OpenAPI / AsyncAPI they index
   │                    │                                │
 collection tags     provider tags                  document tags
                     API tags                       operation tags
                     property tags                  channel + message tags
```

…and renders the result four ways: a **cloud**, a **graph** of who shares which vocabulary, a
**provider × tag matrix**, and a sortable **table**. Click any tag to see the exact providers,
APIs, and operations carrying it.

Everything runs in your browser. Nothing is uploaded.

## The built-in catalogs

Two APIs.json indexes ship with the tool, both built from provider profiles in the
[API Evangelist](https://github.com/api-evangelist) GitHub organization:

| Catalog | What it indexes |
|---|---|
| [`api-management.yml`](public/catalogs/api-management.yml) | 42 providers — the tooling used to **manage** APIs: gateways, full-lifecycle platforms, design/docs/SDK tooling, API security, observability and monetization, GraphQL federation |
| [`api-platform.yml`](public/catalogs/api-platform.yml) | 43 providers — the stack an API platform is **built on**: source control, CI/CD, cloud and container runtimes, IaC, identity, observability and incident response, data and events, product analytics, communications, payments, AI |

Each entry carries an `APIsJSON` property pointing at that provider's own `apis.yml`:

```yaml
- aid: kong
  name: Kong
  humanURL: https://apis.io/providers/kong/
  tags: [API Gateway, AI Gateway, …]
  x-category: API Gateways
  properties:
    - type: APIsJSON
      url: https://raw.githubusercontent.com/api-evangelist/kong/refs/heads/main/apis.yml
```

Both files are plain APIs.json 0.21 (YAML) and are served at
`https://tags.apicommons.org/catalogs/<name>.yml` — use them anywhere, not just here.

## Bring your own APIs.json

- **URL** — paste any `apis.yml` / `apis.json`. `github.com/…/blob/…` links are rewritten to raw automatically.
- **Upload** — read straight off disk, never sent anywhere.
- **Deep link** — see below.

## Deep links

Every combination of catalog and view is addressable, so a link can drop a specific
visual straight into a post:

| param | values | default |
|---|---|---|
| `catalog` | `management`, `platform` | — |
| `src` | any APIs.json URL (wins over `catalog`) | — |
| `view` | `cloud`, `graph`, `matrix`, `table` | `cloud` |
| `depth` | `index`, `specs` | `specs` |
| `run` | `0` to load the settings without harvesting | runs when a source is named |

A link that names a source harvests immediately on load:

```
https://tags.apicommons.org/?catalog=platform&view=graph
https://tags.apicommons.org/?catalog=management&view=matrix
https://tags.apicommons.org/?catalog=platform&view=cloud&depth=index
https://tags.apicommons.org/?src=https://example.com/apis.yml&view=table
```

An unrecognized `catalog` or `view` falls back to the default rather than erroring.

It reads whatever an APIs.json actually contains, in the shapes people really write them:

- `apis[].properties[]` of type `OpenAPI`, `Swagger`, or `AsyncAPI` — by `url` **or** inline `data`
- relative property URLs, resolved against the document that carried them
- nested APIs.json via a property of type `APIsJSON`, or top-level `include[]` / `network[]`
- the 0.21 buckets: `common`, `prompts`, `rules`, `workflows`, `overlays`
- OpenAPI 2.0 / 3.0 / 3.1 (including `webhooks`) and AsyncAPI 2.x / 3.x

That includes platform definitions exported by
**[platform.apicommons.org](https://platform.apicommons.org)** — their inline merged OpenAPIs are
read without a single extra request.

## Showing the work, and failing gracefully

The left rail is a live work log: one row per fetch, newest first, with status, timing, the tag
count it contributed, and a clickable URL. Every failure mode is a logged row rather than a dead
run:

| Row | Means |
|---|---|
| `× HTTP 404` | the index pointed at a definition that isn't there |
| `× timed out` / `× network or CORS blocked` | unreachable from the browser |
| `× not an OpenAPI or AsyncAPI document` | it parsed, but it isn't a definition |
| `! no tags applied anywhere` | it parsed fine and nobody tagged anything — a real finding |
| `– N definitions left unread` | a cap was hit; the row states which and how many |
| `– N duplicate references collapsed` | one document, one read, one count |

Caps exist because a full walk of the API Platform catalog is ~550 definitions. **A cap is never
silent** — it is always logged with the number it dropped, so a partial read never reads as a
complete one. `Stop` keeps everything harvested so far on screen.

## Export

`Export` downloads the vocabulary as JSON (every tag, its levels, its providers, its spellings)
and CSV (one row per tag). `Catalog` downloads the APIs.json currently being walked.

## Design notes

- **Color is computed, not chosen.** Magnitude is one hue, light→dark, stepped and validated
  against this tool's `#1e1e1e` surface. The graph's two node kinds are the first two
  categorical slots. Nothing is colored by rank, and status colors always ship with a glyph and
  a word.
- **Levels are a filter, not seven hues.** Where a tag was applied is a facet you click, not a
  rainbow you decode.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/
```

Deploys to GitHub Pages on push to `main`.

## License

Apache 2.0. Part of the [API Commons](https://apicommons.org) tool suite.
