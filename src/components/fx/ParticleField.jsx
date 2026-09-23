import { useEffect, useRef } from "react";
import useDeviceTier, { PARTICLE_DENSITY } from "../../hooks/useDeviceTier";
import usePrefersReducedMotion from "../../hooks/usePrefersReducedMotion";

const rnd = (a, b) => a + Math.random() * (b - a);

/**
 * Procedural ambient particle canvas.
 * modes: stars | energy | circuit | paradox | hud | ai
 * Density adapts to device tier; loop pauses off-screen / hidden tab /
 * reduced-motion (single static frame instead).
 */
export default function ParticleField({ mode = "stars", className = "", factor = 1 }) {
  const canvasRef = useRef(null);
  const tier = useDeviceTier();
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const budget = PARTICLE_DENSITY[tier];
    const base = mode === "stars" ? budget.stars : mode === "energy" ? budget.energy : budget.shards;
    const count = Math.max(10, Math.round(base * factor));

    let w = 0;
    let h = 0;
    let raf = 0;
    let t = 0;
    let last = performance.now();
    let tabVisible = true;
    let inView = true;
    const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
    let parts = [];

    const spawn = (initial) => {
      switch (mode) {
        case "energy":
          return {
            x: rnd(0, w),
            y: initial ? rnd(0, h) : h + 16,
            r: rnd(1, 3.4),
            vy: rnd(-46, -14),
            sway: rnd(8, 42),
            ph: rnd(0, 6.28),
            a: rnd(0.25, 0.7),
          };
        case "circuit": {
          const G = 56;
          const axis = Math.random() < 0.5 ? "h" : "v";
          if (Math.random() < 0.45) {
            return {
              k: "node",
              x: Math.floor(Math.random() * Math.max(1, w / G)) * G,
              y: Math.floor(Math.random() * Math.max(1, h / G)) * G,
              ph: rnd(0, 6.28),
              s: rnd(1.5, 3),
            };
          }
          const len = axis === "h" ? w : h;
          return {
            k: "pulse",
            axis,
            x0: axis === "h" ? 0 : Math.floor(Math.random() * Math.max(1, w / G)) * G,
            y0: axis === "h" ? Math.floor(Math.random() * Math.max(1, h / G)) * G : 0,
            len,
            pos: rnd(0, len),
            sp: rnd(90, 260),
            a: rnd(0.3, 0.75),
          };
        }
        case "paradox":
          return {
            x: rnd(0, w),
            y: rnd(0, h),
            s: rnd(5, 20),
            rot: rnd(0, 6.28),
            vr: rnd(-0.7, 0.7),
            vx: rnd(-10, 10),
            vy: rnd(-12, 7),
            a: rnd(0.14, 0.5),
            gold: Math.random() < 0.14,
            ph: rnd(0, 6.28),
          };
        case "hud": {
          const roll = Math.random();
          const R = Math.min(w, h);
          if (roll < 0.55)
            return { k: "ring", r: rnd(30, R * 0.46), a0: rnd(0, 6.28), len: rnd(0.5, 2.6), sp: rnd(-0.55, 0.55), a: rnd(0.1, 0.4) };
          if (roll < 0.8)
            return { k: "glitch", x: rnd(0, w), y: rnd(0, h), gw: rnd(30, 220), gh: rnd(1, 5), life: rnd(0, 1), max: rnd(0.15, 0.7) };
          return { k: "sweep", y: rnd(0, h), sp: rnd(40, 130), a: rnd(0.06, 0.2) };
        }
        case "ai": {
          if (Math.random() < 0.2)
            return { k: "orbit", r: rnd(70, 200), tilt: rnd(-0.6, 0.6), sp: rnd(0.1, 0.3), ph: rnd(0, 6.28) };
          return {
            k: "orb",
            th: rnd(0, 6.28),
            ph: rnd(-1.3, 1.3),
            r: rnd(50, 220),
            sp: rnd(0.15, 0.6) * (Math.random() < 0.5 ? -1 : 1),
            s: rnd(0.8, 2.4),
          };
        }
        default:
          return {
            x: rnd(0, w),
            y: rnd(0, h),
            r: rnd(0.4, 1.7),
            tw: rnd(0.5, 2.2),
            ph: rnd(0, 6.28),
            a: rnd(0.2, 0.85),
            vx: rnd(-3, 3),
            vy: rnd(-1.5, 1.5),
            d: rnd(0.3, 1),
          };
      }
    };

    const seed = () => {
      parts = new Array(count);
      for (let i = 0; i < count; i += 1) parts[i] = spawn(true);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const render = (dt) => {
      ctx.clearRect(0, 0, w, h);
      ptr.x += (ptr.tx - ptr.x) * 0.04;
      ptr.y += (ptr.ty - ptr.y) * 0.04;
      t += dt;
      const cx = w / 2;
      const cy = h / 2;

      if (mode === "stars") {
        const ox = ptr.x * 14;
        const oy = ptr.y * 10;
        ctx.fillStyle = "#f5f3ff";
        for (const p of parts) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.x < -4) p.x = w + 4;
          else if (p.x > w + 4) p.x = -4;
          if (p.y < -4) p.y = h + 4;
          else if (p.y > h + 4) p.y = -4;
          ctx.globalAlpha = Math.max(0, p.a * (0.55 + 0.45 * Math.sin(t * p.tw + p.ph)));
          ctx.beginPath();
          ctx.arc(p.x + ox * p.d, p.y + oy * p.d, p.r, 0, 6.2832);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        return;
      }

      if (mode === "energy") {
        ctx.globalCompositeOperation = "lighter";
        for (const p of parts) {
          p.y += p.vy * dt;
          if (p.y < -30) Object.assign(p, spawn(false));
          const x = p.x + Math.sin(t * 0.7 + p.ph) * p.sway;
          ctx.globalAlpha = p.a * 0.35;
          ctx.fillStyle = "#7c3aed";
          ctx.beginPath();
          ctx.arc(x, p.y, p.r * 5, 0, 6.2832);
          ctx.fill();
          ctx.globalAlpha = p.a * 0.6;
          ctx.fillStyle = "#a855f7";
          ctx.beginPath();
          ctx.arc(x, p.y, p.r * 2.6, 0, 6.2832);
          ctx.fill();
          ctx.globalAlpha = p.a;
          ctx.fillStyle = "#e9d5ff";
          ctx.beginPath();
          ctx.arc(x, p.y, p.r, 0, 6.2832);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        return;
      }

      if (mode === "circuit") {
        ctx.strokeStyle = "rgba(124,58,237,0.10)";
        ctx.lineWidth = 1;
        const G = 56;
        ctx.beginPath();
        for (let x = 0; x <= w; x += G) {
          ctx.moveTo(x + 0.5, 0);
          ctx.lineTo(x + 0.5, h);
        }
        for (let y = 0; y <= h; y += G) {
          ctx.moveTo(0, y + 0.5);
          ctx.lineTo(w, y + 0.5);
        }
        ctx.stroke();
        ctx.globalCompositeOperation = "lighter";
        for (const p of parts) {
          if (p.k === "node") {
            const a = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 2 + p.ph));
            ctx.fillStyle = `rgba(216,180,254,${0.55 * a})`;
            ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
          } else {
            p.pos += p.sp * dt;
            if (p.pos > p.len + 60) p.pos = -60;
            const head = p.pos;
            const tail = Math.max(0, head - 70);
            const x1 = p.axis === "h" ? tail : p.x0;
            const y1 = p.axis === "h" ? p.y0 : tail;
            const x2 = p.axis === "h" ? head : p.x0;
            const y2 = p.axis === "h" ? p.y0 : head;
            ctx.strokeStyle = `rgba(168,85,247,${p.a})`;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            ctx.fillStyle = "rgba(245,243,255,0.9)";
            ctx.fillRect(x2 - 1.5, y2 - 1.5, 3, 3);
          }
        }
        ctx.globalCompositeOperation = "source-over";
        return;
      }

      if (mode === "paradox") {
        ctx.globalCompositeOperation = "lighter";
        for (const p of parts) {
          p.x += (p.vx + Math.sin(t + p.ph) * 6) * dt;
          p.y += p.vy * dt;
          p.rot += p.vr * dt;
          if (p.x < -30) p.x = w + 30;
          else if (p.x > w + 30) p.x = -30;
          if (p.y < -30) p.y = h + 30;
          else if (p.y > h + 30) p.y = -30;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          const col = p.gold ? "245,215,142" : "216,180,254";
          ctx.strokeStyle = `rgba(${col},${p.a})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, -p.s);
          ctx.lineTo(p.s * 0.87, p.s * 0.5);
          ctx.lineTo(-p.s * 0.87, p.s * 0.5);
          ctx.closePath();
          ctx.stroke();
          if (p.gold) {
            ctx.fillStyle = `rgba(${col},${p.a * 0.25})`;
            ctx.fill();
          }
          ctx.restore();
        }
        ctx.globalCompositeOperation = "source-over";
      }
      if (mode === "hud") {
        for (const p of parts) {
          if (p.k === "ring") {
            p.a0 += p.sp * dt;
            ctx.strokeStyle = `rgba(168,85,247,${p.a})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(cx, cy, p.r, p.a0, p.a0 + p.len);
            ctx.stroke();
          } else if (p.k === "glitch") {
            p.life += dt;
            if (p.life > p.max) {
              Object.assign(p, spawn(false));
              continue;
            }
            const vis = 0.5 + 0.5 * Math.sin(p.life * 40);
            ctx.fillStyle = `rgba(168,85,247,${0.28 * vis})`;
            ctx.fillRect(p.x, p.y, p.gw, p.gh);
          } else {
            p.y += p.sp * dt;
            if (p.y > h + 4) p.y = -4;
            ctx.fillStyle = `rgba(216,180,254,${p.a})`;
            ctx.fillRect(0, p.y, w, 1);
          }
        }
        return;
      }

      if (mode === "ai") {
        for (const p of parts) {
          if (p.k === "orbit") {
            p.ph += p.sp * dt;
            ctx.strokeStyle = "rgba(168,85,247,0.16)";
            ctx.lineWidth = 1;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(p.tilt + Math.sin(p.ph) * 0.2);
            ctx.beginPath();
            ctx.ellipse(0, 0, p.r, p.r * 0.38, 0, 0, 6.2832);
            ctx.stroke();
            ctx.restore();
          } else {
            p.th += p.sp * dt;
            const x = cx + Math.cos(p.th) * p.r;
            const y = cy + Math.sin(p.ph) * p.r * 0.55;
            const a = 0.25 + 0.75 * (Math.sin(p.th) * 0.5 + 0.5);
            ctx.fillStyle = `rgba(216,180,254,${0.7 * a})`;
            ctx.beginPath();
            ctx.arc(x, y, p.s, 0, 6.2832);
            ctx.fill();
          }
        }
      }
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0 }
    );
    io.observe(canvas);
    const onVis = () => {
      tabVisible = !document.hidden;
      last = performance.now();
    };
    document.addEventListener("visibilitychange", onVis);
    const onMove = (event) => {
      ptr.tx = (event.clientX / Math.max(1, w)) * 2 - 1;
      ptr.ty = (event.clientY / Math.max(1, h)) * 2 - 1;
    };
    window.addEventListener("mousemove", onMove, { passive: true });

    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      if (!tabVisible || !inView) {
        last = now;
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      render(dt);
    };

    if (reduced) {
      render(0);
    } else {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("mousemove", onMove);
      ctx.clearRect(0, 0, w, h);
    };
  }, [mode, tier, reduced, factor]);

  return <canvas ref={canvasRef} aria-hidden className={`absolute inset-0 h-full w-full ${className}`} />;
}
