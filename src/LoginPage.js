// src/LoginPage.js
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

function LoginPage({ onLogin }) {
    const { t } = useTranslation();
    const [password, setPassword] = useState("");

    const handleSubmit = (e) => {
        e.preventDefault();
        onLogin(password);
    };

    return (
        <div style={{ padding: "20px", textAlign: "center" }}>
            <h1>{t("login")}</h1>
            <form onSubmit={handleSubmit}>
                <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("password")}
                    style={{ padding: "5px", margin: "10px", width: "200px" }}
                />
                <button type="submit" style={{ padding: "5px 10px", backgroundColor: "#00aaff", color: "#fff", border: "none", borderRadius: "5px" }}>
                    {t("login")}
                </button>
            </form>
        </div>
    );
}

export default LoginPage;