import { Suspense, lazy } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import useSmoothScroll from "./hooks/useSmoothScroll";
import { AuthProvider } from "./context/AuthContext";
import { TransitionProvider } from "./context/TransitionContext";
import { RealmEntryProvider } from "./context/RealmEntryContext";
import Navbar from "./components/layout/Navbar.jsx";
import Footer from "./components/layout/Footer.jsx";
import ScrollManager from "./components/layout/ScrollManager.jsx";
import CustomCursor from "./components/cursor/CustomCursor.jsx";
import EnterNexusOverlay from "./components/transition/EnterNexusOverlay.jsx";
import RealmEntryOverlay from "./components/transition/RealmEntryOverlay.jsx";

// The landing page stays eager (instant first paint); every other route is
// split into its own chunk and loaded on demand through <Suspense>.
import Home from "./pages/Home.jsx";
const Events = lazy(() => import("./pages/Events.jsx"));
const Forge = lazy(() => import("./pages/Forge.jsx"));
const Paradox = lazy(() => import("./pages/Paradox.jsx"));
const Arena = lazy(() => import("./pages/Arena.jsx"));
const EventDetail = lazy(() => import("./pages/EventDetail.jsx"));
const Bundled = lazy(() => import("./pages/Bundled.jsx"));
const Admin = lazy(() => import("./pages/Admin.jsx"));
const Gateway = lazy(() => import("./pages/Gateway.jsx"));
const Register = lazy(() => import("./pages/Register.jsx"));
const AuthCallback = lazy(() => import("./pages/AuthCallback.jsx"));
const NexusAI = lazy(() => import("./pages/NexusAI.jsx"));
const About = lazy(() => import("./pages/About.jsx"));
const NotFound = lazy(() => import("./pages/NotFound.jsx"));

/** Minimal in-layout loader shown while a route chunk resolves. */
function RouteFallback() {
  return (
    <div aria-busy="true" className="flex min-h-[68vh] flex-1 items-center justify-center">
      <span className="sr-only">Loading realm…</span>
      <span
        aria-hidden
        className="anim-pulse h-3 w-3 rotate-45 bg-violet-bright shadow-[0_0_18px_rgba(168,85,247,0.95)]"
      />
    </div>
  );
}

export default function App() {
  const location = useLocation();
  useSmoothScroll();

  return (
    <AuthProvider>
    <TransitionProvider>
      <RealmEntryProvider>
        <div className="relative flex min-h-screen flex-col overflow-x-hidden bg-void">
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <CustomCursor />
        <Navbar />
        <ScrollManager />

        <Suspense fallback={<RouteFallback />}>
          <AnimatePresence mode="wait" initial={false}>
            <Routes location={location} key={location.pathname}>
              <Route path="/" element={<Home />} />
              <Route path="/events" element={<Events />} />
              <Route path="/events/forge" element={<Forge />} />
              <Route path="/events/paradox" element={<Paradox />} />
              <Route path="/events/arena" element={<Arena />} />
              <Route path="/events/:eventId" element={<EventDetail />} />
              <Route path="/bundled" element={<Bundled />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/gateway" element={<Gateway />} />
              <Route path="/register" element={<Register />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/ai" element={<NexusAI />} />
              <Route path="/about" element={<About />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AnimatePresence>
        </Suspense>

        <Footer />
        <EnterNexusOverlay />
        <RealmEntryOverlay />
      </div>
      </RealmEntryProvider>
    </TransitionProvider>
    </AuthProvider>
  );
}
