import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import usePrefersReducedMotion from "../hooks/usePrefersReducedMotion";
import { stopScroll, startScroll, scrollToTop } from "../lib/lenis";

const RealmEntryContext = createContext(null);

/**
 * Drives the camera-through-crystal entry when a realm portal is chosen:
 * brighten -> energy push -> fragment flyby -> black peak (navigate here)
 * -> the overlay dissolves onto the freshly mounted realm page.
 *
 * The overlay lives ABOVE the route change (provider is mounted in App), so
 * the veil survives navigation. Navigation fires at ~520ms — comfortably
 * inside the verify harness's 900ms post-click path assertion.
 */
export function RealmEntryProvider({ children }) {
  const [phase, setPhase] = useState("idle"); // idle | closing | opening
  const [entry, setEntry] = useState(null); // { route, accent, x, y }
  const navigate = useNavigate();
  const reduced = usePrefersReducedMotion();
  const busy = useRef(false);
  const timers = useRef([]);

  const after = useCallback((ms, fn) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const finish = useCallback(() => {
    timers.current.forEach((id) => clearTimeout(id));
    timers.current = [];
    setPhase("idle");
    setEntry(null);
    busy.current = false;
    startScroll();
  }, []);

  const enterRealm = useCallback(
    (route, { accent = "#7c3aed", x = 0.5, y = 0.5 } = {}) => {
      if (busy.current) return;
      busy.current = true;
      stopScroll();
      setEntry({ route, accent, x, y });
      setPhase("closing");

      if (reduced) {
        after(140, () => {
          navigate(route);
          scrollToTop(true);
          setPhase("opening");
        });
        after(900, finish);
        return;
      }

      // black peak — mount the realm underneath the veil
      after(520, () => {
        navigate(route);
        scrollToTop(true);
        setPhase("opening");
      });
      after(520 + 980, finish);
    },
    [reduced, navigate, after, finish]
  );

  const value = useMemo(() => ({ phase, entry, enterRealm }), [phase, entry, enterRealm]);

  return <RealmEntryContext.Provider value={value}>{children}</RealmEntryContext.Provider>;
}

export function useRealmEntry() {
  const ctx = useContext(RealmEntryContext);
  if (!ctx) throw new Error("useRealmEntry must be used within RealmEntryProvider");
  return ctx;
}
