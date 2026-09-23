import * as THREE from "three";

/**
 * Procedural equirectangular environment (deep violet gradient + soft
 * white/violet/lavender/gold light blobs) baked to PMREM.
 * Gives the crystal real reflections/refraction without network assets.
 */
export function createCrystalEnvironment(gl) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const x = c.getContext("2d");

  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#241150");
  g.addColorStop(0.45, "#12091f");
  g.addColorStop(0.78, "#0a0612");
  g.addColorStop(1, "#1a0d36");
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 256);

  const blob = (bx, by, r, color, alpha) => {
    const rg = x.createRadialGradient(bx, by, 0, bx, by, r);
    rg.addColorStop(0, color);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    x.globalAlpha = alpha;
    x.fillStyle = rg;
    x.fillRect(bx - r, by - r, r * 2, r * 2);
    x.globalAlpha = 1;
  };

  blob(140, 64, 130, "rgba(255,255,255,1)", 1); // key light
  blob(372, 92, 140, "rgba(168,85,247,1)", 0.95); // violet fill
  blob(430, 184, 96, "rgba(216,180,254,0.85)", 0.8); // lavender low
  blob(56, 196, 88, "rgba(245,215,142,0.6)", 0.5); // gold kiss
  blob(258, 34, 80, "rgba(255,255,255,1)", 0.75); // top sheen
  blob(470, 48, 66, "rgba(124,58,237,1)", 0.75); // deep violet
  blob(300, 150, 70, "rgba(255,255,255,0.7)", 0.4); // facet sparkle
  blob(30, 120, 64, "rgba(216,180,254,0.8)", 0.55); // lavender rim
  // tight hotspots drawn last — these give the facets crisp, defined
  // speculars instead of one soft wash (the "expensive glass" tell)
  blob(140, 64, 30, "rgba(255,255,255,1)", 1); // tight key
  blob(258, 34, 20, "rgba(255,255,255,1)", 0.95); // tight top sheen
  blob(372, 92, 26, "rgba(226,206,255,1)", 0.8); // tight violet

  // Linear light streaks — the signature of real faceted-crystal photography.
  // Sharp bright bands crossing at different angles so each facet catches a
  // DIFFERENT highlight instead of one uniform wash of purple.
  const streak = (sx, sy, w, h, rot, color, alpha) => {
    x.save();
    x.translate(sx, sy);
    x.rotate(rot);
    const lg = x.createLinearGradient(-w / 2, 0, w / 2, 0);
    lg.addColorStop(0, "rgba(0,0,0,0)");
    lg.addColorStop(0.5, color);
    lg.addColorStop(1, "rgba(0,0,0,0)");
    x.globalAlpha = alpha;
    x.fillStyle = lg;
    x.filter = "blur(5px)";
    x.fillRect(-w / 2, -h / 2, w, h);
    x.restore();
    x.globalAlpha = 1;
    x.filter = "none";
  };
  streak(150, 110, 300, 26, -0.5, "rgba(255,255,255,1)", 0.9); // white key streak
  streak(360, 70, 260, 18, 0.9, "rgba(216,180,254,1)", 0.85); // lavender cross
  streak(60, 60, 220, 14, 1.4, "rgba(232,220,255,1)", 0.7); // fine sheen
  streak(440, 150, 240, 20, -1.1, "rgba(168,85,247,1)", 0.8); // violet streak
  streak(240, 200, 320, 16, 0.2, "rgba(245,215,142,0.9)", 0.35); // faint gold
  // narrow, hard-edged slivers: these produce the razor highlights that
  // sweep a single facet as the cluster rotates
  streak(200, 78, 180, 5, -0.42, "rgba(255,255,255,1)", 1);
  streak(318, 126, 150, 4, 0.68, "rgba(245,243,255,1)", 0.95);
  streak(96, 158, 130, 3, -1.25, "rgba(216,180,254,1)", 0.85);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(gl);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromEquirectangular(tex);
  tex.dispose();
  pmrem.dispose();
  return rt.texture;
}
