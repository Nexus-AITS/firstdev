import { useEffect } from "react";
import Lenis from "lenis";
import { gsap, ScrollTrigger } from "../lib/gsap";
import { setLenis } from "../lib/lenis";
import usePrefersReducedMotion from "./usePrefersReducedMotion";

/**
 * Lenis smooth scrolling wired into the GSAP ticker so ScrollTrigger and
 * Lenis share a single rAF loop. Disabled entirely for reduced-motion users.
 */
export default function useSmoothScroll() {
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) {
      setLenis(null);
      return undefined;
    }

    const lenis = new Lenis({
      // 0.09 floated for ~1 frame too long after any hiccup and read as
      // "stuck"; 0.11 keeps the cinematic glide but tracks input immediately.
      lerp: 0.11,
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 1.6,
    });
    setLenis(lenis);

    const onScroll = () => ScrollTrigger.update();
    lenis.on("scroll", onScroll);

    const raf = (time) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(raf);
      lenis.off("scroll", onScroll);
      lenis.destroy();
      setLenis(null);
    };
  }, [reduced]);
}
