import * as THREE from "three";

/**
 * Canvas-backed textures for realm rings/HUD/scan planes. All procedural â€”
 * zero network assets, and all additive so they layer cleanly over the
 * crystal's transmitted light.
 */

// soft gold/violet dot reused for embers and sparkles
export function makeEmberTexture() {
  const S = 64;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(245,215,142,0.7)");
  g.addColorStop(1, "rgba(245,215,142,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  return t;
}

// dashed ring alpha â€” `gap` is the dark ratio
export function makeDashedRingTexture(gap = 0.28) {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  const cx = S / 2;
  const R = S * 0.44;
  const r = S * 0.36;
  const seg = 14;
  x.fillStyle = "rgba(255,255,255,1)";
  for (let i = 0; i < seg; i += 1) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1 - gap) / seg) * Math.PI * 2;
    x.beginPath();
    x.arc(cx, cx, R, a0, a1);
    x.arc(cx, cx, r, a1, a0, true);
    x.closePath();
    x.fill("evenodd");
  }
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  return t;
}

// HUD tick band â€” short radial dashes around a ring
export function makeHudTexture() {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  x.strokeStyle = "rgba(255,255,255,0.9)";
  x.lineWidth = 2.4;
  const cx = S / 2;
  const R = S * 0.4;
  for (let i = 0; i < 48; i += 1) {
    const a = (i / 48) * Math.PI * 2;
    const long = i % 4 === 0;
    const len = long ? 16 : 7;
    x.beginPath();
    x.moveTo(cx + Math.cos(a) * R, cx + Math.sin(a) * R);
    x.lineTo(cx + Math.cos(a) * (R + len), cx + Math.sin(a) * (R + len));
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  return t;
}

// circuit grid + bright nodes â€” for the forge's tech haze
export function makeCircuitTexture() {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  x.strokeStyle = "rgba(168,85,247,0.42)";
  x.lineWidth = 1;
  const G = 32;
  for (let i = 0; i <= S; i += G) {
    x.beginPath();
    x.moveTo(i, 0);
    x.lineTo(i, S);
    x.moveTo(0, i);
    x.lineTo(S, i);
    x.stroke();
  }
  x.fillStyle = "rgba(216,180,254,0.95)";
  [[64, 64], [192, 128], [128, 192], [64, 192]].forEach(([gx, gy]) => {
    x.beginPath();
    x.arc(gx, gy, 3, 0, Math.PI * 2);
    x.fill();
  });
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  return t;
}

// horizontal scan lines for the arena scan plane
export function makeScanTexture() {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const x = c.getContext("2d");
  for (let i = 0; i < S; i += 4) {
    x.fillStyle = "rgba(255,255,255,0.85)";
    x.fillRect(0, i, S, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter;
  return t;
}
