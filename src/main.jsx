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
        <pre style={{ whiteSpace: "pre-wrap", padding: 24, fontFamily: "monospace" }}>
          {String(this.state.error?.stack || this.state.error)}
        </pre>
      );
    }

    return this.props.children;
  }
}

const root = ReactDOM.createRoot(document.getElementById("root"));

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
      <pre style={{ whiteSpace: "pre-wrap", padding: 24, fontFamily: "monospace" }}>
        {String(error?.stack || error)}
      </pre>
    );
  }
}

boot();
