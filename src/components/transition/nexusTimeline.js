import { gsap } from "../../lib/gsap";

/**
 * Builds the full ENTER NEXUS cinematic timeline.
 * Returns the GSAP timeline — caller owns kill/skip.
 */
export function buildNexusTimeline({
  reduced,
  veil,
  flash,
  diamond,
  rings,
  shards,
  swarm,
  welcome,
  onMidpoint,
  onComplete,
}) {
  const ringEls = Array.from(rings?.children ?? []);
  const shardEls = Array.from(shards?.children ?? []);
  const swarmEls = Array.from(swarm?.children ?? []);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const reach = Math.max(vw, vh) * 0.8;
  const shardDirs = shardEls.map(() => {
    const a = Math.random() * Math.PI * 2;
    const d = reach * (0.35 + Math.random() * 0.75);
    return { x: Math.cos(a) * d, y: Math.sin(a) * d, r: Math.random() * 720 - 360 };
  });
  const swarmDirs = swarmEls.map(() => {
    const a = Math.random() * Math.PI * 2;
    const d = 40 + Math.random() * Math.min(vw, vh) * 0.5;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d };
  });

  gsap.set(veil, { opacity: 0 });
  gsap.set(flash, { opacity: 0, scale: 0.2 });
  gsap.set(diamond, { opacity: 0, scale: 0.6 });
  gsap.set(welcome, { opacity: 0 });
  gsap.set(ringEls, { opacity: 0, scale: 0.3, xPercent: -50, yPercent: -50 });
  gsap.set(shardEls, { opacity: 0, scale: 0.5, xPercent: -50, yPercent: -50, x: 0, y: 0, rotate: 0 });
  gsap.set(swarmEls, { opacity: 0, xPercent: -50, yPercent: -50, x: 0, y: 0 });

  const tl = gsap.timeline({ onComplete });

  if (reduced) {
    tl.to(veil, { opacity: 1, duration: 0.3 })
      .add(() => onMidpoint(), 0.32)
      .to(welcome, { opacity: 1, duration: 0.4 }, 0.4)
      .to(welcome, { opacity: 0, duration: 0.35 }, 1.4)
      .to(veil, { opacity: 0, duration: 0.4 }, 1.75);
    return tl;
  }

  tl.to(veil, { opacity: 0.55, duration: 0.45, ease: "power2.in" }, 0)
    .to(flash, { opacity: 1, scale: 1.7, duration: 0.5, ease: "power3.out" }, 0.15)
    .to(diamond, { opacity: 1, scale: 1.1, duration: 0.5, ease: "power2.out" }, 0.2)
    .to(ringEls, { opacity: 1, scale: 6.5, duration: 1.5, stagger: 0.12, ease: "power3.out" }, 0.3)
    .to(shardEls, { opacity: 1, scale: 1, duration: 0.2, stagger: { each: 0.01, from: "random" } }, 0.45)
    .to(
      shardEls,
      {
        x: (i) => shardDirs[i].x,
        y: (i) => shardDirs[i].y,
        rotate: (i) => shardDirs[i].r,
        scale: 1.6,
        opacity: 0,
        duration: 1.1,
        ease: "power3.out",
        stagger: { each: 0.014, from: "center" },
      },
      0.55
    )
    .to(diamond, { scale: 9, opacity: 0, duration: 1, ease: "power2.in" }, 0.55)
    .to(flash, { scale: 3.6, opacity: 0, duration: 0.9, ease: "power2.in" }, 0.55)
    .to(
      swarmEls,
      { opacity: 1, x: (i) => swarmDirs[i].x, y: (i) => swarmDirs[i].y, duration: 1, stagger: 0.008, ease: "power2.out" },
      0.8
    )
    .to(veil, { opacity: 1, duration: 0.5, ease: "power2.inOut" }, 1.05)
    .add(() => onMidpoint(), 1.5)
    .fromTo(
      welcome,
      { opacity: 0, letterSpacing: "0.75em", y: 14 },
      { opacity: 1, letterSpacing: "0.34em", y: 0, duration: 0.85, ease: "power3.out" },
      1.6
    )
    .to(swarmEls, { opacity: 0, duration: 0.5, stagger: 0.005 }, 2.5)
    .to(welcome, { opacity: 0, duration: 0.5, ease: "power2.in" }, 2.85)
    .to(veil, { opacity: 0, duration: 0.85, ease: "power2.inOut" }, 3.2);

  return tl;
}
