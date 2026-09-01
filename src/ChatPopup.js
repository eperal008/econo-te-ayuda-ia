// src/ChatPopup.js
import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import axios from "axios";
import capriLogo from "./logo.png";
import "./ChatPopup.css";

function ChatPopup({ onClose }) {
    const { t, i18n } = useTranslation();
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const messagesEndRef = useRef(null);
    const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

    // Add default message on popup open
    useEffect(() => {
        const welcomeMessage = {
            text: t("voice:Hello! How can I help you?", "Hello! How can I help you today?"),
            sender: "bot",
        };
        setMessages([welcomeMessage]);
    }, [i18n.language, t]);

    // Handle window resize for mobile/desktop detection
    useEffect(() => {
        const handleResize = () => {
            setIsMobile(window.innerWidth <= 768);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSend = async (e) => {
        e.preventDefault();
        if (!input.trim()) return;

        const userMessage = { text: input, sender: "user" };
        setMessages((prev) => [...prev, userMessage]);
        setInput("");

        try {
            const res = await axios.post("https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com/ask", {
                query: input,
                language: i18n.language,
            });
            const botMessage = { text: res.data.reply, sender: "bot" };
            setMessages((prev) => [...prev, botMessage]);
        } catch (error) {
            const errorMsg = i18n.language === "es" ? "Lo siento, algo salió mal." : "Sorry, something went wrong.";
            setMessages((prev) => [...prev, { text: errorMsg, sender: "bot" }]);
        }
    };

    // Function to process message text and highlight aisle names
    const renderMessageText = (text) => {
        // Use "Aisle" for English, "pasillo" for Spanish
        const aisleTerm = i18n.language === "es" ? "pasillo" : "Aisle";
        // Regex to match "Aisle X" or "pasillo X" (e.g., "Aisle 5", "pasillo 3A")
        const aisleRegex = new RegExp(`(${aisleTerm}\\s+[A-Za-z0-9]+)`, "g");
        // Split the text around aisle names and wrap them in a span
        const parts = text.split(aisleRegex);
        return parts.map((part, index) => {
            if (part.match(aisleRegex)) {
                return (
                    <span key={index} className="aisle-name">
                        {part}
                    </span>
                );
            }
            return part;
        });
    };

    return (
        <div className="chat-popup-overlay">
            <div className={`chat-popup ${isMobile ? "mobile" : "desktop"}`}>
                <div className="chat-header">
                    <img src={capriLogo} alt="Capri Logo" className="logo" />
                </div>
                <div className="chat-messages">
                    <div className="messages-header">
                        <span className="online-status">
                            <span className="status-dot"></span>
                            Yoly is online...
                        </span>
                        <button onClick={onClose} className="close-button">
                            ✕
                        </button>
                    </div>
                    {messages.map((msg, index) => (
                        <div key={index} className={`message ${msg.sender}`}>
                            <span>{renderMessageText(msg.text)}</span>
                        </div>
                    ))}
                    <div ref={messagesEndRef} />
                </div>
                <form className="chat-input" onSubmit={handleSend}>
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={t("inputPlaceholder", i18n.language === "es" ? "Escribe tu pregunta..." : "Type your question...")}
                    />
                    <button type="submit" className="send-button">
                        ➤
                    </button>
                </form>
            </div>
        </div>
    );
}

export default ChatPopup;