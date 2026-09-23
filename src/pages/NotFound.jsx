import Page from "../components/ui/Page.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import CrystalSigil from "../components/event/CrystalSigil.jsx";

export default function NotFound() {
  return (
    <Page>
      <section className="relative flex min-h-svh flex-col items-center justify-center px-6 text-center">
        <CrystalSigil variant="crystal" accent="violet" className="w-36 md:w-48" label="Unknown realm" />
        <p className="mt-8 text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70">Error // 404</p>
        <h1 className="mt-5 font-display text-[clamp(2.2rem,6vw,4.5rem)] tracking-[0.12em] text-crystal text-glow">
          REALM NOT FOUND
        </h1>
        <p className="mt-5 max-w-md text-sm leading-relaxed text-crystal/55">
          This coordinate doesn't exist in the Nexus. The crystal suggests you re-enter the gateway.
        </p>
        <div className="mt-10">
          <CinematicButton to="/">Return to gateway</CinematicButton>
        </div>
      </section>
    </Page>
  );
}
