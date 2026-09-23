import { useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { motion } from "framer-motion";

export default function MobileMenu({ links, onClose }) {
  const firstLinkRef = useRef(null);

  useEffect(() => {
    firstLinkRef.current?.focus();

    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      id="nexus-mobile-menu"
      role="dialog"
      aria-modal="true"
      aria-label="Navigation menu"
      className="fixed inset-0 z-50 flex flex-col justify-center bg-void/95 px-8 backdrop-blur-2xl md:hidden"
      initial={{ opacity: 0, clipPath: "circle(0% at calc(100% - 2.5rem) 2rem)" }}
      animate={{ opacity: 1, clipPath: "circle(150% at calc(100% - 2.5rem) 2rem)" }}
      exit={{ opacity: 0, clipPath: "circle(0% at calc(100% - 2.5rem) 2rem)" }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close menu"
        className="absolute right-5 top-4 flex h-11 w-11 items-center justify-center text-crystal/70"
      >
        <svg aria-hidden viewBox="0 0 20 20" className="h-5 w-5" stroke="currentColor" strokeWidth="1.4">
          <path d="M4 4l12 12M16 4L4 16" />
        </svg>
      </button>

      <p className="mb-8 text-[10px] uppercase tracking-[0.5em] text-lavender/60">Navigate the realm</p>

      <ul className="flex flex-col gap-7">
        {links.map((link, i) => (
          <motion.li
            key={link.to}
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + i * 0.07, duration: 0.5, ease: "easeOut" }}
          >
            <NavLink
              ref={i === 0 ? firstLinkRef : undefined}
              to={link.to}
              end={link.to === "/"}
              onClick={onClose}
              className={({ isActive }) =>
                [
                  "block font-display text-4xl tracking-[0.14em] transition-colors",
                  isActive ? "text-lavender text-glow" : "text-crystal/80",
                ].join(" ")
              }
            >
              {link.label}
            </NavLink>
          </motion.li>
        ))}
      </ul>

      <div className="mt-14 space-y-2 text-[10px] uppercase tracking-[0.4em] text-crystal/40">
        <p>Connect • Create • Transcend</p>
      </div>
    </motion.div>
  );
}
