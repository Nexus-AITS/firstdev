import { Suspense, lazy } from "react";

const RealmStage = lazy(() => import("./RealmStage.jsx"));

/**
 * Defers @react-three/fiber/three out of the route's blocking graph.
 * Until the chunk lands, an on-brand shell holds the exact footprint —
 * halo, atmosphere color and a faceted crystal silhouette — so the portal
 * card layout never jumps.
 */
function StageShell({ realm, active = false, className = "" }) {
  const accent = realm.accent;
  return (
    <div className={`relative aspect-square w-full ${className}`} aria-hidden>
      <div
        className={`absolute inset-[-18%] rounded-full blur-3xl transition-opacity duration-700 ${
          active ? "opacity-100" : "opacity-55"
        }`}
        style={{ background: `radial-gradient(circle, ${accent}40, transparent 66%)` }}
      />
      <div
        className="anim-pulse absolute left-1/2 top-1/2 h-[44%] w-[32%] -translate-x-1/2 -translate-y-1/2"
        style={{
          clipPath: "polygon(50% 0, 100% 30%, 88% 100%, 12% 100%, 0 30%)",
          background: `linear-gradient(180deg, ${accent}bb, ${accent}44)`,
        }}
      />
    </div>
  );
}

export default function LazyRealmStage(props) {
  return (
    <Suspense fallback={<StageShell {...props} />}>
      <RealmStage {...props} />
    </Suspense>
  );
}