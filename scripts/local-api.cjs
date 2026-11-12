const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const AWS = require("../lambda/node_modules/aws-sdk");
const { createHandler } = require("../lambda/index");
const root = path.resolve(__dirname, "..");

function localClients(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local DynamoDB port');
  const db = new AWS.DynamoDB({
    endpoint: `http://127.0.0.1:${port}`,
    region: "us-west-2",
    credentials: new AWS.Credentials("localonly", "localonly"),
    maxRetries: 2,
    httpOptions: { connectTimeout: 1000, timeout: 3000 },
  });
  return { db, dynamo: new AWS.DynamoDB.DocumentClient({ service: db }) };
}

async function prepareDatabase(db, dynamo, tableName) {
  if (!/^campus-essentials-local(?:-[a-zA-Z0-9-]+)?$/.test(tableName))
    throw new Error("Refusing a non-local table name.");
  try {
    await db.describeTable({ TableName: tableName }).promise();
  } catch (error) {
    if (error.code !== "ResourceNotFoundException") throw error;
    await db
      .createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: "S" },
          { AttributeName: "parentId", AttributeType: "S" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "by-parent",
            KeySchema: [
              { AttributeName: "parentId", KeyType: "HASH" },
              { AttributeName: "id", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      })
      .promise();
  }
  const raw = fs.readFileSync(path.join(root, "data/catalog/2026-2028.json"));
  const digest = createHash("sha256").update(raw).digest("hex");
  const marker = (
    await dynamo
      .get({
        TableName: tableName,
        Key: { id: "localCatalogSeed" },
        ConsistentRead: true,
      })
      .promise()
  ).Item;
  if (marker?.digest === digest) return;
  const snapshot = JSON.parse(raw);
  if (!snapshot.complete || snapshot.courses.length !== snapshot.courseCount)
    throw new Error("Refusing incomplete catalog seed.");
  console.log(`Seeding ${snapshot.courseCount} local catalog courses…`);
  for (let start = 0; start < snapshot.courses.length; start += 20) {
    await Promise.all(
      snapshot.courses.slice(start, start + 20).map((course) =>
        dynamo
          .put({
            TableName: tableName,
            Item: { ...course, entity: "course" },
            ConditionExpression:
              "attribute_not_exists(id) OR #entity = :entity",
            ExpressionAttributeNames: { "#entity": "entity" },
            ExpressionAttributeValues: { ":entity": "course" },
          })
          .promise(),
      ),
    );
  }
  await dynamo
    .put({
      TableName: tableName,
      Item: { id: "localCatalogSeed", entity: "localSeed", digest },
    })
    .promise();
}

function createServer({ dynamo, tableName, password }) {
  const handler = createHandler({
    dynamo,
    tableName: () => tableName,
    adminPassword: () => password,
  });
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/health" && req.method === "GET") {
        await dynamo
          .get({ TableName: tableName, Key: { id: "localCatalogSeed" } })
          .promise();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"ready"}');
        return;
      }
      const route =
        /^\/(verify|courses|sections|material-requirements|books|offers)(?:\/([^/]+))?$/.exec(
          url.pathname,
        );
      if (!route || (route[1] === "verify" && route[2])) {
        res.writeHead(404);
        res.end();
        return;
      }
      // Same-origin browser writes only. Explicit credentials are still checked by the handler.
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          res.writeHead(413);
          res.end();
          return;
        }
        chunks.push(chunk);
      }
      const bulk = route[1] === "courses" && route[2] === "bulk";
      const result = await handler({
        resource: "/" + route[1] + (route[2] ? (bulk ? "/bulk" : "/{id}") : ""),
        path: url.pathname,
        httpMethod: req.method,
        headers: req.headers,
        pathParameters:
          route[2] && !bulk ? { id: decodeURIComponent(route[2]) } : undefined,
        queryStringParameters: Object.fromEntries(url.searchParams),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      };
      // Vite proxies /api; the local adapter does not grant arbitrary websites CORS access.
      res.writeHead(result.statusCode, headers);
      res.end(result.body);
    } catch {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "Local backend unavailable. Check the local database and retry.",
        }),
      );
    }
  });
}
module.exports = { localClients, prepareDatabase, createServer };
