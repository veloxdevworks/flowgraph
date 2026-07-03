import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

const el = document.getElementById("app");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <BrowserRouter basename="/flowgraph">
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}
