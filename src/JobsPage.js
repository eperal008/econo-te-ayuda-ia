import React from "react";
import { useTranslation } from 'react-i18next';
import './JobsPage.css'; // Or your shared CSS file

function JobsPage() {
    const { t } = useTranslation();
    const jobsUrl = "https://tiendascapri.com/empleos/";

    const goBack = () => {
        window.history.back();
    };

    return (
        <div className="jobs-page-layout">
            <header className="app-header-jobs">
                <button onClick={goBack} className="back-button-header-jobs">
                    &larr; {t('backButtonText', 'Back')}
                </button>
            </header>
            <div className="iframe-container-jobs">
                {/* This title is the "page name" for this iframe */}
                <iframe
                    src={jobsUrl}
                    title={t('jobsPage.iframeTitle', 'Tiendas Capri Jobs')}
                    className="external-content-iframe-jobs"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                >
                    <p>{t('iframeNotSupported', 'Your browser does not support iframes or the content cannot be displayed.')}</p>
                </iframe>
            </div>
        </div>
    );
}

export default JobsPage;