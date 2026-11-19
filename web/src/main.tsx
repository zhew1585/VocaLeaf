import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { autoHideScrollbars } from "./scrollbars";
import "./styles.css";

autoHideScrollbars();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
