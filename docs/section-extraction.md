# Public section and materials-link extraction

For routine unattended execution, use [the configuration-driven pipeline](section-pipeline.md):
`npm run sections:sync`. It automatically performs preflight, full extraction, replay,
quality checks, publication and local database import (start `npm run dev:web` first).
The individual commands below are the underlying file-only adapter.

This command reads Cal Poly's **public Class Search**, without a login, then follows
each result into its public class detail. It extracts the displayed section data and
the actual `Course Materials` URL. It does **not** follow that URL into the bookstore,
verify a textbook adoption, infer an ISBN/price, or write to DynamoDB/AWS.

The original September 29 browser example was Fall Semester 2026 BIO 1111 **S02 / CRN
6370 / Charles Knight**, with a Follett course-materials link. That search had **Show
Open Classes Only** enabled. The extractor explicitly disables this filter; the
October 28 pilot finds **S01, S02, and S03**, including closed sections.

## Verified run: 2026-10-28 UTC

| Scope | Observed result |
| --- | --- |
| BIO 1111, Fall 2026, MAIN | 3 sections and 3 materials links; three independent live sessions returned identical content hashes |
| Entire BIO subject, Fall 2026, MAIN | 56 courses, 177 sections: 69 open and 108 closed |
| Materials entry points | 59 links present; 118 sections have no listed link, which does not mean no materials are needed |
| Extraction failures | 0; all 177 declared sections were validated |
| Full-subject offline replay | 177 sections, identical content hash to the live snapshot |
| Tests | 21 extraction tests plus 70 existing backend/infrastructure/Python tests passed |

See [the BIO snapshot](../data/sections/2268-MAIN-BIO.json),
the locally generated `data/sections/2268-MAIN-BIO.report.json`, and
[repeatability evidence](../data/sections/validation-2268-BIO.json). These are dated
observations; rerun the live command to refresh them. No actual textbook list or ISBN
was retrieved. That extraction run only wrote files; the separate importer now loads
validated live snapshots into the local website database with `npm run sections:import`.
Runtime reports, captured pages and database files are gitignored; the reviewed
snapshots and validation summaries are versioned with the code.

## Run it

Python 3.12+ and an internet connection are sufficient; there are no new dependencies.
Run commands from the repository root:

```sh
# Pilot: all BIO 1111 sections at the SLO campus, Fall Semester 2026.
npm run sections:extract -- --term 2268 --subject BIO --course 1111

# Repeat the same command: stable IDs; unchanged content keeps its updatedAt.
npm run sections:extract -- --term 2268 --subject BIO --course 1111

# Same workflow, entire BIO subject. This takes several minutes.
npm run sections:extract -- --term 2268 --subject BIO
```

`--term` is required; `2268` is the official Fall Semester 2026 term code, not a
derived code for arbitrary dates. Obtain other available term codes from the public
Class Search's **Look up Term** control. `--subject` defaults to `BIO`; `--course` is
optional. `--campus` defaults to `MAIN` (SLO); the other publicly offered campus
codes are `AHC`, `CCC`, and `SOLA`. The selected subject and campus must actually
appear in the live form. No course list is hardcoded or taken from a potentially
outdated catalog when discovering the subject's current offerings.

An explicit `--output PATH` overrides the default filename. Keep different scopes
in separate files: the command rejects replacing a snapshot with a different term,
subject, campus, or course scope. Run only one writer per output file at a time.

Requests are serial, with at least one second between their start times; use
`--delay 2` for a slower run. The extractor checks `robots.txt` (404 is recorded as
not published), honors crawl delay/disallow rules, uses in-memory session cookies,
and never follows redirects outside the public search endpoint. It handles the
site's “over 50 classes” confirmation and XML response envelope. It does not try to
bypass access challenges or blindly retry a stateful POST after a timeout. A failed
run should be rerun using a fresh session after resolving the reported cause.

## Outputs and meanings

The BIO 1111 default outputs are:

- `data/sections/2268-MAIN-BIO-1111.json`: latest **complete** section snapshot.
- `data/sections/2268-MAIN-BIO-1111.report.json`: latest attempt, successful or failed.
- `data/sections/.runs/2268-MAIN-BIO-1111/<run-id>/`: sanitized source HTML,
  `capture.json`, and an immutable report for that run. This directory is gitignored.

The subject-wide filenames omit `-1111`. Snapshots are atomically replaced only
after every discovered section passes validation. Failures preserve the previous
snapshot and return exit code **1**. Reports distinguish connection failures, HTTP
errors/rate limiting, access blocks, changed page structure, incomplete result sets,
wrong course/term/campus/CRN, invalid materials links, and interrupted runs. Missing
links are reported separately from failed requests. A recognized explicit “no
results” response means no sections found for that query, never no textbooks needed.

Each section contains:

| Fields | Meaning |
| --- | --- |
| `id` | Stable hash of institution + term + campus + CRN; separate from backend section IDs |
| `subject`, `number`, `title`, `sectionNumber`, `component`, `session`, `crn` | Observed course/section identity |
| `termId`, `termLabel`, `campus`, `status`, `units`, `instructionMode` | Observed offering information |
| `meetings` | All displayed meeting rows, including instructor, days/time, room and dates |
| `materialsUrl` | Actual link extracted from that section's materials panel; omitted if absent |
| `materialsLinkStatus` | `available` or `not_listed`; absence does not establish that materials are unnecessary |
| `materialsVerificationStatus` | Always `not_checked`: a link is not a verified textbook list |
| `source` | Public URL, request scope/action, retrieval time, sanitized evidence SHA-256 and file reference |
| `firstSeenAt`, `lastSeenAt`, `updatedAt` | First observation, latest observation, and latest **content change** |

The report's `changes` counts added, changed, unchanged, and removed records; `delta`
contains their IDs. A removed record is absent from this complete scope snapshot;
it does not cause any backend deletion. `contentSha256` excludes timestamps and
source-capture metadata, so repeated observations can be compared accurately.
Per-section evidence hashes include the actual captured public content. Cookies,
hidden session tokens, scripts, event handlers, and login credentials are not saved.

The parser verifies that the number of distinct sections extracted equals the
count declared by the official result page. Unrecognized pagination, truncation,
changed result ordering during a run, or duplicated CRNs cause a failure rather
than a false claim of full coverage. The current BIO response lists all sections
in one result page; support for a future paginated format requires a parser update.

## Replay without network

The live report records `capturePath`. Keep the capture directory if you want an
auditable offline reproduction; it can be copied along with its snapshot/report.
Paths inside this checkout are relative to the repository root. Example:

```sh
npm run sections:extract -- --term 2268 --subject BIO --course 1111 \
  --replay data/sections/.runs/2268-MAIN-BIO-1111/RUN_ID/capture.json \
  --output data/sections/.runs/replay-BIO-1111.json
```

Replace `RUN_ID` with the live report's actual directory. Replay verifies scope,
request sequence and exact saved-byte checksums; it makes no network requests and
preserves original retrieval times. It cannot replace a live snapshot. An offline
match proves parser reproducibility, **not** that the remote data is still current.
The pilot is also run twice with independent live sessions to check live repeatability.

## Checks and boundaries

```sh
npm run test:sections  # public HTML fixtures + network-free failure/replay tests
npm run check         # existing backend, infrastructure and all Python checks
```

Fixtures are sanitized official page captures. Tests explicitly label any generated
variants as synthetic; production snapshots contain only live observations. Tests
cover closed classes, count mismatches, wrong identities, unknown materials,
multiform responses, access blocks, offline checksums, connection failures, atomic
snapshot preservation and idempotent updates.

These are **discovery snapshots**. The separate `scripts/import-sections.cjs` bridge
maps catalog editions and preserves backend reference/version guards; the sync
pipeline invokes it after publishing live data. Offline replay never writes to the
database. See [import rules and recovery](section-pipeline.md#自动导入规则).
A successful run establishes repeatable
section/materials-link discovery, not access to Follett's textbook adoption data.
The next data-source milestone remains an authorized adoption feed/export or another
verified repeatable source of actual titles, ISBNs, editions and access-code requirements.

Official entry points: [Registrar Class Search](https://registrar.calpoly.edu/class-search)
and [Public Class Search](https://cmsweb.pscs.calpoly.edu/psc/CSLOPRD/EMPLOYEE/SA/c/COMMUNITY_ACCESS.CLASS_SEARCH.GBL).
