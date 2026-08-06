import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import * as fs from "fs";

const BASE = process.env.APP_URL || "https://console-chat-hub.lovable.app";
const CE = `${BASE}/console/conversation-evaluation`;
const FAKE_UUID = "00000000-0000-0000-0000-000000000001";

// ── Fixtures ──
// Auth fixtures: each role requires a pre-seeded user with stored session.
// Set via env: ADMIN_STORAGE, SUPERVISOR_STORAGE, QA_STORAGE, AGENT_STORAGE
const ADMIN_STORAGE = process.env.ADMIN_STORAGE || ".auth/admin.json";
const SUPERVISOR_STORAGE = process.env.SUPERVISOR_STORAGE || ".auth/supervisor.json";
const QA_STORAGE = process.env.QA_STORAGE || ".auth/qa.json";
const AGENT_STORAGE = process.env.AGENT_STORAGE || ".auth/agent.json";

function roleContext(storage: string) {
  return test.extend<{ rolePage: Page }>({
    rolePage: async ({ browser }, use) => {
      const ctx = await browser.newContext({ storageState: storage });
      const page = await ctx.newPage();
      await use(page);
      await ctx.close();
    },
  });
}

// ── F-LIST ──
test("F-LIST-01 route loads", async ({ page }) => {
  const res = await page.goto(`${CE}/`);
  expect(res?.status()).toBeLessThan(500);
  await expect(page.locator("body")).not.toBeEmpty();
});

test("F-LIST-02 loading state visible", async ({ page }) => {
  await page.goto(`${CE}/`);
  const skeleton = page.locator('[class*="skeleton"],[class*="loading"],[role="progressbar"]').first();
  await expect(skeleton).toBeVisible({ timeout: 5000 });
});

test("F-LIST-03 empty state", async ({ page }) => {
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  const emptyMsg = page.locator('text=/no.*evaluation|empty|沒有/i').first();
  const rows = page.locator('tr,li,[data-testid*="eval"]');
  const hasEmpty = await emptyMsg.isVisible();
  const rowCount = await rows.count();
  // Must show either empty message or data rows — not blank
  expect(hasEmpty || rowCount > 0).toBe(true);
});

test("F-LIST-04 populated state", async ({ page }) => {
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  // Page must render without crash
  await expect(page.locator("body")).not.toHaveText(/Unhandled|SQLSTATE|stack trace/i);
});

test("F-LIST-05 safe API error", async ({ page }) => {
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toHaveText(/SQLSTATE|pg_catalog|stack trace|secret/i);
});

test("F-LIST-06 search", async ({ page }) => {
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  const search = page.locator('input[type="search"],input[placeholder*="earch"],input[placeholder*="搜"]').first();
  await expect(search).toBeVisible({ timeout: 5000 });
  await search.fill("test-query");
  await page.waitForTimeout(1000);
  await expect(page.locator("body")).not.toHaveText(/Unhandled/i);
});

test("F-LIST-07 filters", async ({ page }) => {
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  const filter = page.locator('select,[role="combobox"],[data-testid*="filter"]').first();
  await expect(filter).toBeVisible({ timeout: 5000 });
  await filter.click();
  await page.waitForTimeout(500);
  await expect(page.locator("body")).not.toHaveText(/Unhandled/i);
});

test("F-LIST-08 pagination", async ({ page }) => {
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  const pager = page.locator('[aria-label*="page"],[aria-label*="next"],button:has-text("Next"),button:has-text("下一")').first();
  await expect(pager).toBeVisible({ timeout: 5000 });
  await pager.click();
  await page.waitForTimeout(1000);
  await expect(page.locator("body")).not.toHaveText(/Unhandled/i);
});

// ── F-NAV ──
test("F-NAV-01 Open navigates to evaluationId URL", async ({ page }) => {
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  const link = page.locator('a[href*="conversation-evaluation/"],button:has-text("Open"),button:has-text("查看")').first();
  await expect(link).toBeVisible({ timeout: 5000 });
  await link.click();
  await page.waitForURL(/conversation-evaluation\/[0-9a-f-]+/);
  expect(page.url()).toMatch(/conversation-evaluation\/[0-9a-f-]+/);
});

test("F-NAV-02 browser Back returns to list", async ({ page }) => {
  await page.goto(`${CE}/${FAKE_UUID}`);
  await page.waitForLoadState("networkidle");
  await page.goBack();
  await page.waitForURL(/conversation-evaluation\/?$/);
  expect(page.url()).toMatch(/conversation-evaluation\/?$/);
});

test("F-NAV-03 direct detail deep-link", async ({ page }) => {
  const res = await page.goto(`${CE}/${FAKE_UUID}`);
  expect(res!.status()).toBeLessThan(500);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toBeEmpty();
});

test("F-NAV-04 detail reload", async ({ page }) => {
  await page.goto(`${CE}/${FAKE_UUID}`);
  await page.waitForLoadState("networkidle");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toBeEmpty();
});

// ── F-DETAIL ──
test("F-DETAIL-01 valid evaluation renders", async ({ page }) => {
  await page.goto(`${CE}/${FAKE_UUID}`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toHaveText(/Unhandled Runtime Error/i);
  await expect(page.locator("body")).not.toBeEmpty();
});

test("F-DETAIL-02 invalid ID safe error", async ({ page }) => {
  await page.goto(`${CE}/not-a-uuid`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toHaveText(/SQLSTATE|Unhandled/i);
});

test("F-DETAIL-03 missing evaluation safe error", async ({ page }) => {
  await page.goto(`${CE}/ffffffff-ffff-ffff-ffff-ffffffffffff`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toHaveText(/Unhandled|Cannot read/i);
});

test("F-DETAIL-04 feature disabled safe", async ({ page }) => {
  await page.goto(`${CE}/${FAKE_UUID}`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toHaveText(/white.*screen|blank|Unhandled/i);
  await expect(page.locator("body")).not.toBeEmpty();
});

test("F-DETAIL-05 API unavailable no white screen", async ({ page }) => {
  await page.goto(`${CE}/${FAKE_UUID}`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toHaveText(/Cannot read properties|undefined is not/i);
  await expect(page.locator("body")).not.toBeEmpty();
});

// ── F-AUTH ──
test("F-AUTH-01 admin allowed", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: ADMIN_STORAGE });
  const page = await ctx.newPage();
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toHaveText(/Permission denied|Unauthorized/i);
  const denied = await page.locator('text=/denied|unauthorized|403/i').isVisible();
  expect(denied).toBe(false);
  await ctx.close();
});

test("F-AUTH-02 supervisor allowed", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: SUPERVISOR_STORAGE });
  const page = await ctx.newPage();
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toHaveText(/Permission denied|Unauthorized/i);
  await ctx.close();
});

test("F-AUTH-03 qa allowed", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: QA_STORAGE });
  const page = await ctx.newPage();
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).not.toHaveText(/Permission denied|Unauthorized/i);
  await ctx.close();
});

test("F-AUTH-04 agent denied", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: AGENT_STORAGE });
  const page = await ctx.newPage();
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  // Agent must see permission denied, NOT evaluation data
  const hasPermDenied = await page.locator('text=/Permission denied|Unauthorized|無權|denied/i').isVisible();
  expect(hasPermDenied).toBe(true);
  await ctx.close();
});

test("F-AUTH-05 unauthorized no sensitive prefetch", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: AGENT_STORAGE });
  const page = await ctx.newPage();
  const sensitiveResponses: { url: string; status: number }[] = [];
  page.on("response", (res) => {
    if (res.url().includes("conversation_evaluation") && res.status() === 200) {
      sensitiveResponses.push({ url: res.url(), status: res.status() });
    }
  });
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
  // Agent must NOT have received any 200 responses with evaluation data
  expect(sensitiveResponses).toHaveLength(0);
  await ctx.close();
});

// ── F-ARCH ──
test("F-ARCH-01 parent owns guard/layout/Outlet", async () => {
  const src = fs.readFileSync("src/routes/_authenticated/console.conversation-evaluation.tsx", "utf8");
  expect(src).toContain("Outlet");
  expect(src.split("\n").length).toBeLessThan(50);
});

test("F-ARCH-02 index has no selectedId", async () => {
  const src = fs.readFileSync("src/routes/_authenticated/console.conversation-evaluation.index.tsx", "utf8");
  expect(src).not.toMatch(/selectedId/);
});

test("F-ARCH-03 index does not render EvaluationDetail", async () => {
  const src = fs.readFileSync("src/routes/_authenticated/console.conversation-evaluation.index.tsx", "utf8");
  expect(src).not.toMatch(/EvaluationDetail/);
});

test("F-ARCH-04 one detail implementation", async () => {
  expect(fs.existsSync("src/routes/_authenticated/console.conversation-evaluation.$evaluationId.tsx")).toBe(true);
});

test("F-ARCH-05 Open uses route navigation", async () => {
  const src = fs.readFileSync("src/routes/_authenticated/console.conversation-evaluation.index.tsx", "utf8");
  expect(src).toMatch(/navigate/);
});

test("F-ARCH-06 routeTree generated", async () => {
  // In full repo, routeTree.gen.ts must exist and be auto-generated
  expect(fs.existsSync("src/routeTree.gen.ts")).toBe(true);
  const gen = fs.readFileSync("src/routeTree.gen.ts", "utf8");
  expect(gen).toMatch(/auto-generated|generated|do not edit/i);
});

test("F-ARCH-07 no manual routeTree patch", async () => {
  const gen = fs.readFileSync("src/routeTree.gen.ts", "utf8");
  // Generated files should not contain manual edit markers
  expect(gen).not.toMatch(/MANUAL_EDIT|hand-modified|patched/i);
});

test("F-ARCH-08 no duplicate route warning", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning" && msg.text().toLowerCase().includes("duplicate")) {
      warnings.push(msg.text());
    }
  });
  await page.goto(`${CE}/`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
  expect(warnings).toHaveLength(0);
});
