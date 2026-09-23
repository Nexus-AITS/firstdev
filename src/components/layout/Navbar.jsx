import { useEffect, useState } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { getLenis } from "../../lib/lenis";
import MobileMenu from "./MobileMenu.jsx";

const LINKS = [
  { to: "/", label: "HOME" },
  { to: "/events", label: "EVENTS" },
  { to: "/ai", label: "NEXUS AI" },
  { to: "/about", label: "ABOUT" },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        setScrolled(window.scrollY > 24);
        ticking = false;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the mobile menu on navigation; pause Lenis while it is open.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const lenis = getLenis();
    if (!lenis) return undefined;
    if (menuOpen) lenis.stop();
    else lenis.start();
    return () => lenis.start();
  }, [menuOpen]);

  return (
    <>
      <header
        className={[
          "fixed inset-x-0 top-0 z-40 transition-colors duration-500",
          scrolled
            ? "border-b border-white/5 bg-void/55 backdrop-blur-xl"
            : "border-b border-transparent bg-transparent",
        ].join(" ")}
      >
        <nav
          aria-label="Primary"
          className="mx-auto flex h-16 max-w-[1680px] items-center justify-between px-5 md:h-20 md:px-10"
        >
          <Link
            to="/"
            aria-label="NEXUS — home"
            className="group flex items-center gap-3"
            data-cursor="home"
          >
            <span
              aria-hidden
              className="h-2 w-2 rotate-45 bg-violet-bright shadow-[0_0_14px_rgba(168,85,247,0.9)] transition-transform duration-500 group-hover:rotate-[225deg]"
            />
            <span className="font-display text-lg font-medium tracking-[0.46em] text-crystal text-glow-soft md:text-xl">
              NEXUS
            </span>
          </Link>

          <ul className="hidden items-center gap-9 md:flex lg:gap-12">
            {LINKS.map((link) => (
              <li key={link.to}>
                <NavLink
                  to={link.to}
                  end={link.to === "/"}
                  className={({ isActive }) =>
                    [
                      "relative block py-2 text-[10px] font-medium uppercase tracking-[0.34em] transition-all duration-300 lg:text-[11px]",
                      isActive
                        ? "text-crystal [text-shadow:0_0_18px_rgba(168,85,247,0.85)]"
                        : "text-crystal/55 hover:text-crystal hover:[text-shadow:0_0_16px_rgba(168,85,247,0.7)]",
                    ].join(" ")
                  }
                >
                  {({ isActive }) => (
                    <>
                      {link.label}
                      <span
                        aria-hidden
                        className={[
                          "absolute -bottom-0.5 left-1/2 h-px -translate-x-1/2 bg-lavender transition-all duration-400",
                          isActive ? "w-4 opacity-100" : "w-0 opacity-0",
                        ].join(" ")}
                      />
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="group flex h-11 w-11 flex-col items-center justify-center gap-1.5 md:hidden"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="nexus-mobile-menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span
              className={[
                "h-px w-6 bg-crystal transition-transform duration-300",
                menuOpen ? "translate-y-[3.5px] rotate-45" : "",
              ].join(" ")}
            />
            <span
              className={[
                "h-px w-6 bg-crystal transition-transform duration-300",
                menuOpen ? "-translate-y-[3.5px] -rotate-45" : "",
              ].join(" ")}
            />
          </button>
        </nav>
      </header>

      <AnimatePresence>
        {menuOpen ? <MobileMenu links={LINKS} onClose={() => setMenuOpen(false)} /> : null}
      </AnimatePresence>
    </>
  );
}
