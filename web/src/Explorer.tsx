import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { searchCourses } from "./catalog";
import { Icon, useCatalog } from "./shared";
export function Explorer() {
  const catalog = useCatalog();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const subject = params.get("subject") || "";
  const [subjectSearch, setSubjectSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(
    () => searchCourses(catalog.courses, q, subject),
    [catalog, q, subject],
  );
  const pages = Math.max(1, Math.ceil(results.length / 25));
  const page = Math.min(
    pages,
    Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1),
  );
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          (e.target as HTMLElement).tagName,
        )
      ) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    document.title = "Course explorer · Campus Essentials";
  }, []);
  const subjects = catalog.subjects.filter((s) =>
    `${s.code} ${s.label}`.toLowerCase().includes(subjectSearch.toLowerCase()),
  );
  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div>
            <div className="eyebrow">
              <span className="gold-line" />
              YOUR NEXT CLASS, A LITTLE CLEARER
            </div>
            <h1>
              Find your course.
              <br />
              <em>Know what’s ahead.</em>
            </h1>
            <p>
              Explore Cal Poly courses, check the details, and find
              <br />
              the materials for your section. One place to start.
            </p>
            <div className="catalog-tag">
              <span className="status-dot" />
              {catalog.edition} course catalog
              <span className="tag-divider" />
              {catalog.courses.length.toLocaleString()} courses
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-grid" />
            <div className="art-page page-back" />
            <div className="art-page">
              <span className="art-overline">
                A LITTLE PREPARATION
                <br />
                GOES A LONG WAY.
              </span>
              <Icon size={58} />
              <div className="art-rule" />
              <span className="art-big">
                Ready for
                <br />
                what’s next.
              </span>
              <span className="art-bottom">LEARN. PLAN. GO.</span>
            </div>
            <span className="art-star">✳</span>
          </div>
        </div>
      </section>
      <main className="explorer shell">
        <aside className="sidebar">
          <div className="side-heading">
            <h2>Browse by subject</h2>
            <span>{catalog.subjects.length}</span>
          </div>
          <div className="small-search">
            <Icon name="search" size={16} />
            <input
              aria-label="Find a subject"
              placeholder="Find a subject…"
              value={subjectSearch}
              onChange={(e) => setSubjectSearch(e.target.value)}
            />
          </div>
          <button
            className={`subject-row all ${!subject ? "selected" : ""}`}
            onClick={() => update("subject", "")}
          >
            All subjects <span>{catalog.courses.length.toLocaleString()}</span>
          </button>
          <div className="subject-list">
            {subjects.map((s) => (
              <button
                key={s.code}
                className={`subject-row ${subject === s.code ? "selected" : ""}`}
                aria-pressed={subject === s.code}
                onClick={() => update("subject", s.code)}
              >
                <span>
                  <b>{s.code}</b>
                  <small>{s.label.replace(/\s*\([^)]*\)/, "")}</small>
                </span>
                <span>{s.count}</span>
              </button>
            ))}
            {!subjects.length && <p className="muted">No matching subjects.</p>}
          </div>
          <div className="sidebar-note">
            <Icon />
            <p>
              A course catalog is a starting point. Section availability and
              materials can vary by term.
            </p>
          </div>
        </aside>
        <section className="results">
          <form className="course-search" onSubmit={(e) => e.preventDefault()}>
            <Icon name="search" size={24} />
            <input
              ref={input}
              aria-label="Search courses"
              placeholder="Search a course code or title, e.g. AERO 1121"
              value={q}
              onChange={(e) => update("q", e.target.value)}
            />
            {q ? (
              <button
                aria-label="Clear search"
                onClick={() => update("q", "")}
                type="button"
              >
                ×
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </form>
          <div className="results-heading">
            <div>
              <h2>{subject ? `${subject} courses` : "Explore the catalog"}</h2>
              <p>
                {results.length.toLocaleString()}{" "}
                {results.length === 1 ? "course" : "courses"}
                {q ? ` matching “${q}”` : " to discover"}
              </p>
            </div>
            <span className="edition-pill">{catalog.edition}</span>
          </div>
          {results.length ? (
            <>
              <div className="result-table">
                <div className="result-columns">
                  <span>COURSE</span>
                  <span>DESCRIPTION</span>
                  <span>UNITS</span>
                  <span />
                </div>
                {results.slice((page - 1) * 25, page * 25).map((c) => (
                  <Link
                    className="course-row"
                    to={`/courses/${encodeURIComponent(c.id)}`}
                    key={c.id}
                  >
                    <span className="course-code">
                      {c.subject}
                      <b>{c.number}</b>
                    </span>
                    <span className="course-summary">
                      <h3>{c.title}</h3>
                      <p>
                        {c.excerpt}
                        {c.excerpt.length === 180 ? "…" : ""}
                      </p>
                    </span>
                    <span className="units">{c.units}</span>
                    <span className="row-arrow">
                      <Icon name="arrow" size={18} />
                    </span>
                  </Link>
                ))}
              </div>
              <div className="pagination">
                <span>
                  Showing {(page - 1) * 25 + 1}–
                  {Math.min(page * 25, results.length)} of{" "}
                  {results.length.toLocaleString()}
                </span>
                <div>
                  <button
                    className="button small secondary"
                    disabled={page === 1}
                    onClick={() => update("page", String(page - 1))}
                  >
                    ← Previous
                  </button>
                  <span>
                    Page {page} of {pages}
                  </span>
                  <button
                    className="button small secondary"
                    disabled={page === pages}
                    onClick={() => update("page", String(page + 1))}
                  >
                    Next →
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="no-results">
              <Icon name="search" size={32} />
              <h3>No courses found</h3>
              <p>
                Try another course code or title, or clear your subject filter.
              </p>
              <button
                className="button secondary"
                onClick={() => setParams({})}
              >
                Clear all filters
              </button>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
