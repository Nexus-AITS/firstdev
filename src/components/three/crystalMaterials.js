import * as THREE from "three";
import { makeShardGeometry, makeRockGeometry } from "./crystalGeometry.js";

/** Geometry kit for the amethyst cluster (all irregular, seeded). */
export function createShardKit() {
  const centralGeo = makeShardGeometry({ seed: 11, sides: 9, height: 2.3, radius: 0.42, taper: 0.5, jitter: 0.14 });
  const shardGeos = [
    makeShardGeometry({ seed: 21, sides: 7, height: 1.5, radius: 0.3, jitter: 0.24 }),
    makeShardGeometry({ seed: 37, sides: 6, height: 1.15, radius: 0.26, jitter: 0.28 }),
    makeShardGeometry({ seed: 53, sides: 7, height: 0.72, radius: 0.2, jitter: 0.3 }),
    // slimmer blades — break the "wide purple slab" silhouette
    makeShardGeometry({ seed: 89, sides: 5, height: 1.32, radius: 0.17, taper: 0.55, jitter: 0.3 }),
    makeShardGeometry({ seed: 101, sides: 6, height: 0.9, radius: 0.14, taper: 0.5, jitter: 0.34 }),
    // twin spire blades — the cathedral pair flanking the main shard
    makeShardGeometry({ seed: 131, sides: 7, height: 1.92, radius: 0.24, taper: 0.46, jitter: 0.16 }),
  ];
  const floatGeo = makeShardGeometry({ seed: 71, sides: 6, height: 0.48, radius: 0.17, jitter: 0.34 });
  const rockGeo = makeRockGeometry();
  return { centralGeo, shardGeos, floatGeo, rockGeo };
}

/**
 * Physically based crystal materials: real transmission/refraction,
 * gentle violet attenuation (light must PASS THROUGH, not drown),
 * low specular so the internal core never throws twin hot-spots,
 * iridescent fresnel for subtle lavender/gold edge shimmer.
 */
export function createCrystalMaterials({ quality = "high" } = {}) {
  // "low" tiers (tablet/mobile portals, mobile home) keep the transmission
  // look but drop the BRANCH-heavy extras — clearcoat lobe, iridescence
  // sweep — and dim the env: measured ~2x cheaper fragment cost on mid GPUs
  // with an almost identical read behind fog + vignette + grain.
  const low = quality !== "high";
  const physical = (o = {}) =>
    new THREE.MeshPhysicalMaterial({
      color: "#efe6ff",
      metalness: 0,
      transmission: 1,
      thickness: 0.9,
      ior: 1.48,
      clearcoat: low ? 0.35 : 1,
      clearcoatRoughness: 0.12,
      attenuationColor: new THREE.Color("#7c3aed"),
      attenuationDistance: 3.2, // long — deep violet shadows, never opaque
      envMapIntensity: low ? 1.6 : 2.1,
      specularIntensity: 0.55, // tame interior point-light reflections
      roughness: 0.1,
      iridescence: low ? 0.12 : 0.28,
      iridescenceIOR: 1.3,
      dispersion: 0, // charged per-material (see `light`) — dispersion triples
      // the transmission sampling cost, so it is reserved for the hero spire
      flatShading: true,
      ...o,
    });

  return {
    light: physical(
      low
        ? {
            color: "#f2ebff",
            roughness: 0.045,
            thickness: 1.3,
            attenuationDistance: 4.2,
            envMapIntensity: 1.9,
            dispersion: 0, // tier-gated: dispersion triples transmission cost
          }
        : {
            color: "#f2ebff",
            roughness: 0.045,
            clearcoatRoughness: 0.05,
            thickness: 1.3,
            attenuationDistance: 4.2,
            envMapIntensity: 2.6,
            iridescence: 0.34,
            dispersion: 3.2, // real chromatic fire through the facets (three r167+)
          }
    ),
    mid: physical({
      color: "#e4d6ff",
      roughness: 0.11,
      attenuationDistance: 3.0,
      thickness: 0.95,
      envMapIntensity: 2.3,
      iridescence: 0.24,
    }),
    blade: physical({
      color: "#eadffd",
      roughness: 0.07,
      attenuationDistance: 3.6,
      thickness: 0.7,
      envMapIntensity: 2.5,
      iridescence: 0.38,
      iridescenceIOR: 1.35,
    }),
    float: physical({
      color: "#e8dbff",
      roughness: 0.15,
      attenuationDistance: 2.6,
      thickness: 0.6,
      envMapIntensity: 2.2,
      emissive: new THREE.Color("#5b21b6"),
      emissiveIntensity: 0.55,
    }),
    deep: physical({
      color: "#c9b0ff",
      roughness: 0.24,
      attenuationColor: new THREE.Color("#4c1d95"),
      attenuationDistance: 1.6, // darker satellites for depth contrast
      thickness: 0.9,
      envMapIntensity: 1.9,
      iridescence: 0.16,
    }),
    /**
     * Non-transmissive "glass" pairs for the small parts (orbit chips, geode
     * studs). They read as crystal thanks to strong env reflections, but cost
     * one draw call instead of an extra transmission pass — this is what keeps
     * the denser cluster cheap on tablet/mobile.
     */
    chip: new THREE.MeshPhysicalMaterial({
      color: "#e9dcff",
      metalness: 0,
      roughness: 0.06,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 3.1,
      transparent: true,
      opacity: 0.74,
      emissive: new THREE.Color("#4c1d95"),
      emissiveIntensity: 0.5,
      iridescence: 0.4,
      iridescenceIOR: 1.35,
      flatShading: true,
      side: THREE.DoubleSide,
    }),
    stud: new THREE.MeshStandardMaterial({
      color: "#d9c6ff",
      metalness: 0.1,
      roughness: 0.08,
      envMapIntensity: 2.4,
      transparent: true,
      opacity: 0.62,
      emissive: new THREE.Color("#3b1a66"),
      emissiveIntensity: 0.5,
      flatShading: true,
      side: THREE.DoubleSide,
    }),
    rock: new THREE.MeshStandardMaterial({
      color: "#100819",
      roughness: 0.9,
      metalness: 0.05,
      emissive: new THREE.Color("#2e1065"),
      emissiveIntensity: 0.55,
      envMapIntensity: 0.35,
      flatShading: true,
    }),
  };
}
