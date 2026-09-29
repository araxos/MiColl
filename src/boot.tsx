/** The actual app. main.tsx loads this after the splash is visible. */
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { DataProvider } from "@/store";
import { ActionsProvider } from "@/actions";
import { PopoutViewer } from "@/components/PopoutViewer";
import "./index.css";
// fonts for the premium themes (Orbitron = cyberpunk, Zen Maru Gothic = sakura,
// Exo 2 = base font). Only latin subsets to keep the bundle small.
import "@fontsource/orbitron/500.css";
import "@fontsource/orbitron/700.css";
import "@fontsource/zen-maru-gothic/latin-400.css";
import "@fontsource/zen-maru-gothic/latin-500.css";
import "@fontsource/zen-maru-gothic/latin-700.css";
import "@fontsource/exo-2/400.css";
import "@fontsource/exo-2/500.css";
import "@fontsource/exo-2/600.css";
import "@fontsource/exo-2/700.css";
// Unbounded (iridescent) is loaded in index.css, one weight lighter
import { applyAccent, getAccent } from "@/lib/theme";
import { applyGlassButtons } from "@/lib/glassButtons";
import { applyTemplateFont } from "@/lib/templateFont";
import { applyDocumentLang } from "@/lib/i18n";

// apply the saved accent before the first paint (no color flash)
applyAccent(getAccent());
// same for the frosted buttons flag
applyGlassButtons();
// same for the template font
applyTemplateFont();
// set <html lang> early too (screen readers, spell check)
applyDocumentLang();

// pop-out window (?popout=<id>) only shows the viewer, no app chrome and no lock logic
const popoutId = new URLSearchParams(window.location.search).get("popout");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      {popoutId ? (
        <DataProvider>
          <ActionsProvider>
            <PopoutViewer id={popoutId} />
          </ActionsProvider>
        </DataProvider>
      ) : (
        <App />
      )}
    </BrowserRouter>
  </React.StrictMode>,
);
