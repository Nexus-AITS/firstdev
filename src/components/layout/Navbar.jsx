import { useEffect, useState } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { getLenis } from "../../lib/lenis";
import AuthControl from "../auth/AuthControl.jsx";
import MobileMenu from "./MobileMenu.jsx";

/* THE BAR ONLY APPEARS WHERE THE LINKS ACTUALLY FIT â€” and that threshold is
     measured, not guessed (scripts/verify-nav-fit.mjs asserts it at seven widths).

     Seven items at this type scale need about 1.25m of width. The list used to be
     shown from 768px with seven items, and even then it was already over the line
     by ~120px at 1024px â€” invisible only because App.jsx sets `overflow-x-hidden`
     on the page shell, so the browser CLIPPED the overflowing links instead of
     scrolling them into view. CONTACT was simply not on screen.

     Below the threshold this list is hidden and the hamburger takes over. The
     hamburger renders from these same LINKS, so every destination stays reachable
     at every width â€” including PROBLEM STATEMENTS.

     THE WIDTHS ARE WRITTEN OUT RATHER THAN INTERPOLATED. A first attempt built
     the class from a NAV_MIN_WIDTH constant, which is the obvious way to write it
     and is silently wrong: Tailwind extracts classes by scanning the source text,
     so `min-[1280px]:flex` â€” which appears nowhere once it is assembled at
     runtime â€” is never generated, and the bar stays hidden at every width. The
     constant below is the documented number the test asserts against, not the
     thing that builds the class. */
const NAV_MIN_WIDTH = 1280;

const LINKS = [
  { to: "/", label: "HOME" },
  { to: "/events", label: "EVENTS" },
  { to: "/bundled", label: "BUNDLED" },
  // Notices the team publishes: schedule changes, results. Real content from the
  // database, so it changes without a deploy.
  { to: "/announcements", label: "ANNOUNCEMENTS" },
  // What each event asks a team to build. In the header rather than only the
  // footer because the reader arrives looking for it BY EVENT, mid-research,
  // and the footer is the last place on the page anybody looks.
  { to: "/problem-statements", label: "PROBLEM STATEMENTS" },
  { to: "/about", label: "ABOUT" },
  // The channel list is a real page with a real route and real database content,
  // so it belongs beside the other public pages rather than buried in the footer.
  // MobileMenu renders from this same list, so it appears there too.
  { to: "/contact", label: "CONTACT" },
  /* NEXUS AI is deliberately NOT in the header. It is still a live page at /ai
     and still reachable from the footer and the mobile menu â€” this list drives
     both, so removing the line here removes it from the header only.

     It went because the bar had no room for it. Eight items do not fit below
     ~1300px at this type scale, and the shortfall was being hidden by
     overflow-x-hidden on the page shell, which clips overflowing links rather
     than scrolling them â€” so the tail of the bar was simply not on screen. */
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
            ? // fixed bar over the live hero: it re-blurs whatever animates
              // behind it on every frame â€” phones get the lighter sm blur,
              // md+ keeps the original 12px
              "border-b border-white/5 bg-void/70 backdrop-blur-sm md:backdrop-blur-md"
            : "border-b border-transparent bg-transparent",
        ].join(" ")}
      >
        <nav
          aria-label="Primary"
          className="mx-auto flex h-16 max-w-[1680px] items-center justify-between px-5 md:h-20 md:px-10"
        >
          <Link
            to="/"
            aria-label="NEXUS â€” home"
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

          <ul className="hidden items-center gap-7 min-[1280px]:flex lg:gap-11">
            {LINKS.map((link) => (
              <li key={link.to}>
                <NavLink
                  to={link.to}
                  end={link.to === "/"}
                  className={({ isActive }) =>
                    [
                      // whitespace-nowrap is load-bearing, not tidiness. Without it
                      // the last long label silently wraps to two lines and the bar
                      // looks broken instead of the layout reporting that it is too
                      // full â€” the header has a FIXED height, so a wrapped item is
                      // not absorbed, it just spills.
                      "relative block whitespace-nowrap py-2 text-[10px] font-medium uppercase tracking-[0.34em] transition-all duration-300 lg:text-[11px]",
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

          <div className="flex items-center gap-4 md:gap-6">
            <AuthControl />
            <button
              type="button"
              className="group flex h-11 w-11 flex-col items-center justify-center gap-1.5 min-[1280px]:hidden"
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
          </div>
        </nav>
      </header>

      <AnimatePresence>
        {menuOpen ? <MobileMenu links={LINKS} onClose={() => setMenuOpen(false)} /> : null}
      </AnimatePresence>
    </>
  );
}

