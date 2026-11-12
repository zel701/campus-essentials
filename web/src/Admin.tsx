import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, NavLink, useParams, useSearchParams } from "react-router-dom";
import { api, allPages, ApiError, itemKey } from "./api";
import { useAuth } from "./auth";
import { useCatalog, useLoad, ErrorBox, Empty, Icon } from "./shared";
import {
  fields,
  initialValues,
  locked,
  payload,
  visible,
  type Values,
} from "./forms";
import type { Collection, Row } from "./types";
const titles: Record<Collection, string> = {
  sections: "Sections",
  books: "Books",
  "material-requirements": "Requirements",
  offers: "Offers",
};
const singular: Record<Collection, string> = {
  sections: "section",
  books: "book",
  "material-requirements": "requirement",
  offers: "offer",
};
type Option = { id: string; label: string };
type Records = Record<Collection, Row[]>;
function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      trigger?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const controls = [
          ...e.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        ].filter((element) => element.getClientRects().length);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow dark">ADMIN WORKSPACE</span>
          <h2 id={id}>{title}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
function ReferenceSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  disabled: boolean;
  onChange: (s: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.find((o) => o.id === value);
  const filtered = useMemo(
    () =>
      options
        .filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 60),
    [options, query],
  );
  const choose = (option: Option) => {
    onChange(option.id);
    setOpen(false);
    setQuery("");
  };
  return (
    <div
      className="reference-select"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setOpen(false);
          setQuery("");
        }
      }}
    >
      <label htmlFor={id}>
        {label}
        {disabled && <small>Locked</small>}
      </label>
      <input
        id={id}
        role="combobox"
        aria-required="true"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        aria-activedescendant={
          open && filtered[active] ? `${id}-${active}` : undefined
        }
        disabled={disabled}
        value={open ? query : selected?.label || ""}
        placeholder={`Search ${label.toLowerCase()}…`}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActive(0);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
          onChange("");
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setActive((n) =>
              Math.max(
                0,
                Math.min(
                  filtered.length - 1,
                  n + (e.key === "ArrowDown" ? 1 : -1),
                ),
              ),
            );
          }
          if (e.key === "Enter" && open) {
            e.preventDefault();
            if (filtered[active]) choose(filtered[active]);
          }
        }}
      />
      {open && (
        <div role="listbox" id={`${id}-options`} className="reference-options">
          {filtered.map((o, i) => (
            <div
              role="option"
              aria-selected={i === active}
              id={`${id}-${i}`}
              key={o.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
            >
              {o.label}
            </div>
          ))}
          {!filtered.length && <p>No matches. Add the related record first.</p>}
          {filtered.length === 60 && <p>Keep typing to narrow the results.</p>}
        </div>
      )}
    </div>
  );
}
function Login() {
  const { setPassword } = useAuth();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/verify", { method: "POST", password: value });
      setPassword(value);
      setValue("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="shell login-page">
      <div className="login-intro">
        <div className="eyebrow dark">BEHIND THE CATALOG</div>
        <h1>
          A little care.
          <br />
          Better information.
        </h1>
        <p>
          Add sections, verify materials, and keep book offers useful for
          students.
        </p>
        <div className="note-card">
          <Icon />
          <p>
            Catalog courses come from the saved official snapshot. This
            workspace manages section and material records.
          </p>
        </div>
      </div>
      <form className="panel login-form" onSubmit={submit}>
        <span className="eyebrow dark">LOCAL ADMIN ACCESS</span>
        <h2>Welcome back</h2>
        <p className="muted">Sign in with your local admin password.</p>
        <label>
          Admin password
          <input
            type="password"
            autoComplete="off"
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {error && <ErrorBox message={error} />}
        <button className="button" disabled={busy}>
          {busy ? "Checking…" : "Sign in"}
          <Icon name="arrow" size={17} />
        </button>
        <p className="fine-print">
          Your credential stays in this tab’s memory. Reloading or signing out
          ends the session.
        </p>
      </form>
    </main>
  );
}
export function Admin() {
  const { collection = "sections" } = useParams();
  const { password, setPassword } = useAuth();
  if (!password) return <Login />;
  if (!(collection in titles))
    return (
      <main className="shell page">
        <Empty title="Workspace not found">
          Choose a valid admin collection.
        </Empty>
      </main>
    );
  return (
    <Workspace
      key={collection}
      collection={collection as Collection}
      password={password}
      signOut={() => setPassword("")}
    />
  );
}
function Workspace({
  collection,
  password,
  signOut,
}: {
  collection: Collection;
  password: string;
  signOut: () => void;
}) {
  const catalog = useCatalog();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<Row | null | undefined>();
  const [deleting, setDeleting] = useState<Row>();
  const [deleteError, setDeleteError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const state = useLoad(
    async (signal) =>
      Object.fromEntries(
        await Promise.all(
          (Object.keys(titles) as Collection[]).map(async (key) => [
            key,
            await allPages<Row>(key, {}, signal),
          ]),
        ),
      ) as Promise<Records>,
    "admin",
  );
  const records = state.data;
  const courseLabel = (id: unknown) => {
    const c = catalog.courses.find((c) => c.id === id);
    return c ? `${c.subject} ${c.number} · ${c.title}` : "Course unavailable";
  };
  const bookLabel = (id: unknown) => {
    const b = records?.books.find((b) => b.id === id);
    return b
      ? `${b.title} · ${b.edition} · ${b.format}${b.isbn ? ` · ${b.isbn}` : ""}`
      : "Book unavailable";
  };
  const sectionLabel = (id: unknown) => {
    const s = records?.sections.find((s) => s.id === id);
    return s
      ? `${courseLabel(s.courseId)} · ${s.termId} · Section ${s.sectionNumber}`
      : "Section unavailable";
  };
  const label = (row: Row) =>
    collection === "sections"
      ? `${courseLabel(row.courseId)} · ${row.termId} · Section ${row.sectionNumber}`
      : collection === "offers"
        ? `${row.seller} · ${bookLabel(row.bookId)}`
        : String(row.title);
  const related = (row: Row) =>
    collection === "sections"
      ? String(row.instructor || "Instructor not listed")
      : collection === "books"
        ? `${row.author} · Edition ${row.edition} · ${row.format}`
        : collection === "material-requirements"
          ? sectionLabel(row.sectionId)
          : `${row.purchaseType} · ${row.condition} · $${Number(row.price).toFixed(2)} USD`;
  const options: Record<string, Option[]> = {
    courses: catalog.courses.map((c) => ({
      id: c.id,
      label: `${c.subject} ${c.number} · ${c.title}`,
    })),
    sections: (records?.sections || []).map((s) => ({
      id: s.id,
      label: sectionLabel(s.id),
    })),
    books: (records?.books || []).map((b) => ({
      id: b.id,
      label: bookLabel(b.id),
    })),
  };
  const filterKey =
    collection === "sections"
      ? "courseId"
      : collection === "material-requirements"
        ? "sectionId"
        : collection === "offers"
          ? "bookId"
          : "";
  const context = filterKey ? params.get(filterKey) : null;
  const rows = (records?.[collection] || []).filter(
    (r) =>
      (!context || r[filterKey] === context) &&
      `${label(r)} ${related(r)} ${r.isbn || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setDeleteError("");
    try {
      await api(
        `/${collection}/${encodeURIComponent(deleting.id)}?expectedVersion=${deleting.version}`,
        { method: "DELETE", password },
      );
      setDeleting(undefined);
      setNotice(`${singular[collection]} deleted.`);
      state.retry();
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="shell page admin-page">
      <div className="admin-title">
        <div>
          <div className="eyebrow dark">KEEP THE DETAILS USEFUL</div>
          <h1>Admin workspace</h1>
          <p className="muted">
            Section information, material requirements, and book offers.
          </p>
        </div>
        <button className="button secondary" onClick={signOut}>
          Sign out
        </button>
      </div>
      <nav className="admin-tabs" aria-label="Admin collections">
        {(Object.keys(titles) as Collection[]).map((key) => (
          <NavLink to={`/admin/${key}`} key={key}>
            {titles[key]}
            <span>{records?.[key].length ?? "—"}</span>
          </NavLink>
        ))}
      </nav>
      <section className="panel admin-panel">
        <div className="section-heading">
          <div>
            <h2>{titles[collection]}</h2>
            <p className="muted">
              {rows.length} {rows.length === 1 ? "record" : "records"}
              {context ? " in this selection" : ""}
            </p>
          </div>
          <button
            className="button"
            disabled={!records || state.loading}
            onClick={() => setEditing(null)}
          >
            <Icon name="plus" size={17} />
            Create {singular[collection]}
          </button>
        </div>
        {context && (
          <div className="context-strip">
            <span>
              {filterKey === "courseId"
                ? courseLabel(context)
                : filterKey === "sectionId"
                  ? sectionLabel(context)
                  : bookLabel(context)}
            </span>
            <button className="text-link" onClick={() => setParams({})}>
              Clear selection
            </button>
          </div>
        )}
        <div className="admin-toolbar">
          <div className="small-search">
            <Icon name="search" />
            <input
              aria-label={`Search ${titles[collection].toLowerCase()}`}
              placeholder={`Search ${titles[collection].toLowerCase()}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className="button small secondary"
            onClick={state.retry}
            disabled={state.loading}
          >
            Refresh records
          </button>
        </div>
        {notice && (
          <p className="success-text" role="status">
            {notice}
          </p>
        )}
        {state.loading ? (
          <p role="status">Loading records…</p>
        ) : state.error ? (
          <ErrorBox message={state.error} retry={state.retry} />
        ) : rows.length ? (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Select</th>
                <th>
                  {collection === "sections"
                    ? "Course / section"
                    : collection === "offers"
                      ? "Seller / book"
                      : "Title"}
                </th>
                <th>Details</th>
                <th>Version</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={selected === row.id ? "selected" : ""}
                >
                  <td>
                    <input
                      aria-label={`Select ${label(row)}`}
                      type="radio"
                      name="selected-record"
                      checked={selected === row.id}
                      onChange={() => setSelected(row.id)}
                    />
                  </td>
                  <td>
                    <strong>{label(row)}</strong>
                    {collection === "books" && (
                      <small>ISBN {String(row.isbn || "not recorded")}</small>
                    )}
                    {collection === "material-requirements" && (
                      <small
                        className={
                          row.verificationStatus === "verified"
                            ? "success-text"
                            : ""
                        }
                      >
                        {String(row.verificationStatus)} ·{" "}
                        {String(row.requirementLevel)}
                      </small>
                    )}
                  </td>
                  <td>{related(row)}</td>
                  <td>v{row.version}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="text-link"
                        onClick={() => setEditing(row)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-link danger"
                        onClick={() => {
                          setDeleteError("");
                          setDeleting(row);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title={`No ${titles[collection].toLowerCase()} found`}>
            {query
              ? "Try another search."
              : `Create a ${singular[collection]} to get started. Only add information you can support with a source.`}
          </Empty>
        )}
      </section>
      <p className="fine-print">
        Identity fields are locked during editing. Create a replacement record
        when the course, section, edition identity, or seller option changes.
      </p>
      {editing !== undefined && (
        <RecordForm
          collection={collection}
          row={editing || undefined}
          params={params}
          options={options}
          password={password}
          close={() => setEditing(undefined)}
          saved={() => {
            setEditing(undefined);
            setNotice(`${singular[collection]} saved.`);
            state.retry();
          }}
        />
      )}
      {deleting && (
        <Dialog
          title={`Delete ${singular[collection]}?`}
          close={() => {
            if (!busy) setDeleting(undefined);
          }}
        >
          <div className="dialog-body">
            <p>
              <strong>{label(deleting)}</strong>
            </p>
            <p>
              This cannot be undone. Records with dependent requirements or
              offers are protected; remove those dependents first.
            </p>
            {deleteError && (
              <>
                <ErrorBox message={deleteError} />
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const result = await api<Record<string, Row>>(
                        `/${collection}/${encodeURIComponent(deleting.id)}`,
                      );
                      setDeleting(result[itemKey(collection)]);
                      setDeleteError(
                        "Current record loaded. Review before trying again.",
                      );
                      state.retry();
                    } catch (e) {
                      setDeleteError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Reload current record
                </button>
              </>
            )}
          </div>
          <div className="dialog-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </button>
            <button
              className="button destructive"
              disabled={busy}
              onClick={remove}
            >
              {busy ? "Deleting…" : "Confirm delete"}
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
function RecordForm({
  collection,
  row,
  params,
  options,
  password,
  close,
  saved,
}: {
  collection: Collection;
  row?: Row;
  params: URLSearchParams;
  options: Record<string, Option[]>;
  password: string;
  close: () => void;
  saved: () => void;
}) {
  const [current, setCurrent] = useState(row);
  const [values, setValues] = useState(() =>
    initialValues(collection, row, params),
  );
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const change = (key: string, value: string) =>
    setValues((v) => ({
      ...v,
      [key]: value,
      ...(key === "verificationStatus" && value === "verified" && !v.verifiedAt
        ? { verifiedAt: new Date().toISOString().slice(0, -1) }
        : {}),
    }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setConflict(false);
    setBusy(true);
    try {
      await api(`/${collection}`, {
        method: "POST",
        body: payload(collection, values, current),
        password,
      });
      saved();
    } catch (e) {
      setError((e as Error).message);
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    if (!current) return;
    setBusy(true);
    try {
      const response = await api<Record<string, Row>>(
        `/${collection}/${encodeURIComponent(current.id)}`,
      );
      const fresh = response[itemKey(collection)];
      setCurrent(fresh);
      setValues(initialValues(collection, fresh));
      setError("Current record loaded. Review the values before saving.");
      setConflict(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const shown = fields[collection].filter((f) => visible(f, values));
  return (
    <Dialog
      title={`${current ? "Edit" : "Create"} ${singular[collection]}`}
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <div className="dialog-body">
          <p className="muted">
            {current
              ? `Editing version ${current.version}. Locked fields define this record’s identity.`
              : "Enter source-supported details. Optional values can stay unknown."}
          </p>
          {[...new Set(shown.map((f) => f.group))].map((group) => (
            <fieldset className="form-group" key={group} disabled={busy}>
              <legend>{group}</legend>
              <div className="form-grid">
                {shown
                  .filter((f) => f.group === group)
                  .map((f) => {
                    const disabled = locked(collection, f.key, current);
                    const optional =
                      f.optional &&
                      !(
                        f.key === "sourceUrl" &&
                        values.verificationStatus === "verified"
                      );
                    return (
                      <div
                        key={f.key}
                        className={
                          f.type === "ref" || f.type === "textarea"
                            ? "field wide"
                            : "field"
                        }
                      >
                        {f.type === "ref" ? (
                          <ReferenceSelect
                            label={f.label}
                            value={values[f.key] || ""}
                            options={options[f.ref!] || []}
                            disabled={disabled || busy}
                            onChange={(v) => change(f.key, v)}
                          />
                        ) : (
                          <label>
                            {f.label}
                            {optional && <small>Optional</small>}
                            {disabled && <small>Locked</small>}
                            {f.type === "select" || f.type === "boolean" ? (
                              <select
                                aria-label={f.label}
                                aria-required={!optional}
                                disabled={disabled}
                                value={values[f.key] || ""}
                                onChange={(e) => change(f.key, e.target.value)}
                              >
                                {f.type === "boolean" ? (
                                  <>
                                    <option value="">Unknown</option>
                                    <option value="true">Yes</option>
                                    <option value="false">No</option>
                                  </>
                                ) : (
                                  f.options?.map((o) => (
                                    <option key={o}>{o}</option>
                                  ))
                                )}
                              </select>
                            ) : f.type === "textarea" ? (
                              <textarea
                                aria-label={f.label}
                                aria-required={!optional}
                                rows={3}
                                maxLength={4000}
                                value={values[f.key] || ""}
                                onChange={(e) => change(f.key, e.target.value)}
                              />
                            ) : (
                              <input
                                aria-label={f.label}
                                aria-required={!optional}
                                disabled={disabled}
                                maxLength={4000}
                                type={
                                  f.type === "date"
                                    ? "datetime-local"
                                    : f.type === "number"
                                      ? "number"
                                      : f.type === "url"
                                        ? "url"
                                        : "text"
                                }
                                step={
                                  f.type === "date"
                                    ? "0.001"
                                    : f.key === "rentalDays"
                                      ? "1"
                                      : "0.01"
                                }
                                min={
                                  f.type === "number"
                                    ? f.key === "rentalDays"
                                      ? "1"
                                      : "0"
                                    : undefined
                                }
                                max={
                                  f.type === "number"
                                    ? f.key === "rentalDays"
                                      ? "3650"
                                      : "1000000"
                                    : undefined
                                }
                                value={values[f.key] || ""}
                                placeholder={
                                  f.key === "termId"
                                    ? "e.g. 2026-Fall"
                                    : f.key === "shippingPrice"
                                      ? "Leave blank if unknown"
                                      : undefined
                                }
                                onChange={(e) => change(f.key, e.target.value)}
                              />
                            )}
                          </label>
                        )}
                      </div>
                    );
                  })}
              </div>
            </fieldset>
          ))}
          {error && <ErrorBox message={error} />}{" "}
          {conflict && (
            <div className="notice">
              <p>
                Your entries are preserved.{" "}
                {current
                  ? "Reloading replaces them with the latest saved record."
                  : "A matching identity may already exist. Close this form and refresh the table to edit it."}
              </p>
              {current && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={reload}
                >
                  Reload current record
                </button>
              )}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <span className="fine-print">
            {collection === "offers"
              ? "All prices are USD. Unknown shipping is omitted."
              : "Changes are saved to the connected backend."}
          </span>
          <button
            type="button"
            className="button secondary"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button" disabled={busy}>
            {busy ? "Saving…" : `Save ${singular[collection]}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
