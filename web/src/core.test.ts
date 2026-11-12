import { describe, it, expect, vi, afterEach } from "vitest";
import { searchCourses } from "./catalog";
import { allPages, api } from "./api";
import { payload, initialValues, validIsbn, locked } from "./forms";
const course = (subject: string, number: string, title: string) => ({
  id: subject + number,
  subject,
  number,
  title,
  units: "4",
  excerpt: "Description",
});
afterEach(() => vi.unstubAllGlobals());
describe("catalog search", () => {
  const data = [
    course("CSC", "1010", "Introduction to computing"),
    course("CSC", "101", "Programming"),
    course("AERO", "1000", "CSC 101 orientation"),
    course("MATH", "101", "Programming mathematics"),
  ];
  it("finds compact and spaced codes with exact codes first", () => {
    expect(searchCourses(data, "CSC101").map((c) => c.id)).toEqual([
      "CSC101",
      "CSC1010",
    ]);
    expect(searchCourses(data, "csc 101")[0].id).toBe("CSC101");
  });
  it("combines title tokens and subject filters", () => {
    expect(searchCourses(data, "programming", "MATH")).toHaveLength(1);
    expect(searchCourses(data, "intro computing")).toHaveLength(1);
    expect(searchCourses(data, "nonsense")).toEqual([]);
  });
});
describe("API paging and failures", () => {
  it("follows tokens even when a page has no matching records", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ books: [], nextToken: "second" })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ books: [{ id: "b" }], nextToken: null })),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await allPages("books")).toEqual([{ id: "b" }]);
    expect(fetch.mock.calls[1][0]).toContain("nextToken=second");
  });
  it("rejects repeated tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify({ sections: [], nextToken: "same" })),
          ),
        ),
    );
    await expect(allPages("sections")).rejects.toThrow("repeated a page");
  });
  it("distinguishes server errors and connectivity from empty data", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"error":"conflict"}', { status: 409 }),
        ),
    );
    await expect(api("/books")).rejects.toMatchObject({
      status: 409,
      message: "conflict",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(api("/books")).rejects.toMatchObject({ status: 0 });
  });
  it("passes cancellation into obsolete requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () =>
              reject(new DOMException("cancelled", "AbortError")),
            ),
          ),
      ),
    );
    const controller = new AbortController();
    const request = api("/sections", { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
describe("admin payloads", () => {
  it("validates ISBN check digits including ISBN-10", () => {
    expect(validIsbn("0-306-40615-2")).toBe(true);
    expect(validIsbn("9780306406157")).toBe(true);
    expect(validIsbn("9780306406158")).toBe(false);
  });
  it("omits unknown shipping and sends the current version", () => {
    const v = {
      ...initialValues("offers"),
      bookId: "b",
      seller: "Shop",
      url: "https://example.com",
      price: "12.50",
    };
    const body = payload("offers", v, { id: "offer", version: 3 });
    expect(body).toMatchObject({
      price: 12.5,
      currency: "USD",
      expectedVersion: 3,
      id: "offer",
    });
    expect(body).not.toHaveProperty("shippingPrice");
    expect(body).not.toHaveProperty("accessCodeIncluded");
  });
  it("requires verification evidence and rental terms", () => {
    expect(() =>
      payload("material-requirements", {
        sectionId: "s",
        materialType: "supply",
        title: "Pencil",
        requirementLevel: "required",
        verificationStatus: "verified",
      }),
    ).toThrow("Source URL");
    expect(() =>
      payload("offers", {
        ...initialValues("offers"),
        bookId: "b",
        seller: "Shop",
        url: "https://example.com",
        price: "5",
        purchaseType: "rent",
        rentalDays: "1.5",
      }),
    ).toThrow("whole number");
  });
  it("rejects negative money and credential URLs", () => {
    const v = {
      ...initialValues("offers"),
      bookId: "b",
      seller: "Shop",
      url: "https://example.com",
      price: "-1",
    };
    expect(() => payload("offers", v)).toThrow("between");
    expect(() =>
      payload("offers", {
        ...v,
        price: "1",
        url: "https://user:pass@example.com",
      }),
    ).toThrow("without credentials");
  });
  it("locks identity fields for ISBN and non-ISBN books", () => {
    expect(
      locked("books", "title", { id: "b", version: 1, isbn: "9780306406157" }),
    ).toBe(false);
    expect(locked("books", "title", { id: "b", version: 1 })).toBe(true);
    expect(locked("offers", "price", { id: "o", version: 1 })).toBe(false);
  });
});
