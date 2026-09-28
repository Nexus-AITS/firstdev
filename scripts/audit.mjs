/**
 * Mobile audit: WCAG contrast + animation composability, Lighthouse-style.
 *
 *   node scripts/audit.mjs [url] [label]
 *
 * Prints every text node below 4.5:1 (3:1 for large text) with its exact
 * selector, plus every animation whose keyframes touch a property the
 * compositor cannot handle (the "non-composited animations" finding).
 */
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://localhost:4173/";
const LABEL = process.argv[3] || "audit";
const PATHS = ["/", "/events", "/bundled", "/about", "/contact", "/register"];

const browser = await chromium.launch({ channel: "chrome" });

for (const path of PATHS) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(new globalThis.URL(path, BASE).href, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);

  const report = await page.evaluate(() => {
    const parse = (c) => {
      const m = String(c).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(",").map((s) => parseFloat(s.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const lum = (c) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => {
      const l1 = lum(a);
      const l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    const bgOf = (el) => {
      let node = el;
      let acc = { r: 5, g: 3, b: 8, a: 1 };
      const stack = [];
      while (node && node !== document.documentElement) {
        const cs = getComputedStyle(node);
        if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0) stack.push(c);
        if (c && c.a >= 1) break;
        node = node.parentElement;
      }
      for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
      return acc;
    };

    const sel = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += "#" + el.id;
      const cls = (typeof el.className === "string" ? el.className : "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4);
      if (cls.length) s += "." + cls.join(".");
      return s;
    };

    const lowContrast = [];
    for (const el of document.querySelectorAll("body *")) {
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join("");
      if (!text) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (el.closest("[aria-hidden='true']") || el.classList.contains("sr-only")) continue;
      const fgRaw = parse(cs.color);
      if (!fgRaw) continue;
      const bg = bgOf(el);
      if (!bg) continue;
      const op = parseFloat(cs.opacity) || 1;
      const fg = over({ ...fgRaw, a: fgRaw.a * op }, bg);
      const r = ratio(fg, bg);
      const px = parseFloat(cs.fontSize);
      const bold = parseInt(cs.fontWeight, 10) >= 700;
      const large = px >= 24 || (px >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      if (r < need) {
        lowContrast.push({
          selector: sel(el),
          text: text.slice(0, 48),
          color: cs.color,
          background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
          fontSize: px,
          ratio: Number(r.toFixed(2)),
          need,
        });
      }
    }

    /**
     * Properties the compositor can animate on its own thread. `translate`,
     * `rotate` and `scale` are Chrome's individual transform properties — they
     * are composited exactly like `transform`, so they belong in this list too
     * (leaving them out produced false "non-composited" hits on Tailwind v4's
     * `translate-y-*` utilities, which compile to `translate`, not `transform`).
     */
    const COMPOSITED = new Set([
      "transform",
      "translate",
      "rotate",
      "scale",
      "opacity",
      "filter",
      "-webkit-transform",
    ]);
    const anims = new Map();
    for (const a of document.getAnimations()) {
      if (!a.effect || typeof a.effect.getKeyframes !== "function") continue;
      const props = new Set();
      for (const kf of a.effect.getKeyframes()) {
        for (const k of Object.keys(kf)) {
          if (["offset", "easing", "composite", "computedOffset"].includes(k)) continue;
          props.add(k);
        }
      }
      const target = a.effect.target;
      const key = [...props].sort().join("+") + " | " + (target ? sel(target) : "?");
      const prev =
        anims.get(key) ||
        { props: [...props], target: target ? sel(target) : "?", count: 0, infinite: false, name: "" };
      prev.count += 1;
      // Infinite is not readable from one API alone on this Chrome build:
      // getTiming().iterations is the specified count (Infinity for a CSS
      // `infinite`), while getComputedTiming().iterationCount comes back
      // undefined for CSSAnimation. Read whichever answers.
      const timing = a.effect.getTiming();
      const computed = typeof a.effect.getComputedTiming === "function" ? a.effect.getComputedTiming() : null;
      const iterations = timing.iterations ?? computed?.iterationCount;
      if (iterations === Infinity) prev.infinite = true;
      prev.name = a.animationName || prev.name;
      anims.set(key, prev);
    }

    const nonComposited = [];
    const continuous = [];
    for (const [key, v] of anims) {
      const bad = v.props.filter((p) => !COMPOSITED.has(p));
      if (bad.length)
        nonComposited.push({ key, name: v.name, target: v.target, nonCompositedProps: bad, elements: v.count });
      if (v.infinite) continuous.push({ name: v.name, target: v.target, props: v.props, elements: v.count });
    }

    return {
      lowContrast,
      nonComposited,
      continuous: continuous.sort((a, b) => b.elements - a.elements),
      totalAnimations: [...anims.values()].reduce((s, v) => s + v.count, 0),
      domNodes: document.querySelectorAll("*").length,
      canvasCount: document.querySelectorAll("canvas").length,
    };
  });
  report.__path = path;
  console.log("===== " + LABEL + " " + path + " =====");
  console.log(JSON.stringify(report, null, 2));
  await context.close();
}

await browser.close();
