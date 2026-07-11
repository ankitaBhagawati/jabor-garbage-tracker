import React, { useEffect, useRef, useState } from "react";

const RAZORPAY_PAYMENT_BUTTON_ID = import.meta.env.VITE_RAZORPAY_PAYMENT_BUTTON_ID || "pl_TCJCmGKqggc9D9";

export function RazorpayPaymentButton({ containerId = "razorpay-button-container", className = "jabor-razorpay-wrap" }) {
  const containerRef = useRef(null);
  const [showFallback, setShowFallback] = useState(false);
  const fallbackHref = `https://razorpay.com/payment-button/${RAZORPAY_PAYMENT_BUTTON_ID}/view`;

  // Inject Razorpay's payment button script manually - React doesn't execute
  // <script> tags placed directly in JSX, so we append it to the DOM ourselves.
  useEffect(() => {
    const container = containerRef.current || document.getElementById(containerId);
    if (!container || container.childElementCount > 0) return;
    setShowFallback(false);

    const form = document.createElement("form");
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/payment-button.js";
    script.async = true;
    script.setAttribute("data-payment_button_id", RAZORPAY_PAYMENT_BUTTON_ID);
    script.onerror = () => setShowFallback(true);
    form.appendChild(script);
    container.appendChild(form);

    const isRendered = () => Boolean(container.querySelector(".PaymentButton"));
    const fallbackTimer = window.setTimeout(() => {
      if (!isRendered()) setShowFallback(true);
    }, 3500);
    const pollTimer = window.setInterval(() => {
      if (isRendered()) {
        setShowFallback(false);
        window.clearInterval(pollTimer);
      }
    }, 500);

    return () => {
      window.clearTimeout(fallbackTimer);
      window.clearInterval(pollTimer);
    };
  }, [containerId]);

  return (
    <div id={containerId} ref={containerRef} className={className}>
      {showFallback && (
        <a className="razorpay-fallback-link" href={fallbackHref} target="_blank" rel="noopener noreferrer">
          Support Jabor
        </a>
      )}
    </div>
  );
}

export default function SupportJaborSection() {
  const [highlight, setHighlight] = useState(false);

  useEffect(() => {
    const handler = () => {
      setHighlight(true);
      window.setTimeout(() => setHighlight(false), 1600);
    };
    window.addEventListener("jabor:highlight-support", handler);
    return () => window.removeEventListener("jabor:highlight-support", handler);
  }, []);

  return (
    <section id="support-jabor" className="page-section" style={{ scrollMarginTop: 80 }}>
      <div className={`cta-panel${highlight ? " jabor-support-panel--on" : ""}`}>
        <h2 className="jabor-support-title">❤️ Support Jabor</h2>
        <p className="jabor-support-text">
          Jabor is a free civic-tech platform helping citizens report garbage
          across Assam. Your support helps cover hosting, AI processing, domain
          renewals, maintenance, and future improvements. Every contribution
          helps keep Jabor free for everyone.
        </p>

        <RazorpayPaymentButton />

        <p className="jabor-support-note">Secure payments powered by Razorpay.</p>
      </div>
    </section>
  );
}
