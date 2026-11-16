import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { flushUiState, useUiStateStore } from "./stores/uiState";
import { markPlatform } from "./lib/platform";
import "./index.css";

markPlatform();

// Panels read their saved sizes when they mount, so load UI state first.
// load() always resolves (it gives up after a short timeout).
void useUiStateStore
  .getState()
  .load()
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });

window.addEventListener("pagehide", flushUiState);
