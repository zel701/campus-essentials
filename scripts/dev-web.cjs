const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const {
  localClients,
  prepareDatabase,
  createServer,
} = require("./local-api.cjs");
const root = path.resolve(__dirname, "..");
const local = path.join(root, ".local");
const dbPort = Number(process.env.DYNAMODB_LOCAL_PORT || 8765);
const apiPort = Number(process.env.API_PORT || 3001);
const webPort = Number(process.env.WEB_PORT || 5173);
const tableName = process.env.LOCAL_TABLE_NAME || "campus-essentials-local";
const testing = process.env.LOCAL_TEST_MODE === "1";
const children = [];
let server;
let exiting = false;
function cleanup(code = 0) {
  if (exiting) return;
  exiting = true;
  server?.close();
  children.forEach((child) => child.kill("SIGTERM"));
  setTimeout(() => {
    children.forEach((child) => child.kill("SIGKILL"));
    process.exit(code);
  }, 1200);
}
process.on("SIGINT", () => cleanup());
process.on("SIGTERM", () => cleanup());
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function checkPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid local port.");
  // On macOS a loopback bind can coexist with a wildcard listener. Check for
  // a live listener first so startup never seeds somebody else's database.
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Port ${port} is occupied or unavailable.`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`Port ${port} is occupied or unavailable.`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(new Error(`Port ${port} is occupied or unavailable.`));
    });
  });
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () =>
      reject(new Error(`Port ${port} is occupied or unavailable.`)),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
(async () => {
  if (
    !fs.existsSync(path.join(local, "runtime/DynamoDBLocal.jar")) ||
    !fs.existsSync(path.join(local, "admin-password"))
  )
    throw new Error("Run npm run local:setup first.");
  if (!fs.existsSync(path.join(root, "web/node_modules/vite/bin/vite.js")))
    throw new Error("Run npm ci --prefix web first.");
  if (new Set([dbPort, apiPort, webPort]).size !== 3)
    throw new Error("Local ports must be distinct.");
  await Promise.all([dbPort, apiPort, webPort].map(checkPort));
  if (testing && tableName === "campus-essentials-local")
    throw new Error("Tests need a separate local table.");
  const password = testing
    ? "browser-tests-only"
    : fs.readFileSync(path.join(local, "admin-password"), "utf8").trim();
  if (!password) throw new Error("Local admin password file is empty.");
  const catalog = spawnSync(
    process.execPath,
    [path.join(root, "scripts/prepare-web-catalog.cjs")],
    { stdio: "inherit" },
  );
  if (catalog.status !== 0) throw new Error("Catalog generation failed.");
  fs.mkdirSync(path.join(local, "database"), { recursive: true });
  const java = spawn(
    "java",
    [
      "-Djava.library.path=./DynamoDBLocal_lib",
      "-jar",
      "DynamoDBLocal.jar",
      "-sharedDb",
      "-port",
      String(dbPort),
      "-disableTelemetry",
      ...(testing ? ["-inMemory"] : ["-dbPath", path.join(local, "database")]),
    ],
    { cwd: path.join(local, "runtime"), stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(java);
  java.on("error", (error) => {
    console.error(error.message);
    cleanup(1);
  });
  java.stderr.on("data", (data) => console.error(String(data).trim()));
  java.on("exit", (code) => {
    if (!exiting) {
      console.error(`DynamoDB Local stopped (${code}).`);
      cleanup(1);
    }
  });
  const { db, dynamo } = localClients(dbPort);
  let ready = false;
  for (let n = 0; n < 60 && !exiting; n++) {
    try {
      await db.listTables({ Limit: 1 }).promise();
      ready = true;
      break;
    } catch {
      await pause(250);
    }
  }
  if (!ready) throw new Error("Local database did not become ready.");
  await prepareDatabase(db, dynamo, tableName);
  server = createServer({ dynamo, tableName, password });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(apiPort, "127.0.0.1", resolve);
  });
  console.log(
    `Local API ready on 127.0.0.1:${apiPort}. Admin password: .local/admin-password (not printed).`,
  );
  const vite = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    { cwd: path.join(root, "web"), env: process.env, stdio: "inherit" },
  );
  children.push(vite);
  vite.on("error", (error) => {
    console.error(error.message);
    cleanup(1);
  });
  vite.on("exit", (code) => {
    if (!exiting) cleanup(code || 0);
  });
})().catch((error) => {
  console.error(error.message);
  cleanup(1);
});
