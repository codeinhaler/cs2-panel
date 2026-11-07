import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Play } from "./Play";
import "../styles.css";
import "./play.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Play />
  </StrictMode>,
);
