import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
/**
 * Supabase project backing Google sign-in.
 *
 * The dev/preview CSP takes the origin from `VITE_SUPABASE_URL` in `.env`
 * (read via loadEnv below), falling back to the known project when the env
 * var is absent so an unconfigured build still ships a working policy.
 * public/_headers and vercel.json must still hardcode the origin — static
 * headers files cannot read env vars — so changing the Supabase project
 * means updating those two as well, or the browser silently blocks auth.
 */
const FALLBACK_SUPABASE_ORIGIN = "https://xvteqcvvjlxhwijwxbbq.supabase.co";

/** Origin of a URL, or the fallback when the value is missing/malformed. */
function resolveSupabaseOrigin(url) {
  if (!url) return FALLBACK_SUPABASE_ORIGIN;
  try {
    return new URL(url).origin;
  } catch {
    return FALLBACK_SUPABASE_ORIGIN;
  }
}

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
  // `.env` is the single source of truth for the Supabase origin at dev and
  // preview time; production headers live in public/_headers + vercel.json.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const supabaseOrigin = resolveSupabaseOrigin(env.VITE_SUPABASE_URL);
  return {
    plugins: [react(), tailwindcss(), securityHeadersPlugin(supabaseOrigin)],
  esbuild: mode === "production" ? { pure: ["console.log", "console.debug", "console.info"] } : {},
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          three: ["three", "@react-three/fiber"],
          gsap: ["gsap"],
          motion: ["framer-motion"],
        },
      },
    },
  },
  },
  };
});

