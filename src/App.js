import React, { useState, useEffect, useCallback, useRef } from "react";
import { FaTag, FaMicrophone, FaStopCircle, FaShoppingCart, FaEye, FaBriefcase, FaStore, FaRestroom, FaSearch, FaBookOpen } from "react-icons/fa";
import { useTranslation } from "react-i18next";
import { BrowserRouter as Router, Route, Link, Routes, Navigate } from "react-router-dom";
import axios from "axios";
import VoiceVisualizer from './VoiceVisualizer';
import DealsPage from "./DealsPage";
import VisionPage from "./VisionPage";
import LoginPage from "./LoginPage";
import Admin from "./Admin";
import ChatPopup from "./ChatPopup";
import BathroomGuidePage from "./BathroomGuidePage";
import JobsPage from './JobsPage';
import StoresPage from './StoresPage';
import VoiceAndChatSearchPage from './VoiceAndChatSearchPage';
import RecipesPage from './RecipesPage';
import capriLogo from "./logo.png";
import "./App.css";

const API_BASE_URL = "https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com";
const WS_STREAM_URL = "wss://your-store-kiosk-api-68f3020ca2d6.herokuapp.com/stream-audio";

// ErrorBoundary and GridButton components remain the same...
class ErrorBoundary extends React.Component {
    state = { hasError: false, error: null };
    static getDerivedStateFromError(error) { return { hasError: true, error }; }
    componentDidCatch(error, errorInfo) { console.error("Uncaught error:", error, errorInfo); }
    render() {
        if (this.state.hasError) {
            return (
                <div style={{ padding: "20px", color: "yellow", backgroundColor: "#d32f2f", minHeight: "100vh", textAlign: "center", fontSize: "1.2em" }}>
                    <h1>Oops! Something went wrong.</h1>
                    <p>{this.state.error?.message || "An unknown error occurred."}</p>
                    <button onClick={() => window.location.reload()} style={{ padding: '10px 20px', fontSize: '1em', marginTop: '20px', cursor: 'pointer', background: 'white', color: '#d32f2f', border: 'none', borderRadius: '10px', fontWeight: 'bold' }}>Refresh Page</button>
                </div>
            );
        }
        return this.props.children;
    }
}
const GridButton = React.memo(({ to, icon: Icon, labelKey, isInternal = true, className = "", tFunction }) => {
    const label = typeof tFunction === 'function' ? tFunction(labelKey) : labelKey;
    const commonProps = {
        className: `grid-button ${className}`.trim(),
        children: ( <><Icon className="grid-button-icon" /><span className="grid-button-text">{label}</span></> )
    };
    if (isInternal) return <Link to={to} {...commonProps} />;
    else return <a href={to} target="_blank" rel="noopener noreferrer" {...commonProps} />;
});


// ... (imports and other components remain the same)

function App() {
    const { t, i18n } = useTranslation();
    // ... (state and ref definitions remain the same)
    const [isRecording, setIsRecording] = useState(false);
    const [isProcessingSTT, setIsProcessingSTT] = useState(false);
    const [isProcessingLLM, setIsProcessingLLM] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [response, setResponse] = useState("");
    const [conversationHistory, setConversationHistory] = useState([]);
    const [error, setError] = useState("");
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [websocketStatus, setWebsocketStatus] = useState("disconnected");
    const [hasMadeFirstInteraction, setHasMadeFirstInteraction] = useState(false);
    const [productDisplayInfo, setProductDisplayInfo] = useState(null);
    const [typedQuery, setTypedQuery] = useState("");

    const mediaRecorderRef = useRef(null);
    const audioContextRef = useRef(null);
    const analyserRef = useRef(null);
    const streamRef = useRef(null);
    const isMountedRef = useRef(true);
    const socketRef = useRef(null);
    const finalTranscriptForQueryRef = useRef("");
    const webSocketConnectionPromiseRef = useRef(null);
    const audioPlaybackRef = useRef(null);

    const interruptAndResetAudio = useCallback(() => { /* ... */ }, []);

    // ensureMediaDeviceInitialized remains largely the same as the last version
    const ensureMediaDeviceInitialized = useCallback(async () => {
        if (!isMountedRef.current) return false;
        console.log("App: Ensuring media device initialized...");

        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
            mediaRecorderRef.current.stop();
        }
        mediaRecorderRef.current = null;

        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            try { await audioContextRef.current.close(); } catch (e) { console.warn("App: Error closing existing AudioContext:", e); }
            audioContextRef.current = null;
        }

        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error("Media devices API not supported.");
            }
            const audioConstraints = { audio: { noiseSuppression: true, echoCancellation: true } };
            const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
            if (!isMountedRef.current) {
                stream?.getTracks().forEach(track => track.stop()); return false;
            }
            streamRef.current = stream;

            const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
            let selectedMimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
            if (!selectedMimeType) throw new Error("No supported MIME type found for MediaRecorder.");
            
            const options = { mimeType: selectedMimeType, audioBitsPerSecond: 128000 };
            mediaRecorderRef.current = new MediaRecorder(streamRef.current, options);

            if (streamRef.current?.active) {
                audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
                if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();
                analyserRef.current = audioContextRef.current.createAnalyser();
                const source = audioContextRef.current.createMediaStreamSource(streamRef.current);
                source.connect(analyserRef.current);
                analyserRef.current.fftSize = 2048;
            }
            console.log("App: Media device initialized successfully.");
            setError(""); 
            return true;
        } catch (e) {
            console.error("App: Error initializing media device:", e);
            if (isMountedRef.current) setError(t("micAccessError", { message: e.message }));
            if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
            mediaRecorderRef.current = null;
            if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
                try {await audioContextRef.current.close();} catch(err){/*ignore*/}
                audioContextRef.current = null;
            }
            return false;
        }
    }, [t]);

    // **MODIFIED stopRecordingAndReleaseMic to be stable**
    const stopRecordingAndReleaseMic = useCallback(() => {
        console.log("App: stopRecordingAndReleaseMic called.");
        if (isMountedRef.current) {
            setIsRecording(false); // Primary action: update recording state
        }

        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
            console.log("App: Stopping MediaRecorder in stopRecordingAndReleaseMic.");
            try {
                mediaRecorderRef.current.stop();
            } catch (e) {
                console.error("App: Error stopping MediaRecorder:", e);
            }
        }
        mediaRecorderRef.current = null;

        if (streamRef.current) {
            console.log("App: Stopping microphone stream tracks in stopRecordingAndReleaseMic.");
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }

        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close()
                .then(() => {
                    console.log("App: AudioContext closed in stopRecordingAndReleaseMic.");
                    audioContextRef.current = null;
                })
                .catch(e => {
                    console.warn("App: Error closing AudioContext in stopRecordingAndReleaseMic:", e);
                    audioContextRef.current = null;
                });
        } else if (audioContextRef.current) { // Already closed but ref exists
            audioContextRef.current = null;
        }
    }, [setIsRecording]); // Depends only on stable setIsRecording setter

    const speakResponse = useCallback(async (text) => { /* ... same ... */ 
        interruptAndResetAudio();
        if (!isMountedRef.current) return;
        const resetSpeakingStates = () => {
            if (isMountedRef.current) {
                setIsSpeaking(false);
                setIsProcessingLLM(false);
            }
        };
        if (!text || text.trim() === "") {
            resetSpeakingStates();
            return;
        }
        if (isMountedRef.current) setIsSpeaking(true);
        try {
            const res = await axios.post(`${API_BASE_URL}/text-to-speech`, { text, language: i18n.language });
            if (!isMountedRef.current) { resetSpeakingStates(); return; }
            const { audio, format } = res.data;
            if (!audio || !format) throw new Error("Invalid TTS response format");
            const audioUrl = `data:audio/${format};base64,${audio}`;
            const audioElement = new Audio(audioUrl);
            audioPlaybackRef.current = audioElement;
            audioElement.onended = () => {
                audioPlaybackRef.current = null;
                resetSpeakingStates();
            };
            audioElement.onerror = (e) => {
                console.error("TTS Playback Error:", e);
                audioPlaybackRef.current = null;
                if (isMountedRef.current) setError(t('ttsPlaybackError'));
                resetSpeakingStates();
            };
            await audioElement.play();
        } catch (error) {
            console.error("TTS API/Processing Error:", error);
            audioPlaybackRef.current = null;
            if (isMountedRef.current) setError(t('ttsApiError'));
            resetSpeakingStates();
        }
    }, [i18n.language, t, interruptAndResetAudio]);
    const handleQuery = useCallback(async (queryText) => { /* ... same ... */
        interruptAndResetAudio();
        if (!isMountedRef.current || !queryText || queryText.trim() === "") {
            if (isMountedRef.current) {
                setIsProcessingLLM(false);
                if (response === t('thinking')) setResponse("");
                setError(t('noSpeechDetected'));
                setProductDisplayInfo(null);
            }
            return;
        }
        if (isProcessingLLM || isSpeaking) {
            return;
        }
        if (isMountedRef.current) {
            setIsProcessingLLM(true);
            setError("");
            setResponse(t('thinking'));
            setProductDisplayInfo(null);
        }
        try {
            const res = await axios.post(`${API_BASE_URL}/ask`, {
                query: queryText,
                language: i18n.language,
                conversationHistory: conversationHistory // Pass the current history
            });
            
            if (!isMountedRef.current) {
                setIsProcessingLLM(false);
                return;
            }

            // Now, get the updated history from the response
            const newHistory = res.data.conversationHistory;
            if (isMountedRef.current && Array.isArray(newHistory)) {
                setConversationHistory(newHistory); // Save the updated history for the next turn
            }
            
            const reply = res.data.reply;
            const products = res.data.products;
            let newProductDisplayInfo = null;
            if (products && products.length > 0) {
                const firstProduct = products[0];
                let descriptiveLocation = "";
                if (firstProduct.loc_main_entrance_localized && firstProduct.loc_main_entrance_localized.trim() !== "") {
                    descriptiveLocation = firstProduct.loc_main_entrance_localized;
                } else if (firstProduct.loc_rear_entrance_localized && firstProduct.loc_rear_entrance_localized.trim() !== "") {
                    descriptiveLocation = firstProduct.loc_rear_entrance_localized;
                }
                newProductDisplayInfo = {
                    name_en: firstProduct.name_en,
                    name_es: firstProduct.name_es,
                    aisle: firstProduct.aisle,
                    side: firstProduct.side,
                    part_en: firstProduct.shelf_area_en,
                    part_es: firstProduct.shelf_area_es,
                    locationDetail_en: firstProduct.loc_main_entrance_en,
                    locationDetail_es: firstProduct.loc_main_entrance_es,
                    adOfferText_en: firstProduct.ad_offer_text_en,
                    adOfferText_es: firstProduct.ad_offer_text_es,
                    adOfferImageUrl: firstProduct.ad_offer_image_url
                };
            }
            if (isMountedRef.current) {
                setProductDisplayInfo(newProductDisplayInfo);
            }
            if (!reply || reply.trim() === "") {
                if (isMountedRef.current) setResponse(t('noAnswerFound'));
                speakResponse(t('noAnswerFound'));
            } else {
                if (isMountedRef.current) setResponse(reply);
                speakResponse(reply);
            }
        } catch (error) {
            console.error("BUG_DEBUG: handleQuery /ask call FAILED", error);
            if (!isMountedRef.current) return;
            let errText = t('aiError');
            if (error.response) errText = error.response.data?.reply || error.response.data?.error || errText;
            else if (error.request) errText = t('networkError');
            else errText = t('genericError');
            setError(errText);
            if (isMountedRef.current) setResponse("");
            setProductDisplayInfo(null);
            speakResponse(errText);
        }
    }, [i18n.language, speakResponse, t, response, interruptAndResetAudio, isProcessingLLM, isSpeaking]);
    const closeWebSocket = useCallback(() => { /* ... same ... */ 
        if (socketRef.current) {
            if (isMountedRef.current) setWebsocketStatus("closing");
            socketRef.current.onopen = null;
            socketRef.current.onmessage = null;
            socketRef.current.onerror = null;
            socketRef.current.onclose = null;
            if (socketRef.current.readyState === WebSocket.OPEN || socketRef.current.readyState === WebSocket.CONNECTING) {
                socketRef.current.close(1000, "Client initiated close");
            }
            socketRef.current = null;
        }
        webSocketConnectionPromiseRef.current = null;
        if (isMountedRef.current) {
            setWebsocketStatus("disconnected");
        }
    }, []);

    const setupWebSocket = useCallback(() => {
        if (webSocketConnectionPromiseRef.current) return webSocketConnectionPromiseRef.current;
        webSocketConnectionPromiseRef.current = new Promise((resolve, reject) => {
            // ... (previous setupWebSocket logic)
            // Ensure calls to stopRecording use stopRecordingAndReleaseMic if an error means full stop
             if (socketRef.current && socketRef.current.readyState !== WebSocket.OPEN) {
                closeWebSocket();
                webSocketConnectionPromiseRef.current = null;
                reject(new Error("Stale WebSocket connection found and closed. Please retry."));
                return;
            }
            if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify({ type: 'config', language: i18n.language }));
                if (isMountedRef.current) setWebsocketStatus("connected");
                resolve();
                return;
            }
            if (isMountedRef.current) setWebsocketStatus("connecting");
            let tempSocket;
            try {
                tempSocket = new WebSocket(WS_STREAM_URL);
            } catch (e) {
                if (isMountedRef.current) { setError(t('networkError', "Failed to initiate connection.")); setWebsocketStatus("error"); }
                webSocketConnectionPromiseRef.current = null;
                reject(e); return;
            }
            socketRef.current = tempSocket;
            finalTranscriptForQueryRef.current = "";
            tempSocket.onopen = () => {
                if (!isMountedRef.current) {
                    if (webSocketConnectionPromiseRef.current) webSocketConnectionPromiseRef.current = null;
                    tempSocket.close(); return;
                }
                if (isMountedRef.current) setWebsocketStatus("connected");
                tempSocket.send(JSON.stringify({ type: 'config', language: i18n.language }));
                if (typeof resolve === 'function') resolve();
            };
            tempSocket.onpong = () => console.log("Received pong from server.");
            tempSocket.onmessage = (event) => {
                if (!isMountedRef.current) return;
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'interim_transcript') {
                        if (isMountedRef.current) setResponse(finalTranscriptForQueryRef.current + data.transcript);
                    } else if (data.type === 'final_transcript') {
                        const receivedTranscript = data.transcript;
                        finalTranscriptForQueryRef.current += receivedTranscript.trim() + " ";
                        if (isMountedRef.current) setResponse(finalTranscriptForQueryRef.current.trim());
                    } else if (data.type === 'error') { // STT service error
                        if (isMountedRef.current) {
                            setError(data.message || t('sttError'));
                            setIsProcessingSTT(false);
                            // Don't release mic here, just mark STT as not processing.
                            // The recording might still be active if user wants to stop it manually.
                            // If isRecording is true, user should stop it.
                            // If user already stopped, this is just an error for that ended session.
                            if(isRecording) {
                                // This implies STT failed mid-recording. We might want to stop and release.
                                console.warn("App: STT error received while recording. Stopping and releasing mic.");
                                stopRecordingAndReleaseMic();
                            }
                        }
                    }
                } catch (e) { console.error("Error parsing WebSocket message:", e, "Raw data:", event.data); }
            };
            tempSocket.onerror = (errorEvent) => { // WebSocket connection error
                console.error("App: WebSocket error", errorEvent)
                if (isMountedRef.current) {
                    if (!error) setError(t('networkError', "Voice connection error."));
                    setResponse(""); setProductDisplayInfo(null);
                    // If recording was active when WS errored, stop and release everything.
                    if(isRecording) {
                        stopRecordingAndReleaseMic();
                    } else {
                        // If not recording, just ensure STT state is false.
                        setIsProcessingSTT(false);
                    }
                }
                if (socketRef.current === tempSocket) socketRef.current = null;
                webSocketConnectionPromiseRef.current = null;
                reject(errorEvent);
            };
            tempSocket.onclose = (event) => { // WebSocket closed
                const currentError_onClose = error; 
                const currentIsLLM_onClose = isProcessingLLM;
                const currentIsSpk_onClose = isSpeaking;

                if (socketRef.current === tempSocket) {
                    socketRef.current = null;
                    webSocketConnectionPromiseRef.current = null;
                }
                console.log(`App: WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`);
                if (isMountedRef.current) {
                    setWebsocketStatus("disconnected");
                    setIsProcessingSTT(false); // STT for this socket is done.

                    // If isRecording is still true here, it means WS closed unexpectedly mid-recording.
                    // This is an abnormal state. We should probably stop and release the mic.
                    if (isRecording) {
                        console.warn("App: WebSocket closed while still in recording state. Stopping and releasing mic.");
                        stopRecordingAndReleaseMic(); // This will set isRecording to false.
                        if (!currentError_onClose) setError(t('sttConnectionError', 'Voice connection lost unexpectedly.'));
                        return; // Avoid further processing below if we forced a stop.
                    }

                    const finalTranscript = finalTranscriptForQueryRef.current.trim();
                    if (event.code === 1006) { 
                        if (!currentError_onClose) setError(t('sttConnectionError', 'Voice connection lost.'));
                        setResponse(""); setProductDisplayInfo(null);
                    } else if (finalTranscript.length > 0) {
                        if (!currentError_onClose && !currentIsLLM_onClose && !currentIsSpk_onClose) {
                            handleQuery(finalTranscript);
                        } else {
                            setResponse(finalTranscript); 
                        }
                    } else { 
                        if (!currentError_onClose && !currentIsLLM_onClose && !currentIsSpk_onClose) {
                            setError(t('noSpeechDetected'));
                            setResponse(""); setProductDisplayInfo(null);
                        }
                    }
                }
            };
        });
        return webSocketConnectionPromiseRef.current;
    }, [i18n.language, t, closeWebSocket, handleQuery, error, isProcessingLLM, isSpeaking, isRecording, response, stopRecordingAndReleaseMic, setIsProcessingSTT, setError, setResponse, setProductDisplayInfo, setWebsocketStatus]);


    const startRecording = useCallback(async (retryCount = 0, maxRetries = 3) => {
        interruptAndResetAudio();
        if (!isMountedRef.current) return;

        if (isProcessingSTT || isProcessingLLM || isSpeaking) {
            console.warn("App: startRecording called while busy, returning.");
            return;
        }
        console.log("App: Attempting to start recording...");
        const mediaInitialized = await ensureMediaDeviceInitialized();
        if (!mediaInitialized || !mediaRecorderRef.current) {
            console.error("App: Media device initialization failed before starting recording.");
            if (isMountedRef.current && !error) { setError(t('recorderNotReady')); }
            return;
        }
        
        if (mediaRecorderRef.current.state === "inactive") {
            if (socketRef.current && (socketRef.current.readyState === WebSocket.CLOSING || socketRef.current.readyState === WebSocket.CLOSED)) {
                closeWebSocket();
            }
            webSocketConnectionPromiseRef.current = null;

            if (isMountedRef.current) {
                // setError(""); // Done in ensureMediaDeviceInitialized
                setResponse(t('listening'));
                setIsProcessingSTT(true);
                setProductDisplayInfo(null);
            }
            finalTranscriptForQueryRef.current = "";
            try {
                await setupWebSocket();
            } catch (e_ws) {
                console.error("App: WebSocket setup failed in startRecording.", e_ws);
                if (retryCount < maxRetries) {
                    if (isMountedRef.current) setIsProcessingSTT(false);
                    setTimeout(() => startRecording(retryCount + 1, maxRetries), 1000);
                    return;
                }
                if (isMountedRef.current) {
                    if (!error) setError(t('networkError', 'Failed to connect to voice service.'));
                    setIsProcessingSTT(false); setResponse("");
                    setProductDisplayInfo(null);
                }
                stopRecordingAndReleaseMic();
                return;
            }

            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0 && socketRef.current?.readyState === WebSocket.OPEN) {
                    try { socketRef.current.send(event.data); }
                    catch (e_send) { console.error("App: Error sending audio data:", e_send); }
                }
            };
            mediaRecorderRef.current.onstop = () => {
                console.log("App: MediaRecorder onstop triggered.");
                if (socketRef.current?.readyState === WebSocket.OPEN) {
                    console.log("App: MediaRecorder onstop - WebSocket is open, sending EOS.");
                    socketRef.current.send(JSON.stringify({ type: "EOS" }));
                } else { 
                    console.warn("App: MediaRecorder stopped, but WebSocket was not open.");
                    if (isMountedRef.current) {
                        setIsProcessingSTT(false);
                        const finalTranscript = finalTranscriptForQueryRef.current.trim();
                        if (finalTranscript.length > 0 && !error && !isProcessingLLM && !isSpeaking) {
                            handleQuery(finalTranscript);
                        } else if (!error && finalTranscript.length === 0 && !isProcessingLLM && !isSpeaking) {
                            setError(t('noSpeechDetected')); setResponse("");
                            setProductDisplayInfo(null);
                        }
                    }
                }
                // Note: Do not call stopRecordingAndReleaseMic() here directly from onstop.
                // The release should be triggered by user action (clicking stop), page visibility, or unmount.
                // This onstop is just part of the data flow for a completed recording segment.
            };
            mediaRecorderRef.current.onerror = (event_mr_err) => {
                console.error("App: MediaRecorder error:", event_mr_err);
                if (isMountedRef.current) {
                    setError(t('recorderError') + `: ${event_mr_err.error?.name || 'MR Error'}`);
                    setResponse(""); setProductDisplayInfo(null);
                }
                closeWebSocket(); 
                stopRecordingAndReleaseMic();
            };
            try {
                mediaRecorderRef.current.start(100); // Start sending data in chunks
                if (isMountedRef.current) setIsRecording(true);
                console.log("App: MediaRecorder started.");
            } catch (e_mr_start) {
                console.error("App: MediaRecorder failed to start:", e_mr_start);
                if (isMountedRef.current) {
                    setError(t('recorderError') + `: ${e_mr_start.message}`);
                }
                closeWebSocket();
                stopRecordingAndReleaseMic();
            }
        } else {
            console.warn("App: startRecording called but mediaRecorder state not inactive:", mediaRecorderRef.current.state);
        }
    }, [t, error, isProcessingSTT, isProcessingLLM, isSpeaking, ensureMediaDeviceInitialized, interruptAndResetAudio, setupWebSocket, closeWebSocket, handleQuery, response, stopRecordingAndReleaseMic, setIsProcessingSTT, setResponse, setError, setProductDisplayInfo, setIsRecording]);


    const handleVoiceSearch = useCallback(async () => { /* ... same, calls stopRecordingAndReleaseMic ... */ 
        interruptAndResetAudio();
        if (isRecording) {
            stopRecordingAndReleaseMic();
        } else {
            if (isProcessingSTT || isProcessingLLM || isSpeaking) {
                console.warn("App: Mic button pressed to start while busy.");
                return;
            }
            if (isMountedRef.current && !hasMadeFirstInteraction) setHasMadeFirstInteraction(true);
            setTypedQuery("");
            setConversationHistory([]); 
            await startRecording();
        }
    }, [isRecording, isProcessingSTT, isProcessingLLM, isSpeaking, startRecording, stopRecordingAndReleaseMic, hasMadeFirstInteraction, interruptAndResetAudio]);
    const handleTextSearch = useCallback((e) => { /* ... same, calls stopRecordingAndReleaseMic ... */ 
        e.preventDefault();
        interruptAndResetAudio();
        const query = typedQuery.trim();
        if (query) {
            if (isMountedRef.current && !hasMadeFirstInteraction) setHasMadeFirstInteraction(true);
            if (isRecording) {
                stopRecordingAndReleaseMic();
            }
            if (isMountedRef.current) {
                 setResponse(""); setError("");
                 setIsProcessingSTT(false); 
                 setProductDisplayInfo(null);
                 setConversationHistory([]);
            }
            handleQuery(query);
        }
    }, [typedQuery, interruptAndResetAudio, isRecording, stopRecordingAndReleaseMic, handleQuery, hasMadeFirstInteraction]);
    const changeLanguage = useCallback((lang) => { /* ... same, calls stopRecordingAndReleaseMic ... */
        i18n.changeLanguage(lang);
        if (isMountedRef.current) {
            setResponse(""); setError(""); setIsChatOpen(false);
            setProductDisplayInfo(null); setTypedQuery(""); setConversationHistory([]);
        }
        if (isRecording) stopRecordingAndReleaseMic();
        
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ type: 'config', language: lang }));
        } else if (socketRef.current && (socketRef.current.readyState === WebSocket.CONNECTING || socketRef.current.readyState === WebSocket.CLOSED)) {
            closeWebSocket(); // Close it, next voice interaction will re-setup with new lang.
        }
    }, [i18n, isRecording, stopRecordingAndReleaseMic, closeWebSocket]);
    const handleLogin = (password) => { /* ... */ };
    const handleLogout = () => { /* ... */ };

    // **MODIFIED Main useEffect for mount/unmount**
    useEffect(() => {
        isMountedRef.current = true;
        // ensureMediaDeviceInitialized(); // Removed: Let startRecording handle initialization on demand.
                                     // This prevents asking for mic permission on page load
                                     // unless the user actually tries to record.

        return () => { // Comprehensive cleanup on component unmount
            isMountedRef.current = false;
            console.log("App: Component unmounting. Full cleanup.");
            stopRecordingAndReleaseMic(); // Full cleanup of media
            closeWebSocket();
            if (audioPlaybackRef.current) {
                audioPlaybackRef.current.pause();
                audioPlaybackRef.current = null;
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stopRecordingAndReleaseMic, closeWebSocket]); // These are stable callbacks

    useEffect(() => { /* APP_STATE_UPDATE logger - no change */ }, [isRecording, isProcessingSTT, isProcessingLLM, isSpeaking, websocketStatus, error, response, hasMadeFirstInteraction, productDisplayInfo]);

    useEffect(() => { /* Page Visibility API - no change */
        const handleVisibilityChange = () => {
            if (document.hidden) {
                if (isRecording && isMountedRef.current) {
                    console.log("App: Page hidden by user while recording. Stopping recording and releasing mic.");
                    stopRecordingAndReleaseMic();
                }
            }
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [isRecording, stopRecordingAndReleaseMic]);

    const MicIcon = isRecording ? FaStopCircle : FaMicrophone;
    const micButtonClass = `mic-button ${isRecording ? 'recording' : ''} ${(!isRecording && (isProcessingSTT || isProcessingLLM || isSpeaking)) ? 'busy' : ''}`;
    
    // ... (JSX remains the same)
    let mainDisplayContent = null;
    let currentDisplayClass = "display-area";

    if (error) {
        mainDisplayContent = <p>{error}</p>;
        currentDisplayClass = "display-area error";
    } else if (productDisplayInfo) {
        mainDisplayContent = (
            <div className="product-location-display">
                <p className="item-name">{i18n.language === 'es' ? productDisplayInfo.name_es : productDisplayInfo.name_en}</p>

                {productDisplayInfo.aisle && ( <p className="aisle-info"> <span className="heading">{t('aisleDescriptionHeading', 'Aisle:')}</span> <span className="aisle-number">{productDisplayInfo.aisle}</span> </p> )}

             {/*   {productDisplayInfo.side && ( <p className="side-info"> <span className="heading">{t('aisleSideHeading', 'Side:')}</span> {productDisplayInfo.side} </p> )}

                {productDisplayInfo.part_es && ( <p className="part-info"> <span className="heading">{t('aislePartHeading', 'Section:')}</span> {i18n.language === 'es' ? productDisplayInfo.part_es : productDisplayInfo.part_en} </p> )}

                {productDisplayInfo.locationDetail_es && ( <p className="location-detail-info"> <span className="heading">{t('locationDetailHeading', 'Details:')}</span> {i18n.language === 'es' ? productDisplayInfo.locationDetail_es : productDisplayInfo.locationDetail_en} </p> )}*/}
            </div>
            );          
        
        currentDisplayClass = "display-area structured-product-info";
    } else if (response) {
        mainDisplayContent = <p>{response}</p>;
        if (isRecording && response === t('listening', 'Listening...')) { currentDisplayClass = "display-area listening"; }
        else if ((isProcessingSTT && !isRecording) || (isProcessingLLM && !isSpeaking && response === t('thinking', 'Thinking...'))) { currentDisplayClass = "display-area processing"; }
        else if (isSpeaking) { currentDisplayClass = "display-area"; }
        else { currentDisplayClass = "display-area"; }
    } else if (isRecording) {
        mainDisplayContent = <p>{t('listening', 'Listening...')}</p>; currentDisplayClass = "display-area listening";
    } else if (isProcessingSTT || (isProcessingLLM && !isSpeaking)) {
        mainDisplayContent = <p>{isProcessingLLM ? t('thinking', 'Thinking...') : t('processingSTT', 'Processing audio...')}</p>; currentDisplayClass = "display-area processing";
    } else if (hasMadeFirstInteraction) {
        mainDisplayContent = <p>{t('pressMicOrTypePrompt', 'Press the microphone or type to start')}</p>; currentDisplayClass = "display-area placeholder";
    } else {
        mainDisplayContent = null; currentDisplayClass = "display-area";
    }

    return (
        <ErrorBoundary>
            <Router> <div className="app"> <Routes> <Route path="/" element={ <> <div className="content"> <img src={capriLogo} alt={t('logoAlt', 'Capri Logo')} className="logo" /> <div className="mic-button-container">{isRecording && <VoiceVisualizer analyser={analyserRef.current} isRecording={isRecording} />} <div className={micButtonClass} onClick={handleVoiceSearch} aria-label={isRecording ? t('stopRecording') : t('startRecording')}> <MicIcon className="mic-icon" /> </div> </div> <div className="mic-prompt-text"> <strong>{t('pressAndAsk')}</strong>{t('exampleQuestion')} </div> {mainDisplayContent && ( <div className={currentDisplayClass}> {typeof mainDisplayContent === 'string' ? <p>{mainDisplayContent}</p> : mainDisplayContent} </div> )} 
            {productDisplayInfo && (
            <div className="ad-banner-container">
                {productDisplayInfo.adOfferImageUrl && (
                <img src={productDisplayInfo.adOfferImageUrl} alt={i18n.language === 'es' ? productDisplayInfo.adOfferText_es : productDisplayInfo.adOfferText_en || 'Product Offer'} className="ad-image" />
                )}
                {(productDisplayInfo.adOfferText_es || productDisplayInfo.adOfferText_en) && !productDisplayInfo.adOfferImageUrl && (
                <p className="ad-text">{i18n.language === 'es' ? productDisplayInfo.adOfferText_es : productDisplayInfo.adOfferText_en}</p>
                )}
            </div>
            )}
            <form className="app-search-form" onSubmit={handleTextSearch}> <input type="text" value={typedQuery} onChange={(e) => setTypedQuery(e.target.value)} placeholder={t('typeQueryPlaceholder', "Or type your product question here...")} className="app-search-input" disabled={isRecording || isProcessingSTT || isProcessingLLM || isSpeaking} /> <button type="submit" className="app-search-button" disabled={isRecording || isProcessingSTT || isProcessingLLM || isSpeaking || typedQuery.trim() === ""}> <FaSearch /> </button> </form> <div className="quick-options"> <GridButton to="/find-on-shelf" icon={FaTag} labelKey="findOnShelf" tFunction={t} /> <GridButton to="/deals" icon={FaShoppingCart} labelKey="shopperOnline" tFunction={t} /> <GridButton to="/bathroom-guide" icon={FaRestroom} labelKey="findTheBathroom" tFunction={t} /> <GridButton to="/chat" icon={FaEye} labelKey="visualAssistant" className="visual-assistant-button" tFunction={t} /> {/*<GridButton to="/recipes" icon={FaBookOpen} labelKey="recipes" tFunction={t} /> */}</div> <div className="text-links"> <Link to="/jobs" className="text-link">{t('jobsLink', 'Find Jobs')}</Link> <Link to="/stores" className="text-link">{t('storesLink', 'Find Stores')}</Link> </div> <div className="language-toggle"> {i18n.language === 'es' && ( <button onClick={() => changeLanguage("en")} disabled={isSpeaking || isProcessingSTT || isProcessingLLM || isRecording}>English</button> )} {i18n.language === 'en' && ( <button onClick={() => changeLanguage("es")} disabled={isSpeaking || isProcessingSTT || isProcessingLLM || isRecording}>Español</button> )} </div> </div> </> } /> {/* ... other routes ... */ } <Route path="/find-on-shelf" element={<VoiceAndChatSearchPage />} />  {/* <Route path="/recipes" element={<RecipesPage />} /> */}<Route path="/deals" element={<DealsPage />} /> <Route path="/jobs" element={<JobsPage />} /> <Route path="/stores" element={<StoresPage />} /> <Route path="/chat" element={<VisionPage />} /> <Route path="/bathroom-guide" element={<BathroomGuidePage />} /> <Route path="/login" element={isAuthenticated ? <Navigate to="/admin" /> : <LoginPage onLogin={handleLogin} />} /> <Route path="/admin" element={isAuthenticated ? <Admin onLogout={handleLogout} /> : <Navigate to="/login" />} /> <Route path="*" element={<Navigate to="/" replace />} /> </Routes> </div> {isChatOpen && <ChatPopup onClose={() => setIsChatOpen(false)} apiBaseUrl={API_BASE_URL} />} </Router>
        </ErrorBoundary>
    );
}
export default App;