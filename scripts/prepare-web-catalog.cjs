const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const snapshot = JSON.parse(
  fs.readFileSync(path.join(root, "data/catalog/2026-2028.json"), "utf8"),
);
if (!snapshot.complete || snapshot.courses.length !== snapshot.courseCount)
  throw new Error("Catalog snapshot is incomplete.");
const output = path.join(root, "web/public/catalog");
fs.mkdirSync(output, { recursive: true });
const subjects = new Map();
for (const course of snapshot.courses) {
  if (!subjects.has(course.subject)) subjects.set(course.subject, []);
  subjects.get(course.subject).push(course);
}
for (const [subject, courses] of subjects)
  fs.writeFileSync(
    path.join(output, subject + ".json"),
    JSON.stringify(courses),
  );
fs.writeFileSync(
  path.join(output, "index.json"),
  JSON.stringify({
    edition: snapshot.catalogEdition,
    retrievedAt: snapshot.indexRetrievedAt,
    subjects: snapshot.sources.map((source) => ({
      code: source.subject,
      label: source.label,
      count: source.courseCount,
    })),
    courses: snapshot.courses.map(
      ({ id, subject, number, title, units, description }) => ({
        id,
        subject,
        number,
        title,
        units,
        excerpt: description.slice(0, 180),
      }),
    ),
  }),
);
console.log(
  `Prepared ${snapshot.courseCount} courses in ${subjects.size} subjects.`,
);
