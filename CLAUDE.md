# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An automated library-cataloguing agent: it ingests book/magazine files (EPUB, PDF, scanned image sets — pre- or post-ISBN), extracts and enriches their metadata, classifies them by **CDU** (Universal Decimal Classification), and persists schema-validated documents to **MongoDB Atlas**. It is meant to run in Docker on a NAS with an `Inbox` folder mapped under the app root. Code, comments, and identifiers are in **Spanish** — match that convention.

> **Durable project context lives in [`docs/contexto-proyecto.md`](docs/contexto-proyecto.md)** — the accumulated *why* behind decisions, the non-obvious **NAS/Atom deployment constraints** (no sharp/SIMD, no Alpine, Node 18/cheerio 1.0.0, Compose v1, chokidar-over-bind-mount, LF endings, the `down -v` gotcha, the deploy script + `nas-estable` rollback tag), the governing principles (conservative merge, ISBN pivot), and the subsystem history (covers, scanned-PDF OCR, transactional copy, the Conformador). Read it before non-trivial work or any deploy.

## Commands

- **Run the app** (REST API on port 3000 **+** Inbox watcher): `npm start`. Set `DESACTIVAR_VIGILANTE=1` to run the API only. ⚠️ Run **one instance at a time** — two watchers race on the Inbox and cause ENOENT mid-copy.
- **Test suite** = the battery of 12 real-world cases in `Test Battery/`: `node "Test Battery/run-battery.js"`. **Run a single case (or subset):** pass comma-separated ids, e.g. `node "Test Battery/run-battery.js" 12` or `1,3,12`. Cases 1–3 EPUB, 4–7 PDF, 8–11 images, 12 PDF magazine. The runner clears nothing — it inserts/updates Mongo and writes a JSON per case folder under `_resultado/`.
- **Isolated checks** (also in `Test Battery/`): `test-credenciales.js` (verify Gemini + Google Books keys), `test-conservador.js` (conservative merge), `test-vision-api.js` (vision + APIs), `test-endpoint.js` / `test-inbox.js` (live ingest methods — require `npm start` running).
- **Backfill `registro.json` + `registro.marc.xml`** for all catalogued docs: `node "Test Battery/regenerar-registros.js"`.
- **No build/lint/test framework** — plain Node ESM (`"type": "module"`). Syntax-check a file with `node --check <file>`. There is no transpile step.

## Required environment (`.env` at repo root)

`MONGO_URI`, `MONGO_DB_NAME`, `GEMINI_API_KEY`, `GOOGLE_BOOKS_API_KEY`, and the path vars `PATH_INBOX` / `PATH_CDU` / `PATH_CUARENTENA` / `PATH_REINTENTOS` (relative to repo root). Modules resolve these paths relative to the repo root themselves — **do not** re-mutate `process.env.PATH_*` in new code.

All the tuning knobs (timeouts, watcher intervals, maintenance cadence, cover/PDF/OCR sizes…) are `process.env.X || <default>` — see **[`.env.example`](.env.example)** for the full annotated list. The container reads `.env` directly (bind mount → `/app/.env` + `dotenv/config`), so adding a line there and restarting suffices; only the secrets + `PATH_*` are *also* injected via the compose `environment:` block (which wins over dotenv for those).

## Architecture — the ingest pipeline

Everything flows through one shared service so both entry points behave identically:

```
Entry points:                         Shared pipeline (src/servicio-ingesta.js · ingestarRecurso):
  app.js   POST /api/ingestar  ─┐       orquestador.js  → extract by type
  vigilante.js  Inbox watcher  ─┴──►     motor-enriquecimiento.js → enrich (conservative)
                                         motor-catalogo.js → resolve refs + dedup + upsert
                                         copy files into CDU tree + write registro.json/.marc.xml
```

- **`orquestador.js` (`procesarRecurso`)** routes by file type: EPUB → `utils/lector-epub.js`; PDF → `utils/lector-pdf.js` (text layer + ISBN/ISSN regex; flags scanned PDFs); image group → `agente.js` (Gemini vision). Loose JPEGs are grouped into **one** book by `utils/agrupador.js`. Unknown-but-known formats (mobi/cbr/djvu/zip/rar) are catalogued by filename as a placeholder.
- **Tiered enrichment (cost-minimizing): file → free APIs → AI.** `utils/proveedor-metadatos.js` orchestrates Tier 2 (`utils/buscador-bibliografico.js` = OpenLibrary, `utils/buscador-google-books.js`) then Tier 3 (Gemini vision for ISBN hints, CDU classification). The **ISBN is the pivot** — get it cheaply, then a free API call resolves the rest.
- **`motor-enriquecimiento.js` is the single conservative-merge authority.** Data extracted from the file is the source of truth and is **never** overwritten by internet/AI — external sources only fill gaps (`primerValido`). Exceptions encoded here: ePubLibre/Lectulandia etc. are NOT publishers (`EDITORIALES_NO_VALIDAS`), so a real API publisher overrides them; and the ISBN inside the provider lets APIs outrank vision. Reader-internal/null fields are stripped before persisting (avoids base64 bloat and `$jsonSchema` rejections).
- **`motor-catalogo.js`** resolves `autores`/`editorial` strings → ObjectId refs (check-then-create in their collections), dedups by **isbn → issn → titulo**, and on a hit performs an intelligent merge (gap-fill + `pendiente`→`completado` upgrade) — this is the "better info found later" update path.

## CDU classification & the `equivalencias_cdu` cache

`src/clasificador-cdu.js` (`resolverCDU`) normalizes everything to CDU while minimizing AI: **learned-cache → external-API stub → AI**. OpenLibrary's Dewey/LCC codes are captured; on an AI derivation the Dewey/LC→CDU mapping is **learned** into the `equivalencias_cdu` collection (`sistema_origen`, `codigo_origen`, `cdu`, `fuente`, `verificado`) so future books with that code are a free, consistent cache hit. Manual edits set `verificado: true`.

## Outputs & file management

After insert, files are copied to `PATH_CDU/<cdu>/<libros|revistas>/<isbn|issn|ObjectId>/` alongside cover images, plus `registro.json` (resolved names) and `registro.marc.xml` (MARC 21 / MARCXML, via `src/marc21.js`). **CDU folder names are sanitized for Windows+Linux** (`utils/rutas.js`: `141.78:81'37` → `141.78_81`) while the real CDU string stays in Mongo. The doc's `ruta_base`/`imagenes`/`portada` point at `/recursos/...` (served statically by `app.js`).

## Failure handling

`src/errores.js` defines the taxonomy; `src/gestor-fallos.js` routes:
- **`ErrorIdentificacion`** (no title after all tiers) → **Cuarentena** (move out, manual review).
- **`ErrorInfraestructura`** (can't reach a resource) → **Reintentos** (copy, retry later).
Each writes an `estado.json` with work-so-far for resume. Bibliographic APIs **degrade gracefully** (alert + continue) on a network blip; because MongoDB is **Atlas (cloud)**, a genuine connectivity outage surfaces as a Mongo error → Reintentos.

## The MongoDB `biblioteca` collection is `$jsonSchema`-validated

Required: `tipo_recurso` (`libro|revista`), `titulo`, `cdu`, `idioma`, `formatos` (enum array), `ubicacion` (`{ambito, estanteria}`). `autores` is an array of ObjectId, `editorial` an ObjectId. Identifiers are checksum-validated (`utils/identificadores.js`) and dropped to keep the record `pendiente` if malformed. A schema violation throws error 121 — never persist null/empty optional fields.

## Legacy / superseded files (avoid editing by mistake)

`src/controlador-ingesta.js` (old REST handler, replaced by `servicio-ingesta.js`), `src/procesador-epub.js` (epub2 reader — the live one is `utils/lector-epub.js`), `src/utils/procesador-archivos.js` (used only by the old controller), and `src/auditoria-apis.js` (one-off Gemini model-listing diagnostic).
