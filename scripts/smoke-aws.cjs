// Live release verification. The administrator secret stays in memory; no browser trace is recorded.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const AWS = require('../lambda/node_modules/aws-sdk');
const { chromium, webkit, expect: baseExpect } = require('../web/node_modules/@playwright/test');
const expect = baseExpect.configure({ timeout: 30000 });
const { verifiedClients } = require('./import-aws.cjs');
const root = path.resolve(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const config = read('config/aws-deployment.json');
const outputs = read('.local/aws/outputs.json')[config.stackName];
const base = outputs.WebsiteUrl;
assert.match(base, /^https:\/\/[a-z0-9]+\.cloudfront\.net$/);
const directory = path.join(root, '.local/aws/smoke');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const report = { startedAt: new Date().toISOString(), website: base, checks: [], complete: false };
let password;
const check = message => { report.checks.push(message); console.log(message); };
async function request(route, options = {}) {
  return fetch(base + '/api' + route, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
}
async function pages(collection, key) {
  const records = []; let token;
  do {
    const query = new URLSearchParams({ limit: '1000', ...(token ? { nextToken: token } : {}) });
    const response = await request('/' + collection + '?' + query);
    assert.equal(response.status, 200, 'Public collection HTTP status');
    const page = await response.json(); records.push(...page[key]); token = page.nextToken;
  } while (token);
  return records;
}
async function main() {
  const dynamo = await verifiedClients(config);
  const catalog = read(config.catalogPath);
  const courses = await pages('courses', 'courses');
  const byId = new Map(courses.map(c => [c.id, c]));
  for (const c of catalog.courses) {
    assert.equal(byId.get(c.id)?.title, c.title);
    assert.equal(byId.get(c.id)?.description, c.description);
  }
  check(`Verified all ${catalog.courseCount} current catalog IDs; ${courses.length} course records including retained legacy data.`);
  const sections = await pages('sections', 'sections');
  const course = catalog.courses.find(c => c.subject === 'BIO' && c.number === '1111');
  const expected = config.snapshots.flatMap(file => read(file).sections);
  assert.equal(sections.length, expected.length);
  for (const row of expected) {
    const parent = catalog.courses.find(c => c.subject === row.subject && c.number === row.number);
    const stored = sections.find(s => s.courseId === parent.id && s.crn === row.crn && s.termId === row.termId);
    assert.ok(stored, 'Expected section identity missing');
    assert.equal(stored.materialsUrl, row.materialsUrl);
    assert.equal(stored.sourceRetrievedAt, row.source.retrievedAt);
  }
  report.counts = { currentCatalog: catalog.courseCount, totalCourses: courses.length, sections: sections.length,
    materialsLinks: sections.filter(s => s.materialsUrl).length };
  check(`Verified ${sections.length} section identities and ${report.counts.materialsLinks} source-backed materials links.`);
  const section = sections.find(s => s.courseId === course.id && s.crn === '6370');
  const coursePath = '/courses/' + encodeURIComponent(course.id) + '?term=2268&section=' + encodeURIComponent(section.id);
  for (const route of ['/courses/not-a-course', '/admin/sections']) {
    const result = await fetch(base + route); assert.equal(result.status, 200);
    assert.match(await result.text(), /id="root"/);
  }
  const missing = await fetch(base + '/catalog/not-real.json');
  assert.ok(missing.status >= 400);
  assert.doesNotMatch(await missing.text(), /id="root"/);
  const unauthorized = await request('/sections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 403);
  check('Verified direct SPA routes, real missing-asset errors, and denied anonymous writes.');
  const credentials = new AWS.SsoCredentials({ profile: config.profile });
  const secret = await new AWS.SecretsManager({ region: config.region, credentials }).getSecretValue({ SecretId: outputs.AdminSecretArn }).promise();
  password = JSON.parse(secret.SecretString).password;
  const headers = { Authorization: 'Bearer ' + password, 'Content-Type': 'application/json' };
  const verified = await request('/verify', { method: 'POST', headers });
  assert.equal(verified.status, 200);
  const guardId = 'referenceGuard:' + createHash('sha256').update(JSON.stringify([course.id])).digest('hex');
  const guard = async () => (await dynamo.get({ TableName: config.tableName, Key: { id: guardId }, ConsistentRead: true }).promise()).Item?.count;
  const before = await guard(); let temporary;
  const body = { courseId: course.id, termId: 'DEPLOYMENT-SMOKE', sectionNumber: randomUUID().slice(0, 8),
    campus: 'San Luis Obispo', instructor: 'Temporary deployment validation' };
  temporary = { id: 'section:' + createHash('sha256').update(JSON.stringify([body.courseId, body.termId, body.sectionNumber, body.campus])).digest('hex') };
  try {
    let response = await request('/sections', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 201); temporary = (await response.json()).section;
    response = await request('/sections', { method: 'POST', headers, body: JSON.stringify({ ...body,
      id: temporary.id, instructor: 'Stale temporary edit', expectedVersion: temporary.version + 100 }) });
    assert.equal(response.status, 409);
    response = await request('/sections', { method: 'POST', headers, body: JSON.stringify({ ...body,
      id: temporary.id, instructor: 'Updated temporary validation', expectedVersion: temporary.version }) });
    assert.equal(response.status, 200); temporary = (await response.json()).section;
    response = await request('/sections/' + encodeURIComponent(temporary.id) + '?expectedVersion=1', { method: 'DELETE', headers });
    assert.equal(response.status, 409);
  } finally {
    if (temporary) {
      const response = await request('/sections/' + encodeURIComponent(temporary.id));
      if (response.status !== 404) {
        const current = (await response.json()).section;
        assert.ok(current, 'Temporary section needs cleanup');
        const removed = await request('/sections/' + encodeURIComponent(current.id) + '?expectedVersion=' + current.version, { method: 'DELETE', headers });
        assert.equal(removed.status, 204, 'Temporary section cleanup failed');
      }
    }
  }
  assert.equal(await guard(), before);
  check('Verified admin authentication, create/update, stale-edit/delete rejection, cleanup and unchanged reference count.');
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    let page;
    try {
      page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on('response', response => {
        if (response.status() >= 400 && response.url().includes('/api/')) {
          console.log(`${name} HTTP ${response.status()} ${new URL(response.url()).pathname}`);
        }
      });
      await page.goto(base);
      await expect(page.locator('.course-row')).toHaveCount(25);
      await page.getByLabel('Search courses', { exact: true }).fill('BIO1111');
      await expect(page.locator('.course-row')).toHaveCount(1);
      await page.goto(base + coursePath);
      await expect(page.getByRole('combobox', { name: 'Term', exact: true })).toHaveValue('2268');
      await expect(page.getByRole('link', { name: 'View official course materials' })).toHaveAttribute('href', /crn-1=6370/);
      await expect(page.getByRole('heading', { name: 'Materials have not been added' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('combobox', { name: 'Term', exact: true })).toHaveValue('2268');
      await expect(page.getByRole('heading', { name: 'Materials have not been added' })).toBeVisible();
      for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) {
        await page.setViewportSize({ width, height });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(directory, `${name}-course-${width}.png`), fullPage: true });
      }
      await page.goto(base + '/admin/sections');
      await page.getByLabel('Admin password').fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Create section', exact: true })).toBeEnabled();
      await expect(page.getByRole('textbox', { name: 'Search sections' })).toBeVisible();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByLabel('Admin password')).toBeVisible();
      await page.route('**/api/**', route => route.abort());
      await page.goto(base + coursePath);
      await expect(page.getByText('Cannot connect to the backend.', { exact: false })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'About this course' })).toBeVisible();
      check(`${name}: search, direct links/reload, materials source, three desktop sizes, admin login/sign-out and API outage passed.`);
    } catch (error) {
      const visible = await page?.locator('main').innerText().catch(() => 'Page unavailable');
      fs.writeFileSync(path.join(directory, `${name}-error.txt`), String(visible).split(password).join('[redacted]'), { mode: 0o600 });
      throw error;
    } finally { await browser.close(); }
  }
  report.complete = true;
}
main().catch(error => {
  const message = String(error.message).split(password || 'not-a-secret-placeholder').join('[redacted]');
  report.error = message; console.error(message); process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
});
