import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import usePrefersReducedMotion from "../hooks/usePrefersReducedMotion";
import { stopScroll, startScroll, scrollToTop } from "../lib/lenis";
import { triggerCrystalBurst, resetCrystalStore } from "../lib/crystalStore";

const TransitionContext = createContext(null);

/**
 * Drives the cinematic ENTER NEXUS transition.
 * phases: idle -> running (overlay plays) -> idle
 * The overlay calls onMidpoint (navigate under full-black veil) & onComplete.
 */
export function TransitionProvider({ children }) {
  const [phase, setPhase] = useState("idle");
  const navigate = useNavigate();
  const reduced = usePrefersReducedMotion();

  const enterNexus = useCallback(() => {
    setPhase((p) => (p === "idle" ? "running" : p));
    stopScroll();
    triggerCrystalBurst();
    // Warm the destination chunk the moment the flight starts so /events is
    // ready long before the veil lifts (deduped with React.lazy's cache).
    import("../pages/Events.jsx").catch(() => {});
  }, []);

  const onMidpoint = useCallback(() => {
    navigate("/events");
    scrollToTop(true);
    resetCrystalStore();
  }, [navigate]);

  const onComplete = useCallback(() => {
    setPhase("idle");
    startScroll();
    // Belt-and-braces: once Lenis is running and the destination DOM has
    // settled, re-assert the top position. The ResizeObserver-driven
    // lenis resize() adopts whatever the native scroll clamped to when the
    // taller page unmounted — if that ever races the midpoint reset, this
    // snaps back to 0 instead of leaving the user at the page bottom.
    // (No-op when already at top: scrollTo early-returns on same target.)
    scrollToTop(true);
  }, []);

  const value = useMemo(
    () => ({ phase, reduced, enterNexus, onMidpoint, onComplete }),
    [phase, reduced, enterNexus, onMidpoint, onComplete]
  );

  return <TransitionContext.Provider value={value}>{children}</TransitionContext.Provider>;
}

export function useNexusTransition() {
  const ctx = useContext(TransitionContext);
  if (!ctx) throw new Error("useNexusTransition must be used within TransitionProvider");
  return ctx;
}
