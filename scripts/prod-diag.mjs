/** Live production diagnostic — what does /register actually render? */
import { chromium } from "playwright";

const urls = [
  "https://nexus.n-events.tech/register?bundle=bundled-399",
  "https://nexus.n-events.tech/register?bundle=bundled-349",
  "https://nexus.n-events.tech/",
];
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const out = [];
const capture = (tag) => {
  page.on("console", (m) => {
    if (m.type() === "error") out.push(`[${tag}][console.error] ${m.text()}`);
  });
  page.on("pageerror", (e) => out.push(`[${tag}][pageerror] ${e.message}`));
  page.on("requestfailed", (r) =>
    out.push(`[${tag}][reqfail] ${r.url()} :: ${r.failure()?.errorText}`)
  );
};

for (let i = 0; i < urls.length; i++) {
  const url = urls[i];
  const tag = `page${i}`;
  capture(tag);
  out.push(`=== ${url} ===`);
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    out.push(`status=${resp?.status()}`);
  } catch (e) {
    out.push(`goto-error: ${e.message}`);
  }
  await page.waitForTimeout(4000);
  out.push(`url-after=${page.url()}`);
  const info = await page.evaluate(() => ({
    h1: document.querySelector("h1")?.textContent || "(no h1)",
    inputs: [...document.querySelectorAll("input,select")].length,
    buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).slice(0, 8),
    text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 500),
    entry: [...document.scripts].map((s) => s.src).filter(Boolean),
  }));
  out.push(`h1=${info.h1}`);
  out.push(`inputs=${info.inputs} buttons=${JSON.stringify(info.buttons)}`);
  out.push(`text=${info.text}`);
  out.push(`scripts=${JSON.stringify(info.entry)}`);
  await page.screenshot({ path: `artifacts/prod-diag-${i}.png` });
}
await browser.close();
console.log(out.join("\n"));
