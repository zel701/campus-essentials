import { useEffect } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Course, Section, Requirement, Book, Offer } from "./types";
import { allPages, api, safeUrl } from "./api";
import {
  useCatalog,
  useLoad,
  ErrorBox,
  Empty,
  Icon,
  dateLabel,
} from "./shared";
function Offers({ bookId }: { bookId: string }) {
  const state = useLoad(
    (signal) => allPages<Offer>("offers", { bookId }, signal),
    bookId,
  );
  if (state.loading)
    return (
      <p className="muted" role="status">
        Loading offers…
      </p>
    );
  if (state.error)
    return <ErrorBox message={state.error} retry={state.retry} />;
  if (!state.data?.length)
    return (
      <p className="muted">
        No seller offers have been added for this edition.
      </p>
    );
  return (
    <>
      {["buy", "rent", "borrow"].map((type) => {
        const offers = state
          .data!.filter((o) => o.purchaseType === type)
          .sort((a, b) => a.price - b.price);
        return offers.length ? (
          <div className="offer-group" key={type}>
            <h4>
              {type === "buy"
                ? "Purchase options"
                : type === "rent"
                  ? "Rental options"
                  : "Borrowing options"}
            </h4>
            <table className="offers-table">
              <thead>
                <tr>
                  <th>Seller / condition</th>
                  <th>Listed price</th>
                  <th>Shipping</th>
                  <th>Access code</th>
                  <th>Last checked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {offers.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <b>{o.seller}</b>
                      <small>
                        {o.condition}
                        {o.rentalDays ? ` · ${o.rentalDays} days` : ""}
                      </small>
                    </td>
                    <td>
                      <strong>${o.price.toFixed(2)}</strong>
                    </td>
                    <td>
                      {o.shippingPrice === undefined
                        ? "Unknown"
                        : o.shippingPrice === 0
                          ? "Free"
                          : `$${o.shippingPrice.toFixed(2)}`}
                    </td>
                    <td>
                      {o.accessCodeIncluded === undefined
                        ? "Unknown"
                        : o.accessCodeIncluded
                          ? "Included"
                          : "Not included"}
                    </td>
                    <td>{dateLabel(o.checkedAt)}</td>
                    <td>
                      {safeUrl(o.url) && (
                        <a
                          className="text-link"
                          href={safeUrl(o.url)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View <Icon name="external" size={14} />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null;
      })}
      <p className="fine-print">
        Listed prices are not live quotes. Shipping, taxes, access codes, and
        rental terms may affect your final cost.
      </p>
    </>
  );
}
function RequirementCard({ requirement: r }: { requirement: Requirement }) {
  const book = useLoad(
    (signal) =>
      r.bookId
        ? api<{ book: Book }>(`/books/${encodeURIComponent(r.bookId)}`, {
            signal,
          }).then((result) => result.book)
        : Promise.resolve(undefined),
    r.bookId || r.id,
  );
  return (
    <article className="requirement-card">
      <div className="requirement-heading">
        <span className="material-icon">
          <Icon />
        </span>
        <div>
          <div className="badge-row">
            <span className="badge">{r.requirementLevel}</span>
            <span
              className={`badge ${r.verificationStatus === "verified" ? "verified" : "neutral"}`}
            >
              {r.verificationStatus === "verified"
                ? "Source verified"
                : "Unverified"}
            </span>
          </div>
          <h3>{r.title}</h3>
        </div>
      </div>
      {r.bookId && book.loading && <p role="status">Loading book details…</p>}
      {book.error && <ErrorBox message={book.error} retry={book.retry} />}{" "}
      {book.data && (
        <div className="book-meta">
          <b>{book.data.title}</b>
          <span>
            {book.data.author} · Edition {book.data.edition} ·{" "}
            {book.data.format}
          </span>
          <span>ISBN: {book.data.isbn || "Not recorded"}</span>
        </div>
      )}
      {r.accessCodeRequired !== undefined && (
        <p className="access-note">
          {r.accessCodeRequired
            ? "Access code required for this section."
            : "No access code required according to this record."}
        </p>
      )}
      {r.notes && <p>{r.notes}</p>}
      <div className="verification-line">
        {r.verificationStatus === "verified"
          ? `Verified ${dateLabel(r.verifiedAt)}`
          : "Confirm this requirement with your instructor."}
        {safeUrl(r.sourceUrl) && (
          <a href={safeUrl(r.sourceUrl)} target="_blank" rel="noreferrer">
            View source <Icon name="external" size={13} />
          </a>
        )}
      </div>
      {book.data && <Offers bookId={book.data.id} />}
    </article>
  );
}
function Materials({ sectionId }: { sectionId: string }) {
  const state = useLoad(
    (signal) =>
      allPages<Requirement>("material-requirements", { sectionId }, signal),
    sectionId,
  );
  return state.loading ? (
    <p role="status">Loading materials…</p>
  ) : state.error ? (
    <ErrorBox message={state.error} retry={state.retry} />
  ) : state.data?.length ? (
    <div>
      {state.data.map((r) => (
        <RequirementCard key={r.id} requirement={r} />
      ))}
    </div>
  ) : (
    <Empty title="Materials have not been added">
      Check the syllabus or ask your instructor. An empty list does not mean
      there are no required materials.
    </Empty>
  );
}
export function CoursePage() {
  const { id = "" } = useParams();
  const catalog = useCatalog();
  const [params, setParams] = useSearchParams();
  const summary = catalog.courses.find((c) => c.id === id);
  const detail = useLoad(async (signal) => {
    if (!summary) return undefined;
    const response = await fetch(`/catalog/${summary.subject}.json`, {
      signal,
    });
    if (!response.ok) throw new Error("Course details could not be loaded.");
    return ((await response.json()) as Course[]).find((c) => c.id === id);
  }, id);
  const sections = useLoad(
    (signal) =>
      summary
        ? allPages<Section>("sections", { courseId: id }, signal)
        : Promise.resolve([]),
    id,
  );
  useEffect(() => {
    document.title = summary
      ? `${summary.subject} ${summary.number} · Campus Essentials`
      : "Course not found · Campus Essentials";
  }, [summary]);
  const selectedTerm = params.get("term") || "";
  const selectedId = params.get("section") || "";
  const terms = [...new Set(sections.data?.map((s) => s.termId) || [])]
    .sort()
    .reverse();
  const options = (sections.data || []).filter(
    (s) => s.termId === selectedTerm,
  );
  const selected = options.find((s) => s.id === selectedId);
  if (!summary)
    return (
      <main className="shell page">
        <Link to="/" className="back-link">
          <Icon name="back" />
          Back to courses
        </Link>
        <Empty title="Course not found">
          This course is not in the saved catalog. Return to the explorer to
          find another course.
        </Empty>
      </main>
    );
  const course = detail.data;
  return (
    <main className="shell page">
      <Link to={`/?subject=${summary.subject}`} className="back-link">
        <Icon name="back" size={17} />
        Back to {summary.subject} courses
      </Link>
      <div className="course-title">
        <div className="eyebrow dark">
          {summary.subject} {summary.number}
          <span className="title-divider" />
          {catalog.edition} CATALOG
        </div>
        <h1>{summary.title}</h1>
        <p>
          {summary.units} units <span className="dot">·</span> San Luis Obispo
        </p>
      </div>
      <div className="detail-grid">
        <div>
          <section className="panel description-panel">
            <div className="section-heading">
              <h2>About this course</h2>
              <Icon />
            </div>
            {detail.loading && <p role="status">Loading course details…</p>}
            {detail.error && (
              <ErrorBox message={detail.error} retry={detail.retry} />
            )}{" "}
            {course && (
              <>
                <p className="full-description">{course.description}</p>
                <dl className="requirements-list">
                  {[
                    ["Prerequisites", course.prerequisite],
                    ["Corequisites", course.corequisite],
                    ["Concurrent coursework", course.concurrent],
                    ["Recommended preparation", course.recommended],
                    ["General education", course.geArea],
                    ["Grading basis", course.gradingBasis],
                  ]
                    .filter(([, value]) => value)
                    .map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                </dl>
                {course.catalogDetails && (
                  <details className="catalog-notes">
                    <summary>All catalog notes</summary>
                    <p>{course.catalogDetails}</p>
                  </details>
                )}
              </>
            )}
          </section>
          <section className="panel materials-panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow dark">PLAN FOR YOUR SECTION</div>
                <h2>Materials & books</h2>
              </div>
              <Link
                className="text-link"
                to={`/admin/sections?courseId=${encodeURIComponent(id)}`}
              >
                Manage sections <Icon name="arrow" size={16} />
              </Link>
            </div>
            <p className="muted">
              Requirements can vary by instructor and term. Choose your section
              to see what’s been added.
            </p>
            {sections.loading ? (
              <p role="status">Loading available sections…</p>
            ) : sections.error ? (
              <ErrorBox message={sections.error} retry={sections.retry} />
            ) : !sections.data?.length ? (
              <Empty title="No sections added yet">
                This catalog course is ready to explore. Section-specific
                information will appear here once it has been added.
              </Empty>
            ) : (
              <>
                <div className="section-selectors">
                  <label>
                    Term
                    <select
                      value={selectedTerm}
                      onChange={(e) =>
                        setParams(
                          e.target.value ? { term: e.target.value } : {},
                        )
                      }
                    >
                      <option value="">Select a term</option>
                      {terms.map((t) => (
                        <option key={t} value={t}>
                          {sections.data?.find((s) => s.termId === t && s.termLabel)?.termLabel || t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Section
                    <select
                      value={selected?.id || ""}
                      disabled={!selectedTerm}
                      onChange={(e) =>
                        setParams({
                          term: selectedTerm,
                          ...(e.target.value
                            ? { section: e.target.value }
                            : {}),
                        })
                      }
                    >
                      <option value="">Select a section</option>
                      {options.map((s) => (
                        <option value={s.id} key={s.id}>
                          {s.sectionNumber} ·{" "}
                          {s.instructor || "Instructor not listed"} · {s.campus}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {selected ? (
                  <>
                    <div className="selected-section">
                      <span>
                        Section {selected.sectionNumber} ·{" "}
                        {selected.instructor || "Instructor not listed"}
                      </span>
                      <Link
                        className="text-link"
                        to={`/admin/material-requirements?sectionId=${encodeURIComponent(selected.id)}`}
                      >
                        Manage materials →
                      </Link>
                    </div>
                    {safeUrl(selected.materialsUrl) && (
                      <p>
                        <a href={safeUrl(selected.materialsUrl)} target="_blank" rel="noreferrer">
                          View official course materials ↗
                        </a>
                        <br />
                        <span className="muted">
                          Official bookstore entry for this section. Textbook requirements have not been verified here.
                          {selected.sourceRetrievedAt && ` Source retrieved ${new Date(selected.sourceRetrievedAt).toLocaleDateString()}.`}
                        </span>
                      </p>
                    )}
                    <Materials sectionId={selected.id} />
                  </>
                ) : (
                  <p className="muted">
                    Select a term and section to continue.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
        <aside className="course-aside">
          <div className="panel facts-panel">
            <h2>At a glance</h2>
            <dl>
              <div>
                <dt>Course code</dt>
                <dd>
                  {summary.subject} {summary.number}
                </dd>
              </div>
              <div>
                <dt>Units</dt>
                <dd>{summary.units}</dd>
              </div>
              <div>
                <dt>Typically offered</dt>
                <dd>{course?.term || "Not recorded"}</dd>
              </div>
              <div>
                <dt>Catalog</dt>
                <dd>{catalog.edition}</dd>
              </div>
            </dl>
            <p className="fine-print">
              F = Fall · SP = Spring · SU = Summer
              <br />
              Typical offerings are not a current class schedule.
            </p>
            {course && safeUrl(course.sourceUrl) && (
              <a
                className="button secondary source-button"
                href={safeUrl(course.sourceUrl)}
                target="_blank"
                rel="noreferrer"
              >
                Official catalog <Icon name="external" size={15} />
              </a>
            )}
            <p className="fine-print">
              Source retrieved{" "}
              {dateLabel(course?.retrievedAt || catalog.retrievedAt)}
            </p>
          </div>
          <div className="note-card">
            <Icon />
            <h3>Start informed.</h3>
            <p>
              Your syllabus and instructor are the final source for section
              requirements. Check the edition and access-code details before
              buying a book.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
