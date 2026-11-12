const configured = import.meta.env.VITE_API_BASE_URL || "/api";
if (
  configured !== "/api" &&
  (!/^https:\/\//.test(configured) ||
    new URL(configured).username ||
    new URL(configured).password ||
    new URL(configured).search ||
    new URL(configured).hash)
)
  throw new Error("VITE_API_BASE_URL must be an HTTPS base URL, or /api.");
export const API_BASE = configured.replace(/\/$/, "");
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    password?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 20000);
  try {
    const response = await fetch(API_BASE + path, {
      method: options.method || "GET",
      signal: controller.signal,
      redirect: "error",
      headers: {
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.password
          ? { Authorization: `Bearer ${options.password}` }
          : {}),
      },
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (response.status === 204) return undefined as T;
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new ApiError(
        response.status,
        body.error || `Request failed (${response.status}).`,
      );
    return body as T;
  } catch (error) {
    if (options.signal?.aborted)
      throw new DOMException("Cancelled", "AbortError");
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      0,
      "Cannot connect to the backend. Your catalog is still available. Check the local server and retry.",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
export const listKey = (collection: string) =>
  collection === "material-requirements" ? "materialRequirements" : collection;
export const itemKey = (collection: string) =>
  (
    ({
      sections: "section",
      books: "book",
      "material-requirements": "materialRequirement",
      offers: "offer",
    }) as Record<string, string>
  )[collection];
export async function allPages<T>(
  collection: string,
  filters: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T[]> {
  const records: T[] = [];
  const seen = new Set<string>();
  let token: string | null = null;
  do {
    const params: URLSearchParams = new URLSearchParams({
      ...filters,
      limit: "1000",
      ...(token ? { nextToken: token } : {}),
    });
    const page: Record<string, unknown> = await api<Record<string, unknown>>(
      `/${collection}?${params}`,
      { signal },
    );
    if (!Array.isArray(page[listKey(collection)]))
      throw new ApiError(0, "The backend returned an unexpected response.");
    records.push(...(page[listKey(collection)] as T[]));
    token = typeof page.nextToken === "string" ? page.nextToken : null;
    if (token && seen.has(token))
      throw new ApiError(0, "The backend repeated a page. Please retry.");
    if (token) seen.add(token);
  } while (token);
  return records;
}
export function safeUrl(value?: string): string | undefined {
  try {
    const u = new URL(value || "");
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
