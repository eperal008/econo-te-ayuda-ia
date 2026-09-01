// ... (imports)
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FaMicrophone, FaStopCircle, FaSearch, FaArrowLeft, FaFilePdf } from 'react-icons/fa';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import './RecipesPage.css';

// Temporarily point to the local backend for testing
const API_BASE_URL = "http://localhost:3000";
const WS_STREAM_URL = "wss://your-store-kiosk-api-68f3020ca2d6.herokuapp.com/stream-audio";


function RecipesPage() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    
    const [isRecording, setIsRecording] = useState(false);
    const [isProcessingSTT, setIsProcessingSTT] = useState(false);
    const [isProcessingLLM, setIsProcessingLLM] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [response, setResponse] = useState("");
    const [error, setError] = useState("");
    const [websocketStatus, setWebsocketStatus] = useState("disconnected");
    const [hasMadeFirstInteraction, setHasMadeFirstInteraction] = useState(false);
    const [typedQuery, setTypedQuery] = useState("");
    const analyserRef = useRef(null);
    const webSocketConnectionPromiseRef = useRef(null);

    const [recipeResponse, setRecipeResponse] = useState(null);
    const [shoppingList, setShoppingList] = useState([]);
    const [conversationHistory, setConversationHistory] = useState([]);

    const mediaRecorderRef = useRef(null);
    const audioContextRef = useRef(null);
    
    const streamRef = useRef(null);
    const isMountedRef = useRef(true);
    const socketRef = useRef(null);
    const finalTranscriptForQueryRef = useRef("");
    
    const audioPlaybackRef = useRef(null);

    const interruptAndResetAudio = useCallback(() => { /* ... */ }, []);

    // **ensureMediaDeviceInitialized - mirrored from App.js**
    const ensureMediaDeviceInitialized = useCallback(async () => {
        if (!isMountedRef.current) return false;
        console.log("VCSPage: Ensuring media device initialized...");
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") { mediaRecorderRef.current.stop(); }
        mediaRecorderRef.current = null;
        if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            try { await audioContextRef.current.close(); } catch (e) { console.warn("VCSPage: Error closing existing AudioContext:", e); }
            audioContextRef.current = null;
        }
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Media devices API not supported.");
            const audioConstraints = { audio: { noiseSuppression: true, echoCancellation: true } };
            const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
            if (!isMountedRef.current) { stream?.getTracks().forEach(track => track.stop()); return false; }
            streamRef.current = stream;
            const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
            let selectedMimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
            if (!selectedMimeType) throw new Error("No supported MIME type for MediaRecorder.");
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
            console.log("VCSPage: Media device initialized successfully.");
            setError(""); return true;
        } catch (e) {
            console.error("VCSPage: Error initializing media device:", e);
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

    // **stopRecordingAndReleaseMic - mirrored from App.js**
    const stopRecordingAndReleaseMic = useCallback(() => {
        console.log("VCSPage: stopRecordingAndReleaseMic called.");
        if (isMountedRef.current) { setIsRecording(false); }
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
            try { mediaRecorderRef.current.stop(); } catch (e) { console.error("VCSPage: Error stopping MediaRecorder:", e); }
        }
        mediaRecorderRef.current = null;
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close()
                .then(() => { audioContextRef.current = null; })
                .catch(e => { console.warn("VCSPage: Error closing AudioContext:", e); audioContextRef.current = null; });
        } else if (audioContextRef.current) { audioContextRef.current = null;}
    }, [setIsRecording]);


    const speakResponse = useCallback(async (text) => { /* ... same ... */ 
        interruptAndResetAudio();
        if (!isMountedRef.current) return;
        const resetProcessingStates = () => {
            if (isMountedRef.current) {
                setIsSpeaking(false);
                setIsProcessingLLM(false);
            }
        };
        if (!text || text.trim() === "") {
            resetProcessingStates();
            return;
        }
        if (isMountedRef.current) setIsSpeaking(true);
        try {
            const res = await axios.post(`${API_BASE_URL}/text-to-speech`, { text, language: i18n.language });
            if (!isMountedRef.current) { resetProcessingStates(); return; }
            const { audio, format } = res.data;
            if (!audio || !format) throw new Error("Invalid TTS response format");
            const audioUrl = `data:audio/${format};base64,${audio}`;
            const audioElement = new Audio(audioUrl);
            audioPlaybackRef.current = audioElement;
            audioElement.onended = () => {
                audioPlaybackRef.current = null;
                resetProcessingStates();
            };
            audioElement.onerror = (e) => {
                console.error("[VoicePage] TTS Playback Error:", e);
                audioPlaybackRef.current = null;
                if (isMountedRef.current) { setError(t('ttsPlaybackError')); }
                resetProcessingStates();
            };
            await audioElement.play();
        } catch (error) {
            console.error("[VoicePage] TTS API/Processing Error:", error);
            audioPlaybackRef.current = null;
            if (isMountedRef.current) { setError(t('ttsApiError')); }
            resetProcessingStates();
        }
    }, [i18n.language, t, interruptAndResetAudio]);
    const handleQuery = useCallback(async (queryText) => {
        interruptAndResetAudio();
        if (!isMountedRef.current) return;

        if (!queryText || queryText.trim() === "") {
            if (isMountedRef.current) {
                setIsProcessingLLM(false);
                setError(t('noSpeechDetected'));
                setRecipeResponse(null); // Clear previous recipe
            }
            return;
        }

        if (isProcessingLLM || isSpeaking) return;
        
        if (isMountedRef.current) {
            setIsProcessingLLM(true);
            setError("");
            setResponse(t('thinking'));
            setRecipeResponse(null); // Clear previous recipe while thinking
        }

        const updatedHistory = [...conversationHistory, { role: 'user', content: queryText }];
        setConversationHistory(updatedHistory);

        try {
            const apiUrl = `${API_BASE_URL}/generate-recipe`;
            const res = await axios.post(apiUrl, {
                query: queryText,
                language: i18n.language,
                conversationHistory: updatedHistory,
            });

            if (!isMountedRef.current) return;

            const { reply, recipe, updatedHistory: newHistory } = res.data;

            setRecipeResponse(recipe);
            setResponse(reply);
            setConversationHistory(newHistory || []); // Update history with the bot's full response context
            speakResponse(reply);

        } catch (error) {
            if (!isMountedRef.current) return;
            let errText = t('aiError');
            if (error.response) errText = error.response.data?.reply || error.response.data?.error || errText;
            else if (error.request) errText = t('networkError');
            else errText = t('genericError');
            
            setError(errText);
            setResponse("");
            speakResponse(errText);
        } finally {
            if (isMountedRef.current) {
                setIsProcessingLLM(false);
            }
        }
    }, [i18n.language, t, interruptAndResetAudio, isProcessingLLM, isSpeaking, conversationHistory, speakResponse]);


    
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
    const setupWebSocket = useCallback(() => { /* ... same as App.js, ensuring stopRecordingAndReleaseMic is called on errors if needed ... */
        if (webSocketConnectionPromiseRef.current) return webSocketConnectionPromiseRef.current;
        webSocketConnectionPromiseRef.current = new Promise((resolve, reject) => {
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
            tempSocket.onpong = () => {};
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
                            if(isRecording) {
                                console.warn("VCSPage: STT error received while recording. Stopping and releasing mic.");
                                stopRecordingAndReleaseMic();
                            }
                        }
                    }
                } catch (e) { console.error("[VoicePage] Error parsing WebSocket message:", e, "Raw data:", event.data); }
            };
            tempSocket.onerror = (errorEvent) => { // WebSocket connection error
                console.error("VCSPage: WebSocket error", errorEvent)
                if (isMountedRef.current) {
                    if (!error) setError(t('networkError', "Voice connection error."));
                    setResponse(""); 
                    if(isRecording) {
                        stopRecordingAndReleaseMic();
                    } else {
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
                console.log(`VCSPage: WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`);
                if (isMountedRef.current) {
                    setWebsocketStatus("disconnected");
                    setIsProcessingSTT(false); 
                    if (isRecording) {
                        console.warn("VCSPage: WebSocket closed while still in recording state. Stopping and releasing mic.");
                        stopRecordingAndReleaseMic(); 
                        if (!currentError_onClose) setError(t('sttConnectionError', 'Voice connection lost unexpectedly.'));
                        return; 
                    }

                    const finalTranscript = finalTranscriptForQueryRef.current.trim();
                    if (event.code === 1006) { 
                        if (!currentError_onClose) setError(t('sttConnectionError', 'Voice connection lost.'));
                        setResponse(""); 
                    } else if (finalTranscript.length > 0) {
                        if (!currentError_onClose && !currentIsLLM_onClose && !currentIsSpk_onClose) {
                            handleQuery(finalTranscript);
                        } else {
                            setResponse(finalTranscript); 
                        }
                    } else { 
                        if (!currentError_onClose && !currentIsLLM_onClose && !currentIsSpk_onClose) {
                            setError(t('noSpeechDetected'));
                            setResponse(""); 
                        }
                    }
                }
            };
        });
        return webSocketConnectionPromiseRef.current;
    }, [i18n.language, t, closeWebSocket, handleQuery, error, isProcessingLLM, isSpeaking, isRecording, response, stopRecordingAndReleaseMic, setIsProcessingSTT, setError, setResponse,setWebsocketStatus]);

    // **startRecording - mirrored from App.js**
    const startRecording = useCallback(async (retryCount = 0, maxRetries = 3) => {
        interruptAndResetAudio();
        if (!isMountedRef.current) return;
        if (isProcessingSTT || isProcessingLLM || isSpeaking) {
            console.warn("VCSPage: startRecording called while busy.");
            return;
        }
        console.log("VCSPage: Attempting to start recording...");
        const mediaInitialized = await ensureMediaDeviceInitialized();
        if (!mediaInitialized || !mediaRecorderRef.current) {
            console.error("VCSPage: Media device init failed in startRecording.");
            if (isMountedRef.current && !error) {setError(t('recorderNotReady'));}
            return;
        }
        if (mediaRecorderRef.current.state === "inactive") {
            if (socketRef.current && (socketRef.current.readyState === WebSocket.CLOSING || socketRef.current.readyState === WebSocket.CLOSED)) {
                closeWebSocket();
            }
            webSocketConnectionPromiseRef.current = null;
            if (isMountedRef.current) {
                setResponse(t('listening', 'Listening...'));
                setIsProcessingSTT(true);
                
            }
            finalTranscriptForQueryRef.current = "";
            try {
                await setupWebSocket();
            } catch (e_ws) {
                console.error("VCSPage: WebSocket setup failed in startRecording.", e_ws);
                if (retryCount < maxRetries) {
                    if (isMountedRef.current) setIsProcessingSTT(false);
                    setTimeout(() => startRecording(retryCount + 1, maxRetries), 1000);
                    return;
                }
                if (isMountedRef.current) {
                    if (!error) setError(t('networkError', 'Failed to connect to voice service.'));
                    setIsProcessingSTT(false); setResponse("");
                    
                }
                stopRecordingAndReleaseMic();
                return;
            }
            mediaRecorderRef.current.ondataavailable = (event) => { /* ... same ... */ 
                if (event.data.size > 0 && socketRef.current?.readyState === WebSocket.OPEN) {
                    try { socketRef.current.send(event.data); }
                    catch (e_send) { console.error(`[VoicePage] Error sending audio data via WebSocket:`, e_send); }
                }
            };
            mediaRecorderRef.current.onstop = () => { /* ... same ... */
                console.log("VCSPage: MediaRecorder onstop triggered.");
                if (socketRef.current?.readyState === WebSocket.OPEN) {
                    console.log("VCSPage: MediaRecorder onstop - WebSocket is open, sending EOS.");
                    socketRef.current.send(JSON.stringify({ type: "EOS" }));
                } else { 
                    console.warn("VCSPage: MediaRecorder stopped, but WebSocket was not open.");
                    if (isMountedRef.current) {
                        setIsProcessingSTT(false); 
                        const finalTranscript = finalTranscriptForQueryRef.current.trim();
                        if (finalTranscript.length > 0 && !error && !isProcessingLLM && !isSpeaking) {
                            handleQuery(finalTranscript);
                        } else if (!error && finalTranscript.length === 0 && !isProcessingLLM && !isSpeaking) {
                            setError(t('noSpeechDetected')); setResponse("");
                            
                        }
                    }
                }
            };
            mediaRecorderRef.current.onerror = (event_mr_err) => { /* ... same ... */ 
                console.error("VCSPage: MediaRecorder error:", event_mr_err);
                if (isMountedRef.current) {
                    setError(t('recorderError') + `: ${event_mr_err.error?.name || 'MR Error'}`);
                    setResponse(""); 
                }
                closeWebSocket(); 
                stopRecordingAndReleaseMic();
            };
            try {
                mediaRecorderRef.current.start(100);
                if (isMountedRef.current) setIsRecording(true);
                console.log("VCSPage: MediaRecorder started.");
            } catch (e_mr_start) { /* ... same ... */
                console.error("VCSPage: MediaRecorder failed to start:", e_mr_start);
                if (isMountedRef.current) {
                    setError(t('recorderError') + `: ${e_mr_start.message}`);
                }
                closeWebSocket();
                stopRecordingAndReleaseMic();
            }
        } else {
            console.warn("VCSPage: startRecording called but mediaRecorder state not inactive:", mediaRecorderRef.current.state);
        }
    }, [t, error, isProcessingSTT, isProcessingLLM, isSpeaking, ensureMediaDeviceInitialized, interruptAndResetAudio, setupWebSocket, closeWebSocket, handleQuery, response, stopRecordingAndReleaseMic, setIsProcessingSTT, setResponse, setError, setIsRecording]);

    // **handleVoiceSearch - mirrored from App.js**
    const handleVoiceSearch = useCallback(async () => {
        interruptAndResetAudio();
        if (isRecording) {
            stopRecordingAndReleaseMic();
        } else {
            if (isProcessingSTT || isProcessingLLM || isSpeaking) {
                console.warn("[VoicePage] Cannot start recording: System is busy.");
                return;
            }
            if (isMountedRef.current && !hasMadeFirstInteraction) {
                setHasMadeFirstInteraction(true);
            }
            setTypedQuery("");
            await startRecording();
        }
    }, [isRecording, isProcessingSTT, isProcessingLLM, isSpeaking, startRecording, stopRecordingAndReleaseMic, hasMadeFirstInteraction, interruptAndResetAudio]);

    const handleAddToList = (ingredient) => {
        
        if (!shoppingList.some(item => item.name === ingredient.name)) {
            setShoppingList(prevList => [...prevList, ingredient]);
        }
    };
    const handleExportPdf = async () => {
        if (shoppingList.length === 0) return;
        try {
            const response = await axios.post(`${API_BASE_URL}/export-list`, 
                { shoppingList },
                { responseType: 'blob' } // Important to handle the file download
            );
            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', 'shopping-list.pdf');
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (err) {
            setError(t('pdfExportError', 'Could not export PDF.'));
            console.error("PDF Export Error:", err);
        }
    };
    // **handleTextSearch - mirrored from App.js**
    const handleTextSearch = (e) => {
        e.preventDefault();
        interruptAndResetAudio();
        const query = typedQuery.trim();
        if (query) {
            if (!hasMadeFirstInteraction && isMountedRef.current) setHasMadeFirstInteraction(true);
            if (isRecording) {
                stopRecordingAndReleaseMic();
            }
            if (isMountedRef.current) {
                setResponse(""); setError("");
                setIsProcessingSTT(false); 
                
            }
            handleQuery(query);
        }
    };


    // **useEffect for mount/unmount - mirrored from App.js**
    useEffect(() => {
        isMountedRef.current = true;
        // ensureMediaDeviceInitialized(); // No initial call
        return () => {
            isMountedRef.current = false;
            console.log("VCSPage: Component unmounting. Full cleanup.");
            stopRecordingAndReleaseMic();
            closeWebSocket();
            if (audioPlaybackRef.current) {
                audioPlaybackRef.current.pause();
                audioPlaybackRef.current = null;
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stopRecordingAndReleaseMic, closeWebSocket]);

    // **Page Visibility API - ADDED to VoiceAndChatSearchPage.js**
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.hidden) {
                if (isRecording && isMountedRef.current) {
                    console.log("VCSPage: Page hidden by user. Stopping recording and releasing mic.");
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
    const micButtonClasses = [
        "vcs-mic-button",
        isRecording ? "recording" : "",
        (!isRecording && (isProcessingSTT || isProcessingLLM || isSpeaking)) ? "busy" : ""
    ].filter(Boolean).join(" ");

    // ... (Display logic and JSX return remain the same)
    let mainDisplayContentElement = null;
    let vcsDisplayClass = 'vcs-display-area';
    
    if (error) {
        mainDisplayContentElement = <p>{error}</p>;
        vcsDisplayClass += ' error';
    } else if (recipeResponse && recipeResponse.ingredients) {
        mainDisplayContentElement = (
            <div className="recipe-display">
                <h3 className="recipe-name">{recipeResponse.recipeName}</h3>
                <p className="recipe-description">{recipeResponse.description}</p>
                <h4 className="ingredients-title">{t('ingredients', 'Ingredients:')}</h4>
                <ul className="ingredients-list">
                    {recipeResponse.ingredients.map((item, index) => (
                        <li key={index} className="ingredient-item">
                            <span>
                                {item.quantity} {item.name}
                                {item.aisle && <span className="location-info"> ({t('aisle', 'Aisle')}: {item.aisle}, {t('side', 'Side')}: {item.side})</span>}
                            </span>
                            <button
                                onClick={() => handleAddToList(item)}
                                className="add-to-list-btn"
                                aria-label={`Add ${item.name} to list`}
                            >
                                + {t('addToList', 'Add to List')}
                            </button>
                        </li>
                    ))}
                </ul>
                <p className="recipe-instructions">
                    <strong>{t('instructions', 'Instructions:')}</strong> {recipeResponse.instructions}
                </p>
            </div>
        );
    } else if (response) {
        mainDisplayContentElement = <p>{response}</p>;
    } else if (isRecording || isProcessingSTT) {
        mainDisplayContentElement = <p>{t('listening', 'Listening...')}</p>;
    } else if (isProcessingLLM) {
        mainDisplayContentElement = <p>{t('thinking', 'Thinking...')}</p>;
    } else {
        mainDisplayContentElement = <p>{t('recipesPage.initialPrompt', 'Ask me for a recipe! For example, "What can I make with chicken?"')}</p>;
        vcsDisplayClass += ' placeholder';
    }

    return (
        <div className="vcs-page-container">
            <div className="vcs-header">
                <button onClick={() => navigate(-1)} className="vcs-back-button" aria-label={t('back', 'Back')}>
                    <FaArrowLeft /> {t('back', 'Back')}
                </button>
                {/* --- MODIFIED: Title --- */}
                <h1>{t('recipesPage.title', 'Recipe Assistant')}</h1>
            </div>
            <div className="vcs-content">
                <div className="vcs-mic-container">
                    <button className={micButtonClasses} onClick={handleVoiceSearch} aria-label={isRecording ? t('stopRecording', 'Stop recording') : t('startRecording', 'Start recording')}>
                        <MicIcon className="vcs-mic-icon" />
                    </button>
                </div>
                {mainDisplayContentElement && <div className={vcsDisplayClass}>{mainDisplayContentElement}</div>}
                
                {/* --- ADDED: Shopping List Display --- */}
                {shoppingList.length > 0 && (
                    <div className="shopping-list-container">
                        <h3>{t('shoppingList', 'My Shopping List')}</h3>
                        <ul>
                            {shoppingList.map((item, index) => (
                                <li key={index}>
                                    {item.name}
                                    <button onClick={() => setShoppingList(list => list.filter(i => i.name !== item.name))}>
                                        {t('remove', 'Remove')}
                                    </button>
                                </li>
                            ))}
                        </ul>
                        <button onClick={handleExportPdf} className="export-pdf-btn">
                            <FaFilePdf /> {t('exportPdf', 'Export as PDF')}
                        </button>
                    </div>
                )}

                <form className="vcs-search-form" onSubmit={handleTextSearch}>
                    <input
                        type="text"
                        value={typedQuery}
                        onChange={(e) => setTypedQuery(e.target.value)}
                        placeholder={t('recipesPage.typeQueryPlaceholder', "Or type your recipe question here...")}
                        className="vcs-search-input"
                        disabled={isRecording || isProcessingSTT || isProcessingLLM || isSpeaking}
                    />
                    <button type="submit" className="vcs-search-button" disabled={isRecording || isProcessingSTT || isProcessingLLM || isSpeaking || typedQuery.trim() === ""}>
                        <FaSearch /> {t('search', 'Search')}
                    </button>
                </form>
            </div>
        </div>
    );
}

export default RecipesPage;