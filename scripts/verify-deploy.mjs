/**
 * Deploy-shape guard — `npm run verify:deploy` (wired as `npm test`).
 *
 * These invariants are maintained BY HAND across four files and therefore drift
 * silently. Each check below fails the run when they disagree:
 *
 *  1. SPA fallback — every route declared in src/App.jsx must be covered by a
 *     200 rule in public/_redirects AND by a vercel.json rewrite, so a cold
 *     load / hard refresh of e.g. /register cannot 404. The two files are
 *     alternatives, not a pair: only vercel.json is honoured on Vercel, only
 *     _redirects on Netlify / Cloudflare Pages — so both are checked.
 *
 *  2. CSP origin — connect-src must allow the Supabase project. vite.config.js
 *     derives the origin from VITE_SUPABASE_URL, but public/_headers and
 *     vercel.json cannot read env vars and hardcode it; changing the Supabase
 *     project then silently blocks every auth request in the browser.
 *
 *  3. Secret hygiene — anything carrying a VITE_ prefix is inlined into the
 *     public bundle, so no PAT (sbp_…), service-role key or database
 *     connection string may wear one.
 *
 *  4. .env must be gitignored and untracked (it holds the anon key and,
 *     locally, the PAT).
 *
 * Needs no server and no browser: npm test
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const out = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
};

const path = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel) => readFileSync(path(rel), "utf8");

/** Minimal KEY=value .env parser — same shape as scripts/apply-migration.mjs. */
function loadEnv(file) {
  if (!existsSync(file)) return null;
  const vars = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}

/* ---------- 1) SPA fallback coverage ---------- */

const app = read("src/App.jsx");
const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((p) => p !== "*"); // the JSX catch-all is the 404 route, not a URL

// "<src> /index.html 200" — comments and blank lines are skipped.
const redirectRules = read("public/_redirects")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split(/\s+/))
  .filter(([, dest, status]) => dest === "/index.html" && status === "200")
  .map(([src]) => src);

/** Netlify-style match: `/events/*` covers /events and /events/<anything>. */
function redirectsMatch(src, route) {
  if (src === "*" || src === "/*") return true;
  if (src.endsWith("/*")) {
    const base = src.slice(0, -2);
    return route === base || route.startsWith(`${base}/`);
  }
  if (src.endsWith("*")) return route.startsWith(src.slice(0, -1));
  return route === src;
}

const missingRedirects = routes.filter(
  (route) => !redirectRules.some((src) => redirectsMatch(src, route))
);
out(
  missingRedirects.length === 0,
  "public/_redirects covers every declared route",
  missingRedirects.length ? `missing: ${missingRedirects.join(", ")}` : `${routes.length} routes`
);

let vercel;
try {
  vercel = JSON.parse(read("vercel.json"));
} catch (err) {
  vercel = null;
  out(false, "vercel.json parses", String(err.message || err));
}
if (vercel) {
  const spaRewrites = (vercel.rewrites ?? []).filter((rw) => rw.destination === "/index.html");

  /** Vercel sources are path-to-regexp; ours is the catch-all "/(.*)". */
  function rewritesMatch(rw, route) {
    const src = rw.source ?? "";
    if (src === "/(.*)" || src === "*" || src === "/*") return true;
    const rx = new RegExp(
      `^${src.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`
    );
    return rx.test(route);
  }

  const missingRewrite = routes.filter(
    (route) => !spaRewrites.some((rw) => rewritesMatch(rw, route))
  );
  out(
    missingRewrite.length === 0 && spaRewrites.length > 0,
    "vercel.json rewrite covers every declared route",
    missingRewrite.length
      ? `missing: ${missingRewrite.join(", ")}`
      : spaRewrites.length
        ? `${routes.length} routes`
        : "no SPA rewrite found"
  );
}

/* ---------- 2) CSP origin is in sync ---------- */

const envPath = path(".env");
const envVars = loadEnv(envPath);
// Fall back to .env.example so a fresh clone / CI still exercises this check.
const vars = envVars ?? loadEnv(path(".env.example")) ?? {};

let origin = null;
try {
  origin = new URL(vars.VITE_SUPABASE_URL).origin;
} catch {
  origin = null;
}

if (!origin) {
  out(true, "CSP origin sync", "skipped — no VITE_SUPABASE_URL in .env or .env.example");
} else {
  out(
    read("public/_headers").includes(origin),
    "public/_headers CSP allows the Supabase origin",
    origin
  );
  out(
    read("vercel.json").includes(origin),
    "vercel.json CSP allows the Supabase origin",
    origin
  );
}

/* ---------- 3) no secret may carry a VITE_ prefix ---------- */

const SECRET_PATTERNS = [
  [/\bsbp_[A-Za-z0-9_-]+/, "Supabase access token (sbp_…)"],
  [/service_role/i, "service-role key"],
  [/postgres(ql)?:\/\//i, "database connection string"],
];

const viteKeys = Object.keys(vars).filter((k) => k.startsWith("VITE_"));
if (viteKeys.length === 0) {
  out(true, "VITE_ secret scan", "skipped — no VITE_ vars found");
}
for (const key of viteKeys) {
  const hit = SECRET_PATTERNS.find(([rx]) => rx.test(key) || rx.test(vars[key]));
  out(!hit, `VITE_ var "${key}" carries no secret`, hit ? hit[1] : "");
}

/* ---------- 4) .env stays out of the repo ---------- */

const gitignore = existsSync(path(".gitignore")) ? read(".gitignore") : "";
const rules = gitignore
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const ignored = rules.some(
  (rule) => rule === ".env" || rule === ".env.*" || rule === "*" || rule === "**"
);
out(ignored, ".env is covered by .gitignore", ignored ? "" : "no rule matches .env");

try {
  const tracked = execFileSync("git", ["ls-files", "--", ".env"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  }).trim();
  out(tracked === "", ".env is not tracked by git", tracked ? tracked : "untracked");
} catch {
  out(true, ".env git tracking", "skipped — git unavailable");
}

console.log(
  failures === 0
    ? "\n=== ALL DEPLOY CHECKS PASSED ==="
    : `\n=== ${failures} DEPLOY CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);