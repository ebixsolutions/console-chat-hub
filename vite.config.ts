// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const isolatedBrowserAuth = process.env.C3_ISOLATED_BROWSER_AUTH === "local-only";
if (isolatedBrowserAuth && process.env.NODE_ENV === "production") {
  throw new Error("Isolated browser Auth binding is forbidden in a production build");
}

const consoleEnvironment = process.env.C3_CONSOLE_ENV;
if (consoleEnvironment && !["production", "nonproduction"].includes(consoleEnvironment)) {
  throw new Error("Unknown C3 Console environment");
}
const nonproductionConsole = consoleEnvironment === "nonproduction";
if (nonproductionConsole && isolatedBrowserAuth) {
  throw new Error("Nonproduction Console cannot use isolated mock Auth");
}
const buildIdentity = nonproductionConsole
  ? `${execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()} / ${execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim()}${execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() ? " / WORKTREE MODIFIED" : ""}`
  : "";
const tlsCert = process.env.C3_DEMO_TLS_CERT;
const tlsKey = process.env.C3_DEMO_TLS_KEY;
if ((tlsCert || tlsKey) && (!nonproductionConsole || !tlsCert || !tlsKey)) {
  throw new Error("Demo TLS requires nonproduction and both certificate paths");
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    define: { "import.meta.env.VITE_C3_BUILD_IDENTITY": JSON.stringify(buildIdentity) },
    server: tlsCert && tlsKey ? { https: { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) } } : undefined,
    plugins: [mcpPlugin(), ...(nonproductionConsole ? [{
      name: "c3-nonproduction-customer-entrypoint",
      configureServer(server: any) {
        server.middlewares.use((req: any, res: any, next: any) => {
          if (req.url !== "/phase1-demo") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>C3 Phase 1 Demo</title><body><h1>NONPRODUCTION</h1><p>nbtowfuvvfqpxqydyoby</p><p>${buildIdentity}</p><p>按右下角聊天按鈕開始；真人接手請開啟 <a href="/console/conversations">Chat Console</a>。</p><script src="/widget/chat.js" data-channel-id="f6000000-0000-4000-8000-000000000130" data-api-base="https://nbtowfuvvfqpxqydyoby.supabase.co/functions/v1" defer></script></body></html>`);
        });
      },
    }] : [])],
    // Test-only external Auth boundary. The production binding module and
    // application source are unchanged; this alias requires explicit dev mode.
    resolve: nonproductionConsole
      ? {
          alias: [
            {
              find: /^(?:.*\/)?runtime-authority\.mjs$/,
              replacement: fileURLToPath(
                new URL("./src/integrations/supabase/nonproduction-authority.mjs", import.meta.url),
              ),
            },
          ],
        }
      : isolatedBrowserAuth
        ? {
            alias: [
              {
                // Match the entire import specifier. A suffix-only regex leaves
                // "./" in front of the absolute replacement and breaks SSR loading.
                find: /^(?:.*\/)?runtime-authority\.mjs$/,
                replacement: fileURLToPath(
                  new URL("./tests/e2e/c3_local_auth_authority.mjs", import.meta.url),
                ),
              },
            ],
          }
        : undefined,
  },
});
