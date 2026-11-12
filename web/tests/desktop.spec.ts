import { test, expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

test("imported sections expose official materials links without claiming verified textbooks", async ({ page, request }, info) => {
  const root = path.resolve(process.cwd(), "..");
  await promisify(execFile)(process.execPath, [
    path.join(root, "scripts/import-sections.cjs"),
    "--snapshot", path.join(root, "data/sections/2268-MAIN-BIO.json"),
    "--port", "8766", "--table", "campus-essentials-local-browser-tests",
    "--report", path.join(root, `web/test-results/import-${info.project.name}.json`),
  ], { cwd: root });
  const catalog = await (await request.get("/catalog/index.json")).json();
  const course = catalog.courses.find((c: { subject: string; number: string }) => c.subject === "BIO" && c.number === "1111");
  const result = await (await request.get(`/api/sections?courseId=${encodeURIComponent(course.id)}`)).json();
  const section = result.sections.find((s: { crn: string }) => s.crn === "6370");
  expect(result.sections).toHaveLength(3);
  await page.goto(`/courses/${encodeURIComponent(course.id)}?term=2268&section=${encodeURIComponent(section.id)}`);
  await expect(page.getByRole("combobox", { name: "Term", exact: true })).toHaveValue("2268");
  await expect(page.getByRole("combobox", { name: "Term", exact: true }).locator("option:checked")).toHaveText("Fall Semester 2026");
  await expect(page.getByRole("link", { name: "View official course materials" })).toHaveAttribute("href", /crn-1=6370/);
  await expect(page.getByText("Textbook requirements have not been verified here.", { exact: false })).toBeVisible();
  await expect(page.getByText("Materials have not been added", { exact: false })).toBeVisible();
  await fits(page);
});
async function login(page: Page) {
  await page.goto("/admin/sections");
  await page.getByLabel("Admin password").fill("browser-tests-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create section" }),
  ).toBeEnabled();
}
async function choose(page: Page, label: string, text: string) {
  const input = page.getByRole("combobox", { name: label, exact: true });
  await input.fill(text);
  await page.getByRole("listbox").getByRole("option").first().click();
}
async function fits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
test("search, filters, 25-row pagination, history, direct links and empty states", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".course-row")).toHaveCount(25);
  await page.getByRole("button", { name: "Next →", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.goBack();
  await expect(page).not.toHaveURL(/page=2/);
  await page.goForward();
  await expect(page).toHaveURL(/page=2/);
  await page.getByLabel("Search courses", { exact: true }).fill("AERO1121");
  await expect(page.locator(".course-row")).toHaveCount(1);
  await expect(page.locator(".course-code")).toContainText("1121");
  await page.getByLabel("Search courses", { exact: true }).fill("AERO 1121");
  await expect(page.locator(".course-row")).toHaveCount(1);
  const href = await page.locator(".course-row").getAttribute("href");
  await page.goto(href!);
  await expect(
    page.getByRole("heading", { name: "About this course" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Official catalog" }),
  ).toHaveAttribute("href", /catalog.calpoly.edu/);
  await page.goto("/?subject=MATH");
  await expect(
    page.getByRole("heading", { name: "MATH courses", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".course-code").first()).toContainText("MATH");
  await page.getByLabel("Search courses", { exact: true }).fill("zzzz");
  await expect(
    page.getByRole("heading", { name: "No courses found" }),
  ).toBeVisible();
  await page.goto("/courses/not-a-course");
  await expect(
    page.getByRole("heading", { name: "Course not found" }),
  ).toBeVisible();
});
test("desktop layouts, visible focus and offline catalog", async ({
  page,
}, info) => {
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.locator(".course-row")).toHaveCount(25);
    await fits(page);
    await page.screenshot({
      path: `test-results/${info.project.name}-explorer-${width}.png`,
    });
  }
  await page.keyboard.press("/");
  await expect(
    page.getByLabel("Search courses", { exact: true }),
  ).toBeFocused();
  expect(
    await page
      .getByLabel("Search courses", { exact: true })
      .evaluate((el) => getComputedStyle(el.parentElement!).outlineWidth),
  ).not.toBe("0px");
  await page.route("**/api/**", (route) => route.abort());
  await page.locator(".course-row").first().click();
  await expect(
    page.getByText("Cannot connect to the backend.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "About this course" }),
  ).toBeVisible();
  await page.goto("/admin/sections");
  await page.getByLabel("Admin password").fill("browser-tests-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Cannot connect");
});
test("admin creates linked records, handles conflicts and protected deletion, then student reads offers", async ({
  page,
  request,
}, info) => {
  const suffix = info.project.name;
  await page.goto("/admin/sections");
  await page.getByLabel("Admin password").fill("wrong");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid password");
  await login(page);
  await page.getByRole("button", { name: "Create section" }).click();
  await choose(page, "Course", "AERO 1121");
  await page.getByLabel("Term", { exact: true }).fill(`TEST-${suffix}`);
  await page.getByLabel("Section number", { exact: true }).fill("01");
  await page.getByLabel("Instructor", { exact: true }).fill("Test Instructor");
  await page.getByRole("button", { name: "Save section", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("textbox", { name: "Search sections" })
    .fill(`TEST-${suffix}`);
  await expect(page.locator(".admin-table tbody tr")).toHaveCount(1);
  const catalog = await (await request.get("/catalog/index.json")).json();
  const selectedCourse = catalog.courses.find(
    (c: { subject: string; number: string }) =>
      c.subject === "AERO" && c.number === "1121",
  );
  const sectionResponse = await request.get(
    `/api/sections?courseId=${encodeURIComponent(selectedCourse.id)}`,
  );
  const section = (await sectionResponse.json()).sections.find(
    (s: any) => s.termId === `TEST-${suffix}`,
  );
  expect(section).toBeTruthy();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Term", { exact: true })).toBeDisabled();
  await page
    .getByLabel("Instructor", { exact: true })
    .fill("My preserved edit");
  const { id, courseId, termId, sectionNumber, campus, version } = section;
  const other = await request.post("/api/sections", {
    headers: { Authorization: "Bearer browser-tests-only" },
    data: {
      id,
      courseId,
      termId,
      sectionNumber,
      campus,
      instructor: "Concurrent edit",
      expectedVersion: version,
    },
  });
  expect(other.ok()).toBe(true);
  await page.getByRole("button", { name: "Save section", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("expectedVersion");
  await expect(page.getByLabel("Instructor", { exact: true })).toHaveValue(
    "My preserved edit",
  );
  await page
    .getByRole("button", { name: "Reload current record", exact: true })
    .click();
  await expect(page.getByLabel("Instructor", { exact: true })).toHaveValue(
    "Concurrent edit",
  );
  await page.getByLabel("Instructor", { exact: true }).fill("Test Instructor");
  await page.getByRole("button", { name: "Save section", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: /Books/ }).click();
  await page.getByRole("button", { name: "Create book" }).click();
  await page.getByLabel("ISBN", { exact: false }).fill("123");
  await page
    .getByLabel("Title", { exact: true })
    .fill(`Browser Test Book ${suffix}`);
  await page.getByLabel("Author", { exact: true }).fill("Test Author");
  await page.getByLabel("Edition", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Save book", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("valid ISBN");
  await page.getByLabel("ISBN", { exact: false }).fill("");
  await page.getByRole("button", { name: "Save book", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: /Requirements/ }).click();
  await page.getByRole("button", { name: "Create requirement" }).click();
  await choose(page, "Section", `TEST-${suffix}`);
  await choose(page, "Book", `Browser Test Book ${suffix}`);
  await page
    .getByLabel("Requirement title", { exact: true })
    .fill(`Test textbook ${suffix}`);
  await page
    .getByLabel("Verification status", { exact: true })
    .selectOption("verified");
  await page
    .getByRole("button", { name: "Save requirement", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Source URL");
  await page
    .getByLabel("Source URL", { exact: false })
    .fill("https://example.com/test-syllabus");
  await page
    .getByLabel("Access code required", { exact: false })
    .selectOption("true");
  await page
    .getByRole("button", { name: "Save requirement", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: /Offers/ }).click();
  await page.getByRole("button", { name: "Create offer" }).click();
  await choose(page, "Book", `Browser Test Book ${suffix}`);
  await page
    .getByLabel("Seller", { exact: true })
    .fill(`Test Seller ${suffix}`);
  await page
    .getByLabel("Offer URL", { exact: true })
    .fill("https://example.com/test-book");
  await page.getByLabel("Listed price (USD)", { exact: true }).fill("12.50");
  await page.getByRole("button", { name: "Save offer", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: /Books/ }).click();
  await page.getByRole("textbox", { name: "Search books" }).fill(suffix);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(/referenc|depend/i);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: false })).toBeDisabled();
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await fits(page);
    await expect(
      page.getByRole("button", { name: "Save book", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/${suffix}-dialog-${width}.png`,
    });
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto(
    `/courses/${encodeURIComponent(courseId)}?term=${encodeURIComponent(termId)}&section=${encodeURIComponent(id)}`,
  );
  await expect(
    page.getByText("Source verified", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("$12.50", { exact: true })).toBeVisible();
  await expect(page.locator(".offers-table tbody td").nth(2)).toHaveText(
    "Unknown",
  );
  await expect(
    page.getByText("Access code required for this section.", { exact: true }),
  ).toBeVisible();
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await fits(page);
    await page.screenshot({
      path: `test-results/${suffix}-course-${width}.png`,
      fullPage: true,
    });
  }
  await page.goto("/admin/sections");
  await expect(page.getByLabel("Admin password")).toBeVisible();
  await login(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Admin password")).toBeVisible();
});
test("missing and unverified materials stay distinct; offline saves preserve input and keyboard selectors work", async ({
  page,
  request,
}, info) => {
  const catalog = await (await request.get("/catalog/index.json")).json();
  const courseId = catalog.courses[0].id;
  const termId = `EMPTY-${info.project.name}`;
  const response = await request.post("/api/sections", {
    headers: { Authorization: "Bearer browser-tests-only" },
    data: { courseId, termId, sectionNumber: "02", campus: "San Luis Obispo" },
  });
  expect(response.ok()).toBe(true);
  const section = (await response.json()).section;
  await page.goto(
    `/courses/${encodeURIComponent(courseId)}?term=${encodeURIComponent(termId)}&section=${encodeURIComponent(section.id)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Materials have not been added" }),
  ).toBeVisible();
  const material = await request.post("/api/material-requirements", {
    headers: { Authorization: "Bearer browser-tests-only" },
    data: {
      sectionId: section.id,
      materialType: "supply",
      title: "Unverified test supply",
      requirementLevel: "recommended",
      verificationStatus: "unverified",
    },
  });
  expect(material.ok()).toBe(true);
  await page.reload();
  await expect(page.getByText("Unverified", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Confirm this requirement with your instructor.", {
      exact: true,
    }),
  ).toBeVisible();
  await login(page);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  await page.getByRole("button", { name: "Create section" }).click();
  const selector = page.getByRole("combobox", { name: "Course", exact: true });
  await selector.fill("AERO 1121");
  await selector.press("ArrowDown");
  await selector.press("Enter");
  await expect(selector).toHaveValue(/AERO 1121/);
  await page.getByLabel("Term", { exact: true }).fill("OFFLINE-TEST");
  await page.getByLabel("Section number", { exact: true }).fill("09");
  await page.route("**/api/sections", (route) =>
    route.request().method() === "POST" ? route.abort() : route.continue(),
  );
  await page.getByRole("button", { name: "Save section", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Cannot connect");
  await expect(page.getByLabel("Term", { exact: true })).toHaveValue(
    "OFFLINE-TEST",
  );
  await page.getByRole("button", { name: "Save section", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      Boolean(document.activeElement?.closest("dialog")),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
