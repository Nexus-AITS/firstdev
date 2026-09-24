import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import CrystalRig from "./CrystalRig.jsx";
import { createShardKit, createCrystalMaterials } from "./crystalMaterials.js";
import { makeGlowTexture, makeSoftGlowTexture, makeStarGlintTexture, makeShaftTexture } from "./crystalSetup.js";
import { buildCluster } from "./crystalCluster.js";
import { createCrystalEnvironment } from "./crystalEnvironment.js";

/**
 * The NEXUS amethyst cluster: dominant central shard flanked by twin spires,
 * asymmetric secondaries/minors on a crystal-studded geode matrix, orbiting
 * glass chips, translucent free fragments, a volumetric beam, pulsing
 * internal energy and near-camera bokeh.
 */
export default function CrystalCore({ fragments: fragmentCount = 16, reduced = false, quality = "high" }) {
  const { gl, scene } = useThree();

  const root = useRef(null);
  const shards = useRef([]);
  const floaters = useRef([]);
  const chips = useRef([]);
  const studs = useRef([]);
  const beam = useRef(null);
  const core = useRef(null);
  const coreLight = useRef(null);
  const goldLight = useRef(null);
  const haloV = useRef(null);
  const haloW = useRef(null);
  const orbit = useRef(null);
  const bokehs = useRef([]);
  const tips = useRef([]);

  const glowTex = useMemo(makeGlowTexture, []);
  const softTex = useMemo(makeSoftGlowTexture, []);
  const starTex = useMemo(makeStarGlintTexture, []);
  const shaftTex = useMemo(makeShaftTexture, []);
  const kit = useMemo(createShardKit, []);
  const mats = useMemo(() => createCrystalMaterials({ quality }), [quality]);
  const cluster = useMemo(() => buildCluster(fragmentCount), [fragmentCount]);
  const refs = {
    root,
    shards,
    floaters,
    chips,
    studs,
    beam,
    core,
    coreLight,
    goldLight,
    haloV,
    haloW,
    orbit,
    bokehs,
    tips,
  };

  useEffect(
    () => () => {
      [kit.centralGeo, kit.floatGeo, kit.rockGeo, ...kit.shardGeos].forEach((g) => g.dispose());
      Object.values(mats).forEach((m) => m.dispose());
      glowTex.dispose();
      softTex.dispose();
      starTex.dispose();
      shaftTex.dispose();
    },
    [kit, mats, glowTex, softTex, starTex, shaftTex] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    const envTex = createCrystalEnvironment(gl);
    scene.environment = envTex;
    scene.environmentIntensity = 1.7;
    return () => {
      scene.environment = null;
      envTex.dispose();
    };
  }, [gl, scene]);

  return (
    <group ref={root}>
      <CrystalRig cluster={cluster} reduced={reduced} refs={refs} />

      <mesh geometry={kit.rockGeo} material={mats.rock} position={[0, -0.95, 0]} scale={[1.35, 0.78, 1.35]} />

      {/* micro-crystals growing out of the geode dome — the bed reads as a
          real crystal formation instead of a plinth */}
      {cluster.studs.map((s, i) => (
        <mesh
          key={`sd${i}`}
          ref={(el) => {
            studs.current[i] = el;
          }}
          geometry={kit.shardGeos[s.geo]}
          material={mats.stud}
        />
      ))}
      <mesh
        geometry={kit.centralGeo}
        material={mats.light}
        position={cluster.central.position}
        rotation={cluster.central.rotation}
        scale={cluster.central.scale}
      />
      {/* NOTE: no edge/wireframe overlay — facet lines must come from
          lighting and refraction, never from drawn lines */}

      {cluster.shards.map((s, i) => (
        <mesh
          key={i}
          ref={(el) => {
            shards.current[i] = el;
          }}
          geometry={kit.shardGeos[s.geo]}
          material={[mats.light, mats.mid, mats.deep, mats.blade, mats.float][s.mat] ?? mats.mid}
        />
      ))}

      {cluster.floaters.map((f, i) => (
        <mesh
          key={`f${i}`}
          ref={(el) => {
            floaters.current[i] = el;
          }}
          geometry={kit.floatGeo}
          material={mats.float}
          scale={f.scale}
        />
      ))}

      {/* suspended glass chips on inclined orbits — a slowly turning halo
          that frames the core and adds parallax depth */}
      {cluster.orbitChips.map((c, i) => (
        <mesh
          key={`c${i}`}
          ref={(el) => {
            chips.current[i] = el;
          }}
          geometry={kit.shardGeos[c.geo]}
          material={mats.chip}
        />
      ))}

      {/* volumetric beam: sits behind the spire (z = -1.15) so the crystal
          naturally occludes it — reads as light, never as a decal */}
      <mesh ref={beam} position={[0, 1.15, -1.15]}>
        <planeGeometry args={[1.7, 5.6]} />
        <meshBasicMaterial
          map={shaftTex}
          color="#d9bcfd"
          transparent
          opacity={0.2}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      {/* internal energy — layered soft glow only (no hard geometry:
          light must diffuse through the glass, never read as a sticker) */}
      <group ref={core} position={[0, 0.36, 0]}>
        <sprite scale={[2.6, 2.6, 1]}>
          <spriteMaterial
            map={softTex}
            color="#a855f7"
            transparent
            opacity={0.3}
            depthWrite={false}
            depthTest={false}
            blending={THREE.AdditiveBlending}
            userData={{ base: 0.3 }}
          />
        </sprite>
        <sprite scale={[1.25, 1.25, 1]}>
          <spriteMaterial
            map={softTex}
            color="#eee4ff"
            transparent
            opacity={0.36}
            depthWrite={false}
            depthTest={false}
            blending={THREE.AdditiveBlending}
            userData={{ base: 0.36 }}
          />
        </sprite>
        <sprite scale={[0.55, 0.55, 1]}>
          <spriteMaterial
            map={softTex}
            color="#fffdf6"
            transparent
            opacity={0.3}
            depthWrite={false}
            depthTest={false}
            blending={THREE.AdditiveBlending}
            userData={{ base: 0.3 }}
          />
        </sprite>
      </group>
      {/* rim lights: lavender/violet backlight carves every facet edge
          out of the dark — this is what makes glass read as glass */}
      <directionalLight position={[2.6, 2.2, -4]} intensity={2.4} color="#d8b4fe" />
      <directionalLight position={[-3.2, 0.6, -3]} intensity={1.5} color="#a855f7" />
      {/* internal light: pushed slightly back + softened so it reads as one
          warm heart, not twin specular dots on the front facets */}
      <pointLight ref={coreLight} position={[0, 0.22, -0.3]} color="#f6f0ff" intensity={2.4} distance={9} decay={2} />
      <pointLight ref={goldLight} position={[0, -0.45, 0]} color="#f5d78e" intensity={0} distance={5} decay={2} />
      <sprite ref={haloV} position={[0, -0.05, 0]} scale={[5, 5, 1]}>
        <spriteMaterial map={glowTex} color="#7c3aed" transparent opacity={0.5} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <sprite ref={haloW} position={[0, -0.05, 0]} scale={[1.5, 1.5, 1]}>
        <spriteMaterial map={glowTex} color="#f0e8ff" transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      {/* grounding pool of violet light beneath the geode — seats the
          cluster in the scene instead of floating it on black */}
      <sprite position={[0, -1.3, 0]} scale={[4.6, 1.7, 1]}>
        <spriteMaterial map={softTex} color="#7c3aed" transparent opacity={0.38} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

      {/* twinkling fire on shard tips */}
      {cluster.tips.map((tp, i) => (
        <sprite
          key={`t${i}`}
          ref={(el) => {
            tips.current[i] = el;
          }}
          position={tp.p}
          scale={[tp.s, tp.s, 1]}
        >
          <spriteMaterial map={starTex} color="#fffdf6" transparent opacity={0.5} depthWrite={false} depthTest={false} blending={THREE.AdditiveBlending} />
        </sprite>
      ))}

      {/* orbiting crystalline dust */}
      <points ref={orbit}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[cluster.orbit, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.07} map={glowTex} color="#d8b4fe" transparent opacity={0.85} depthWrite={false} blending={THREE.AdditiveBlending} sizeAttenuation />
      </points>

      {/* near-camera defocused fragments */}
      {cluster.bokehs.map((b, i) => (
        <sprite
          key={`b${i}`}
          ref={(el) => {
            bokehs.current[i] = el;
          }}
          position={b.p}
          scale={[b.s, b.s, 1]}
        >
          <spriteMaterial map={glowTex} color="#c4a6ff" transparent opacity={b.o} depthWrite={false} depthTest={false} blending={THREE.AdditiveBlending} />
        </sprite>
      ))}
    </group>
  );
}
