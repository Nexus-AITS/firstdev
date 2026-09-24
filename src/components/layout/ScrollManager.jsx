import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { gsap, ScrollTrigger } from "../../lib/gsap";
import { scrollToTop } from "../../lib/lenis";

/**
 * Keeps scroll position and ScrollTrigger in sync across route changes.
 */
export default function ScrollManager() {
  const { pathname } = useLocation();

  useEffect(() => {
    scrollToTop(true);
    const id = requestAnimationFrame(() => ScrollTrigger.refresh());
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  // Layout shifts after mount: webfont swap (display serif changes heading
  // metrics) and late image/load settle both invalidate trigger positions.
  // Without this, a hard reload on Home computes the crystal story against
  // stale rects — scatter/glow land on the wrong values ("abnormal NEXUS").
  useEffect(() => {
    const refresh = () => ScrollTrigger.refresh();
    document.fonts?.ready.then(refresh).catch(() => {});
    window.addEventListener("load", refresh, { once: true });
    return () => window.removeEventListener("load", refresh);
  }, []);

  return null;
}

/**
 * Shared helper: creates a fade/rise reveal for a section title group.
 * Returns a cleanup function.
 */
export function revealOnScroll(rootRef, { selector = "[data-reveal]", stagger = 0.12 } = {}) {
  if (!rootRef.current) return () => {};
  const els = rootRef.current.querySelectorAll(selector);
  if (!els.length) return () => {};

  const tween = gsap.from(els, {
    opacity: 0,
    y: 44,
    duration: 1.1,
    ease: "power3.out",
    stagger,
    scrollTrigger: {
      trigger: rootRef.current,
      start: "top 72%",
      once: true,
    },
  });

  return () => {
    tween.scrollTrigger?.kill();
    tween.kill();
  };
}
