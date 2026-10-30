import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installPreloadRecovery } from "./ViewBoundary";
import { relayChatGPTSignIn } from "./chatgpt-return";
import "./styles.css";
import "./product.css";
if (window.teamswarmDesktop) document.documentElement.classList.add("desktop");
installPreloadRecovery();
relayChatGPTSignIn();
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
