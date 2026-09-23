import { mulberry32 } from "./crystalGeometry.js";

/**
 * Deterministic amethyst cluster layout:
 * - one dominant central shard
 * - ~10 asymmetric secondary shards erupting at golden-angle spacing
 * - ~9 minors around the rim
 * - `fragCount` free-floating translucent fragments
 * Placements carry axis/tilt so the component can build quaternions.
 */
export function buildCluster(fragCount = 16, seed = 2065) {
  const rnd = mulberry32(seed);

  const central = {
    position: [0, -0.62, 0],
    rotation: [0.05, rnd() * Math.PI * 2, -0.06],
    scale: [1.06, 1.22, 1.0],
  };

  const shards = [];

  const SECONDARY = 12;
  for (let i = 0; i < SECONDARY; i += 1) {
    const angle = i * 2.399963 + rnd() * 0.6; // golden-angle + jitter
    const dist = 0.3 + rnd() * 0.55;
    const tilt = 0.14 + rnd() * 0.92; // some upright, some flung outward
    shards.push({
      kind: "secondary",
      position: [Math.cos(angle) * dist, -0.66 - rnd() * 0.16, Math.sin(angle) * dist],
      axis: [Math.sin(angle), 0, -Math.cos(angle)],
      tilt,
      yaw: rnd() * Math.PI * 2,
      scale: [0.62 + rnd() * 0.5, 0.72 + rnd() * 0.5, 0.6 + rnd() * 0.45],
      out: [Math.cos(angle), 0.35, Math.sin(angle)],
      geo: i % 5,
      mat: i % 4 === 0 ? 3 : i % 4 === 1 ? 0 : i % 4 === 2 ? 1 : 0,
    });
  }

  // Twin spire blades flanking the main shard — the classic cathedral
  // silhouette. They join the normal shard list so they inherit the whole
  // story animation (scatter / reform / glow) for free.
  const TWINS = [
    { position: [-0.37, -0.67, 0.19], axis: [-0.22, 0, 0.98], tilt: 0.09, yaw: 0.5, scale: [0.85, 1.06, 0.82], out: [-0.6, 0.32, 0.32] },
    { position: [0.39, -0.7, -0.23], axis: [0.22, 0, -0.98], tilt: 0.11, yaw: 2.1, scale: [0.76, 0.94, 0.74], out: [0.6, 0.3, -0.32] },
  ];
  TWINS.forEach((tw, i) => {
    shards.push({ kind: "twin", geo: 5, mat: i === 0 ? 0 : 3, ...tw });
  });

  const MINOR = 12;
  for (let i = 0; i < MINOR; i += 1) {
    const angle = rnd() * Math.PI * 2;
    const dist = 0.72 + rnd() * 0.5;
    const tilt = 0.5 + rnd() * 0.8;
    shards.push({
      kind: "minor",
      position: [Math.cos(angle) * dist, -0.74 - rnd() * 0.1, Math.sin(angle) * dist],
      axis: [Math.sin(angle), 0, -Math.cos(angle)],
      tilt,
      yaw: rnd() * Math.PI * 2,
      scale: [0.3 + rnd() * 0.28, 0.34 + rnd() * 0.34, 0.3 + rnd() * 0.24],
      out: [Math.cos(angle), 0.4, Math.sin(angle)],
      geo: 2 + (i % 3),
      mat: i % 3 === 0 ? 4 : 2,
    });
  }

  const floaters = [];
  for (let i = 0; i < fragCount; i += 1) {
    const angle = rnd() * Math.PI * 2;
    floaters.push({
      angle,
      dist: 1.7 + rnd() * 1.9,
      y: -0.3 + rnd() * 1.9,
      scale: 0.07 + rnd() * 0.26,
      speed: (0.02 + rnd() * 0.05) * (rnd() < 0.5 ? -1 : 1),
      bob: rnd() * Math.PI * 2,
      axis: [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5],
      rotSpeed: 0.12 + rnd() * 0.4,
    });
  }

  const bokehs = [
    { p: [-2.7, 1.4, 4.6], s: 2.6, o: 0.12, ph: 0 },
    { p: [2.9, -1.1, 4.2], s: 3.1, o: 0.1, ph: 1.7 },
    { p: [-3.1, -1.6, 5.0], s: 2.2, o: 0.09, ph: 3.1 },
    { p: [2.4, 1.9, 5.2], s: 2.0, o: 0.11, ph: 4.4 },
  ];

  // pin-point glints that twinkle on shard tips (fake specular fire)
  const tips = [];
  for (let i = 0; i < 9; i += 1) {
    const a = rnd() * Math.PI * 2;
    const r = 0.2 + rnd() * 0.82;
    tips.push({
      p: [Math.cos(a) * r, 0.05 + rnd() * 1.65, Math.sin(a) * r],
      s: 0.13 + rnd() * 0.22,
      ph: rnd() * Math.PI * 2,
      sp: 0.9 + rnd() * 1.2,
    });
  }

  // Glass chips locked on inclined orbits — a slowly turning halo of
  // suspended crystal that makes the core feel embedded in a system,
  // not standing alone on a rock. Non-transmissive material: cheap.
  const orbitChips = [];
  const CHIPS = 10;
  for (let i = 0; i < CHIPS; i += 1) {
    orbitChips.push({
      r: 1.22 + rnd() * 0.6,
      incl: (rnd() - 0.5) * 0.85,
      phase: (i / CHIPS) * Math.PI * 2 + rnd() * 0.55,
      speed: (0.05 + rnd() * 0.085) * (i % 2 ? 1 : -1),
      y: -0.08 + rnd() * 0.95,
      scale: 0.075 + rnd() * 0.105,
      tilt: rnd() * Math.PI,
      spin: 0.2 + rnd() * 0.55,
      geo: i % 2,
    });
  }

  // Micro-crystals sprouting from the geode dome. They sit on the ellipsoid
  // surface so the matrix reads as a real crystal bed rather than a plinth.
  const studs = [];
  const STUD = 24;
  for (let i = 0; i < STUD; i += 1) {
    const a = i * 2.399963 + rnd() * 0.5;
    const rr = 0.48 + rnd() * 0.76;
    const n = Math.min(0.97, rr / 1.34);
    studs.push({
      position: [
        Math.cos(a) * rr,
        -0.95 + 0.429 * Math.sqrt(Math.max(0, 1 - n * n)) - 0.07,
        Math.sin(a) * rr,
      ],
      axis: [Math.sin(a), 0.12, -Math.cos(a)],
      tilt: 0.5 + rnd() * 1.0,
      yaw: rnd() * Math.PI * 2,
      scale: 0.13 + rnd() * 0.15,
      geo: 2 + (i % 3),
    });
  }

  const orbit = new Float32Array(80 * 3);
  for (let i = 0; i < 80; i += 1) {
    const a = rnd() * Math.PI * 2;
    const r = 1.4 + rnd() * 2.1;
    orbit[i * 3] = Math.cos(a) * r;
    orbit[i * 3 + 1] = -0.9 + rnd() * 2.5;
    orbit[i * 3 + 2] = Math.sin(a) * r;
  }

  return { central, shards, floaters, bokehs, tips, orbit, orbitChips, studs };
}
