# NEXUS

A grand, cinematic, futuristic event-universe frontend.

> Black + Purple + Violet + Crystal White. Occasional gold energy inside important cores.

## Stack

- React 19 + Vite
- React Router 7
- Tailwind CSS 4
- GSAP + ScrollTrigger
- Lenis (smooth scroll)
- Three.js / React Three Fiber (procedural crystal core)
- Framer Motion

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build
npm run preview  # preview build
```

## Routes

| Route              | Page                        |
| ------------------ | --------------------------- |
| `/`                | Home gateway                |
| `/events`          | Realm selection             |
| `/events/forge`    | Technical realm             |
| `/events/paradox`  | Non-technical realm         |
| `/events/arena`    | Esports realm               |
| `/events/:eventId` | Event detail                |
| `/gateway`         | Registration gateway        |
| `/ai`              | Nexus AI                    |
| `/about`           | About Nexus                 |

## Centralized external links

All registration/application URLs live in **`src/config/eventLinks.js`**.
Replace `https://YOUR-REAL-APP-URL...` with the real application — nothing else
needs to change.

Every event's "Enter Event" CTA first routes to **`/gateway`** (the themed
registration hand-off page, `src/pages/Gateway.jsx`), whose single "Enter the
application" button resolves `APPLICATION_BASE_URL` — so the final link can
also be swapped in that one file.

Event content lives in **`src/data/events.js`** (add/edit events there).

## Accessibility & performance

- Keyboard navigation, visible focus states, semantic landmarks
- `prefers-reduced-motion` disables cinematic animation & smooth scroll
- WebGL fallback (CSS crystal), reduced particle density on mobile/tablet
- Canvas loops pause when the tab is hidden

## Verification

An automated Playwright suite lives at `verify.mjs`:

```bash
npm run build
npm run preview   # keep running on :4173
node verify.mjs   # uses system Chrome (channel: "chrome")
```

It checks all routes × desktop/mobile viewports for console errors and
horizontal overflow, the ENTER NEXUS transition (normal + reduced-motion),
realm-portal navigation, the mobile menu, keyboard focus order, and that
event CTAs pass through `/gateway`, which resolves the external link via
`eventLinks.js`.

---

## Performance & security (built in)

- **Route-level code splitting** — every page except the landing hero is a
  `React.lazy` chunk, so the entry bundle no longer carries all ten pages.
- **WebGL off the critical path** — three.js (the largest dependency) loads
  behind `LazyCrystalCanvas` / `LazyRealmStage` with on-brand CSS fallbacks
  (nebula backdrop / faceted silhouette); first paint never waits for it.
- **Vendor chunks** — `react` / `three` / `gsap` / `motion` are split in
  `vite.config.js` for long-term caching.
- **Security headers** — CSP, `nosniff`, frame-deny, referrer and
  permissions policies are served by dev/preview via the
  `securityHeadersPlugin` in `vite.config.js` and mirrored for hosting in
  `public/_headers` (Netlify / Cloudflare Pages). Keep both in sync.
- **Dependency audit** — `npm audit` reports 0 vulnerabilities.
- **Compositor-friendly motion** — every keyframe animates only
  transform / opacity / clip-path / stroke-dashoffset; WebGL stages pause
  on hidden tabs and respect reduced-motion.
- **Production hygiene** — `console.log/debug/info` are stripped from
  production bundles (warn/error survive); external CTAs carry
  `rel="noopener noreferrer"`.
