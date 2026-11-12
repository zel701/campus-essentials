const AWS = require("aws-sdk");
const { randomUUID, createHash, timingSafeEqual } = require("node:crypto");
function createHandler({ dynamo = new AWS.DynamoDB.DocumentClient({ maxRetries: 2, httpOptions: { connectTimeout: 1000, timeout: 2000 } }), tableName = () => process.env.TABLE_NAME, adminPassword = () => process.env.ADMIN_PASSWORD } = {}) {

const CORS_HEADERS = {
  ...(process.env.CORS_ORIGIN === '' ? {} : { "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*" }),
  "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,x-admin-password",
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET,DELETE",
};

class HttpError extends Error {
  constructor(statusCode, message, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

function objectBody(event) {
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "{}";
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object") throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON.");
  }
}

function validateRecord(record, fields) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new HttpError(400, "Each record must be an object.");
  }
  for (const field of fields) {
    if (typeof record[field] !== "string" || !record[field].trim()) {
      throw new HttpError(400, `${field} must be a non-empty string.`);
    }
  }
  if (record.id !== undefined && (typeof record.id !== "string" || !record.id.trim() || Buffer.byteLength(record.id) > 2048)) {
    throw new HttpError(400, "id must be a non-empty string of at most 2048 bytes.");
  }
}

function makeCourse(record) {
  // Course numbers can arrive as numbers from older clients or strings from CSV.
  if (record && typeof record === "object" && !Array.isArray(record)) {
    record = { ...record, number: record.number == null ? "" : String(record.number) };
  }
  validateRecord(record, ["subject", "number", "title"]);
  if (["termId", "crn", "instructor"].some(field => record[field] !== undefined && record[field] !== "" && record[field] !== null)) {
    throw new HttpError(400, "Course records contain catalog data only. Save termId, crn, and instructor through /sections.");
  }
  const course = {
    entity: "course",
    subject: record.subject.trim().toUpperCase(),
    number: record.number.trim(),
    title: record.title.trim(),
  };
  for (const field of ["description", "units", "term", "prerequisite", "recommended", "corequisite", "catalogEdition", "sourceUrl", "retrievedAt", "concurrent", "geArea", "gradingBasis", "catalogDetails", "campus"]) {
    if (record[field] !== undefined && record[field] !== null) {
      if (!["string", "number"].includes(typeof record[field])) throw new HttpError(400, `${field} must be text.`);
      course[field] = String(record[field]);
    }
  }
  // Preserve the catalog IDs used by existing snapshots; offering fields now live on sections.
  const identity = [course.subject, course.number, course.catalogEdition || "", "", "", ""];
  course.id = record.id || `course:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  course.timestamp = new Date().toISOString();
  return course;
}

function makeCourseItem(record) {
  validateRecord(record, ["courseId", "itemId"]);
  if (record.required !== undefined && typeof record.required !== "boolean") throw new HttpError(400, "required must be a boolean.");
  if (record.notes !== undefined && typeof record.notes !== "string") throw new HttpError(400, "notes must be text.");
  return {
    id: record.id || `courseItem:${createHash("sha256").update(JSON.stringify([record.courseId, record.itemId])).digest("hex")}`,
    entity: "courseItem", courseId: record.courseId, itemId: record.itemId,
    required: record.required !== false, notes: record.notes || "",
    timestamp: new Date().toISOString(),
  };
}

function entityCondition(entity) {
  return {
    ConditionExpression: "attribute_not_exists(id) OR #entity = :entity",
    ExpressionAttributeNames: { "#entity": "entity" },
    ExpressionAttributeValues: { ":entity": entity },
  };
}

async function putRecord(record) {
  // A client-supplied ID must never overwrite a different kind of record.
  await dynamo.put({ TableName: tableName(), Item: record, ...entityCondition(record.entity) }).promise();
}

async function writeImport(items, context = {}) {
  if (items.length > 100) throw new HttpError(400, "Import at most 100 records per request.");
  if (new Set(items.map(item => item.id)).size !== items.length) throw new HttpError(400, "Import contains duplicate record IDs.");
  let completed = 0;
  // Conditional puts protect entity boundaries; the SDK retries transient failures.
  // Report partial progress instead of claiming the entire import succeeded.
  for (const item of items) {
    try {
      if (context.getRemainingTimeInMillis && context.getRemainingTimeInMillis() < 12000) {
        throw new Error("Insufficient time for another write");
      }
      await putRecord(item);
      completed++;
    } catch (error) {
      throw new HttpError(error.code === "ConditionalCheckFailedException" ? 409 : 503,
        "Import stopped. Earlier records may have been saved; retry with the same IDs.",
        { completed, remaining: items.length - completed, failedId: item.id });
    }
  }
}

async function scanPage(event) {
  const query = event.queryStringParameters || {};
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, "limit must be an integer from 1 to 1000.");
  const params = { TableName: tableName(), Limit: limit };
  if (query.nextToken) {
    try {
      const key = JSON.parse(Buffer.from(query.nextToken, "base64url").toString("utf8"));
      if (!key || typeof key.id !== "string" || !key.id || Object.keys(key).length !== 1 || Buffer.byteLength(key.id) > 2048) throw new Error();
      params.ExclusiveStartKey = key;
    } catch { throw new HttpError(400, "Invalid nextToken."); }
  }
  const result = await dynamo.scan(params).promise();
  return { ...result, nextToken: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url") : null };
}

function isAdmin(event) {
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const expected = adminPassword();
  if (!expected) return false;
  const auth = headers.authorization;
  const bearer = typeof auth === "string" && /^bearer /i.test(auth) ? auth.slice(7).trim() : undefined;
  return [headers["x-admin-password"], bearer].some(value => {
    if (typeof value !== "string") return false;
    const actualBytes = Buffer.from(value);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  });
}

const academicApi = require("./academic-records").createAcademicApi({
  dynamo, tableName: () => tableName(), isAdmin, readBody: objectBody,
  HttpError, headers: CORS_HEADERS,
});

return async (event, context = {}) => {
  const method = event.httpMethod;
  const path = (event.resource || event.path || "").replace(/\/$/, "");

  if (method === "OPTIONS") {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ message: "CORS preflight success" }),
    };
  }

  try {
    // REST API Gateway forwards encoded path parameters to the Lambda proxy.
    // The local adapter already decodes them and has no API Gateway requestContext.
    if (event.requestContext?.apiId && typeof event.pathParameters?.id === 'string') {
      try {
        event = { ...event, pathParameters: { ...event.pathParameters, id: decodeURIComponent(event.pathParameters.id) } };
      } catch { throw new HttpError(400, 'Invalid URL encoding in record ID.'); }
    }
    const academicResponse = await academicApi.handle(event, path);
    if (academicResponse) return academicResponse;
    if (path.endsWith("/verify")) {
      if (method === "POST") {
        if (isAdmin(event)) {
          return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              message: "Password verified successfully.",
            }),
          };
        } else {
          return {
            statusCode: 403,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Invalid password" }),
          };
        }
      }
    }

    // --- COURSE ITEM BY ID (for DELETE) ---
    else if (["/courses/course-items/{id}", "/course-items/{id}"].includes(path) && event.pathParameters?.id) {
      const courseItemId = event.pathParameters.id;

      if (method === "DELETE") {
        if (!isAdmin(event)) {
          return {
            statusCode: 403,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Invalid admin password" }),
          };
        }

        const courseId = event.queryStringParameters?.courseId;
        if (!courseId) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "courseId is required" }),
          };
        }

        // Look up by id (matches your table key)
        const { Item } = await dynamo
          .get({
            TableName: tableName(),
            Key: { id: courseItemId },
          })
          .promise();

        if (!Item || Item.entity !== "courseItem") {
          return {
            statusCode: 404,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Course item not found" }),
          };
        }

        // Make sure it belongs to requested course
        if (Item.courseId !== courseId) {
          return {
            statusCode: 404,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              error: "Course item not found in specified course",
            }),
          };
        }

        // ✅ Delete by id only (same key as GET)
        await dynamo
          .delete({
            TableName: tableName(),
            Key: { id: courseItemId },
            ConditionExpression: "#entity = :entity AND courseId = :courseId",
            ExpressionAttributeNames: { "#entity": "entity" },
            ExpressionAttributeValues: { ":entity": "courseItem", ":courseId": courseId },
          })
          .promise();

        // 204 No Content is ideal for DELETE
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
      }
    }

    // --- ID ROUTES (items or courses) ---
    else if (["/courses/{id}", "/items/{id}"].includes(path) && event.pathParameters?.id) {
      const id = event.pathParameters.id;

      // Courses by ID
      if (path.includes("/courses/") && !path.includes("/course-items")) {
        if (method === "GET") {
          const params = { TableName: tableName(), Key: { id } };
          const data = await dynamo.get(params).promise();
          const item = data.Item || null;
          if (!item || item.entity !== "course") {
            return {
              statusCode: 404,
              headers: CORS_HEADERS,
              body: JSON.stringify({ error: "Course not found" }),
            };
          }
          return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({ course: item }),
          };
        } else if (method === "DELETE") {
          if (!isAdmin(event)) {
            return {
              statusCode: 403,
              headers: CORS_HEADERS,
              body: JSON.stringify({ error: "Invalid admin password" }),
            };
          }
          // Ensure we only delete a course entity
          const getParams = { TableName: tableName(), Key: { id } };
          const found = await dynamo.get(getParams).promise();
          if (!found.Item || found.Item.entity !== "course") {
            return {
              statusCode: 404,
              headers: CORS_HEADERS,
              body: JSON.stringify({ error: "Course not found" }),
            };
          }
          await academicApi.deleteCourse(id);
          return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({ message: `Course with id ${id} deleted.` }),
          };
        }
      }

      // Items by ID (default)
      else {
        if (method === "GET") {
          const params = { TableName: tableName(), Key: { id } };
          const data = await dynamo.get(params).promise();
          if (!data.Item || (data.Item.entity && data.Item.entity !== "item")) throw new HttpError(404, "Item not found.");
          return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({ item: data.Item }),
          };
        } else if (method === "DELETE") {
          if (!isAdmin(event)) {
            return {
              statusCode: 403,
              headers: CORS_HEADERS,
              body: JSON.stringify({ error: "Invalid admin password" }),
            };
          }
          const deleteParams = {
            TableName: tableName(),
            Key: { id },
            ConditionExpression: "attribute_exists(id) AND (attribute_not_exists(#entity) OR #entity = :entity)",
            ExpressionAttributeNames: { "#entity": "entity" },
            ExpressionAttributeValues: { ":entity": "item" },
          };
          await dynamo.delete(deleteParams).promise();
          return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({ message: `Item with id ${id} deleted.` }),
          };
        }
      }
    }

    // --- COURSES BULK IMPORT ---
    else if (path.endsWith("/courses/bulk")) {
      if (method === "POST") {
        if (!isAdmin(event)) {
          return {
            statusCode: 403,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Forbidden: Invalid password" }),
          };
        }
        const payload = objectBody(event);
        const inputArray = Array.isArray(payload)
          ? payload
          : Array.isArray(payload.courses)
          ? payload.courses
          : [];
        if (inputArray.length === 0) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "No courses provided" }),
          };
        }
        const toPut = inputArray.map(makeCourse);
        await writeImport(toPut, context);
        return {
          statusCode: 201,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            message: `Imported ${toPut.length} courses.`,
            count: toPut.length,
          }),
        };
      }
    }

    // --- COURSE ITEMS (required textbooks/materials) ---
    else if (path.endsWith("/course-items")) {
      if (method === "GET") {
        const courseId = event.queryStringParameters?.courseId;
        const data = await scanPage(event);
        const courseItemsOnly = (data.Items || []).filter(
          (it) => it.entity === "courseItem"
        );

        if (courseId) {
          const filtered = courseItemsOnly.filter(
            (ci) => ci.courseId === courseId
          );
          return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({ courseItems: filtered, nextToken: data.nextToken }),
          };
        }

        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({ courseItems: courseItemsOnly, nextToken: data.nextToken }),
        };
      } else if (method === "POST") {
        if (!isAdmin(event)) {
          return {
            statusCode: 403,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Forbidden: Invalid password" }),
          };
        }
        const requestData = objectBody(event);
        const courseItem = makeCourseItem(requestData);
        await putRecord(courseItem);
        return {
          statusCode: 201,
          headers: CORS_HEADERS,
          body: JSON.stringify({ message: "Course item added!", courseItem }),
        };
      }
    }



    // --- COURSE ITEMS BULK ---
    else if (path.endsWith("/course-items/bulk")) {
      if (method === "POST") {
        if (!isAdmin(event)) {
          return {
            statusCode: 403,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Forbidden: Invalid password" }),
          };
        }
        const payload = objectBody(event);
        const inputArray = Array.isArray(payload)
          ? payload
          : Array.isArray(payload.courseItems)
          ? payload.courseItems
          : [];
        if (inputArray.length === 0) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "No course items provided" }),
          };
        }
        const toPut = inputArray.map(makeCourseItem);
        await writeImport(toPut, context);
        return {
          statusCode: 201,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            message: `Added ${toPut.length} items to courses.`,
            count: toPut.length,
          }),
        };
      }
    }

    // --- COURSES COLLECTION ---
    else if (path.endsWith("/courses")) {
      if (method === "GET") {
        const query = event.queryStringParameters?.q;
        const data = await scanPage(event);
        const coursesOnly = (data.Items || []).filter(
          (it) => it.entity === "course"
        );

        if (query && query.trim() !== "") {
          const qLower = query.toLowerCase();
          const filtered = coursesOnly.filter((c) => {
            const subject = String(c.subject || "").toLowerCase();
            const number = String(c.number || "").toLowerCase();
            const title = String(c.title || "").toLowerCase();
            const crn = String(c.crn || "").toLowerCase();
            const instructor = String(c.instructor || "").toLowerCase();
            const termId = String(c.termId || "").toLowerCase();
            return (
              subject.includes(qLower) ||
              number.includes(qLower) ||
              `${subject} ${number}`.includes(qLower) ||
              title.includes(qLower) ||
              crn.includes(qLower) ||
              instructor.includes(qLower) ||
              termId.includes(qLower)
            );
          });
          return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              courses: filtered,
              total: filtered.length,
              nextToken: data.nextToken,
              q: query,
            }),
          };
        }

        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({ courses: coursesOnly, nextToken: data.nextToken }),
        };
      } else if (method === "POST") {
        if (!isAdmin(event)) {
          return {
            statusCode: 403,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Forbidden: Invalid password" }),
          };
        }
        const requestData = objectBody(event);
        const course = makeCourse(requestData);
        await putRecord(course);
        return {
          statusCode: 201,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            message: "Course saved to DynamoDB!",
            course,
          }),
        };
      }
    }

    // --- ITEMS COLLECTION ---
    else if (path.endsWith("/items")) {
      if (method === "GET") {
        const query = event.queryStringParameters?.q;
        const data = await scanPage(event);

        const itemsOnly = (data.Items || []).filter(
          (it) => !it.entity || it.entity === "item"
        );

        if (query && query.trim() !== "") {
          const qLower = query.toLowerCase();
          const filtered = itemsOnly.filter((item) => {
            const name = String(item.itemName || "").toLowerCase();
            const url = String(item.url || "").toLowerCase();
            return name.includes(qLower) || url.includes(qLower);
          });

          return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              items: filtered,
              total: filtered.length,
              nextToken: data.nextToken,
              q: query,
            }),
          };
        }

        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({ items: itemsOnly, nextToken: data.nextToken }),
        };
      } else if (method === "POST") {
        if (!isAdmin(event)) {
          return {
            statusCode: 403,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Forbidden: Invalid password" }),
          };
        }
        const requestData = objectBody(event);
        validateRecord(requestData, ["itemName", "url"]);
        try {
          if (!["http:", "https:"].includes(new URL(requestData.url).protocol)) throw new Error();
        } catch { throw new HttpError(400, "url must be an HTTP or HTTPS URL."); }
        if (typeof requestData.price !== "number" || !Number.isFinite(requestData.price) || requestData.price < 0) throw new HttpError(400, "price must be a non-negative number.");
        const item = {
          id: randomUUID(),
          entity: "item",
          itemName: requestData.itemName,
          price: requestData.price,
          url: requestData.url,
          timestamp: new Date().toISOString(),
        };
        await dynamo
          .put({ TableName: tableName(), Item: item })
          .promise();
        return {
          statusCode: 201,
          headers: CORS_HEADERS,
          body: JSON.stringify({ message: "Item saved to DynamoDB!", item }),
        };
      }
    }

    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Not Found" }),
    };
  } catch (error) {
    const statusCode = error.statusCode || (error.code === "ConditionalCheckFailedException" ? 409 : 500);
    // Never log events, headers, credentials, or arbitrary SDK error contents.
    if (statusCode >= 500) console.error("Backend request failed", { statusCode });
    return {
      statusCode,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: error.statusCode ? error.message : statusCode === 409 ? "Record conflicts with this operation." : "An internal server error occurred.", ...(error.details || {}) }),
    };
  }
};

}
exports.createHandler = createHandler;
exports.handler = createHandler();
