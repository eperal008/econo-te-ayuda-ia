import React from "react";
// Placeholder Econo "Te Ayuda IA" wordmark. Swap for the official logo asset
// (drop an econo-logo.svg/png in src/ and import it) when the customer provides it.
export default function EconoLogo({ variant = "onRed", showTagline = true }) {
  return (
    <div className={`econo-logo econo-logo--${variant}`}>
      <div className="econo-wordmark" aria-label="ECONO">
        <span className="econo-word">ECONO</span>
      </div>
      {showTagline && (
        <div className="econo-tagline">
          <span className="econo-te-ayuda">TE AYUDA</span>
          <span className="econo-ia-bubble">
            IA<span className="econo-spark">✦</span>
          </span>
        </div>
      )}
    </div>
  );
}
