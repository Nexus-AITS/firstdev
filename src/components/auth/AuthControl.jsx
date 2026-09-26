import { useAuth } from "../../context/AuthContext";
import GoogleSignIn from "./GoogleSignIn.jsx";
import ProfileChip from "./ProfileChip.jsx";

/**
 * Navbar-sized auth slot — picks the right surface for the session state.
 *
 * Renders nothing at all when the deployment has no Supabase credentials, so
 * an unconfigured NEXUS is identical to the pre-auth site.
 *
 * While the stored session resolves it holds the space with a pulsing diamond
 * (the same loader used for route chunks) instead of swapping SIGN IN for the
 * profile chip a frame later.
 */
export default function AuthControl({ className = "" }) {
  const { configured, signedIn, status } = useAuth();

  if (!configured) return null;

  if (status === "loading") {
    return (
      <span aria-hidden className={`flex h-8 w-8 items-center justify-center ${className}`}>
        <span className="anim-pulse h-2.5 w-2.5 rotate-45 bg-violet-bright/80 shadow-[0_0_14px_rgba(168,85,247,0.9)]" />
      </span>
    );
  }

  return signedIn ? (
    <ProfileChip className={className} />
  ) : (
    <GoogleSignIn variant="inline" className={className} />
  );
}
