const HEX = "polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)";

/**
 * Pure-CSS crystalline core shown when WebGL is unavailable.
 * Keeps the gateway concept intact on low-end devices.
 */
export default function WebGLFallback() {
  return (
    <div className="absolute left-1/2 top-1/2 h-[52vmin] w-[52vmin] -translate-x-1/2 -translate-y-1/2 anim-float">
      <div
        className="absolute inset-[-35%] rounded-full blur-2xl"
        style={{ background: "radial-gradient(circle, rgba(124,58,237,0.55), transparent 65%)" }}
      />
      <div
        className="anim-spin-slow absolute inset-0"
        style={{
          clipPath: HEX,
          background:
            "conic-gradient(from 20deg, rgba(124,58,237,0.55), rgba(168,85,247,0.18), rgba(216,180,254,0.4), rgba(124,58,237,0.55))",
          border: "1px solid rgba(216,180,254,0.5)",
        }}
      />
      <div
        className="absolute inset-[17%] rotate-12"
        style={{
          clipPath: HEX,
          background:
            "radial-gradient(circle at 50% 42%, rgba(245,215,142,0.75), rgba(168,85,247,0.28) 45%, rgba(5,3,8,0.92) 78%)",
        }}
      />
      <div className="anim-pulse absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold shadow-[0_0_40px_rgba(245,215,142,0.9)]" />
    </div>
  );
}
