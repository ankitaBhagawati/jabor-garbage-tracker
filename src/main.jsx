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
          <p>Please refresh the page or try again later.</p>
        </div>
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
      <div style={{ padding: 24, fontFamily: "sans-serif" }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Jabor could not start</h1>
        <p>Please refresh the page or try again later.</p>
      </div>
    );
  }
}

boot();
