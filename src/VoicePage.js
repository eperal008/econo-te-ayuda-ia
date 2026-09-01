import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { FaMicrophone, FaStopCircle } from "react-icons/fa";
import axios from "axios";
import "./VoicePage.css";

// --- Configuration ---
const SILENCE_THRESHOLD_AMPLITUDE = 15;
const SILENCE_DURATION_MS = 1500;
const MIN_RECORDING_TIME_MS = 500;
const API_BASE_URL = "https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com";
// --- End Configuration ---

function VoicePage() {
    const { t, i18n } = useTranslation();
    const location = useLocation();
    const [isListeningActive, setIsListeningActive] = useState(() => {
        // Initialize from local storage
        const saved = localStorage.getItem('isListeningActive');
        return saved ? JSON.parse(saved) : false;
    });
    const [isCurrentlyRecording, setIsCurrentlyRecording] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [response, setResponse] = useState("");
    const [error, setError] = useState("");

    const mediaRecorderRef = useRef(null);
    const audioContextRef = useRef(null);
    const analyserRef = useRef(null);
    const silenceDetectionIntervalRef = useRef(null);
    const audioChunksRef = useRef([]);
    const silenceStartRef = useRef(null);
    const recordingStartTimeRef = useRef(null);
    const streamRef = useRef(null);
    const isMountedRef = useRef(false);

    // Log navigation changes
    useEffect(() => {
        console.log("Location changed:", location.pathname);
    }, [location]);

    // Persist isListeningActive to local storage
    useEffect(() => {
        localStorage.setItem('isListeningActive', JSON.stringify(isListeningActive));
    }, [isListeningActive]);

    // --- 1. Initialization and Greeting ---
    useEffect(() => {
        isMountedRef.current = true;
        let didCancel = false;

        const initializeMedia = async () => {
            console.log("Attempting to initialize media...");
            setError("");
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                if (didCancel || !isMountedRef.current) return;
                streamRef.current = stream;

                const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
                console.log("MediaRecorder initialized with mimeType: audio/webm;codecs=opus");
                mediaRecorderRef.current = recorder;

                const context = new (window.AudioContext || window.webkitAudioContext)();
                const source = context.createMediaStreamSource(stream);
                const analyserNode = context.createAnalyser();
                analyserNode.fftSize = 2048;
                source.connect(analyserNode);

                audioContextRef.current = context;
                analyserRef.current = analyserNode;

                // --- Event Listeners for MediaRecorder ---
                recorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        console.log("Audio chunk received, size:", event.data.size);
                        audioChunksRef.current.push(event.data);
                    } else {
                        console.log("Empty audio chunk received.");
                    }
                };

                recorder.onstop = async () => {
                    console.log("MediaRecorder stopped.");
                    setIsCurrentlyRecording(false);

                    if (audioChunksRef.current.length === 0) {
                        console.warn("No audio chunks recorded.");
                        if (isListeningActive && isMountedRef.current) {
                            startSegmentRecording();
                        }
                        return;
                    }

                    setIsProcessing(true);
                    setResponse(t('processing'));

                    const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
                    audioChunksRef.current = [];
                    console.log("Audio blob created, size:", audioBlob.size);

                    if (audioBlob.size < 100) {
                        console.warn("Audio blob size is very small, likely no speech captured.");
                        setResponse("");
                        setIsProcessing(false);
                        if (isListeningActive && isMountedRef.current) {
                            startSegmentRecording();
                        }
                        return;
                    }

                    const audioBase64 = await blobToBase64(audioBlob);
                    console.log("Audio base64 length:", audioBase64 ? audioBase64.length : "empty");

                    if (!audioBase64) {
                        console.error("Failed to convert blob to Base64.");
                        setError("Error processing audio data.");
                        setIsProcessing(false);
                        if (isListeningActive && isMountedRef.current) {
                            startSegmentRecording();
                        }
                        return;
                    }

                    try {
                        console.log("Sending audio for transcription...");
                        const sttRes = await axios.post(`${API_BASE_URL}/speech-to-text`, {
                            audio: audioBase64,
                            language: i18n.language,
                        });
                        const transcript = sttRes.data.transcript;
                        console.log("Received transcript:", transcript);

                        if (transcript && transcript.trim().length > 0) {
                            setError("");
                            setResponse(t('thinking'));
                            handleQuery(transcript);
                        } else {
                            console.log("No speech detected or transcript empty.");
                            setResponse("");
                            setError(t('noSpeechDetected'));
                            setIsProcessing(false);
                            if (isListeningActive && isMountedRef.current) {
                                startSegmentRecording();
                            }
                        }
                    } catch (error) {
                        console.error("Error transcribing audio:", error.response?.data || error.message);
                        setError(t('sttError'));
                        setResponse("");
                        setIsProcessing(false);
                        if (isListeningActive && isMountedRef.current) {
                            startSegmentRecording();
                        }
                    }
                };

                recorder.onerror = (event) => {
                    console.error("MediaRecorder error:", event.error);
                    setError(`Recorder Error: ${event.error.name} - ${event.error.message}`);
                    stopListeningCompletely();
                };

                // --- Initial Greeting ---
                console.log("Media initialized successfully. Triggering greeting.");
                speakResponse(t('Hello! How can I help you?'));

                // If isListeningActive was true (from local storage), start listening
                if (isListeningActive && isMountedRef.current) {
                    console.log("Resuming listening mode from persisted state...");
                    startSegmentRecording();
                }

            } catch (error) {
                console.error("Error accessing microphone:", error);
                setError(t('micAccessError'));
                setIsListeningActive(false);
            }
        };

        initializeMedia();

        return () => {
            isMountedRef.current = false;
            didCancel = true;
            console.log("Cleaning up VoicePage component...");
            stopListeningCompletely();
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                console.log("Media stream tracks stopped.");
            }
            if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
                audioContextRef.current.close();
                console.log("AudioContext closed.");
            }
        };
    }, []);

    // --- 2. Silence Detection Logic ---
    useEffect(() => {
        if (isCurrentlyRecording && analyserRef.current && !silenceDetectionIntervalRef.current) {
            console.log("Starting silence detection interval.");
            const analyser = analyserRef.current;
            const dataArray = new Uint8Array(analyser.fftSize);

            const checkSilence = () => {
                if (!isCurrentlyRecording || !mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording') {
                    stopSilenceDetection();
                    return;
                }

                analyser.getByteTimeDomainData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += Math.abs(dataArray[i] - 128);
                }
                const averageAmplitude = sum / dataArray.length;
                const isSilent = averageAmplitude < SILENCE_THRESHOLD_AMPLITUDE;

                const recordingDuration = recordingStartTimeRef.current ? Date.now() - recordingStartTimeRef.current : 0;
                if (recordingDuration < MIN_RECORDING_TIME_MS) {
                    silenceStartRef.current = null;
                    return;
                }

                if (isSilent) {
                    if (!silenceStartRef.current) {
                        silenceStartRef.current = Date.now();
                    } else if (Date.now() - silenceStartRef.current > SILENCE_DURATION_MS) {
                        console.log(`Silence detected for over ${SILENCE_DURATION_MS}ms. Stopping recording segment.`);
                        stopSegmentRecording();
                    }
                } else {
                    silenceStartRef.current = null;
                }
            };

            silenceDetectionIntervalRef.current = setInterval(checkSilence, 100);
        } else if (!isCurrentlyRecording && silenceDetectionIntervalRef.current) {
            stopSilenceDetection();
        }

        return () => stopSilenceDetection();
    }, [isCurrentlyRecording]);

    const stopSilenceDetection = () => {
        if (silenceDetectionIntervalRef.current) {
            clearInterval(silenceDetectionIntervalRef.current);
            silenceDetectionIntervalRef.current = null;
            silenceStartRef.current = null;
        }
    };

    // --- 3. Recording Control Functions ---
    const startSegmentRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "inactive") {
            if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
                audioContextRef.current.resume();
            }
            console.log("Starting new recording segment...");
            audioChunksRef.current = [];
            mediaRecorderRef.current.start();
            setIsCurrentlyRecording(true);
            setResponse("");
            setError("");
            silenceStartRef.current = null;
            recordingStartTimeRef.current = Date.now();
        } else {
            console.warn("Could not start segment recording. Recorder state:", mediaRecorderRef.current?.state);
        }
    }, []);

    const stopSegmentRecording = useCallback(() => {
        stopSilenceDetection();
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            console.log("Stopping current recording segment...");
            mediaRecorderRef.current.stop();
        } else {
            console.warn("Could not stop segment recording. Recorder state:", mediaRecorderRef.current?.state);
            if (isCurrentlyRecording) {
                setIsCurrentlyRecording(false);
                if (isListeningActive && isMountedRef.current) {
                    startSegmentRecording();
                }
            }
        }
    }, [isCurrentlyRecording, isListeningActive, startSegmentRecording]);

    const startListeningCompletely = useCallback(() => {
        if (!mediaRecorderRef.current) {
            setError(t('micNotReadyError'));
            return;
        }
        console.log("Activating listening mode...");
        setIsListeningActive(true);
        setError("");
        startSegmentRecording();
    }, [startSegmentRecording, t]);

    const stopListeningCompletely = useCallback(() => {
        console.log("Deactivating listening mode completely...");
        setIsListeningActive(false);
        stopSilenceDetection();
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            console.log("Stopping recorder as part of complete stop...");
            mediaRecorderRef.current.stop();
        } else {
            setIsCurrentlyRecording(false);
        }
        audioChunksRef.current = [];
        setResponse("");
        recordingStartTimeRef.current = null;
        silenceStartRef.current = null;
    }, []);

    // --- 4. Button Handler ---
    const handleMicButtonClick = useCallback(() => {
        if (isProcessing || isSpeaking) {
            console.log("Cannot toggle microphone while processing or speaking.");
            return;
        }

        if (isListeningActive) {
            stopListeningCompletely();
        } else {
            startListeningCompletely();
        }
    }, [isListeningActive, isProcessing, isSpeaking, startListeningCompletely, stopListeningCompletely]);

    // --- 5. Utility and API Call Functions ---
    const blobToBase64 = (blob) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                if (reader.result) {
                    const base64String = reader.result.toString().split(",")[1];
                    resolve(base64String);
                } else {
                    reject(new Error("FileReader result is null"));
                }
            };
            reader.onerror = (error) => reject(error);
            reader.readAsDataURL(blob);
        });
    };

    const speakResponse = useCallback(async (text) => {
        if (!text) return;
        console.log(`Requesting TTS for: "${text}"`);
        setIsSpeaking(true);
        setError("");
        try {
            const res = await axios.post(`${API_BASE_URL}/text-to-speech`, {
                text,
                language: i18n.language,
            });
            const { audio, format } = res.data;
            if (!audio || !format) {
                throw new Error("Invalid TTS response format from server");
            }
            const audioUrl = `data:audio/${format};base64,${audio}`;
            const audioElement = new Audio(audioUrl);

            audioElement.onended = () => {
                console.log("TTS playback finished.");
                setIsSpeaking(false);
                setIsProcessing(false);
                if (isListeningActive && isMountedRef.current) {
                    console.log("AI finished speaking, restarting listening segment.");
                    startSegmentRecording();
                }
            };
            audioElement.onerror = (e) => {
                console.error("Audio playback error:", e);
                setError(t('ttsPlaybackError'));
                setIsSpeaking(false);
                setIsProcessing(false);
                if (isListeningActive && isMountedRef.current) {
                    startSegmentRecording();
                }
            };

            audioElement.play();
            console.log("Playing TTS audio...");
        } catch (error) {
            console.error("Error with text-to-speech:", error.response?.data || error.message);
            setError(t('ttsApiError'));
            setIsSpeaking(false);
            setIsProcessing(false);
            if (isListeningActive && isMountedRef.current) {
                startSegmentRecording();
            }
        }
    }, [i18n.language, isListeningActive, startSegmentRecording, t]);

    const handleQuery = useCallback(async (query) => {
        console.log(`Sending query to AI: "${query}"`);
        try {
            const res = await axios.post(`${API_BASE_URL}/ask`, {
                query,
                language: i18n.language,
            });
            const reply = res.data.reply;
            console.log("Received AI reply:", reply);
            setResponse(reply);
            speakResponse(reply);
        } catch (error) {
            console.error("Error asking AI:", error.response?.data || error.message);
            const errorMsg = t('aiError');
            setError(errorMsg);
            setResponse("");
            speakResponse(errorMsg);
        }
    }, [i18n.language, speakResponse, t]);

    // --- 6. Render ---
    const MicIcon = isListeningActive ? FaStopCircle : FaMicrophone;

    return (
        <div className="voice-page">
            <h1 className="logo">{t("logo")}</h1>
            <div className="mic-container">
                <div className={`mic-circle ${isListeningActive || isSpeaking || isProcessing ? "animate" : ""}`}>
                    <MicIcon
                        className="mic-icon"
                        onClick={handleMicButtonClick}
                        style={{
                            cursor: !mediaRecorderRef.current || isProcessing || isSpeaking ? 'not-allowed' : 'pointer',
                            opacity: !mediaRecorderRef.current || isProcessing || isSpeaking ? 0.5 : 1
                        }}
                    />
                </div>
            </div>

            {(response || error) && (
                <div className={`message-area ${error ? 'error-message' : 'response'}`}>
                    {error && <p className="error-text">{error}</p>}
                    {response && !error && <p>{response}</p>}
                </div>
            )}

            <Link to="/" className="dashboard-link">{t("backToKiosk")}</Link>
        </div>
    );
}

export default VoicePage;