import React from "react";
import { useTranslation } from 'react-i18next';
import './DealsPage.css'; // Or your shared CSS file

function DealsPage() {
    const { t } = useTranslation();
    // Change this line to use https
    const externalShopperUrl = "https://shopper.tiendascapri.com/?utm_source=WebsiteTC&utm_medium=Direct&utm_id=Trafico%2B";

    const goBack = () => {
        window.history.back();
    };

    return (
        <div className="deals-page-layout">
            <header className="app-header">
                <button onClick={goBack} className="back-button-header">
                    &larr; {t('backButtonText', 'Back')}
                </button>
            </header>
            <div className="iframe-container">
                {/* This title is the "page name" for this iframe */}
                <iframe
                    src={externalShopperUrl} // This will now use the https URL
                    title={t('dealsPage.iframeTitle', 'Shopper Tiendas Capri')}
                    className="external-content-iframe"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                >
                    <p>{t('iframeNotSupported', 'Your browser does not support iframes or the content cannot be displayed.')}</p>
                </iframe>
            </div>
        </div>
    );
}

export default DealsPage;