import { Suspense, lazy } from "react";

const CrystalCanvas = lazy(() => import("./CrystalCanvas.jsx"));

/**
 * Three.js is the largest chunk in the project — this wrapper keeps it off
 * the critical path so the page paints immediately with CrystalCanvas's CSS
 * backdrop (nebula + breathing aura); the WebGL stage mounts a beat later.
 * Drop-in replacement: props are forwarded to the real component.
 */
function Backdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(52% 44% at 50% 46%, rgba(124,58,237,0.34), rgba(5,3,8,0) 72%)",
        }}
      />
      <div className="absolute inset-[-20%] bg-[radial-gradient(38%_34%_at_28%_66%,rgba(76,29,149,0.30),transparent_70%)]" />
      <div className="absolute inset-[-20%] bg-[radial-gradient(34%_30%_at_74%_30%,rgba(168,85,247,0.18),transparent_70%)]" />
      <div className="anim-drift absolute inset-[-25%] bg-[radial-gradient(30%_26%_at_64%_70%,rgba(124,58,237,0.22),transparent_70%)]" />
      <div
        className="anim-drift absolute inset-[-30%] bg-[radial-gradient(26%_24%_at_24%_24%,rgba(216,180,254,0.10),transparent_70%)]"
        style={{ animationDelay: "-23s" }}
      />
      <div className="anim-pulse absolute left-1/2 top-1/2 h-[64vmin] w-[64vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(168,85,247,0.40),rgba(124,58,237,0.10)_55%,transparent_72%)] blur-[80px]" />
    </div>
  );
}

export default function LazyCrystalCanvas(props) {
  return (
    <Suspense fallback={<Backdrop />}>
      <CrystalCanvas {...props} />
    </Suspense>
  );
}