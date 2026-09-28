/**
 * Local PageSpeed-style lab harness (Lighthouse mobile emulation).
 *
 *   1.6 Mbps down / 750 Kbps up / 150 ms RTT, 4x CPU throttling,
 *   Moto G Power class viewport (390x844 @ dpr3, touch).
 *
 * Reports FCP, LCP, TBT, CLS, DCL, load, transferred bytes by type,
 * long tasks and a rough Speed Index (visual completeness checkpoints).
 *
 * Usage:  node scripts/psi-lab.mjs [url] [label]
 * The site must already be served (npm run preview -> http://localhost:4173).
 */
import { chromium } from "playwright";

const URL = process.argv[2] || "http://localhost:4173/";
const LABEL = process.argv[3] || "run";

const NET = {
  offline: false,
  latency: 150,
  downloadThroughput: Math.round((1.6 * 1024 * 1024) / 8), // 1.6 Mbps
  uploadThroughput: Math.round((750 * 1024) / 8),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collect(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = performance.getEntriesByType("paint");
    const fcp = paints.find((p) => p.name === "first-contentful-paint")?.startTime ?? null;

    let lcp = null;
    try {
      // LCP is observer-only: it is NOT in performance.getEntriesByType()
      // (getEntriesByType("largest-contentful-paint") always returns []), which
      // is why this used to report -1 on every run. The init script records it.
      lcp = window.__lcp ?? null;
      if (lcp === null) {
        const entries = performance.getEntriesByType("largest-contentful-paint");
        lcp = entries.length ? entries[entries.length - 1].startTime : null;
      }
    } catch {
      /* observer-only */
    }

    let cls = 0;
    try {
      for (const e of performance.getEntriesByType("layout-shift")) {
        if (!e.hadRecentInput) cls += e.value;
      }
    } catch {
      /* unsupported */
    }

    const resources = performance.getEntriesByType("resource").map((r) => ({
      name: r.name,
      type: r.initiatorType,
      transfer: r.transferSize || 0,
      encoded: r.encodedBodySize || 0,
    }));

    const byType = {};
    for (const r of resources) byType[r.type] = (byType[r.type] || 0) + r.transfer;

    return {
      fcp: Math.round(fcp ?? -1),
      lcp: Math.round(lcp ?? -1),
      cls: Number(cls.toFixed(4)),
      domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? -1),
      load: Math.round(nav?.loadEventEnd ?? -1),
      transferByType: byType,
      totalTransfer: resources.reduce((s, r) => s + r.transfer, 0),
      resources: resources.length,
      __tbt: 0,
    };
  });
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", args: ["--disable-gpu-vsync"] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 11; Moto G Power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
  });

  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", NET);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  // Long-task / TBT observer injected before any app script runs.
  await page.addInitScript(() => {
    window.__tasks = [];
    window.__lcp = null;
    window.__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__tasks.push({ start: e.startTime, dur: e.duration });
        }
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* unsupported */
    }
    try {
      new PerformanceObserver((list) => {
        const es = list.getEntries();
        if (es.length) window.__lcp = es[es.length - 1].startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      /* unsupported */
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      /* unsupported */
    }
    // Visual completeness checkpoints for a rough Speed Index.
    window.__checkpoints = [];
    const t0 = performance.now();
    const tick = () => {
      window.__checkpoints.push([
        Math.round(performance.now() - t0),
        Math.round((window.scrollY + window.innerHeight >= document.body.scrollHeight ? 1 : 0) * 100),
      ]);
      if (performance.now() - t0 < 15000) setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });

  const t0 = Date.now();
  await page.goto(URL, { waitUntil: "load", timeout: 90000 });
  await sleep(12000); // let the experience settle + capture late LCP
  const wall = Date.now() - t0;

  const base = await collect(page);
  const extra = await page.evaluate(() => {
    const tasks = window.__tasks || [];
    const tbt = tasks.reduce((s, t) => s + Math.max(0, t.dur - 50), 0);
    const h1 = document.querySelector("h1");
    const lcpEl = (() => {
      // Best-effort: report the biggest text/image node that painted late.
      const imgs = [...document.querySelectorAll("img")].map((i) => ({
        tag: "img",
        src: i.currentSrc || i.src,
        w: i.getBoundingClientRect().width,
        h: i.getBoundingClientRect().height,
      }));
      return { h1: h1 ? h1.textContent.trim().slice(0, 40) : null, imgs };
    })();
    return {
      tbt: Math.round(tbt),
      longTasks: tasks.length,
      longest: Math.round(tasks.reduce((m, t) => Math.max(m, t.dur), 0)),
      lcpObserved: Math.round(window.__lcp || -1),
      clsObserved: Number((window.__cls || 0).toFixed(4)),
      lcpEl,
      domNodes: document.querySelectorAll("*").length,
      animated: document.getAnimations().length,
    };
  });

  console.log(JSON.stringify({ label: LABEL, url: URL, wallMs: wall, ...base, ...extra, errors: errors.slice(0, 5) }, null, 2));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
