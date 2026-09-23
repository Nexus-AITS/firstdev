import * as THREE from "three";

/** Soft radial glow sprite texture (procedural — no external assets). */
export function makeGlowTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/**
 * Smooth gaussian-like falloff for internal-energy glows.
 * No bright plateau — the center eases out gradually so the sprite
 * reads as diffused light inside the crystal, never a hard disc.
 */
export function makeSoftGlowTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.12, "rgba(255,255,255,0.72)");
  g.addColorStop(0.32, "rgba(255,255,255,0.3)");
  g.addColorStop(0.62, "rgba(255,255,255,0.07)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/**
 * Four-point star sparkle for shard-tip fire.
 * A hot centre plus anisotropic spikes reads like a real specular glint
 * caught on a sharp crystal edge — far richer than a plain dot.
 */
export function makeStarGlintTexture() {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const x = c.getContext("2d");
  const mid = S / 2;

  const core = x.createRadialGradient(mid, mid, 0, mid, mid, S * 0.17);
  core.addColorStop(0, "rgba(255,255,255,1)");
  core.addColorStop(0.4, "rgba(240,232,255,0.5)");
  core.addColorStop(1, "rgba(240,232,255,0)");
  x.fillStyle = core;
  x.fillRect(0, 0, S, S);

  const spike = (w, h, rot) => {
    x.save();
    x.translate(mid, mid);
    x.rotate(rot);
    const g = x.createLinearGradient(0, -h / 2, 0, h / 2);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0.85)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.filter = "blur(1.1px)";
    x.fillStyle = g;
    x.fillRect(-w / 2, -h / 2, w, h);
    x.restore();
  };
  spike(2.8, S * 0.99, 0); // vertical
  spike(2.2, S * 0.78, Math.PI / 2); // horizontal
  spike(1.3, S * 0.42, Math.PI / 4); // diagonals
  spike(1.3, S * 0.42, -Math.PI / 4);

  return new THREE.CanvasTexture(c);
}

/**
 * Vertical volumetric beam — a soft narrow column of light.
 * Drawn as a radially-faded ellipse squeezed horizontally, then mapped onto
 * a plane so it reads as atmosphere rather than a hard-edged shape.
 */
export function makeShaftTexture() {
  const W = 128;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");

  x.save();
  x.translate(W / 2, H * 0.52);
  x.scale(0.24, 1); // squeeze -> column
  const g = x.createRadialGradient(0, 0, 0, 0, 0, H * 0.5);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.2, "rgba(226,206,255,0.42)");
  g.addColorStop(0.52, "rgba(168,85,247,0.14)");
  g.addColorStop(1, "rgba(124,58,237,0)");
  x.fillStyle = g;
  x.fillRect(-W * 3, -H, W * 6, H * 2);
  x.restore();

  return new THREE.CanvasTexture(c);
}

