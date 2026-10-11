import { test as base, expect } from "@playwright/test";

// Shared by the smoke tests. Nothing here can change data on the site under test.
export const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";
export const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const bypassHeaders = BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {};

// Adds the Vercel bypass header to requests for the site itself, never to third parties.
export async function addBypass(context, baseURL) {
  if (!BYPASS) return;
  const host = new URL(baseURL).host;
  await context.route("**/*", route => {
    const request = route.request();
    if (new URL(request.url()).host === host) return route.continue({ headers: { ...request.headers(), "x-vercel-protection-bypass": BYPASS } });
    return route.continue();
  });
}

// The default guard: every non-GET request is aborted in the browser.
export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    const host = new URL(baseURL).host;
    await context.route("**/*", route => {
      const request = route.request();
      if (!READ_METHODS.has(request.method())) return route.abort();
      if (BYPASS && new URL(request.url()).host === host) {
        return route.continue({ headers: { ...request.headers(), "x-vercel-protection-bypass": BYPASS } });
      }
      return route.continue();
    });
    await use(context);
  },
});

export { expect };
