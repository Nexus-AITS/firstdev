import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { crystalStore as store } from "../../lib/crystalStore";

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const WHITE = new THREE.Color("#f6f0ff");
const GOLD = new THREE.Color("#f5d78e");

/**
 * Renders nothing — owns the cinematic animation loop for the cluster:
 * camera parallax, cluster float, shard sway, fragment orbits, internal
 * energy pulse and story-driven scatter/glow/burst transforms.
 */
export default function CrystalRig({ cluster, reduced, refs }) {
  const camera = useThree((s) => s.camera);
  const time = useRef(0);
  const ptr = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const camSm = useRef({ x: 0, y: 0 });

  const { shardQuats, studQuats } = useMemo(() => {
    const quatFor = (t) =>
      new THREE.Quaternion()
        .setFromAxisAngle(tmpV.set(t.axis[0], t.axis[1], t.axis[2]).normalize(), t.tilt)
        .multiply(new THREE.Quaternion().setFromAxisAngle(UP, t.yaw));
    return { shardQuats: cluster.shards.map(quatFor), studQuats: cluster.studs.map(quatFor) };
  }, [cluster]);

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
    store.scatter += (store.tScatter - store.scatter) * Math.min(1, dt * 4.2);
    store.glow += (store.tGlow - store.glow) * Math.min(1, dt * 4.2);
    store.burst = Math.max(0, store.burst - dt * 1.4);
    const { scatter, glow, burst } = store;
    if (!reduced) time.current += dt;
    const t = time.current;

    const p = ptr.current;
    p.x += (p.tx - p.x) * Math.min(1, dt * 3);
    p.y += (p.ty - p.y) * Math.min(1, dt * 3);

    const cs = camSm.current;
    cs.x += (p.x * 0.5 - cs.x) * Math.min(1, dt * 2);
    cs.y += (-p.y * 0.32 - cs.y) * Math.min(1, dt * 2);
    camera.position.x = cs.x;
    camera.position.y = 0.1 + cs.y;
    camera.lookAt(0, 0.18, 0);

    const root = refs.root.current;
    if (root) {
      root.position.y = Math.sin(t * 0.32) * 0.09;
      root.rotation.y = Math.sin(t * 0.1) * 0.13 + p.x * 0.14;
      root.rotation.x = Math.sin(t * 0.07) * 0.045 - p.y * 0.08;
      root.rotation.z = Math.sin(t * 0.05) * 0.02;
    }

    const push = scatter * 1.15 - glow * 0.55;
    const pull = 1 - glow * 0.3;
    for (let i = 0; i < cluster.shards.length; i += 1) {
      const m = refs.shards.current[i];
      if (!m) continue;
      const s = cluster.shards[i];
      m.position.set(
        (s.position[0] + s.out[0] * push) * pull,
        (s.position[1] + s.out[1] * push * 0.55) * pull,
        (s.position[2] + s.out[2] * push) * pull
      );
      m.quaternion.copy(shardQuats[i]);
      if (!reduced) {
        tmpQ.setFromAxisAngle(UP, Math.sin(t * 0.5 + i * 1.7) * (0.02 + scatter * 0.08));
        m.quaternion.multiply(tmpQ);
      }
      const sc = 1 - glow * 0.22;
      m.scale.set(s.scale[0] * sc, s.scale[1] * sc, s.scale[2] * sc);
    }

    // matrix studs stay anchored (the bed doesn't fragment — only the
    // spires do), but they tighten slightly as the core charges
    for (let i = 0; i < cluster.studs.length; i += 1) {
      const m = refs.studs.current[i];
      if (!m) continue;
      const st = cluster.studs[i];
      m.position.set(st.position[0] * pull, st.position[1] * pull, st.position[2] * pull);
      m.quaternion.copy(studQuats[i]);
      const ss = st.scale * (1 - glow * 0.14);
      m.scale.set(ss, ss, ss);
    }

    for (let i = 0; i < cluster.floaters.length; i += 1) {
      const m = refs.floaters.current[i];
      if (!m) continue;
      const f = cluster.floaters[i];
      if (!reduced) f.angle += f.speed * dt * (1 + scatter * 2.2 + burst * 5);
      const radius = f.dist * (1 + scatter * 1.55) * (1 - glow * 0.82) + burst * f.dist * 0.5;
      const y = (f.y + Math.sin(t * 0.5 + f.bob) * 0.16) * (1 - glow * 0.6);
      m.position.set(Math.cos(f.angle) * radius, y, Math.sin(f.angle) * radius);
      if (!reduced) {
        tmpV.set(f.axis[0], f.axis[1], f.axis[2]).normalize();
        m.rotateOnAxis(tmpV, f.rotSpeed * dt * (1 + scatter * 1.5));
      }
      m.scale.setScalar(Math.max(0.001, f.scale * (1 - glow * 0.5)));
    }

    // orbiting glass chips — inclined ellipses, tumbling as they travel
    for (let i = 0; i < cluster.orbitChips.length; i += 1) {
      const m = refs.chips.current[i];
      if (!m) continue;
      const c = cluster.orbitChips[i];
      if (!reduced) c.phase += c.speed * dt * (1 + scatter * 2.4 + burst * 6);
      const rad = c.r * (1 + scatter * 0.8) * (1 - glow * 0.42);
      const cx = Math.cos(c.phase) * rad;
      const cz = Math.sin(c.phase) * rad;
      m.position.set(cx, c.y + Math.sin(c.phase * 0.8 + i) * 0.13 + cz * Math.sin(c.incl), cz * Math.cos(c.incl));
      if (!reduced) {
        m.rotation.x = c.tilt + t * c.spin * 0.3;
        m.rotation.y = -c.phase + c.tilt;
        m.rotation.z = c.tilt * 0.55 + t * c.spin * 0.18;
      }
      const cs = Math.max(0.001, c.scale * (1 - glow * 0.45 + burst * 0.5));
      m.scale.set(cs, cs, cs);
    }

    const pulse = 0.74 + 0.26 * Math.sin(t * 0.9);
    const energy = pulse * (1 + burst * 2.4) + glow * 0.9;
    const core = refs.core.current;
    if (core) {
      // group of soft glow sprites: scale + tint + breathe (no hard mesh)
      core.scale.setScalar(1 + glow * 0.6 + burst * 0.5 + pulse * 0.07);
      const tint = Math.min(0.7, glow * 0.85);
      for (let i = 0; i < core.children.length; i += 1) {
        const m = core.children[i].material;
        if (!m) continue;
        m.color.copy(WHITE).lerp(GOLD, tint);
        const base = m.userData.base ?? 0.36;
        m.opacity = Math.min(0.7, base * (0.72 + 0.42 * pulse) * (1 + burst * 0.9));
      }
    }
    const cl = refs.coreLight.current;
    if (cl) {
      cl.intensity = (2.4 + glow * 12 + burst * 14) * pulse;
      cl.color.copy(WHITE).lerp(GOLD, Math.min(0.75, glow * 0.8));
    }
    if (refs.goldLight.current) refs.goldLight.current.intensity = (glow * 8 + burst * 7) * pulse;
    const hv = refs.haloV.current;
    if (hv) {
      hv.scale.setScalar((5.6 + glow * 2.2 + burst * 3) * (0.97 + 0.05 * pulse));
      hv.material.opacity = Math.min(0.8, 0.42 + glow * 0.3 + burst * 0.3);
    }
    const hw = refs.haloW.current;
    if (hw) {
      hw.scale.setScalar((1.5 + glow * 1.6 + burst * 1.8) * (0.95 + 0.08 * pulse));
      hw.material.opacity = Math.min(0.8, 0.4 * energy);
    }
    // the volumetric beam flares hardest at the burst, then settles
    const bm = refs.beam.current;
    if (bm) {
      bm.material.opacity = Math.min(0.62, 0.14 + 0.07 * pulse + glow * 0.26 + burst * 0.34);
      const bs = 1 + glow * 0.42 + burst * 0.25 + pulse * 0.04;
      bm.scale.set(bs, bs, 1);
    }

    const orb = refs.orbit.current;
    if (orb && !reduced) {
      orb.rotation.y = t * 0.05;
      orb.rotation.x = Math.sin(t * 0.08) * 0.12;
    }
    for (let i = 0; i < cluster.bokehs.length; i += 1) {
      const m = refs.bokehs.current[i];
      if (!m || reduced) continue;
      const b = cluster.bokehs[i];
      m.position.set(b.p[0] + Math.sin(t * 0.11 + b.ph) * 0.6, b.p[1] + Math.cos(t * 0.09 + b.ph) * 0.4, b.p[2]);
    }
    // shard-tip fire: sharp twinkles, brighter while the core charges
    for (let i = 0; i < cluster.tips.length; i += 1) {
      const m = refs.tips.current[i];
      if (!m) continue;
      const tp = cluster.tips[i];
      const w = reduced ? 0.55 : Math.max(0, Math.sin(t * tp.sp + tp.ph));
      const a = w * w * (0.65 + glow * 0.9 + burst * 0.8);
      m.material.opacity = Math.min(0.95, a);
      const sc = tp.s * (0.75 + w * 0.5 + glow * 0.3);
      m.scale.set(sc, sc, 1);
    }
  });

  return null;
}
