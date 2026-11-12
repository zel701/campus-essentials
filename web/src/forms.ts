import type { Collection, Row } from "./types";
export type Field = {
  key: string;
  label: string;
  type?:
    | "text"
    | "textarea"
    | "select"
    | "ref"
    | "number"
    | "date"
    | "url"
    | "boolean";
  options?: string[];
  ref?: "courses" | "sections" | "books";
  optional?: boolean;
  group: string;
};
const f = (
  key: string,
  label: string,
  group: string,
  extra: Partial<Field> = {},
): Field => ({ key, label, group, ...extra });
export const fields: Record<Collection, Field[]> = {
  sections: [
    f("courseId", "Course", "Section identity", {
      type: "ref",
      ref: "courses",
    }),
    f("termId", "Term", "Section identity"),
    f("sectionNumber", "Section number", "Section identity"),
    f("campus", "Campus", "Section identity"),
    f("instructor", "Instructor", "Details", { optional: true }),
    f("crn", "CRN", "Details", { optional: true }),
    f("sourceUrl", "Source URL", "Details", { type: "url", optional: true }),
  ],
  books: [
    f("isbn", "ISBN", "Book identity", { optional: true }),
    f("format", "Format", "Book identity", {
      type: "select",
      options: [
        "paperback",
        "hardcover",
        "ebook",
        "loose-leaf",
        "bundle",
        "other",
      ],
    }),
    f("title", "Title", "Book metadata"),
    f("author", "Author", "Book metadata"),
    f("edition", "Edition", "Book metadata"),
  ],
  "material-requirements": [
    f("sectionId", "Section", "Material identity", {
      type: "ref",
      ref: "sections",
    }),
    f("materialType", "Material type", "Material identity", {
      type: "select",
      options: ["book", "supply", "software", "other"],
    }),
    f("bookId", "Book", "Material identity", { type: "ref", ref: "books" }),
    f("title", "Requirement title", "Requirement details"),
    f("requirementLevel", "Requirement level", "Requirement details", {
      type: "select",
      options: ["required", "recommended", "optional"],
    }),
    f("accessCodeRequired", "Access code required", "Requirement details", {
      type: "boolean",
      optional: true,
    }),
    f("notes", "Notes", "Requirement details", {
      type: "textarea",
      optional: true,
    }),
    f("verificationStatus", "Verification status", "Verification evidence", {
      type: "select",
      options: ["unverified", "verified"],
    }),
    f("sourceUrl", "Source URL", "Verification evidence", {
      type: "url",
      optional: true,
    }),
    f("verifiedAt", "Verified at (UTC)", "Verification evidence", {
      type: "date",
    }),
  ],
  offers: [
    f("bookId", "Book", "Offer identity", { type: "ref", ref: "books" }),
    f("seller", "Seller", "Offer identity"),
    f("url", "Offer URL", "Offer identity", { type: "url" }),
    f("condition", "Condition", "Offer identity", {
      type: "select",
      options: ["new", "used", "digital", "unspecified"],
    }),
    f("purchaseType", "Purchase type", "Offer identity", {
      type: "select",
      options: ["buy", "rent", "borrow"],
    }),
    f("rentalDays", "Rental duration (days)", "Offer identity", {
      type: "number",
    }),
    f("price", "Listed price (USD)", "Price and availability", {
      type: "number",
    }),
    f("shippingPrice", "Shipping price (USD)", "Price and availability", {
      type: "number",
      optional: true,
    }),
    f("accessCodeIncluded", "Access code included", "Price and availability", {
      type: "boolean",
      optional: true,
    }),
    f("checkedAt", "Last checked (UTC)", "Price and availability", {
      type: "date",
    }),
  ],
};
export type Values = Record<string, string>;
export const visible = (field: Field, v: Values) =>
  !(field.key === "bookId" && v.materialType && v.materialType !== "book") &&
  !(field.key === "verifiedAt" && v.verificationStatus !== "verified") &&
  !(field.key === "rentalDays" && v.purchaseType !== "rent");
export function locked(collection: Collection, key: string, row?: Row) {
  if (!row) return false;
  return {
    sections: ["courseId", "termId", "sectionNumber", "campus"],
    books: row.isbn
      ? ["isbn", "format"]
      : ["isbn", "title", "author", "edition", "format"],
    "material-requirements": [
      "sectionId",
      "materialType",
      "bookId",
      ...(row.bookId ? [] : ["title"]),
    ],
    offers: [
      "bookId",
      "seller",
      "url",
      "condition",
      "purchaseType",
      "rentalDays",
    ],
  }[collection].includes(key);
}
export function initialValues(
  collection: Collection,
  row?: Row,
  params = new URLSearchParams(),
): Values {
  const v: Values = {
    campus: "San Luis Obispo",
    format: "paperback",
    materialType: "book",
    requirementLevel: "required",
    verificationStatus: "unverified",
    condition: "unspecified",
    purchaseType: "buy",
    checkedAt: new Date().toISOString().slice(0, -1),
  };
  for (const field of fields[collection]) {
    if (row?.[field.key] !== undefined)
      v[field.key] =
        field.type === "date"
          ? String(row[field.key]).replace(/Z$/, "")
          : String(row[field.key]);
    else if (row) v[field.key] = "";
    else if (params.has(field.key)) v[field.key] = params.get(field.key)!;
  }
  return v;
}
export function validIsbn(value: string) {
  const s = value.replace(/[\s-]/g, "").toUpperCase();
  return /^\d{9}[\dX]$/.test(s)
    ? [...s].reduce(
        (n, d, i) => n + (10 - i) * (d === "X" ? 10 : Number(d)),
        0,
      ) %
        11 ===
        0
    : /^97[89]\d{10}$/.test(s) &&
        [...s].reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0) % 10 ===
          0;
}
export function payload(
  collection: Collection,
  v: Values,
  row?: Row,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields[collection].filter((f) => visible(f, v))) {
    const value = (v[field.key] || "").trim();
    const required =
      !field.optional ||
      (field.key === "sourceUrl" && v.verificationStatus === "verified");
    if (!value) {
      if (required) throw new Error(`${field.label} is required.`);
      continue;
    }
    if (value.length > 4000)
      throw new Error(`${field.label} must be at most 4000 characters.`);
    if (field.key === "isbn" && !validIsbn(value))
      throw new Error(
        "Enter a valid ISBN-10 or ISBN-13 with a correct checksum.",
      );
    if (field.type === "url") {
      try {
        const u = new URL(value);
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password
        )
          throw new Error();
      } catch {
        throw new Error(
          `${field.label} must be an HTTP(S) URL without credentials.`,
        );
      }
    }
    if (field.type === "number") {
      const n = Number(value);
      if (
        !Number.isFinite(n) ||
        n < 0 ||
        n > 1000000 ||
        Math.abs(n * 100 - Math.round(n * 100)) > 1e-7
      )
        throw new Error(
          `${field.label} must be between 0 and 1,000,000 with at most two decimals.`,
        );
      if (
        field.key === "rentalDays" &&
        (!Number.isInteger(n) || n < 1 || n > 3650)
      )
        throw new Error(
          "Rental duration must be a whole number from 1 to 3650.",
        );
      result[field.key] = n;
    } else if (field.type === "boolean") result[field.key] = value === "true";
    else if (field.type === "date") {
      const iso = value + "Z";
      if (!Number.isFinite(Date.parse(iso)))
        throw new Error(`${field.label} must be a valid date and time.`);
      result[field.key] = new Date(iso).toISOString();
    } else result[field.key] = value;
  }
  if (collection === "offers") result.currency = "USD";
  if (row) {
    result.id = row.id;
    result.expectedVersion = row.version;
  }
  return result;
}
