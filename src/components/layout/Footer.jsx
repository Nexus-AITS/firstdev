import { Link } from "react-router-dom";

const QUICK = [
  { to: "/", label: "HOME" },
  { to: "/events", label: "EVENTS" },
  { to: "/events/forge", label: "NEXUS REBUILDERS" },
  { to: "/events/paradox", label: "NEXUS OFF-GRID" },
  { to: "/events/arena", label: "THE ARENA" },
  { to: "/bundled", label: "BUNDLED" },
  { to: "/ai", label: "NEXUS AI" },
  { to: "/about", label: "ABOUT" },
];

export default function Footer() {
  return (
    <footer className="relative z-10 border-t border-white/5 bg-void/70 backdrop-blur-sm">
      <div className="mx-auto max-w-[1680px] px-5 py-14 md:px-10 md:py-16">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div>
            <Link to="/" className="inline-flex items-center gap-3" aria-label="NEXUS — home">
              <span
                aria-hidden
                className="h-2 w-2 rotate-45 bg-violet-bright shadow-[0_0_14px_rgba(168,85,247,0.9)]"
              />
              <span className="font-display text-xl tracking-[0.46em] text-crystal">NEXUS</span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-crystal/50">
              An event ecosystem disguised as a universe. Three realms, countless possibilities.
            </p>
          </div>

          <nav aria-label="Footer">
            <ul className="grid grid-cols-2 gap-x-10 gap-y-3 sm:grid-cols-3">
              {QUICK.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="text-[10px] uppercase tracking-[0.32em] text-crystal/50 transition-colors duration-300 hover:text-lavender hover:[text-shadow:0_0_14px_rgba(216,180,254,0.6)]"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="hairline my-10" aria-hidden />

        <div className="flex flex-col gap-4 text-[10px] uppercase tracking-[0.32em] text-crystal/35 md:flex-row md:items-center md:justify-between">
          <p>Connect • Create • Transcend</p>
          <p>© {new Date().getFullYear()} NEXUS — All realms reserved.</p>
        </div>

        <p className="mt-6 text-center text-[10px] uppercase tracking-[0.32em] text-crystal/35 md:text-left">
          Developed by Omprakash Chandragiri and Sai Sujith BV from CSIT Department
        </p>
      </div>
    </footer>
  );
}
