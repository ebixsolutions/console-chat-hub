// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { ConfigEnv } from "vite";
import { resolveConsoleEnvironment } from "./vite.preview-environment.mjs";
import { candidateIdentity, candidateIdentityPlugin, renderCandidateIdentity } from "./vite.candidate-identity.mjs";

export default async (environment: ConfigEnv) => {

const isolatedBrowserAuth = process.env.C3_ISOLATED_BROWSER_AUTH === "local-only";
if (isolatedBrowserAuth && process.env.NODE_ENV === "production") {
  throw new Error("Isolated browser Auth binding is forbidden in a production build");
}

const consoleEnvironment = resolveConsoleEnvironment(environment, process.env);
if (consoleEnvironment && !["production", "nonproduction"].includes(consoleEnvironment)) {
  throw new Error("Unknown C3 Console environment");
}
const nonproductionConsole = consoleEnvironment === "nonproduction";
const previewRouteTree = fileURLToPath(new URL("./.tanstack/c3-preview-routeTree.gen.ts", import.meta.url));
if (nonproductionConsole && isolatedBrowserAuth) {
  throw new Error("Nonproduction Console cannot use isolated mock Auth");
}
const identity = candidateIdentity(nonproductionConsole);
const buildIdentity = renderCandidateIdentity(identity);
const demoHtml = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>C3 Phase 1 Demo</title><body><h1>NONPRODUCTION</h1><p>nbtowfuvvfqpxqydyoby</p><p>${buildIdentity}</p><p>按右下角聊天按鈕開始；真人接手請開啟 <a href="/console/conversations">Chat Console</a>。</p><script src="/widget/chat.js" data-channel-id="f6000000-0000-4000-8000-000000000130" data-api-base="https://nbtowfuvvfqpxqydyoby.supabase.co/functions/v1" defer></script></body></html>`;
const tlsCert = process.env.C3_DEMO_TLS_CERT;
const tlsKey = process.env.C3_DEMO_TLS_KEY;
if ((tlsCert || tlsKey) && (!nonproductionConsole || !tlsCert || !tlsKey)) {
  throw new Error("Demo TLS requires nonproduction and both certificate paths");
}

return defineConfig({
  tanstackStart: {
    // Start needs its route crawler. Keep Preview's generated output in the
    // existing ignored build cache, rather than rewriting frozen source.
    router: { generatedRouteTree: previewRouteTree },
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    define: { "import.meta.env.VITE_C3_BUILD_IDENTITY": JSON.stringify(buildIdentity), "import.meta.env.VITE_C3_CANDIDATE": JSON.stringify(identity) },
    server: tlsCert && tlsKey ? { https: { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) } } : undefined,
    plugins: [mcpPlugin(), candidateIdentityPlugin(identity), ...(nonproductionConsole ? [{
      name: "c3-nonproduction-customer-entrypoint",
      configureServer(server: any) {
        server.middlewares.use((req: any, res: any, next: any) => {
          if (req.url !== "/phase1-demo") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(demoHtml);
        });
      },
      generateBundle(this: any) {
        // The hosted Preview can serve a development build instead of the
        // sandbox dev process. Reuse exactly the same existing Widget page.
        this.emitFile({ type: "asset", fileName: "phase1-demo/index.html", source: demoHtml });
      },
    }] : [])],
    // Start's client-tree plugin handles only generatedRouteTree. Every target
    // must import that same file so SSR metadata and server-only pruning agree.
    resolve: {
      alias: [
        { find: /^(?:.*\/)?routeTree\.gen(?:\.ts)?$/, replacement: previewRouteTree },
        ...(nonproductionConsole ? [{
          find: /^(?:.*\/)?runtime-authority\.mjs$/,
          replacement: fileURLToPath(new URL("./src/integrations/supabase/nonproduction-authority.mjs", import.meta.url)),
        }] : isolatedBrowserAuth ? [{
          find: /^(?:.*\/)?runtime-authority\.mjs$/,
          replacement: fileURLToPath(new URL("./tests/e2e/c3_local_auth_authority.mjs", import.meta.url)),
        }] : []),
      ],
    },
  },
})(environment);
};
