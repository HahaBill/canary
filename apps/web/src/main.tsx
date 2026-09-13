import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import { startLiveRefresh } from "./api/useDerived.ts";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import "./index.css";

// The backend's demo clock advances a simulated day every real minute. This
// heartbeat re-fetches so the day appears on screen without anyone reloading —
// the dashboard is a live account, not a screenshot of one.
startLiveRefresh();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter future={{ v7_relativeSplatPath: true }}>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
