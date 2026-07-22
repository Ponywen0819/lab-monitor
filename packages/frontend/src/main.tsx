import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { WsProvider } from "./ws/WsProvider";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <WsProvider>
        <App />
      </WsProvider>
    </BrowserRouter>
  </StrictMode>
);
