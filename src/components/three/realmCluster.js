import { mulberry32 } from "./crystalGeometry.js";

/**
 * Deterministic realm crystal assemblies (seeded, so the three worlds are
 * visually stable across reloads). Each realm gets its OWN geometry story —
 * the cluster is the identity of the portal, not a decoration.
 *
 * Returns { central, shards[], studs[], chips[], floaters[], rings[],
 *           arcs[], embers[], seam[] }. Every entry carries
 * position/rotation/scale + a `mat` index understood by RealmCrystal, plus a
 * realm-specific `kind` the animator dispatches on.
 */
export function buildRealmCluster(realmId, seed = 2065) {
  const off = realmId === "forge" ? 0 : realmId === "paradox" ? 1 : 2;
  const rnd = mulberry32(seed + off);
  if (realmId === "forge") return buildForge(rnd);
  if (realmId === "paradox") return buildParadox(rnd);
  return buildArena(rnd);
}

// ---- THE FORGE: an engineered reactor column + coil blades + containment
function buildForge(rnd) {
  const shards = [];
  const central = {
    position: [0, -0.34, 0],
    rotation: [0.02, rnd() * Math.PI * 2, -0.03],
    scale: [1.0, 1.72, 1.0], // tall column
  };
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2;
    const r = 0.46;
    shards.push({
      kind: "coil",
      mat: 1,
      geo: 3,
      position: [Math.cos(a) * r, -0.18, Math.sin(a) * r],
      rotation: [0.08, a, 0],
      scale: [0.78, 1.92, 0.82],
      out: [Math.cos(a) * 0.9, 0.14, Math.sin(a) * 0.9],
    });
  }
  const SAT = 8;
  for (let i = 0; i < SAT; i += 1) {
    const a = (i / SAT) * Math.PI * 2 + 0.4;
    const dist = 0.72 + rnd() * 0.18;
    shards.push({
      kind: "satellite",
      mat: rnd() < 0.5 ? 2 : 3,
      geo: 1 + (i % 3),
      position: [Math.cos(a) * dist, -0.86 - rnd() * 0.14, Math.sin(a) * dist],
      rotation: [0.14 + rnd() * 0.6, rnd() * Math.PI * 2, 0],
      scale: [0.38 + rnd() * 0.18, 0.44 + rnd() * 0.22, 0.4 + rnd() * 0.16],
      out: [Math.cos(a), 0.18, Math.sin(a)],
    });
  }
  const rings = [
    { y: 0.18, r: 1.04, tilt: 0.26, spin: 0.32, mat: 0, hue: 0.72 },
    { y: -0.48, r: 0.78, tilt: -0.18, spin: -0.44, mat: 1, hue: 0.72 },
  ];
  return {
    central,
    shards,
    studs: [],
    chips: buildChips(rnd, 6),
    floaters: buildFloaters(rnd, 10),
    rings,
    arcs: buildArcs(rnd, 3),
    embers: [],
    seam: [],
  };
}

// ---- THE PARADOX: a fractured core, chaotic, with gold seep ----
function buildParadox(rnd) {
  const shards = [];
  // two halves of a split shard — the fracture IS the portal
  shards.push({
    kind: "fracture",
    mat: 2,
    geo: 0,
    position: [-0.16, 0.06, 0.06],
    rotation: [0, 0.9, 0.26],
    scale: [0.7, 1.36, 0.8],
    out: [-0.4, 0.28, 0.3],
    hero: true,
  });
  shards.push({
    kind: "fracture",
    mat: 5,
    geo: 0,
    position: [0.18, -0.08, -0.1],
    rotation: [0, -0.9, -0.24],
    scale: [0.66, 1.26, 0.78],
    out: [0.38, 0.22, -0.3],
    hero: true,
  });
  const SAT = 11;
  for (let i = 0; i < SAT; i += 1) {
    const a = rnd() * Math.PI * 2;
    const dist = 0.82 + rnd() * 0.7;
    const inverted = rnd() > 0.5;
    const tilt = rnd() * 0.7 + (inverted ? Math.PI : 0);
    shards.push({
      kind: "chaos",
      mat: rnd() < 0.5 ? 2 : 5,
      geo: 2 + (i % 4),
      position: [Math.cos(a) * dist, -0.14 - rnd() * 0.5, Math.sin(a) * dist],
      rotation: [tilt, rnd() * Math.PI * 2, rnd() * 0.3],
      scale: [0.32 + rnd() * 0.32, 0.36 + rnd() * 0.42, 0.3 + rnd() * 0.3],
      out: [Math.cos(a) * 1.1, 0.34, Math.sin(a) * 1.1],
      gold: rnd() < 0.22,
    });
  }
  const rings = [
    { y: 0.3, r: 1.32, tilt: 0.42, spin: 0.18, mat: 5, hue: 1.0 },
    { y: -0.2, r: 1.62, tilt: -0.58, spin: -0.12, mat: 5, hue: 0.92 },
    { y: 0.56, r: 0.94, tilt: 0.1, spin: 0.26, mat: 1, hue: 0.96 },
  ];
  return {
    central: shards[0],
    shards: shards.slice(1),
    studs: buildStuds(rnd, 10),
    chips: buildChips(rnd, 8),
    floaters: buildFloaters(rnd, 12),
    rings,
    arcs: [],
    embers: buildEmbers(rnd, 9),
    seam: [
      { position: new Float32Array([0, 0.7, -0.04, 0, -0.6, -0.02, 0.06, 0.7, 0.04, 0.06, -0.6, -0.04]) },
    ],
  };
}

// ---- THE ARENA: a crown core, aggressive, HUD-laden ----
function buildArena(rnd) {
  const shards = [];
  const central = {
    position: [0, 0.05, 0],
    rotation: [0.01, rnd() * Math.PI * 2, 0],
    scale: [1.34, 0.92, 1.34], // wide, grounded pyramid
  };
  for (let i = 0; i < 3; i += 1) {
    const a = (i / 3) * Math.PI * 2;
    shards.push({
      kind: "crown",
      mat: 1,
      geo: 5,
      position: [Math.cos(a) * 0.54, 0.42, Math.sin(a) * 0.54],
      rotation: [0.1, a, 0],
      scale: [0.58, 1.42, 0.62],
      out: [Math.cos(a) * 0.7, 0.4, Math.sin(a) * 0.7],
    });
  }
  const SAT = 9;
  for (let i = 0; i < SAT; i += 1) {
    const a = (i / SAT) * Math.PI * 2 + 0.52;
    const dist = 0.96 + rnd() * 0.34;
    shards.push({
      kind: "satellite",
      mat: rnd() < 0.5 ? 1 : 2,
      geo: 1 + (i % 3),
      position: [Math.cos(a) * dist, -0.6 - rnd() * 0.32, Math.sin(a) * dist],
      rotation: [0.12, rnd() * Math.PI * 2, 0],
      scale: [0.36 + rnd() * 0.2, 0.4 + rnd() * 0.26, 0.38 + rnd() * 0.22],
      out: [Math.cos(a), -0.1, Math.sin(a)],
      glitch: rnd() < 0.28,
    });
  }
  const rings = [
    { y: 0.36, r: 1.36, tilt: 0, spin: 0.54, mat: 0, hue: 0.78 },
    { y: -0.18, r: 1.02, tilt: 0.14, spin: -0.34, mat: 1, hue: 0.72 },
    { y: 0.78, r: 0.7, tilt: 0.34, spin: 0.82, mat: 1, hue: 0.8 },
    { y: -0.64, r: 1.66, tilt: -0.08, spin: -0.22, mat: 2, hue: 0.75 },
  ];
  return {
    central,
    shards,
    studs: buildStuds(rnd, 14),
    chips: buildChips(rnd, 10),
    floaters: buildFloaters(rnd, 10),
    rings,
    arcs: buildArcs(rnd, 4),
    embers: [],
    seam: [],
  };
}

// --- shared builders -----------------------------------------------------

function buildChips(rnd, n) {
  const chips = [];
  for (let i = 0; i < n; i += 1) {
    chips.push({
      a: rnd() * Math.PI * 2,
      r: 1.2 + rnd() * 0.9,
      y: -0.1 + rnd() * 0.6,
      s: 0.08 + rnd() * 0.15,
      sp: (0.04 + rnd() * 0.07) * (rnd() < 0.5 ? -1 : 1),
      phase: rnd() * Math.PI * 2,
      axis: [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5],
    });
  }
  return chips;
}

function buildStuds(rnd, n) {
  const studs = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.6;
    const rr = 0.52 + rnd() * 0.56;
    studs.push({
      position: [Math.cos(a) * rr, -0.7 + rnd() * 0.2, Math.sin(a) * rr],
      tilt: rnd() * 0.8 + 0.3,
      yaw: rnd() * Math.PI * 2,
      scale: 0.1 + rnd() * 0.12,
      geo: 1 + (i % 3),
      gold: rnd() < 0.18,
    });
  }
  return studs;
}

function buildFloaters(rnd, n) {
  const fl = [];
  for (let i = 0; i < n; i += 1) {
    fl.push({
      angle: rnd() * Math.PI * 2,
      dist: 1.6 + rnd() * 1.6,
      y: -0.2 + rnd() * 1.6,
      scale: 0.06 + rnd() * 0.18,
      speed: (0.02 + rnd() * 0.045) * (rnd() < 0.5 ? -1 : 1),
      bob: rnd() * Math.PI * 2,
      axis: [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5],
      rotSpeed: 0.1 + rnd() * 0.34,
    });
  }
  return fl;
}

// arcs: thin line segments (electric discharge / HUD connectors)
function buildArcs(rnd, n) {
  const arcs = [];
  for (let i = 0; i < n; i += 1) {
    const a0 = rnd() * Math.PI * 2;
    const a1 = a0 + 1.6 + rnd() * 1.2;
    const r0 = 0.4 + rnd() * 0.36;
    const r1 = 0.76 + rnd() * 0.32;
    const y = rnd() * 1.6 - 0.8;
    arcs.push({
      p0: [Math.cos(a0) * r0, y, Math.sin(a0) * r0],
      p1: [Math.cos(a1) * r1, y + 0.22, Math.sin(a1) * r1],
      ph: rnd() * Math.PI * 2,
      sp: 0.6 + rnd() * 0.9,
    });
  }
  return arcs;
}

// embers: gold sparks rising from the paradox fracture
function buildEmbers(rnd, n) {
  const e = [];
  for (let i = 0; i < n; i += 1) {
    e.push({
      p: [(rnd() - 0.5) * 0.5, rnd() * 0.6 - 0.4, (rnd() - 0.5) * 0.6],
      s: 0.08 + rnd() * 0.16,
      ph: rnd() * Math.PI * 2,
      sp: 0.06 + rnd() * 0.1,
      gold: rnd() < 0.5,
    });
  }
  return e;
}