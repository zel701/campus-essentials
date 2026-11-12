# AWS deployment runbook

Verified deployed website: **https://dcedgja5njbt2.cloudfront.net**.
The current catalog (3,968 IDs), all 359 sections and 93 materials entry links were
verified through the public API. Chromium/WebKit smoke checks passed, including
administrator writes and version conflicts; temporary test records were removed.
The retained database also contains 84 older courses and 16 legacy/untyped records.
Local release/backup identifiers and results are in `.local/aws/deployment-result.json`.

The reviewed target is account `127214176503`, region `us-west-2`, SSO profile
`campus`, stack `CampusEssentialsStack`, table `campus-essentials`.
The public identifiers and seven snapshot paths are in `config/aws-deployment.json`;
no credentials belong in that file. This is an update to an existing deployment.
The old API contains manually added paths outside CloudFormation. The target's
`preserveLegacyApi` option retains its original managed routes and creates a separate
`CampusWebsiteApi` for the site, avoiding conflicts or removal of those manual paths.
Use the new `ApiUrl` output; the original API endpoint output is retained for legacy use.
The website API uses two Lambda invoke permissions scoped by API ARN and account
(main handler and the price-entry handler), avoiding per-route policy growth and
Lambda's 20 KB resource-policy limit. Password checks still apply to every write.

## Prepare and review

```sh
aws sso login --profile campus
aws sts get-caller-identity --profile campus
npm ci
npm ci --prefix lambda
npm ci --prefix web
npm run check
npm run test:web
npm run aws:prepare
npm run aws:diff
```

`aws:prepare` builds the current static catalog and frontend with `/api`, then
synthesizes the full stack with website hosting enabled. Always rebuild before
deploying. `aws:diff` uses `--no-change-set`, so reviewing does not create a change
set or upload deployment assets. Old templates/diffs may include historical secret
configuration; keep raw output private and do not paste it into chat or commit it.

Keep the current table and API logical IDs. Do not proceed if a review shows the
table being replaced or removed. Back up the existing table before the first
update. An AWS on-demand backup is a separate cloud write with possible storage
charges. Existing legacy records remain in place; they are not automatically migrated.

## Deployment and administrator access

The account/region must already be CDK-bootstrapped; if not, an authorized operator
runs `npx cdk bootstrap aws://127214176503/us-west-2 --profile campus` first.
After approval of the reviewed changes:

```sh
mkdir -p .local/aws
npm run aws:deploy
```

This command adds the managed website API, updates the Lambdas/table, adds the `by-parent` index,
enables table deletion protection and point-in-time recovery, and publishes the
website through a private, versioned S3 bucket and CloudFront OAC. API stage
throttling is 20 requests/second with a burst limit of 40. This is not a spending cap.
Secrets Manager, backups, requests, storage, and content delivery can incur charges;
configure account budget notifications for the chosen budget.

CloudFormation generates an administrator credential in Secrets Manager. The
`AdminSecretArn` output identifies it. Privately retrieve the JSON `password` value
through the Secrets Manager console and enter it in the website's admin login.
It is not the SSO password or local `.local/admin-password`. No password is passed
on a shell command line or bundled into the website. CloudFormation resolves the
secret into the Lambda environment; principals with Lambda configuration access
can access it. Changing the secret alone does not refresh that environment; password
rotation requires synchronizing/redeploying the function configuration.

Outputs are saved in gitignored `.local/aws/outputs.json`: `WebsiteUrl`, `ApiUrl`,
`TableName`, and `AdminSecretArn`. Preserve the prior build for rollback. Database
and website bucket have retention enabled; deleting the stack is not a rollback
procedure. Deletion protection does not protect against erroneous record writes.

## Import saved data

```sh
npm run aws:import              # dry-run: local validation + STS/table reads only
npm run aws:import -- --apply   # explicit write to the reviewed target
```

The importer uses the named SSO profile and rejects the wrong account, region,
table ARN, inactive table, or missing parent index. The dry-run checks all saved
catalog/course and section identities before any writes. On the old schema it
reports that deployment must happen first. It does not seed or create AWS resources.

After the schema update, `--apply` writes the 3,968 saved catalog courses first,
then the 359 sections in the seven explicit complete live snapshots. It reuses
backend validation/entity conditions and the same section version/reference
transactions as the local importer. Admin-owned sections are protected. Repeated
section import does not create duplicates or advance unchanged versions; catalog
uploads refresh their write timestamps. Import is per record, not one transaction
for the whole batch. On a failure, earlier writes may already exist; retain the
report and rerun the same inputs after resolving the failure.

Reports with target, timestamps, counts, individual section outcomes and failures
are under `.local/aws/imports/`. Only saved source observations are imported: 93
materials entry URLs are not verified textbook requirements. No books, requirements
or prices are invented. Old records and reference guards are never bulk-deleted;
the total table count may exceed the current catalog plus sections.

`sections:sync`, `sections:expand`, and `sections:import` remain local-only. After
future successful local collection, review/update `snapshots` in the AWS config,
then use the explicit AWS importer to publish. No cloud schedule is enabled.

## Website routing and smoke checks

The generated website uses same-origin `/api/*`. CloudFront removes `/api` and
forwards the request to the API's `prod` stage, retaining authorization, query
strings and all supported methods with caching disabled. Lambda disables cross-origin
browser access when website hosting is enabled. Public API GETs remain readable by
non-browser clients; CORS is not authentication.

Only course/admin SPA routes rewrite to `index.html`. Missing catalog JSON/assets
and API errors keep their actual error status. CloudFront and origin connections
use HTTPS. Static responses use revalidation and deployment invalidates the cache.

Before announcing the site, check the actual `WebsiteUrl` in desktop Chromium and
WebKit: search BIO 1111, open a direct course URL and refresh, select Fall 2026/S02,
check the official materials link and source date, verify missing requirements are
shown as unknown, and confirm unauthorized writes are denied. Test admin sign-in
with the new secret, stale-edit handling, and API outage behavior. If testing
create/update/delete, use clearly labeled temporary records and remove them with
their expected versions after validation. Verify each saved catalog ID and all
359 section IDs, follow continuation tokens, and check all 93 materials links.
`npm run aws:smoke` automates these checks against the deployed outputs. It retrieves
the administrator secret only into memory, temporarily creates/edits/deletes one
clearly labeled deployment-test section, checks stale versions and reference counts,
and runs Chromium/WebKit without traces or screenshots of password entry. Student
screenshots and its result report are saved in `.local/aws/smoke/`.
The Lambda proxy decodes API Gateway path IDs once at the request boundary. Local
adapter IDs are already decoded and remain unchanged; live tests cover encoded
IDs for reads and versioned deletes.

If a release fails, restore the prior frontend build/backend code while preserving
table logical IDs and data. Review PITR recovery separately: it restores into a
new table and requires a deliberate cutover. Do not delete the current database
as an incident-recovery shortcut.
