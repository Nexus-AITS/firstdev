import { useEffect, useRef, useState } from "react";

/**
 * Desktop-only custom cursor: a precise dot with a trailing ring that
 * expands over [data-cursor] elements. Never rendered on touch devices
 * or for reduced-motion users.
 */
export default function CustomCursor() {
  const [enabled, setEnabled] = useState(false);
  const [label, setLabel] = useState("");
  const dotRef = useRef(null);
  const ringRef = useRef(null);

  useEffect(() => {
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!finePointer || reduced) return undefined;

    setEnabled(true);
    document.documentElement.classList.add("nexus-cursor");

    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    let rx = x;
    let ry = r0();
    function r0() {
      return window.innerHeight / 2;
    }
    let raf = 0;
    let visible = true;

    const onMove = (event) => {
      x = event.clientX;
      y = event.clientY;
      if (!visible) {
        visible = true;
        dotRef.current && (dotRef.current.style.opacity = "1");
        ringRef.current && (ringRef.current.style.opacity = "1");
      }
      const target = event.target instanceof Element ? event.target.closest("[data-cursor]") : null;
      setLabel(target ? target.getAttribute("data-cursor") || "" : "");
    };

    const onLeave = () => {
      visible = false;
      if (dotRef.current) dotRef.current.style.opacity = "0";
      if (ringRef.current) ringRef.current.style.opacity = "0";
    };

    const tick = () => {
      rx += (x - rx) * 0.16;
      ry += (y - ry) * 0.16;
      if (dotRef.current) dotRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      if (ringRef.current) ringRef.current.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      document.documentElement.classList.remove("nexus-cursor");
    };
  }, []);

  if (!enabled) return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[120] hidden md:block">
      <div
        ref={dotRef}
        className="absolute left-0 top-0 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-lavender shadow-[0_0_10px_rgba(216,180,254,0.9)]"
        style={{ opacity: 0, willChange: "transform" }}
      />
      <div
        ref={ringRef}
        className="absolute left-0 top-0 flex items-center justify-center rounded-full border border-lavender/40 transition-[width,height,background-color,border-color] duration-300"
        style={{
          opacity: 0,
          width: label ? 74 : 38,
          height: label ? 74 : 38,
          marginLeft: label ? -37 : -19,
          marginTop: label ? -37 : -19,
          willChange: "transform",
          backgroundColor: label ? "rgba(124,58,237,0.14)" : "transparent",
        }}
      >
        {label ? (
          <span className="text-[8px] font-medium uppercase tracking-[0.3em] text-lavender">{label}</span>
        ) : null}
      </div>
    </div>
  );
}
