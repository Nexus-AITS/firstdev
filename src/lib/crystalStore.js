/**
 * Mutable store shared between the Home ScrollTrigger timeline and the
 * React Three Fiber crystal. Written/read inside rAF loops — never triggers
 * React re-renders.
 *
 * tScatter / tGlow are targets (driven by scroll), scatter / glow are the
 * lerped values consumed by the renderer.
 */
export const crystalStore = {
  scatter: 0,
  tScatter: 0,
  glow: 0,
  tGlow: 0,
  burst: 0, // one-shot impulse used by the ENTER NEXUS transition
};

export function resetCrystalStore() {
  crystalStore.scatter = 0;
  crystalStore.tScatter = 0;
  crystalStore.glow = 0;
  crystalStore.tGlow = 0;
  crystalStore.burst = 0;
}

export function triggerCrystalBurst() {
  crystalStore.burst = 1;
}

export default crystalStore;
