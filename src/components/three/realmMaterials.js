/**
 * Realm-tinted material set for a portal core. Each realm keeps the home
 * page's physical crystal language (transmission + attenuation + iridescence)
 * but shifts the attenuation/emissive/ring palette so the three portals read
 * as three different worlds even at a glance.
 *
 * Shard `mat` indices: 0 hero | 1 blade | 2 deep | 3 mid | 4 float | 5 gold.
 */
import * as THREE from "three";
import { createCrystalMaterials } from "./crystalMaterials.js";
import {
  makeDashedRingTexture,
  makeHudTexture,
  makeCircuitTexture,
  makeScanTexture,
  makeEmberTexture,
} from "./realmTextures.js";
import { makeGlowTexture, makeSoftGlowTexture, makeStarGlintTexture } from "./crystalSetup.js";

/**
 * Realm-tinted material set for a portal core. Each realm keeps the home
 * page's physical crystal language (transmission + attenuation + iridescence)
 * but shifts the attenuation/emissive/ring palette so the three portals read
 * as three different worlds even at a glance.
 *
 * Shard `mat` indices: 0 hero | 1 blade | 2 deep | 3 mid | 4 float | 5 gold.
 */
const PALETTE = {
  forge: { atten: "#7c3aed", emissive: "#4c1d95", glow: "#8b5cf6", ring: "#a855f7" },
  paradox: { atten: "#6d28d9", emissive: "#5b21b6", glow: "#a855f7", ring: "#f5d78e" },
  arena: { atten: "#5b21b6", emissive: "#3b1a66", glow: "#7c3aed", ring: "#d8b4fe" },
};

/** Procedural texture bundle shared by materials + scene meshes. */
export function createRealmTextures() {
  return {
    ringA: makeDashedRingTexture(0.24),
    ringB: makeDashedRingTexture(0.5),
    hud: makeHudTexture(),
    circuit: makeCircuitTexture(),
    scan: makeScanTexture(),
    ember: makeEmberTexture(),
    glow: makeGlowTexture(),
    soft: makeSoftGlowTexture(),
    star: makeStarGlintTexture(),
  };
}

export function createRealmMaterials(realmId, tex) {
  const p = PALETTE[realmId] ?? PALETTE.forge;
  const b = createCrystalMaterials();

  const tint = (m, { atten = p.atten, emissive = null, ei = 0.5 } = {}) => {
    m.attenuationColor = new THREE.Color(atten);
    if (emissive) {
      m.emissive = new THREE.Color(emissive);
      m.emissiveIntensity = ei;
    }
    return m;
  };

  // portals are small on screen — dispersion triples sampling cost for a
  // sparkle nobody can resolve, so the hero shard runs without it
  b.light.dispersion = 0;
  b.light.needsUpdate = true;

  const gold = b.float.clone();
  gold.color = new THREE.Color("#f6ecd4");
  gold.attenuationColor = new THREE.Color("#a16207");
  gold.emissive = new THREE.Color("#713f12");
  gold.emissiveIntensity = 0.55;

  const byIndex = [
    b.light,
    tint(b.blade),
    tint(b.deep),
    tint(b.mid, { emissive: p.emissive, ei: 0.45 }),
    tint(b.float),
    gold,
  ];

  const additive = (map, color, opacity) => {
    const m = new THREE.MeshBasicMaterial({
      map,
      color: new THREE.Color(color),
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    m.userData.base = opacity; // animated toward focus by RealmCrystal
    return m;
  };

  return {
    byIndex,
    rock: b.rock,
    stud: b.stud,
    chip: b.chip,
    ringA: additive(tex.ringA, p.ring, 0.5),
    ringB: additive(tex.ringB, p.ring, 0.42),
    hud: additive(tex.hud, p.ring, 0.45),
    ringGold: additive(tex.ringA, "#f5d78e", 0.5),
    scan: additive(tex.scan, p.ring, 0.16),
    seam: additive(tex.soft, p.glow, 0.5),
    halo: additive(tex.glow, p.glow, 0.5),
    core: additive(tex.soft, "#f2ecff", 0.4),
    emberGold: additive(tex.ember, "#f5d78e", 0.85),
    emberViolet: additive(tex.ember, p.glow, 0.85),
    arc: new THREE.LineBasicMaterial({
      color: new THREE.Color(p.ring),
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  };
}

/** Pick the ring material for a cluster ring descriptor. */
export function ringMaterialFor(mats, ring) {
  if (ring.mat === 5) return mats.ringGold;
  if (ring.mat === 2) return mats.hud;
  if (ring.mat === 1) return mats.ringB;
  return mats.ringA;
}