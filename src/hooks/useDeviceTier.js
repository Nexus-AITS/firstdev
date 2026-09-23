import { useEffect, useState } from "react";

function computeTier() {
  if (typeof window === "undefined") return "desktop";
  const w = window.innerWidth;
  if (w < 640) return "mobile";
  if (w < 1024) return "tablet";
  return "desktop";
}

/** Particle budgets per device class — keeps mobile light. */
export const PARTICLE_DENSITY = {
  desktop: { stars: 220, energy: 70, shards: 46, fps: 60 },
  tablet: { stars: 150, energy: 44, shards: 30, fps: 60 },
  mobile: { stars: 90, energy: 24, shards: 18, fps: 30 },
};

export default function useDeviceTier() {
  const [tier, setTier] = useState(computeTier);

  useEffect(() => {
    let timer = null;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTier(computeTier()), 140);
    };
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return tier;
}
