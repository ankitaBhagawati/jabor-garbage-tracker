import React, { useEffect, useState } from "react";

export function RazorpayPaymentButton({ containerId = "razorpay-button-container", className = "jabor-razorpay-wrap" }) {
  // Inject Razorpay's payment button script manually - React doesn't execute
  // <script> tags placed directly in JSX, so we append it to the DOM ourselves.
  useEffect(() => {
    const container = document.getElementById(containerId);
    if (!container || container.childElementCount > 0) return;
    const form = document.createElement("form");
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/payment-button.js";
    script.async = true;
    script.setAttribute("data-payment_button_id", "pl_TCJCmGKqggc9D9");
    form.appendChild(script);
    container.appendChild(form);
  }, [containerId]);

  return <div id={containerId} className={className}></div>;
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
