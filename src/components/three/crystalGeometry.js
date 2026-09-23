import * as THREE from "three";

/** Tiny deterministic PRNG so the cluster is stable across reloads. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Irregular faceted crystal shard — prismatic body with a pyramidal
 * termination. Per-vertex jitter, per-ring twist and an off-center apex
 * ensure no two shards look alike. Non-indexed => crisp flat facets.
 */
export function makeShardGeometry({
  seed = 1,
  sides = 6,
  height = 2,
  radius = 0.34,
  taper = 0.6,
  jitter = 0.16,
  apexOffset = 0.12,
} = {}) {
  const rnd = mulberry32(seed);

  const bodyStops = [
    [0, 1],
    [height * 0.5, 0.99],
    [height * 0.74, 0.9],
    [height * 0.87, taper],
  ];
  const twist0 = rnd() * Math.PI * 2;
  const rings = bodyStops.map(([y, r], ri) => {
    const twist = twist0 + ri * (rnd() - 0.5) * 0.4;
    const ring = [];
    for (let i = 0; i < sides; i += 1) {
      const a = twist + (i / sides) * Math.PI * 2;
      const rr = radius * r * (1 + (rnd() - 0.5) * jitter * 2);
      ring.push({
        x: Math.cos(a) * rr,
        y: y + (rnd() - 0.5) * jitter * height * 0.1,
        z: Math.sin(a) * rr,
      });
    }
    return ring;
  });

  const apex = {
    x: (rnd() - 0.5) * radius * apexOffset * 2.4,
    y: height,
    z: (rnd() - 0.5) * radius * apexOffset * 2.4,
  };

  const verts = [];
  const push = (v) => verts.push(v.x, v.y, v.z);
  const quad = (a, b, c, d) => {
    push(a);
    push(b);
    push(c);
    push(a);
    push(c);
    push(d);
  };

  for (let r = 0; r < rings.length - 1; r += 1) {
    const A = rings[r];
    const B = rings[r + 1];
    for (let i = 0; i < sides; i += 1) {
      const j = (i + 1) % sides;
      quad(A[i], A[j], B[j], B[i]);
    }
  }

  const top = rings[rings.length - 1];
  for (let i = 0; i < sides; i += 1) {
    push(top[i]);
    push(top[(i + 1) % sides]);
    push(apex);
  }

  const center = { x: 0, y: 0, z: 0 };
  const base = rings[0];
  for (let i = 0; i < sides; i += 1) {
    push(base[(i + 1) % sides]);
    push(base[i]);
    push(center);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Dark displaced geode matrix the cluster grows from. */
export function makeRockGeometry(seed = 7) {
  const rnd = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(0.82 + rnd() * 0.42);
    pos.setXYZ(i, v.x, v.y * 0.55, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
