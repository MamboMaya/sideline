import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

// The recording-pill overlay window loads this same index.html with
// `?window=overlay` (see the `overlay` entry in src-tauri/tauri.conf.json,
// and its show/hide/position logic in src-tauri/src/window.rs). Branch
// BEFORE importing App so that window's bundle never pulls in — and never
// runs — App's notes/config loading; it gets the tiny Overlay root
// instead. Checked here, not in App.tsx, so there's no path by which App
// briefly mounts first.
const isOverlay =
  new URLSearchParams(window.location.search).get("window") === "overlay";
if (isOverlay) document.body.classList.add("overlay");

async function mount() {
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const Root = isOverlay
    ? (await import("./Overlay")).default
    : (await import("./App")).default;
  root.render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

mount();
