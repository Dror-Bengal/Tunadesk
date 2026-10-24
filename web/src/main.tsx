import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./i18n";
import { ToastProvider } from "./components/ui";
import { App } from "./App";
import "./styles.css";

// Theme preference: "system" | "light" | "dark" (system follows prefers-color-scheme).
try {
  const theme = localStorage.getItem("tunadesk.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  /* storage unavailable */
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
