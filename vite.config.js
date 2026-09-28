import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Supabase project backing Google sign-in.
 *
 * The browser learns the project origin at RUNTIME from /api/config (see
 * api/config.js and src/config/runtime-config.js) rather than from a VITE_
 * variable compiled into the bundle. That has a direct consequence here: the
 * CSP can no longer be derived from an env var at build time, because a static
 * header file cannot read the server environment.
 *
 * So `connect-src` allows the Supabase wildcard instead of one project origin.
 * That is a deliberate, stated trade-off: it is broader than a single project,
 * but the only thing it exposes is the ability to open a connection to *some*
 * Supabase instance. It grants no data access whatsoever — the anon key is
 * public by design and Row Level Security is the actual gate (the only anon
 * grant is a narrow INSERT; reads are denied). The previous hardcoded origin
 * was checked by `npm run verify:deploy`; that check is now obsolete because
 * there is nothing left to keep in sync.
 */
const FALLBACK_SUPABASE_ORIGIN = "https://*.supabase.co";

/** Origin of a URL, or the wildcard fallback when missing/malformed. */
function resolveSupabaseOrigin(url) {
  if (!url) return FALLBACK_SUPABASE_ORIGIN;
  try {
    return new URL(url).origin;
  } catch {
    return FALLBACK_SUPABASE_ORIGIN;
  }
}

/**
 * Serve /api/config during `vite dev` and `vite preview`.
 *
 * The production endpoint is a Vercel function, which a local Vite server knows
 * nothing about. Without this shim every local run — and the whole Playwright
 * suite, including `npm run verify:google` — would see an unconfigured
 * deployment and could not tell a real regression from a missing function. It
 * reads the same non-prefixed env vars and applies the same key-safety rule, so
 * a privileged key is refused here too rather than being handed to the browser.
 */
function runtimeConfigPlugin(supabaseUrl, supabaseAnonKey) {
  const apply = (server) => {
    server.middlewares.use((req, res, next) => {
      const path = (req.url || "").split("?")[0];
      if (path !== "/api/config") return next();

      const send = (status, body) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store, max-age=0");
        res.end(JSON.stringify(body));
      };

      if (!supabaseUrl) return send(503, { error: "SUPABASE_URL is not set" });
      // Refuse anything that is not a publishable key — same rule as the
      // production function, so a service-role key cannot be served locally.
      const publishable =
        supabaseAnonKey.startsWith("sb_publishable_") ||
        (supabaseAnonKey.startsWith("eyJ") && !/service_role/.test(supabaseAnonKey));
      if (!publishable) return send(503, { error: "SUPABASE_ANON_KEY is not a publishable key" });

      return send(200, {
        supabaseUrl: new URL(supabaseUrl).origin,
        supabaseAnonKey,
      });
    });
  };

  return {
    name: "nexus-runtime-config",
    configureServer: (server) => apply(server),
    configurePreviewServer: (server) => apply(server),
  };
}

/**
 * Loud build-time guard for the two Supabase variables.
 *
 * These are no longer inlined into the bundle, so a missing variable no longer
 * produces a silently broken auth surface — it produces a /api/config that
 * answers 503, which the app degrades around. But that is still a green deploy
 * with dead sign-in, so the check stays: it names the missing variables and the
 * fix in the build log, and refuses a production Vercel build outright.
 * Local dev and CI are never fatal (a clone with no .env must still build), and
 * `VITE_REQUIRE_SUPABASE=0` is the escape hatch for a deliberately
 * credential-free deploy, e.g. a design-review preview.
 */
function assertSupabaseEnv(supabaseUrl, supabaseAnonKey, mode) {
  const missing = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!supabaseAnonKey) missing.push("SUPABASE_ANON_KEY");
  if (missing.length === 0) return;

  const banner = [
    "",
    "  !  SUPABASE ENV VARS MISSING",
    `     mode    : ${mode}`,
    `     missing : ${missing.join(", ")}`,
    "",
    "     /api/config will answer 503, so the site deploys but Google sign-in",
    '     and registration cloud sync stay off ("sign-in unavailable" /',
    '     "cloud sync unavailable"). Nothing throws — it fails quietly, which is',
    "     exactly why this is checked at build time.",
    "",
    "     Fix: Vercel → project → Settings → Environment Variables → add",
    `     ${missing.join(" and ")} → tick Production → redeploy.`,
    "     These names carry NO VITE_ prefix on purpose: a prefixed variable is",
    "     inlined into the public bundle at build time, which is what this",
    "     project moved away from. api/config.js serves them at runtime instead.",
    "",
  ].join("\n");

  const required = process.env.VITE_REQUIRE_SUPABASE !== "0";
  if (mode === "production" && process.env.VERCEL && required) {
    throw new Error(
      `${banner}     Refusing to ship. Set VITE_REQUIRE_SUPABASE=0 to override.\n`
    );
  }
  console.warn(banner);
}

/**
 * Security headers for `vite dev` and `vite preview`. The same set is
 * mirrored for real deployments in `public/_headers` (Netlify /
 * Cloudflare Pages) — keep both in sync when changing the policy.
 *
 * - dev relaxes script-src with 'unsafe-inline' (React Refresh injects an
 *   inline module) and allows ws: for HMR; preview/production is strict.
 * - HSTS is only sent by preview and is honored by browsers only over
 *   HTTPS, so it stays inert on localhost but is ready behind TLS.
 */
function securityHeadersPlugin(supabaseOrigin) {
  // NOTE: must return undefined — a returned Connect app would be mistaken
  // for Vite's "post configureServer" hook and called as a function.
  const apply = (server, { preview }) => {
    server.middlewares.use((_req, res, next) => {
      const csp = [
        "default-src 'self'",
        `script-src 'self'${preview ? "" : " 'unsafe-inline'"}`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob: https://*.googleusercontent.com",
        `connect-src 'self' ${supabaseOrigin}${preview ? "" : " ws: wss:"}`,
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; ");

      res.setHeader("Content-Security-Policy", csp);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
      );
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      if (preview) {
        res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
      }
      next();
    });
  };

  return {
    name: "nexus-security-headers",
    configureServer: (server) => apply(server, { preview: false }),
    configurePreviewServer: (server) => apply(server, { preview: true }),
  };
}

export default defineConfig(({ mode }) => {
  // Credentials are NOT read with loadEnv("VITE_") any more — nothing is
  // inlined into the bundle any more. They are read here only to derive the
  // dev/preview CSP and to assert they exist before a deploy; the browser gets
  // them from /api/config at runtime. `SUPABASE_*` is read from the real
  // environment first, then from .env so local dev keeps working.
  const dotenv = loadEnv(mode, process.cwd(), "SUPABASE_");
  const supabaseUrl = process.env.SUPABASE_URL || dotenv.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || dotenv.SUPABASE_ANON_KEY || "";
  assertSupabaseEnv(supabaseUrl, supabaseAnonKey, mode);
  const supabaseOrigin = resolveSupabaseOrigin(supabaseUrl);
  return {
    plugins: [
      react(),
      tailwindcss(),
      securityHeadersPlugin(supabaseOrigin),
      // Only wired up when a URL is actually present; otherwise the shim
      // answers 503, which is the honest "unconfigured" signal.
      runtimeConfigPlugin(supabaseUrl, supabaseAnonKey),
    ],
    // Strip casual console noise from production bundles; warn/error survive.
    esbuild: mode === "production" ? { pure: ["console.log", "console.debug", "console.info"] } : {},
    build: {
      target: "es2020",
      chunkSizeWarningLimit: 900,
      /**
       * Source maps for the first-party bundle.
       *
       * PageSpeed flags "Missing source maps for large first-party JavaScript",
       * and without them a production stack trace is unrecoverable. This is safe
       * to publish here because the bundle contains no secrets: Supabase
       * credentials are fetched at RUNTIME from /api/config (they are never
       * VITE_-inlined), api/config.js is a serverless function that Vite never
       * bundles, and .env never reaches the client. The anon key is public by
       * design — Row Level Security is the actual gate.
       *
       * Trade-off, stated plainly: readable source. If a future change puts a
       * privileged value into the client bundle, switch this to `false` (or to
       * `"hidden"`, which emits .map files without the sourceMappingURL comment
       * so they are not advertised — note that Lighthouse would then flag it
       * again).
       */
      sourcemap: true,
      rollupOptions: {
        output: {
          /**
           * Chunking — and the one subtlety that decides what is in the critical
           * path of every route.
           *
           * `manualChunks` is deliberately a FUNCTION, not the usual object
           * shorthand. The object form (`{ three: ["three"] }`) makes Rollup
           * treat each listed package as an implicit ENTRY chunk, so Vite emits
           * `<link rel="modulepreload">` for it in index.html even when nothing
           * in the initial graph imports it. On this app that put an 860 kB
           * (232 kB gzip) three.js preload plus the @react-three/fiber runtime
           * into the critical path of *every* route — including the ones with no
           * WebGL at all — and was the largest single contributor to the ~4.2 s
           * of LCP render delay PageSpeed reported.
           *
           * The function form only *names* a chunk; it does not promote it to an
           * entry. three is reached exclusively through dynamic `import()`
           * (LazyCrystalCanvas / LazyRealmStage), so its chunk stays behind the
           * Suspense boundary and streams on demand instead of being preloaded.
           * react and framer-motion are genuine static imports of the entry (and
           * gsap is too, via useSmoothScroll ← App), so those chunks are still
           * preloaded — as they should be. The split above exists so the vendor
           * code stays cached across deploys, not to hide it.
           */
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            const path = id.replace(/\\/g, "/");
            // three itself plus the R3F runtime it renders through.
            if (/\/node_modules\/(?:three|@react-three\/[^/]+)\//.test(path)) return "three";
            if (/\/node_modules\/(?:gsap|@gsap)\//.test(path)) return "gsap";
            // framer-motion ships as several packages; keep them together so
            // the version pairing can never drift across chunks.
            if (/\/node_modules\/(?:framer-motion|motion-dom|motion-utils)\//.test(path)) {
              return "motion";
            }
            if (/\/node_modules\/(?:react|react-dom|react-router|react-router-dom|scheduler)\//.test(path)) {
              return "react";
            }
            return undefined;
          },
        },
      },
    },
  };
});

