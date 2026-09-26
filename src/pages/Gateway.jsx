import { Navigate, useSearchParams } from "react-router-dom";

/**
 * Legacy registration hand-off — kept so old links and docs stay alive.
 * Every `/gateway` URL now redirects straight into the `/register` wizard
 * (details → payment QR → UTR), preserving `?event=` / `?bundle=` context.
 */
export default function Gateway() {
  const [params] = useSearchParams();
  const qs = params.toString();
  return <Navigate to={qs ? `/register?${qs}` : "/register"} replace />;
}