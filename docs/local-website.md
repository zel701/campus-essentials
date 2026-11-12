# Desktop website and local administration

This version targets computer browsers at 1280–1920 pixels wide. It uses the saved San Luis Obispo 2026–2028 catalog, with no student accounts. The catalog is a snapshot, not a current schedule. No section requirements or prices are invented or seeded.

## Install and start

Use Node.js 22.12+ (22.17 tested), Python 3.12+, and Java 17+ (21 tested). In a user-owned checkout:

```sh
npm ci
npm ci --prefix lambda
npm ci --prefix web
npm run local:setup
npm run dev:web
```

The setup command downloads DynamoDB Local from AWS's distribution, checks its published SHA-256 before extracting it, and records the verified archive digest in `.local/runtime/install.json`. Re-running setup retains the runtime and existing password. Installation requires internet access; ordinary startup uses the saved catalog and installed runtime without refreshing either.

Open **http://127.0.0.1:5173**. The launcher checks all ports before starting DynamoDB Local (8765), the HTTP API (3001), and Vite (5173). API and Vite listen on loopback; the SDK connects exclusively to loopback with fake credentials and the distinct `campus-essentials-local` table. It never falls back to AWS. DynamoDB Local's Java server uses its standard listener; run this development stack on a trusted computer, not an exposed server.

Press **Ctrl+C** in the launcher terminal to stop the managed processes. Local records survive. Occupied ports, invalid table names, startup failures, and database errors stop startup or surface an error rather than resetting the database. If a prior process was force-killed, stop the old process before restarting.

## Password access

Setup creates `.local/admin-password` with owner-only read/write permissions (0600) inside the gitignored `.local/` directory. Open that file privately in a local editor and copy the password into **Admin workspace**. On macOS you can copy it without printing it:

```sh
pbcopy < .local/admin-password
```

Do not put the password in a frontend environment variable. The frontend verifies it with `/verify`, retains it only in the current tab's React memory, and clears it on sign-out or reload. It is never written to browser storage. The credential is sent only with authenticated writes and verification. The running API reads the password on startup; restart after changing it.

## Student and admin workflow

Course codes work with or without spaces; title words and subject filters combine. Exact course-code matches appear first. Search, subject, page, term, and section selections are URL-addressable. `/` focuses search. Browser Back/Forward restores the URL state. Each results page shows up to 25 courses.

Course descriptions, academic requirements, units, and provenance come from generated static JSON. Section materials and offers use the API. An API outage leaves the catalog readable and displays an error where section data or a save is unavailable. Empty material lists mean **Materials have not been added**, not that no materials are needed.

From a course, **Manage sections** preselects that course. From a selected section, **Manage materials** preselects the section. Add records in this order:

1. Section: choose the course, then enter the actual term, section number, and campus.
2. Book: enter title, author, edition, format, and ISBN if known. ISBN-10/13 checksums are validated; the backend normalizes ISBN-10 to ISBN-13.
3. Requirement: choose the section and book (or another material type). Verified records require a source URL and UTC verification timestamp.
4. Offer: choose the book, seller, option, condition, price, and last-checked UTC timestamp. Rentals require a whole-number duration. Leave unknown shipping or access-code values blank/Unknown.

Searchable reference selectors support typing, Arrow Up/Down, Enter, and Escape. Dialogs keep focus inside and return it on close. Identity fields are locked on edits. Create a new record for a different identity. Edits and deletions send `expectedVersion`; a conflict preserves the edit until you explicitly choose **Reload current record** (which replaces the form values). Deletions require confirmation. Referenced records cannot be deleted until their dependent requirements/offers are removed. Records are never cascade-deleted.

Offers are grouped into purchase, rental, and borrowing tables. Shipping stays **Unknown** when absent. Prices are dated USD observations, not live quotes or claims of being cheapest. Check the seller's final price and terms.

Catalog editing, bulk admin imports in the UI, legacy migration, mobile optimization, and publishing are outside this version. Real public section metadata and official materials links can be loaded by the standalone extraction/import pipeline.

## Catalog generation and persistence

`web/` has independent dependencies, TypeScript settings, and tests. `npm run dev:web`, `npm run dev --prefix web`, and `npm run build:web` generate `web/public/catalog/index.json` plus subject detail files from `data/catalog/2026-2028.json`. IDs, source URLs, edition, and retrieval dates are preserved. Normal startup never fetches a new catalog.

On first use, or when the saved snapshot hash changes, the local API seeds catalog records in the local database. Matching course IDs are updated; admin records and reference guards are untouched. Courses removed from a later snapshot are retained in the database for reference integrity, but only the current static snapshot is browsable. A seed marker is written after all courses succeed; a failed run retries safely on the next start.

With the launcher running, use `npm run sections:import` in another terminal to load saved live section snapshots, or `npm run sections:sync` to extract, validate and automatically import fresh ones. Imported sections show friendly term labels, official bookstore entry links and source dates. Links do not establish verified textbook requirements. The importer retains administrator-created or edited records, uses version checks and reference transactions, and never deletes missing sections. See [pipeline configuration, reports and recovery](section-pipeline.md). Ordinary website startup still does not fetch or automatically import section snapshots.

## Backup and restore

Stop the launcher completely before backing up `.local/database/`. Copy the **whole directory** to your backup location; do not copy live SQLite files. Store `.local/admin-password` separately and securely if retaining the same credential matters. The downloadable runtime can be recreated by setup.

To restore, stop the launcher, preserve a copy of the current database directory, replace it with the stopped backup, and restart. Keep the saved catalog snapshot with the backup if you need the same catalog state. Do not delete `.local/database` to fix a connection failure.

## Checks and production build

```sh
npm run check                 # existing backend, CDK, and Python checks
npm run test:web              # search, API pagination/cancellation, form validation
npm run build:web             # isolated TypeScript check + static production bundle
npx --prefix web playwright install chromium webkit
npm run test:browser          # isolated database, Chromium + WebKit
npm run test:local            # disk persistence, reseeding, reference guards, HTTP auth
npm run test:section-import   # isolated DynamoDB import/repeat/admin protection checks
```

Browser tests run on separate ports (8766/3002/5174), use an in-memory test database and a test-only credential, and never write to the persistent preview database. Screenshots and failure traces are under ignored `web/test-results/`. Chrome and Edge share the Chromium engine; WebKit tests provide Safari engine coverage, not a claim of testing every vendor/version manually.

`web/dist/` contains the static production output. Do not open `index.html` via `file://`; use an HTTP server with SPA fallback for direct course/admin links. The dev server defaults to the `/api` proxy. You can run `npm run dev --prefix web` on its own to browse the catalog while the backend is offline.

## Future HTTPS AWS API

No AWS deployment or writes are performed by these local commands. When explicitly ready to connect a deployed API, set a **public base URL only**:

```sh
VITE_API_BASE_URL=https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/prod npm run build:web
```

The frontend only accepts `/api` or an explicit HTTPS base URL without embedded credentials, query, or fragment. Configure the API's CORS to allow the website origin, Authorization/Content-Type, and GET/POST/DELETE/OPTIONS. Host the static build with SPA fallback. Admin authentication will use that API's credential, entered at runtime, never bundled. The static snapshot must match the catalog IDs loaded into that API. Deployment, catalog upload, production authentication hardening, and real data collection remain separate work.
