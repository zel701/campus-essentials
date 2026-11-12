# Courses, sections, materials, books, and offers

The existing `campus-essentials` DynamoDB table and its `id` primary key remain in place. New records use `schemaVersion: 2`; existing catalog IDs and legacy records are preserved. No data migration or cloud deployment happens just by applying these code changes.

| Record | Purpose | Relationship |
| --- | --- | --- |
| `course` | Catalog code, title, description, units, prerequisites, edition | Independent of term/instructor |
| `section` | Term, section number, campus, optional instructor and CRN | `courseId` references a catalog course |
| `materialRequirement` | Required/recommended/optional material and verification evidence | `sectionId`; also `bookId` for a book |
| `book` | Title, author, edition, format, optional normalized ISBN-13 | Reusable across sections |
| `offer` | Seller, price, condition, purchase type, URL, last checked time | `bookId` identifies the exact book/format |

```mermaid
flowchart LR
  Course --> Section
  Section --> Requirement[Material requirement]
  Requirement --> Book
  Book --> Offer[Seller offer]
```

## Endpoints

All new collections support public `GET`, admin `POST`, public `GET /{id}`, and admin `DELETE /{id}`. Existing admin authentication and CORS rules apply. There are no bulk endpoints for these four new collections yet.

| Collection | List filters | Response key |
| --- | --- | --- |
| `/sections` | `courseId`, `termId` | `sections` / `section` |
| `/material-requirements` | `sectionId` | `materialRequirements` / `materialRequirement` |
| `/books` | `isbn` (ISBN-10 or ISBN-13) | `books` / `book` |
| `/offers` | `bookId` | `offers` / `offer` |

All lists accept `limit` (1–1000, default 100) and `nextToken`. Pass the token back with the same filters and collection; tokens cannot be reused across queries. A page can be empty with a continuation token because filtering happens after the database page is read. Collections without a parent filter still scan the table. Parent filters use the new `by-parent` global secondary index (`parentId`, `id`). Index reads are eventually consistent; immediate GET-by-ID uses a strongly consistent read.

## Example workflow

These are illustrative payloads, not verified Cal Poly requirements or seller offers. Replace placeholder IDs with IDs returned by the preceding requests. The existing catalog provides course IDs via `GET /courses`.

1. `POST /sections`:

```json
{
  "courseId": "<catalog-course-id>",
  "termId": "2026-Fall",
  "sectionNumber": "01",
  "campus": "San Luis Obispo",
  "instructor": "Example Instructor"
}
```

Course, term, section number, and campus define a section's identity. Changing instructor or CRN edits that section rather than creating a new one. Instructor and CRN can be absent when not yet known. Term IDs are explicit strings; no term schedule is fetched or inferred.

Optional section fields also include `termLabel` (display text), `sourceUrl`,
`sourceRetrievedAt` (UTC observation timestamp), and `materialsUrl` (official
materials entry point, not a verified book requirement). The local importer maps
public schedule snapshots to these records, retaining the existing stable backend
IDs. Internal `sectionImport` metadata records the discovery ID, evidence hash/file,
link status, and `managedVersion`; clients cannot set it through HTTP. An admin edit
advances the record version without advancing `managedVersion`, so future imports
leave that row protected. Older admin forms preserve imported link/provenance fields
when omitted. Full observations remain in the source JSON and capture files.

2. `POST /books`:

```json
{
  "isbn": "9780306406157",
  "title": "Example title",
  "author": "Example author",
  "edition": "1",
  "format": "paperback"
}
```

ISBN checksums are validated and ISBN-10 is normalized to ISBN-13. Supported formats: `paperback`, `hardcover`, `ebook`, `loose-leaf`, `bundle`, `other`. ISBN plus format determines identity. Without an ISBN, title, author, edition, and format determine identity. An ISBN is not proof that the entered title or edition is correct; verify that against the source before using it for price matching.

3. `POST /material-requirements`:

```json
{
  "sectionId": "<section-id>",
  "materialType": "book",
  "title": "Course textbook",
  "bookId": "<book-id>",
  "requirementLevel": "required",
  "verificationStatus": "verified",
  "sourceUrl": "https://example.edu/syllabus",
  "verifiedAt": "2026-09-24T12:00:00Z",
  "accessCodeRequired": true
}
```

Material types: `book`, `supply`, `software`, `other`. A book requirement needs a real book record; other material types have a title without `bookId`. Requirements can be `required`, `recommended`, or `optional`. Verification defaults to `unverified`; marking verified requires both a source URL and timestamp. This records an admin's verification claim; the backend does not fetch or authenticate the syllabus. `notes` and `accessCodeRequired` are optional. Absence of requirements means unknown coverage, not “nothing required.”

4. `POST /offers`:

```json
{
  "bookId": "<book-id>",
  "seller": "Example seller",
  "price": 25.99,
  "currency": "USD",
  "shippingPrice": 3.50,
  "url": "https://example.com/book",
  "condition": "used",
  "purchaseType": "buy",
  "checkedAt": "2026-09-24T12:00:00Z",
  "accessCodeIncluded": false
}
```

Conditions: `new`, `used`, `digital`, `unspecified`. Purchase types: `buy`, `rent`, `borrow`; rentals require `rentalDays` (1–3650). Prices are non-negative numeric USD amounts with at most two decimal places; zero is supported. Shipping and access-code inclusion may be omitted when unknown. Unknown shipping is not treated as free. `checkedAt` is required, and no live price freshness is implied. This step stores offers; it does not rank offers or perform currency conversion, tax calculation, scraping, or ISBN lookup.

## Editing and retries

New records receive deterministic IDs, version `1`, `createdAt`, and `updatedAt`. Repeating an identical POST returns the existing record (`200`) without duplicating records or reference counts. A new record returns `201`.

To edit, POST the complete payload with the current `expectedVersion`. Successful changes increment the version. Stale or missing versions for edits return `409`; reload and reapply the edit. Optional fields omitted from a complete update are removed. Do not repost response-only fields such as `entity`, `schemaVersion`, `version`, or timestamps: unknown fields are rejected.

An optional supplied `id` must match the deterministic identity. Identity fields cannot be changed in place: create the replacement record and explicitly remove the old record after updating dependents. For an ISBN-bearing book, a change from one ISBN/format to another therefore creates a new book record. No book or material substitution is automatic.

DELETE accepts optional `expectedVersion` as a query parameter. It returns `204` for new entities; the existing course delete route retains its `200` response. Missing/wrong-type records return `404`. Reads remain public; writes require admin access.

## Reference integrity and deletion

Each new write checks parent existence and entity type in a DynamoDB transaction. A section must reference a catalog course, not an old record containing term/instructor fields. Requirements check their section and, for books, their book. Offers check their book.

Internal `referenceGuard` records count dependents. They are changed in the same transaction as child creation/deletion; normal catalog imports do not replace them. A referenced course, section, or book cannot be deleted until its dependents have been removed. This prevents a child creation racing with parent deletion from producing an orphan. Guards with count zero are retained; they are not returned in public collection lists. Transaction conflicts return `409`; capacity failures return `503`. SDK retries reuse a transaction token.

No cascading deletion is performed. Delete requirements and offers first, then sections/books, then courses if desired. These guarantees apply to writes through this API; direct DynamoDB edits can bypass them. The CDK stack adds one GSI and permission for transaction condition checks to the existing table; deploy those changes before using the new filtered endpoints.

## Legacy compatibility

`/items`, `/course-items`, their nested aliases, and `/scrape` remain available for old clients. They continue to represent legacy item/link data and are not silently reinterpreted as books, offers, or verified section requirements. Legacy association references do not participate in the new guard counters.

Existing mixed course records remain readable. New `/courses` writes reject non-empty `termId`, `crn`, and `instructor`; use `/sections` instead. The catalog importer's IDs and all 3,968 saved catalog records are unchanged. To migrate an old mixed record, identify its matching catalog course and confirm term, section number, and campus before creating a section. Keep the old record until reviewed. Legacy item titles/URLs alone are insufficient to infer ISBNs, editions, prices, or section requirements; this step does not guess those mappings.

## Verification

`npm run check` includes stateful tests for the relationship chain, duplicate retries, ISBN normalization, version conflicts, missing parents, evidence requirements, pagination, deletion protection, and an interrupted parent-creation race, as well as CDK index/route/IAM assertions.

Optional integration verification against [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html): start it on port 8765 with `-inMemory -sharedDb -port 8765`, then run `npm run test:dynamodb-local`. Set `DYNAMODB_LOCAL_PORT` to use another port. The test only connects to `127.0.0.1` with fake credentials, creates a uniquely named test table, and deletes that table in `finally`. It never uses an AWS account or production table.
