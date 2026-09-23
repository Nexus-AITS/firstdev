import { defineConfig } from "vite";
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
function securityHeadersPlugin() {
  // NOTE: must return undefined — a returned Connect app would be mistaken
  // for Vite's "post configureServer" hook and called as a function.
  const apply = (server, { preview }) => {
    server.middlewares.use((_req, res, next) => {
      const csp = [
        "default-src 'self'",
        `script-src 'self'${preview ? "" : " 'unsafe-inline'"}`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        `connect-src 'self'${preview ? "" : " ws: wss:"}`,
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

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), securityHeadersPlugin()],
  // Strip casual console noise from production bundles; warn/error survive.
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
}));

