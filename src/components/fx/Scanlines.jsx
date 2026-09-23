/**
 * Digital HUD scanlines — repeating line overlay + a slow luminance sweep.
 */
export default function Scanlines({ className = "" }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      <div className="absolute inset-0 scanlines" />
      <div
        className="absolute inset-x-0 top-0 h-[8vh] bg-gradient-to-b from-transparent via-violet-bright/25 to-transparent"
        style={{ animation: "nexus-sweep 6.5s linear infinite" }}
      />
    </div>
  );
}
