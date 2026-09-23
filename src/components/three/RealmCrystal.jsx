import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { buildRealmCluster } from "./realmCluster.js";
import { createRealmMaterials, createRealmTextures, ringMaterialFor } from "./realmMaterials.js";
import { makeShardGeometry, makeRockGeometry } from "./crystalGeometry.js";
import { createCrystalEnvironment } from "./crystalEnvironment.js";

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

/**
 * A single realm's crystalline core inside its portal canvas.
 * Reuses the home page's geometry/material language, but the assembly,
 * palette and animation are realm-specific (reactor / fracture / HUD crown).
 * `active` (hover focus) drives an energy value that brightens, expands and
 * accelerates everything — this is the hover-dominance behaviour in 3D.
 */
export default function RealmCrystal({ realmId, active = false, reduced = false }) {
  const { gl, scene } = useThree();

  const rootRef = useRef(null);
  const shardRefs = useRef([]);
  const chipRefs = useRef([]);
  const floatRefs = useRef([]);
  const ringRefs = useRef([]);
  const emberRefs = useRef([]);
  const arcRefs = useRef([]);
  const seamRef = useRef(null);
  const scanRef = useRef(null);
  const coreLight = useRef(null);
  const haloRef = useRef(null);

  const energy = useRef(0);
  const time = useRef(0);
  const ptr = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  const kit = useMemo(
    () => ({
      geos: [
        makeShardGeometry({ seed: 301, sides: 9, height: 2.3, radius: 0.4, taper: 0.5, jitter: 0.15 }),
        makeShardGeometry({ seed: 311, sides: 7, height: 1.5, radius: 0.3, jitter: 0.24 }),
        makeShardGeometry({ seed: 317, sides: 6, height: 1.15, radius: 0.26, jitter: 0.28 }),
        makeShardGeometry({ seed: 323, sides: 7, height: 0.72, radius: 0.2, jitter: 0.3 }),
        makeShardGeometry({ seed: 331, sides: 5, height: 1.32, radius: 0.17, taper: 0.55, jitter: 0.3 }),
        makeShardGeometry({ seed: 337, sides: 6, height: 0.9, radius: 0.14, taper: 0.5, jitter: 0.34 }),
      ],
      rock: makeRockGeometry(19),
      tex: createRealmTextures(),
    }),
    []
  );
  const mats = useMemo(() => createRealmMaterials(realmId, kit.tex), [realmId, kit]);
  const cluster = useMemo(() => buildRealmCluster(realmId), [realmId]);

  // electric discharge lines (forge/arena) built once, flickered per frame
  const arcs = useMemo(
    () =>
      cluster.arcs.map((a) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute([...a.p0, ...a.p1], 3));
        return new THREE.Line(geo, mats.arc);
      }),
    [cluster, mats]
  );

  // shared procedural environment so facets catch real reflections
  useEffect(() => {
    const env = createCrystalEnvironment(gl);
    scene.environment = env;
    scene.environmentIntensity = 1.6;
    return () => {
      scene.environment = null;
      env.dispose();
    };
  }, [gl, scene]);

  useEffect(
    () => () => {
      kit.geos.forEach((g) => g.dispose());
      kit.rock.dispose();
      Object.values(kit.tex).forEach((t) => t.dispose());
      mats.byIndex.forEach((m) => m.dispose());
      [
        mats.rock, mats.stud, mats.chip, mats.ringA, mats.ringB, mats.hud,
        mats.ringGold, mats.scan, mats.seam, mats.halo, mats.core,
        mats.emberGold, mats.emberViolet, mats.arc,
      ].forEach((m) => m.dispose());
      arcs.forEach((l) => l.geometry.dispose());
    },
    [kit, mats, arcs] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    const onMove = (e) => {
      ptr.current.tx = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
      ptr.current.ty = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    if (!reduced) time.current += dt;
    const t = time.current;

    // focus energy: 0 = ambient, 1 = dominant
    energy.current += ((active ? 1 : 0) - energy.current) * Math.min(1, dt * 3.4);
    const e = energy.current;
    const pulse = 0.78 + 0.22 * Math.sin(t * 0.9);

    const p = ptr.current;
    p.x += (p.tx - p.x) * Math.min(1, dt * 3);
    p.y += (p.ty - p.y) * Math.min(1, dt * 3);

    const root = rootRef.current;
    if (root) {
      root.position.y = Math.sin(t * 0.3) * 0.07;
      root.rotation.y = Math.sin(t * 0.09) * 0.16 + p.x * 0.18 + e * 0.16;
      root.rotation.x = Math.sin(t * 0.06) * 0.04 - p.y * 0.07;
      root.scale.setScalar(1 + e * 0.05);
    }

    // shards drift outward + sway when focused; arena shards can glitch-jitter
    for (let i = 0; i < cluster.shards.length; i += 1) {
      const m = shardRefs.current[i];
      if (!m) continue;
      const s = cluster.shards[i];
      const out = s.out ?? [0, 0, 0];
      m.position.set(
        s.position[0] + out[0] * e * 0.14,
        s.position[1] + out[1] * e * 0.1,
        s.position[2] + out[2] * e * 0.14
      );
      m.quaternion.setFromEuler(tmpE.set(s.rotation[0], s.rotation[1], s.rotation[2]));
      if (!reduced) {
        tmpQ.setFromAxisAngle(UP, Math.sin(t * 0.45 + i * 1.7) * (0.02 + e * 0.05));
        m.quaternion.multiply(tmpQ);
      }
      if (s.glitch && e > 0.35 && !reduced && Math.random() < 0.05) {
        m.position.x += (Math.random() - 0.5) * 0.07;
      }
      m.scale.set(s.scale[0], s.scale[1], s.scale[2]);
    }

    // rings: spin faster + brighten when focused
    for (let i = 0; i < cluster.rings.length; i += 1) {
      const g = ringRefs.current[i];
      if (!g || reduced) continue;
      const r = cluster.rings[i];
      const mesh = g.children[0];
      if (mesh) mesh.rotation.z += r.spin * dt * (0.5 + e * 1.7);
    }
    for (const m of [mats.ringA, mats.ringB, mats.hud, mats.ringGold]) {
      m.opacity = Math.min(0.95, m.userData.base * (0.45 + e * 0.75 + pulse * 0.12));
    }

    // orbiting crystalline chips
    for (let i = 0; i < cluster.chips.length; i += 1) {
      const m = chipRefs.current[i];
      if (!m) continue;
      const c = cluster.chips[i];
      if (!reduced) c.phase += c.sp * dt * (1 + e * 2.4);
      const a = c.a + c.phase;
      m.position.set(Math.cos(a) * c.r, c.y + Math.sin(a * 0.8 + i) * 0.14, Math.sin(a) * c.r);
      if (!reduced) m.rotation.set(t * 0.4 + c.phase, -a, c.phase);
      m.scale.setScalar(Math.max(0.001, c.s * (1 + e * 0.25)));
    }

    // free-floating fragments drifting through space
    for (let i = 0; i < cluster.floaters.length; i += 1) {
      const m = floatRefs.current[i];
      if (!m) continue;
      const f = cluster.floaters[i];
      if (!reduced) f.angle += f.speed * dt * (1 + e * 1.6);
      m.position.set(
        Math.cos(f.angle) * f.dist,
        f.y + Math.sin(t * 0.5 + f.bob) * 0.16,
        Math.sin(f.angle) * f.dist
      );
      if (!reduced) m.rotation.set(t * f.rotSpeed, t * f.rotSpeed * 0.7, 0);
      m.scale.setScalar(f.scale * (1 + e * 0.3));
    }

    // paradox: gold sparks rising out of the fracture
    for (let i = 0; i < cluster.embers.length; i += 1) {
      const m = emberRefs.current[i];
      if (!m) continue;
      const em = cluster.embers[i];
      const cyc = ((t * em.sp + em.ph) % 1 + 1) % 1;
      m.position.set(em.p[0] + Math.sin(t + em.ph) * 0.06, em.p[1] + cyc * 1.5, em.p[2]);
      const fade = Math.sin(cyc * Math.PI);
      m.material.opacity = fade * (0.4 + e * 0.6);
      const s = em.s * (0.7 + fade * 0.5);
      m.scale.set(s, s, 1);
    }

    // electric discharge: sharp irregular flicker, brighter when dominant
    if (arcs.length) {
      const flick = 0.5 + 0.5 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.7);
      mats.arc.opacity = (0.1 + 0.55 * flick * flick) * (0.35 + e * 0.9);
    }

    // paradox fracture seam breathes
    if (seamRef.current) {
      seamRef.current.material.opacity =
        (0.26 + 0.34 * Math.abs(Math.sin(t * 1.4))) * (0.6 + e * 0.8);
    }

    // arena scan plane sweeps the core
    if (scanRef.current) {
      scanRef.current.position.y = -1.1 + ((t * 0.22) % 1) * 2.6;
      scanRef.current.material.opacity =
        mats.scan.userData.base * (0.5 + e * 1.1);
    }

    const cl = coreLight.current;
    if (cl) cl.intensity = 1.8 + e * 5.5 + pulse * 0.8;
    const hv = haloRef.current;
    if (hv) {
      hv.scale.setScalar((3.6 + e * 1.5) * (0.97 + 0.05 * pulse));
      hv.material.opacity = hv.material.userData.base * (0.5 + e * 0.7);
    }
  });

  return (
    <group ref={rootRef}>
      {/* dark geode matrix the realm grows from */}
      <mesh geometry={kit.rock} material={mats.rock} position={[0, -0.95, 0]} scale={[1.3, 0.72, 1.3]} />

      {/* micro-crystals studding the dome */}
      {cluster.studs.map((s, i) => (
        <mesh
          key={`st${i}`}
          geometry={kit.geos[s.geo]}
          material={s.gold ? mats.byIndex[5] : mats.stud}
          position={s.position}
          rotation={[0, s.yaw, 0]}
          scale={[s.scale, s.scale * (1 + s.tilt), s.scale]}
        />
      ))}

      {/* the realm's hero shard */}
      <mesh
        geometry={kit.geos[0]}
        material={mats.byIndex[0]}
        position={cluster.central.position}
        rotation={cluster.central.rotation}
        scale={cluster.central.scale}
      />

      {/* realm shards (coil blades / fracture half / crown blades / satellites) */}
      {cluster.shards.map((s, i) => (
        <mesh
          key={`sh${i}`}
          ref={(el) => {
            shardRefs.current[i] = el;
          }}
          geometry={kit.geos[s.geo]}
          material={mats.byIndex[s.mat] ?? mats.byIndex[1]}
        />
      ))}

      {/* realm rings: containment (forge) / time gyros (paradox) / HUD bands */}
      {cluster.rings.map((r, i) => (
        <group
          key={`rg${i}`}
          ref={(el) => {
            ringRefs.current[i] = el;
          }}
          position={[0, r.y, 0]}
          rotation={[r.tilt, 0, 0]}
        >
          <mesh rotation={[-Math.PI / 2, 0, 0]} material={ringMaterialFor(mats, r)}>
            <planeGeometry args={[r.r * 2, r.r * 2]} />
          </mesh>
        </group>
      ))}

      {/* orbiting crystalline chips */}
      {cluster.chips.map((c, i) => (
        <mesh
          key={`ch${i}`}
          ref={(el) => {
            chipRefs.current[i] = el;
          }}
          geometry={kit.geos[3]}
          material={mats.chip}
          position={[Math.cos(c.a) * c.r, c.y, Math.sin(c.a) * c.r]}
        />
      ))}

      {/* free-floating fragments drifting through space */}
      {cluster.floaters.map((f, i) => (
        <mesh
          key={`fl${i}`}
          ref={(el) => {
            floatRefs.current[i] = el;
          }}
          geometry={kit.geos[4]}
          material={mats.byIndex[4]}
          position={[Math.cos(f.angle) * f.dist, f.y, Math.sin(f.angle) * f.dist]}
        />
      ))}

      {/* paradox: gold sparks rising from the fracture */}
      {cluster.embers.map((em, i) => (
        <sprite
          key={`em${i}`}
          ref={(el) => {
            emberRefs.current[i] = el;
          }}
          position={em.p}
        >
          <spriteMaterial
            map={kit.tex.ember}
            color={em.gold ? "#f5d78e" : "#a855f7"}
            transparent
            opacity={0.6}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
      ))}

      {/* paradox: the seam of light inside the split core */}
      {cluster.seam.length ? (
        <mesh ref={seamRef} position={[0, 0.05, 0.05]} material={mats.seam}>
          <planeGeometry args={[0.42, 1.7]} />
        </mesh>
      ) : null}

      {/* arena: scan plane sweeping the core */}
      {realmId === "arena" ? (
        <mesh ref={scanRef} rotation={[-Math.PI / 2, 0, 0]} material={mats.scan}>
          <planeGeometry args={[4.2, 4.2]} />
        </mesh>
      ) : null}

      {/* electric discharge lines */}
      {arcs.map((l, i) => (
        <primitive key={`ar${i}`} object={l} />
      ))}

      {/* rim lights: lavender/violet backlight carves facet edges out of dark */}
      <directionalLight position={[2.6, 2.2, -4]} intensity={2.2} color="#d8b4fe" />
      <directionalLight position={[-3.2, 0.6, -3]} intensity={1.4} color="#a855f7" />
      <pointLight
        ref={coreLight}
        position={[0, 0.2, -0.25]}
        color="#f6f0ff"
        intensity={2}
        distance={9}
        decay={2}
      />

      {/* internal glow + realm halo */}
      <sprite position={[0, 0.1, 0.3]} scale={[1.2, 1.2, 1]} material={mats.core} />
      <sprite ref={haloRef} position={[0, -0.05, 0]} scale={[3.6, 3.6, 1]} material={mats.halo} />
      {/* grounding pool of realm light beneath the geode */}
      <sprite position={[0, -1.25, 0]} scale={[4, 1.5, 1]} material={mats.halo} />
    </group>
  );
}
