import type { CourseSummary } from "./types";
export function searchCourses(
  courses: CourseSummary[],
  query: string,
  subject = "",
) {
  const q = query.trim().toLowerCase();
  const compact = q.replace(/\s+/g, "");
  const tokens = q.split(/\s+/).filter(Boolean);
  const result = courses.filter(
    (course) =>
      (!subject || course.subject === subject) &&
      (!q ||
        `${course.subject}${course.number}`.toLowerCase().includes(compact) ||
        tokens.every((token) =>
          `${course.subject} ${course.number} ${course.title}`
            .toLowerCase()
            .includes(token),
        )),
  );
  const rank = (c: CourseSummary) => {
    const code = `${c.subject}${c.number}`.toLowerCase();
    return code === compact ? 0 : code.startsWith(compact) ? 1 : 2;
  };
  return result.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.subject.localeCompare(b.subject) ||
      a.number.localeCompare(b.number, undefined, { numeric: true }),
  );
}
