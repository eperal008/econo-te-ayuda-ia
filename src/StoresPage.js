import React from "react";
import { useTranslation } from 'react-i18next';
// Assuming you have a shared CSS file, e.g., DealsPage.css or a more generic one like App.css
// import './DealsPage.css'; // Or './SharedLayout.css' or './App.css'

function StoresPage() {
    const { t } = useTranslation();
    const storesUrl = "https://tiendascapri.com/tiendas/";

    const goBack = () => {
        window.history.back();
    };

    return (
        // Use shared layout class names for consistency
        <div className="deals-page-layout"> {/* Or a generic name like "page-layout-with-iframe" */}
            <header className="app-header">
                <button onClick={goBack} className="back-button-header">
                    &larr; {t('backButtonText', 'Back')}
                </button>
            </header>
            <div className="iframe-container">
                {/* This title is the "page name" for this iframe */}
                <iframe
                    src={storesUrl}
                    title={t('storesPage.iframeTitle', 'Find Our Stores')}
                    className="external-content-iframe"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                >
                    <p>{t('iframeNotSupported', 'Your browser does not support iframes or the content cannot be displayed.')}</p>
                </iframe>
            </div>
        </div>
    );
}

export default StoresPage;