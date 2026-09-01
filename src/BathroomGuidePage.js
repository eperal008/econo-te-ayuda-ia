// src/BathroomGuidePage.js
import React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import "./BathroomGuidePage.css"; // Styles for this page

function BathroomGuidePage() {
    const { t } = useTranslation();

    return (
        <div className="bathroom-guide-page-simple">
            <div className="header-container-guide">
                <Link to="/" className="top-back-button">
                    <span className="arrow-icon">←</span> 
                    {t("bathroomGuidePage.topBackButtonText", "Back")} 
                </Link>
                <h1>{t("bathroomGuidePage.title", "Guide to the Bathroom")}</h1>
            </div>

            <div className="content-container-guide">
                <p>{t("bathroomGuidePage.description", "Restrooms Located at the entrance next to the service counter on the right side")}</p>
                <Link to="/" className="back-to-kiosk-button">
                    {t("bathroomGuidePage.backButton", "Back to Kiosk")}
                </Link>
            </div>
        </div>
    );
}

export default BathroomGuidePage;