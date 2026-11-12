# Campus Essentials

Live website: **https://dcedgja5njbt2.cloudfront.net**. The deployed snapshot includes
3,968 current catalog courses, 359 sections across seven subjects, and 93 official
materials entry links. Actual textbook adoptions and prices have not been verified.
Deployment and cloud administrator access are documented in [the AWS runbook](docs/aws-deployment.md).

Desktop-first Cal Poly course explorer with local admin tools for sections, books, material requirements, and textbook offers. The saved catalog contains 3,968 courses across 97 subjects. Real section-level material data still needs to be collected. See [website setup and operation](docs/local-website.md) and [the data model and API workflow](docs/data-model.md).

Start the local website after installing the dependencies below and `npm ci --prefix web`:

```sh
npm run local:setup  # requires Java 17+; verifies the DynamoDB Local download
npm run dev:web     # http://127.0.0.1:5173
```

Admin password: open `.local/admin-password` privately, or copy it with `pbcopy < .local/admin-password` on macOS. It is never printed by the setup/start commands. All local database files stay in ignored `.local/`. No AWS deployment or writes are performed.

## Public section and materials-link pilot

For normal operation use the configuration-driven pipeline; no Codex session or manual browser work is required:

```sh
npm run sections:sync -- --plan
npm run sections:sync
npm run sections:status
npm run sections:expand -- --batch-size 3 # discover mapped subjects and process the next batch
npm run sections:expand -- --status
```

Configure term/campus/subjects in `config/sections-pipeline.json`. Start `npm run dev:web` in another terminal first: database import is enabled by default. The pipeline automatically runs a pilot, stages full-subject extraction, verifies offline replay and quality thresholds, publishes each successful snapshot, then imports sections and official materials links into local DynamoDB. Use `npm run sections:import` to import saved live snapshots without recrawling. Imports preserve manual edits and reference guards; repeated imports of the same snapshot make no changes. It records failures, preserves prior snapshots on failed checks, retries connection faults once, and prevents overlapping pipeline runs. See [pipeline operation, import recovery and job-runner usage](docs/section-pipeline.md). No recurring schedule is enabled automatically.

The lower-level extraction commands remain available for development:

```sh
npm run sections:extract -- --term 2268 --subject BIO --course 1111
npm run sections:extract -- --term 2268 --subject BIO
```

These commands extract all statuses of sections and the materials links actually displayed in the public class details. They save source-backed JSON, change counts, failure reports, and sanitized offline-replay evidence under `data/sections/`. Incomplete runs preserve the last good snapshot. They do not retrieve bookstore textbook lists or write to the website database. See [extraction commands, provenance, replay, and limitations](docs/section-extraction.md).

## Local setup

Use Node.js 22 and Python 3.12 or newer. From the repository root:

```sh
npm ci
npm ci --prefix lambda
npm run check
```

The second install packages the API's existing AWS SDK dependency; it is required before synthesis/deployment. Python tests use standard-library mocks, so they do not need AWS credentials or boto3 installed locally. The price Lambda uses the boto3 supplied by its Python runtime. Migrating the Node handler from its existing AWS SDK v2 dependency is follow-up maintenance.

`npm run check` runs TypeScript checking, backend behavior tests, CDK template/asset tests, and Python tests. `npm run build` emits JavaScript. Tests prefer TypeScript to avoid loading stale compiled files.

The existing `node_modules` folder on this checkout was created by root. If `npm ci` reports permission errors, use a fresh checkout in a user-owned directory and run the commands above there. Do not use `sudo npm install`.

## Infrastructure and administration

The CDK stack creates an on-demand DynamoDB table, Node.js API Lambda, Python price-storage Lambda, and API Gateway. The existing table name and construct ID are retained. Stack removal now retains the table. Both functions require `TABLE_NAME` and `ADMIN_PASSWORD`; authentication fails closed if the password is absent.

Synthesize locally without deploying:

```sh
npm run cdk -- synth
```

The template generates an admin credential in Secrets Manager and references it in the Lambda environment through a CloudFormation dynamic reference. Retrieve its `password` privately from the secret identified by the `AdminSecretArn` output; never commit it, paste it into chat, or bundle it in the frontend. IAM principals allowed to inspect Lambda configuration can still access the resolved environment value.

Deployment is a separate step requiring AWS account access, cost review, and an authenticated cloud smoke test. No live deployment is part of these local repairs. Review the CloudFormation change set before updating an existing stack: API routes, runtimes, Python function packaging, required configuration, and table retention have changed.

See the [AWS deployment runbook](docs/aws-deployment.md) for the reviewed account, existing-stack update, private S3/CloudFront hosting, and explicit cloud import commands. `npm run aws:prepare` builds/synthesizes; `npm run aws:import` defaults to read-only validation. Deployment and `aws:import -- --apply` change cloud state. Ordinary local commands continue to use DynamoDB Local exclusively.

## API

Reads are public. All writes and `/verify` require either `x-admin-password` or `Authorization: Bearer ...`. Header names are case-insensitive. CORS preflight is configured in API Gateway and supported by both handlers.

| Path | Methods | Purpose |
| --- | --- | --- |
| `/verify` | POST | Verify admin credential |
| `/courses` | GET, POST | Search/list or save a course |
| `/courses/{id}` | GET, DELETE | Retrieve/delete a course |
| `/courses/bulk` | POST | Import up to 100 courses |
| `/items` | GET, POST | Search/list or create a material/link |
| `/items/{id}` | GET, DELETE | Retrieve/delete an item |
| `/course-items` | GET, POST | List or save course-material associations |
| `/course-items/bulk` | POST | Import up to 100 associations |
| `/course-items/{id}` | DELETE | Delete association; requires `?courseId=...` |
| `/scrape` | POST | Store a supplied URL and numeric price; does not scrape |
| `/sections` | GET, POST | List or save term-specific course sections |
| `/material-requirements` | GET, POST | List or save section-specific requirements |
| `/books` | GET, POST | List or save book editions/formats |
| `/offers` | GET, POST | List or save offers for a specific book |

Each new section/requirement/book/offer collection also supports GET and DELETE at `/{id}`. See [schema, filters, updates, and examples](docs/data-model.md).

`/courses/course-items`, its `/bulk` endpoint, and its `/{id}` endpoint are aliases retained for compatibility. DELETE belongs on individual records, not collection paths.

### Course payload

```json
{
  "subject": "AERO",
  "number": "121",
  "title": "Aerospace Fundamentals",
  "description": "Example description",
  "units": "2",
  "term": "F",
  "prerequisite": "",
  "recommended": "",
  "corequisite": "",
  "catalogEdition": "legacy-sample"
}
```

Subject, number, and title are required. Optional catalog fields include `sourceUrl`, `retrievedAt`, `concurrent`, `geArea`, `gradingBasis`, `catalogDetails`, and `campus`. `term` means typical offering season. Non-empty `termId`, `crn`, and `instructor` are now rejected on course writes; use `/sections` for offering-specific data. Existing mixed course records remain readable. Catalog editions must be supplied when importing multiple versions.

Bulk requests accept an array or `{ "courses": [...] }` / `{ "courseItems": [...] }`. Association records require `courseId` and `itemId`; `required` is a boolean defaulting to true. They do not yet enforce that both referenced records exist, and deleting a course does not cascade to associations.

A supplied `id` preserves an existing record's identity. Otherwise catalog course IDs derive from subject, number, and catalog edition (retaining empty offering slots in the hash for compatibility); association IDs derive from course and item IDs. Reimporting a record with the same identity replaces its stored fields, so send the full record. Duplicate IDs in one import are rejected. Conditional writes prevent overwriting a different entity type. Old records with timestamp IDs should be imported with those IDs to avoid duplicates.

Imports validate all rows before writing, then save in order. They are not atomic. A 409/503 response includes `completed`, `remaining`, and `failedId`; retry using the same IDs. Timeouts/network failures can leave the final write's outcome uncertain, so stable IDs are essential. The handler stops early when too little Lambda time remains. No success count is returned for an incomplete import.

Item creation requires `itemName`, an HTTP(S) `url`, and a finite numeric `price >= 0`. `/scrape` requires only the URL and price; zero is valid. The Python handler uses Decimal for DynamoDB compatibility.

### Pagination and search

Collection GET responses include `nextToken`, null when exhausted. Pass it back with `?nextToken=...` and keep the same search/filter parameters until exhausted. `limit` defaults to 100, maximum 1000, and limits **database records evaluated**, not matching results. A page can be empty and still have a continuation token. The existing `total` search field counts matches on that page only.

`q` searches course subject/number/title/instructor/CRN/term ID or item name/URL. Association lists accept `courseId`. This implementation still scans the table; indexed queries and a better search model belong in the database-design step.

## Existing course sample

```sh
python3 scripts/parse_courses_to_csv.py scripts/input.txt > scripts/courses.csv
```

The checked-in sample contains 83 legacy AERO courses. It is not the current full catalog. The parser supports BOM-prefixed input, two-to-five-letter subjects, three/four-digit numbers, and combined prerequisite/corequisite/recommended lines. No automatic quarter-to-semester conversion is attempted.

Legacy vendored Python packages and experimental scraping scripts remain in this checkout, but are excluded from the deployed Python asset. Only `scraper-lambda/lambda_function.py` is packaged; no Docker build is needed.


## Current catalog importer

The checked-in [2026–2028 snapshot](data/catalog/2026-2028.json) contains **3,968 courses across 97 subjects**, fetched from the [official catalog index](https://catalog.calpoly.edu/courses/). The adjacent [report](data/catalog/2026-2028.report.json) lists every subject, count, source URL, retrieval time, and source hash. The legacy CSV remains separate.

```sh
# Refresh the complete SLO catalog, reusing fetched pages for up to 24 hours.
npm run catalog:import

# Force a fresh fetch of the index, robots.txt, and every selected subject.
npm run catalog:import -- --refresh

# Repeat parsing from cached HTML without network access.
npm run catalog:import -- --offline

# A pilot must use its own output path.
python3 scripts/import_catalog.py --subject AERO --output /tmp/aero-catalog.json

# Optional: include subjects labeled Solano; writes a separate -all snapshot.
npm run catalog:import -- --campus all

# Validate the saved snapshot and upload batch sizes without accessing AWS.
npm run catalog:validate
```

The importer uses only Python's standard library. It observes the catalog's `robots.txt`, limits requests to the official catalog host, spaces requests at least one second apart, retries transient failures, and caches source pages in ignored `data/catalog/.cache/`. An offline run preserves the original retrieval times; it does not claim to refresh the source.

Default scope excludes the 31 subjects explicitly labeled “Solano Campus” in the current catalog index. `campus` records the catalog grouping inferred from that index, **not a guarantee of where a particular class section meets**. The `--campus all` option includes both groups. The importer validates the requested catalog edition on every page; a future edition needs an explicit `--edition YYYY-YYYY`.

Every course preserves its full description, units, typical offering term, prerequisite/corequisite/concurrent/recommended text, GE notes, grading basis, source URL, catalog edition, and retrieval time. `catalogDetails` also retains the complete source detail text so unfamiliar labels are not silently discarded. “Formerly” notes stay in the description; they are not treated as verified one-to-one course equivalencies.

A run checks all selected subject pages and fails if any course block is malformed, a page is missing/empty, an edition changes, or duplicate IDs appear. Successful snapshots are written atomically. On a partial failure, the previous JSON course snapshot stays intact and the `.report.json` describes the failed attempt. Inspect its `complete` and `scope` fields before treating a report as a full catalog. A subject pilot requires `--output` so it cannot accidentally overwrite the default full snapshot. This is catalog coverage, not a term schedule or evidence that a course is currently offered.

### Load into the backend after deployment

The downloader only writes local files. After deploying the repaired API, configure `API_BASE_URL` (including the stage path) and `ADMIN_PASSWORD` through your local environment/secret manager, then run:

```sh
python3 scripts/upload_catalog.py data/catalog/2026-2028.json --apply
```

Without `--apply`, the uploader only validates the snapshot and makes no API requests. Actual upload sends 25 courses at a time to `/courses/bulk`, checks each acknowledgement, and retries transient failures with the same IDs. It requires HTTPS, never follows redirects with credentials, and stops on authentication or record conflicts. Repeated uploads replace matching current-catalog records; they never delete missing courses or legacy records. Concurrent execution and transactional all-or-nothing imports are not implemented. A live AWS upload has not been performed.
