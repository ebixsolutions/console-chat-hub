// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";
import { fileURLToPath } from "node:url";

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

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [mcpPlugin()],
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
