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
 *  2. Runtime config — the browser fetches /api/config (api/config.js) for its
 *     Supabase credentials, so the catch-all SPA rewrite must NOT swallow /api/*.
 *     A rewrite that captured it would return index.html to fetch(), the config
 *     would parse as null, and auth would die with no error anywhere. The CSP
 *     `connect-src` must also allow the Supabase wildcard.
 *
 *  3. Secret hygiene — no VITE_ prefix may survive (that prefix is what inlines
 *     a value into the public bundle), and the values /api/config hands the
 *     browser must be publishable: no PAT (sbp_…), service-role key or database
 *     connection string.
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

  function sourceToRegExp(src) {
    // The rewrite is "/((?!api/).*)" — a catch-all that excludes /api/* so the
    // runtime-config function stays reachable. Two traps make a naive
    // translation wrong, and both yield a FALSE NEGATIVE (every route reported
    // as uncovered) rather than a false pass:
    //   1. escaping the source wholesale turns "(?!api/)" into a literal that
    //      matches nothing, so the lookahead must survive as a lookahead;
    //   2. translated literally the lookahead sits INSIDE the group and is
    //      evaluated after the leading slash, rejecting the bare root "/".
    // Vercel applies the exclusion to the path as a whole, so: root and every
    // normal route match, /api/... does not.
    const m = /^\/\(\(\?!(\/?[^)]*)\)\.\*\)$/.exec(src);
    if (m) return new RegExp("^/(?!" + m[1] + ").*$");
    // Any other shape: walk it, keeping lookaheads intact.
    let out = "";
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "(" && src.startsWith("(?!", i)) {
        const close = src.indexOf(")", i);
        if (close === -1) break;
        out += "(?!" + src.slice(i + 3, close) + ")";
        i = close + 1;
      } else if (ch === "*") {
        out += ".*";
        i += 1;
      } else if (ch === ".") {
        // ".*" is a wildcard, not a literal dot plus a quantifier.
        out += src[i + 1] === "*" ? "." : "\\.";
        i += 1;
      } else if (ch === "(" || ch === ")" || ch === "/") {
        out += ch;
        i += 1;
      } else {
        out += ch.replace(/[+?^${}|[\]\\]/, "\\$&");
        i += 1;
      }
    }
    return new RegExp("^" + out + "$");
  }
  function rewritesMatch(rw, route) {
    const src = rw.source ?? "";
    if (src === "/(.*)" || src === "*" || src === "/*") return true;
    if (/^\/api(\/|$)/.test(route)) return false; // never rewritten to the SPA
    return sourceToRegExp(src).test(route);
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

/* ---------- 2) runtime config: /api/* must survive the SPA rewrite ---------- */

const envPath = path(".env");
const envVars = loadEnv(envPath);
// Fall back to .env.example so a fresh clone / CI still exercises this check.
const vars = envVars ?? loadEnv(path(".env.example")) ?? {};

// The rewrite must exclude /api/ or the config endpoint is unreachable. This is
// the highest-value check in the file: getting it wrong produces a green deploy
// with completely dead auth and no error message anywhere.
if (vercel) {
  const spaRewrites = (vercel.rewrites ?? []).filter((rw) => rw.destination === "/index.html");
  const capturesApi = spaRewrites.some((rw) => {
    const src = rw.source ?? "";
    if (src === "/(.*)" || src === "*" || src === "/*") return true;
    // A negative lookahead like /((?!api/).*) is the correct exclusion.
    return !/\(\?!api\//.test(src);
  });
  out(
    !capturesApi,
    "vercel.json rewrite excludes /api/ (runtime config reachable)",
    capturesApi ? "the catch-all would rewrite /api/config to index.html" : "excluded"
  );
}

// The CSP must permit the Supabase origin the runtime config will hand out.
for (const file of ["public/_headers", "vercel.json"]) {
  out(
    read(file).includes("https://*.supabase.co"),
    `${file} CSP allows the Supabase origin`,
    "connect-src https://*.supabase.co"
  );
}

// The function itself must exist, or there is nothing to fetch.
out(
  existsSync(path("api/config.js")),
  "api/config.js exists",
  existsSync(path("api/config.js")) ? "" : "runtime config endpoint is missing"
);

/* ---------- 3) no VITE_ prefix, and no secret in what /api/config serves ---------- */

const SECRET_PATTERNS = [
  [/\bsbp_[A-Za-z0-9_-]+/, "Supabase access token (sbp_…)"],
  [/service_role/i, "service-role key"],
  [/postgres(ql)?:\/\//i, "database connection string"],
];

// A VITE_ prefix is now a bug, not a convention: it makes Vite inline the value
// into the public bundle, which is exactly the coupling /api/config removes.
const viteKeys = Object.keys(vars).filter((k) => k.startsWith("VITE_"));
out(
  viteKeys.length === 0,
  "no VITE_-prefixed vars remain",
  viteKeys.length ? `still inlining into the bundle: ${viteKeys.join(", ")}` : "runtime config only"
);

// Whatever /api/config hands the browser must be publishable, never privileged.
for (const key of ["SUPABASE_ANON_KEY"]) {
  if (!(key in vars)) continue;
  const hit = SECRET_PATTERNS.find(([rx]) => rx.test(vars[key]));
  out(!hit, `${key} carries no secret`, hit ? hit[1] : "");
}

// The endpoint must read the server-side names, not a prefixed one.
const apiConfig = read("api/config.js");
for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY"]) {
  out(
    apiConfig.includes(`process.env.${name}`),
    `api/config.js reads ${name} from the server environment`
  );
}
out(
  !/process\.env\.VITE_/.test(apiConfig),
  "api/config.js reads no VITE_-prefixed variable",
  /process\.env\.VITE_/.test(apiConfig) ? "a prefixed var would still be inlined" : ""
);

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
