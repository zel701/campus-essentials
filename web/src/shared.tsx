import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Link, NavLink } from "react-router-dom";
import type { Catalog } from "./types";
export const CatalogContext = createContext<Catalog | null>(null);
export function useCatalog() {
  const catalog = useContext(CatalogContext);
  if (!catalog) throw new Error("Catalog not loaded");
  return catalog;
}
export function Icon({
  name = "book",
  size = 20,
}: {
  name?: string;
  size?: number;
}) {
  const paths: Record<string, ReactNode> = {
    book: (
      <>
        <path d="M3 4h6a4 4 0 0 1 3 1 4 4 0 0 1 3-1h6v15h-6a4 4 0 0 0-3 1 4 4 0 0 0-3-1H3z" />
        <path d="M12 5v15" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    back: <path d="M19 12H5m5-5-5 5 5 5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14" />
        <path d="M10 3H3v18h18v-7" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] || paths.book}
    </svg>
  );
}
export function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <div className="nav-wrap">
          <Link to="/" className="brand">
            <span className="brand-mark">
              <Icon size={24} />
            </span>
            <span>
              campus<span className="brand-light"> essentials</span>
              <small>CAL POLY · SAN LUIS OBISPO</small>
            </span>
          </Link>
          <nav aria-label="Main navigation">
            <NavLink to="/" end>
              Course explorer
            </NavLink>
            <NavLink to="/admin">
              Admin workspace <span aria-hidden="true">↗</span>
            </NavLink>
          </nav>
        </div>
      </header>
      {children}
      <footer>
        <span>
          Campus Essentials <span className="dot">·</span> Unofficial student
          project
        </span>
        <span>Built for a little less guesswork.</span>
      </footer>
    </>
  );
}
export function ErrorBox({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="notice error" role="alert">
      <strong>Something needs attention</strong>
      <p>{message}</p>
      {retry && (
        <button className="button small secondary" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={26} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </div>
  );
}
export function dateLabel(value?: string) {
  return value
    ? new Date(value).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "Not recorded";
}
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
) {
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error?: string;
    loading: boolean;
  }>({ key, loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, loading: true });
    load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data, loading: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ key, error: error.message, loading: false });
      });
    return () => controller.abort();
    // key deliberately represents the load arguments; abort on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision]);
  return {
    ...(state.key === key
      ? state
      : { key, loading: true, data: undefined, error: undefined }),
    retry: () => setRevision((n) => n + 1),
  };
}
