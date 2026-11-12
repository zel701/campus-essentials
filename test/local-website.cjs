// Real disk-backed local operation test. Uses its own temporary data directory and ports.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const {
  localClients,
  prepareDatabase,
  createServer,
} = require("../scripts/local-api.cjs");
const root = path.resolve(__dirname, "..");
const tableName = "campus-essentials-local-persistence-test";
const password = "isolated-operation-test";
const dbPort = 8767;
const apiPort = 3003;
let java;
let server;
let directory;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { db, dynamo } = localClients(dbPort);
async function unused(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}
async function start() {
  java = spawn(
    "java",
    [
      "-Djava.library.path=./DynamoDBLocal_lib",
      "-jar",
      "DynamoDBLocal.jar",
      "-sharedDb",
      "-disableTelemetry",
      "-port",
      String(dbPort),
      "-dbPath",
      directory,
    ],
    { cwd: path.join(root, ".local/runtime"), stdio: "ignore" },
  );
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (java.exitCode !== null) throw new Error("Test database exited.");
    try {
      await db.listTables({ Limit: 1 }).promise();
      ready = true;
      break;
    } catch {
      await pause(200);
    }
  }
  assert.ok(ready, "database ready");
  await prepareDatabase(db, dynamo, tableName);
  server = createServer({ dynamo, tableName, password });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(apiPort, "127.0.0.1", resolve);
  });
}
async function stop() {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
  if (java && java.exitCode === null) {
    const stopped = once(java, "exit");
    java.kill("SIGTERM");
    await stopped;
  }
  java = undefined;
}
async function call(route, method = "GET", body, credential = password) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}
(async () => {
  await unused(dbPort);
  await unused(apiPort);
  directory = fs.mkdtempSync(path.join(root, ".local/persistence-test-"));
  try {
    await start();
    assert.equal(
      (await call("/verify", "POST", undefined, "wrong")).status,
      403,
    );
    assert.equal((await call("/verify", "POST")).status, 200);
    const course = JSON.parse(
      fs.readFileSync(path.join(root, "data/catalog/2026-2028.json")),
    ).courses[0];
    const sectionBody = {
      courseId: course.id,
      termId: "TEST-PERSISTENCE",
      sectionNumber: "01",
      campus: "San Luis Obispo",
    };
    const created = await call("/sections", "POST", sectionBody);
    assert.equal(created.status, 201);
    const section = created.body.section;
    const material = await call("/material-requirements", "POST", {
      sectionId: section.id,
      materialType: "supply",
      title: "Isolated test supply",
      requirementLevel: "recommended",
      verificationStatus: "unverified",
    });
    assert.equal(material.status, 201);
    // Force the next startup through the changed-snapshot seed path without altering the saved snapshot.
    await dynamo
      .delete({ TableName: tableName, Key: { id: "localCatalogSeed" } })
      .promise();
    await stop();
    await start();
    const restored = await call(`/sections/${encodeURIComponent(section.id)}`);
    assert.deepEqual(restored.body.section, section);
    assert.equal(
      (
        await call(
          `/sections/${encodeURIComponent(section.id)}?expectedVersion=1`,
          "DELETE",
        )
      ).status,
      409,
      "reference guards survive reseeding and restart",
    );
    const update = await call("/sections", "POST", {
      ...sectionBody,
      instructor: "Changed",
      expectedVersion: 1,
    });
    assert.equal(update.status, 200);
    assert.equal(
      (
        await call("/sections", "POST", {
          ...sectionBody,
          instructor: "Stale",
          expectedVersion: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          `/sections/${encodeURIComponent(section.id)}?expectedVersion=1`,
          "DELETE",
        )
      ).status,
      409,
    );
    const launcher = spawn(process.execPath, ["scripts/dev-web.cjs"], {
      cwd: root,
      env: {
        ...process.env,
        DYNAMODB_LOCAL_PORT: String(dbPort),
        API_PORT: "3004",
        WEB_PORT: "5175",
      },
    });
    let output = "";
    launcher.stdout.on("data", (data) => (output += data));
    launcher.stderr.on("data", (data) => (output += data));
    const [code] = await once(launcher, "exit");
    assert.equal(code, 1);
    assert.match(output, /occupied or unavailable/);
    const stopped = once(java, "exit");
    java.kill("SIGTERM");
    await stopped;
    const unavailable = await call("/health");
    assert.equal(unavailable.status, 503);
    console.log(
      "Local operation passed: HTTP auth, disk persistence across restart, reseeding, preserved reference guards, stale writes/deletes, occupied-port refusal, and database outage.",
    );
  } finally {
    await stop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
