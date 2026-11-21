import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { flushUiState, useUiStateStore } from "./stores/uiState";
import { flushTabs, hydrateTabs } from "./stores/tabs";
import { markPlatform } from "./lib/platform";
import "./index.css";

markPlatform();

// Panels read their saved sizes when they mount, so load UI state first; the
// open tabs are restored from it too. load() always resolves (it gives up
// after a short timeout).
void useUiStateStore
  .getState()
  .load()
  .then(hydrateTabs)
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });

const flushAll = () => {
  flushUiState();
  flushTabs();
};
window.addEventListener("pagehide", flushAll);
window.addEventListener("beforeunload", flushAll);
