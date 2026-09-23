import { Link } from "react-router-dom";

function Bracket({ className }) {
  return <span aria-hidden className={`absolute h-2.5 w-2.5 border-lavender/70 ${className}`} />;
}

function Arrow({ dir = "right" }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 12"
      className="h-2.5 w-6 overflow-visible"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d={dir === "left" ? "M24 6H2M7 1L2 6l5 5" : "M0 6h22M17 1l5 5-5 5"} />
    </svg>
  );
}

/**
 * Primary cinematic CTA. Renders a Link (internal), <a> (external) or
 * <button>. Bracketed frame, energy sheen, hover glow.
 */
export default function CinematicButton({
  children,
  to,
  href,
  onClick,
  type = "button",
  className = "",
  tone = "violet",
  external = false,
  arrow = "right",
  ...rest
}) {
  const baseClass = [
    "group relative inline-flex items-center justify-center gap-4",
    "px-7 py-4 md:px-9 md:py-4.5",
    "text-[10px] md:text-[11px] font-medium uppercase tracking-[0.38em]",
    "text-crystal select-none",
    "border transition-[box-shadow,background-color,border-color] duration-500",
    tone === "gold"
      ? "border-gold/40 hover:border-gold/90 hover:shadow-[0_0_44px_rgba(245,215,142,0.22)]"
      : "border-lavender/35 hover:border-lavender/90 hover:shadow-[0_0_44px_rgba(124,58,237,0.4)]",
    "bg-[linear-gradient(110deg,rgba(124,58,237,0.14),rgba(124,58,237,0.02)_55%,transparent)]",
    "hover:bg-[linear-gradient(110deg,rgba(124,58,237,0.34),rgba(168,85,247,0.08)_60%,transparent)]",
    "overflow-hidden",
    className,
  ].join(" ");

  const inner = (
    <>
      <Bracket className="-left-px -top-px border-l border-t" />
      <Bracket className="-right-px -top-px border-r border-t" />
      <Bracket className="-bottom-px -left-px border-b border-l" />
      <Bracket className="-bottom-px -right-px border-b border-r" />
      <span
        aria-hidden
        className="absolute inset-y-0 -left-full w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-crystal/25 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-[280%]"
      />
      <span className="relative z-10 whitespace-nowrap">{children}</span>
      <Arrow dir={arrow} />
    </>
  );

  const common = {
    className: baseClass,
    "data-cursor": "enter",
    ...rest,
  };

  if (href) {
    return (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        {...common}
      >
        {inner}
      </a>
    );
  }

  if (to) {
    return (
      <Link to={to} {...common}>
        {inner}
      </Link>
    );
  }

  return (
    <button type={type} onClick={onClick} {...common}>
      {inner}
    </button>
  );
}
