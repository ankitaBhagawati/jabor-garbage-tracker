import React from "react";
import ReactDOM from "react-dom/client";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "sans-serif" }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Jabor could not start</h1>
          <p style={{ marginBottom: 12 }}>Please fix the startup error below and refresh the page.</p>
          <pre style={{ whiteSpace: "pre-wrap", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 8, padding: 12 }}>
            {this.state.error.message || String(this.state.error)}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

const root = ReactDOM.createRoot(document.getElementById("root"));

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(error => {
      console.warn("[Jabor] Service worker registration failed", error);
    });
  });
}

async function boot() {
  try {
    const { default: Jabor } = await import("../Jabor.jsx");
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <Jabor />
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (error) {
    root.render(
      <div style={{ padding: 24, fontFamily: "sans-serif" }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Jabor could not start</h1>
        <p style={{ marginBottom: 12 }}>Please fix the startup error below and refresh the page.</p>
        <pre style={{ whiteSpace: "pre-wrap", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 8, padding: 12 }}>
          {error.message || String(error)}
        </pre>
      </div>
    );
  }
}

boot();
registerServiceWorker();
