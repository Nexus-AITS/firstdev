import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
// Webfont @font-face first so the declarations ship inside the one stylesheet
// the app already blocks on (no separate render-blocking request to
// fonts.googleapis.com — see src/fonts.css for the measurement).
import "./fonts.css";
import "./index.css";

// Opt out of browser scroll restoration: it races Lenis on reload (native
// jump vs. Lenis' virtual position) which reads as a stuck/jerky home page.
// The router's ScrollManager owns scroll position from here on.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
