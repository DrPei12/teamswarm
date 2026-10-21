import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./product.css";
if (window.teamswarmDesktop) document.documentElement.classList.add("desktop");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
import "./integration.css";
import "./visuals.css";
import "./conversation.css";
import "./design-system/tokens.css";
import "./design-system/workspace.css";
