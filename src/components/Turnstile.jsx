import { useEffect, useRef } from "react";

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";
let scriptPromise = null;

function loadTurnstile() {
  scriptPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Could not load the human check."));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// Cloudflare Turnstile human check. Tokens are single-use: remount (change `key`) after each submit.
export default function Turnstile({ onToken }) {
  const ref = useRef(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let widgetId;
    let cancelled = false;
    const emit = token => onTokenRef.current?.(token);
    loadTurnstile()
      .then(turnstile => {
        if (cancelled || !ref.current) return;
        widgetId = turnstile.render(ref.current, {
          sitekey: SITE_KEY,
          callback: emit,
          "expired-callback": () => emit(""),
          "error-callback": () => emit(""),
        });
      })
      .catch(() => emit(""));
    return () => {
      cancelled = true;
      if (widgetId !== undefined) window.turnstile?.remove(widgetId);
    };
  }, []);

  return <div ref={ref} style={{ margin: "10px 0", minHeight: 65 }} />;
}
