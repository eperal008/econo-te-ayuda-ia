import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import axios from "axios";
import i18n from "i18next";
import Fuse from 'fuse.js';
import { FaMicrophone, FaStopCircle } from "react-icons/fa";
import "./ProductsPage.css";

// --- Configuration ---
const SILENCE_THRESHOLD_AMPLITUDE = 15;
const SILENCE_DURATION_MS = 1500;
const MIN_RECORDING_TIME_MS = 500;
const API_BASE_URL = "https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com";
// --- End Configuration ---

function ProductsPage() {
    const { t } = useTranslation();
    const [products, setProducts] = useState([]);
    const [filteredProducts, setFilteredProducts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
    const [searchTerm, setSearchTerm] = useState("");
    const [isRecording, setIsRecording] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);

    const mediaRecorderRef = useRef(null);
    const audioContextRef = useRef(null);
    const analyserRef = useRef(null);
    const silenceDetectionIntervalRef = useRef(null);
    const audioChunksRef = useRef([]);
    const silenceStartRef = useRef(null);
    const recordingStartTimeRef = useRef(null);
    const streamRef = useRef(null);
    const isMountedRef = useRef(false);

    useEffect(() => {
        const handleResize = () => {
            setIsMobile(window.innerWidth <= 768);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

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
                    setIsRecording(false);

                    if (audioChunksRef.current.length === 0) {
                        console.warn("No audio chunks recorded.");
                        setError(t('noSpeechDetected'));
                        setIsProcessing(false);
                        return;
                    }

                    setIsProcessing(true);
                    setError("");

                    const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
                    audioChunksRef.current = [];
                    console.log("Audio blob created, size:", audioBlob.size);

                    if (audioBlob.size < 100) {
                        console.warn("Audio blob size is very small, likely no speech captured.");
                        setError(t('noSpeechDetected'));
                        setIsProcessing(false);
                        return;
                    }

                    const audioBase64 = await blobToBase64(audioBlob);
                    console.log("Audio base64 length:", audioBase64 ? audioBase64.length : "empty");

                    if (!audioBase64) {
                        console.error("Failed to convert blob to Base64.");
                        setError("Error processing audio data.");
                        setIsProcessing(false);
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
                            setSearchTerm(transcript);
                        } else {
                            console.log("No speech detected or transcript empty.");
                            setError(t('noSpeechDetected'));
                            setIsProcessing(false);
                        }
                    } catch (error) {
                        console.error("Error transcribing audio:", error.response?.data || error.message);
                        setError(t('sttError'));
                        setIsProcessing(false);
                    }
                };

                recorder.onerror = (event) => {
                    console.error("MediaRecorder error:", event.error);
                    setError(`Recorder Error: ${event.error.name} - ${event.error.message}`);
                    setIsRecording(false);
                    setIsProcessing(false);
                };

            } catch (error) {
                console.error("Error accessing microphone:", error);
                setError(t('micAccessError'));
                setIsRecording(false);
            }
        };

        initializeMedia();

        return () => {
            isMountedRef.current = false;
            didCancel = true;
            console.log("Cleaning up ProductsPage component...");
            stopRecording();
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                console.log("Media stream tracks stopped.");
            }
            if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
                audioContextRef.current.close();
                console.log("AudioContext closed.");
            }
        };
    }, [t]);

    useEffect(() => {
        const fetchProducts = async () => {
            try {
                const response = await axios.get("https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com/products");
                console.log("Products fetched successfully:", response.data);
                setProducts(response.data);
                setFilteredProducts(response.data);
                setLoading(false);
            } catch (err) {
                console.error("Error fetching products:", err.response ? err.response.data : err.message);
                setError(t("products.error"));
                setLoading(false);
            }
        };

        fetchProducts();
    }, [t]);

    // Fuzzy search implementation
    useEffect(() => {
        if (searchTerm) {
            const fuse = new Fuse(products, {
                keys: ['name_en', 'name_es', 'category', 'brand'],
                threshold: 0.3,
                includeMatches: true
            });

            const result = fuse.search(searchTerm);
            const matchedProducts = result.map(res => res.item);
            setFilteredProducts(matchedProducts.length > 0 ? matchedProducts : products);
        } else {
            setFilteredProducts(products);
        }
    }, [searchTerm, products]);

    // Recording Control Functions
    const startRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "inactive") {
            if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
                audioContextRef.current.resume();
            }
            console.log("Starting recording...");
            audioChunksRef.current = [];
            mediaRecorderRef.current.start();
            setIsRecording(true);
            setError("");
            silenceStartRef.current = null;
            recordingStartTimeRef.current = Date.now();
        } else {
            console.warn("Could not start recording. Recorder state:", mediaRecorderRef.current?.state);
        }
    }, []);

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            console.log("Stopping recording...");
            mediaRecorderRef.current.stop();
        } else {
            console.warn("Could not stop recording. Recorder state:", mediaRecorderRef.current?.state);
            setIsRecording(false);
        }
    }, []);

    const handleVoiceSearch = () => {
        if (isProcessing) {
            console.log("Cannot toggle microphone while processing.");
            return;
        }

        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    };

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

    if (loading) return <div style={{ textAlign: 'center', padding: '20px' }}>{t("products.loading")}</div>;
    if (error) return <div style={{ textAlign: 'center', padding: '20px', color: 'red' }}>{error}</div>;

    const itemsPerRow = isMobile ? 2 : 3;
    const rows = Math.ceil(filteredProducts.length / itemsPerRow);
    const rowHeight = isMobile ? 160 + 20 : 421;
    const baseHeight = isMobile ? 640 : 1024;
    const additionalHeight = (rows > 2 ? (rows - 2) * rowHeight : 0);
    const totalHeight = baseHeight + additionalHeight;

    return (
        <div style={{ width: isMobile ? 360 : 1440, position: 'relative' }}>
            {/* Search Bar with Text and Voice Input */}
            <div style={{
                position: 'absolute',
                top: isMobile ? 60 : 140,
                left: isMobile ? 10 : 41,
                width: isMobile ? 340 : 1358,
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                zIndex: 1000, // Ensure search bar is on top
                backgroundColor: '#fff', // Ensure visibility with a background
                padding: '5px',
                borderRadius: '5px',
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)' // Add shadow for visibility
            }}>
                <input
                    type="text"
                    placeholder={t("Search for Products...") || "Search products or categories..."}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    style={{
                        width: isMobile ? '280px' : '1250px',
                        padding: '10px',
                        borderRadius: '5px',
                        border: '1px solid #ccc',
                        fontSize: isMobile ? '14px' : '20px',
                        outline: 'none'
                    }}
                />
                <button
                    onClick={handleVoiceSearch}
                    style={{
                        padding: '10px',
                        backgroundColor: isRecording ? '#ff4444' : '#00aaff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '5px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}
                >
                    {isRecording ? <FaStopCircle size={isMobile ? 20 : 24} /> : <FaMicrophone size={isMobile ? 20 : 24} />}
                </button>
            </div>

            {/* Absolutely positioned container for products */}
            <div style={{ width: isMobile ? 360 : 1440, height: totalHeight, left: 0, top: 0, position: 'absolute', background: 'white' }}>
                {/* Dynamic Product Rows */}
                {Array.from({ length: rows }).map((_, rowIndex) => (
                    <React.Fragment key={rowIndex}>
                        {filteredProducts.slice(rowIndex * itemsPerRow, (rowIndex + 1) * itemsPerRow).map((product, index) => (
                            <React.Fragment key={product.id}>
                                <div style={{
                                    width: isMobile ? 160 : 430,
                                    height: isMobile ? 160 : 385,
                                    left: isMobile ? 10 + (index * 170) : 41 + (index * 463),
                                    top: isMobile ? 110 + (rowIndex * (160 + 20)) : 187 + (rowIndex * 421),
                                    position: 'absolute',
                                    background: '#D9D9D9',
                                    borderRadius: 10
                                }} />
                                <div style={{
                                    width: isMobile ? 140 : 350,
                                    left: isMobile ? 15 + (index * 170) : 56 + (index * 463),
                                    top: isMobile ? 120 + (rowIndex * (160 + 20)) : 219 + (rowIndex * 421),
                                    position: 'absolute',
                                    color: 'black',
                                    fontSize: isMobile ? 12 : 22,
                                    fontFamily: 'Inter',
                                    fontWeight: '700',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    textAlign: 'left'
                                }}>
                                    {product.category}
                                </div>
                                <img
                                    style={{
                                        width: isMobile ? 110 : 291,
                                        height: isMobile ? 91 : 218,
                                        left: isMobile ? 15 + (index * 170) : 56 + (index * 463),
                                        top: isMobile ? 140 + (rowIndex * (160 + 20)) : 250 + (rowIndex * 421),
                                        position: 'absolute'
                                    }}
                                    src={product.image || (isMobile ? "https://placehold.co/110x91" : "https://placehold.co/291x218")}
                                    alt={i18n.language === 'es' ? product.name_es : product.name_en}
                                    onError={(e) => { e.target.src = isMobile ? "https://placehold.co/110x91" : "https://placehold.co/291x218"; }}
                                />
                                <div style={{
                                    left: isMobile ? 15 + (index * 170) : 56 + (index * 463),
                                    top: isMobile ? 235 + (rowIndex * (160 + 20)) : 489 + (rowIndex * 421),
                                    position: 'absolute',
                                    color: 'black',
                                    fontSize: isMobile ? 9 : 20,
                                    fontFamily: 'Inter',
                                    fontWeight: '700',
                                    wordWrap: 'break-word'
                                }}>
                                    {`Brand - ${product.brand || "N/A"}`}
                                </div>
                                <div style={{
                                    left: isMobile ? 15 + (index * 170) : 56 + (index * 463),
                                    top: isMobile ? 245 + (rowIndex * (160 + 20)) : 515 + (rowIndex * 421),
                                    position: 'absolute',
                                    color: 'black',
                                    fontSize: isMobile ? 8 : 20,
                                    fontFamily: 'Inter',
                                    fontWeight: '700',
                                    wordWrap: 'break-word'
                                }}>
                                    {`Location - ${product.location_en.split(',')[0].replace('Aisle ', '')}${product.location_en.includes('Side') ? '-' + product.location_en.split(',')[1].replace(' Side ', '') : ''}`}
                                </div>
                            </React.Fragment>
                        ))}
                    </React.Fragment>
                ))}
                <div style={{ width: isMobile ? 360 : 1440, height: isMobile ? 59 : 136, left: 0, top: 0, position: 'absolute', background: '#D9D9D9' }} />
                <div style={{ width: isMobile ? 273 : 1161, height: isMobile ? 59 : 136, left: isMobile ? 87 : 279, top: 0, position: 'absolute', background: '#2596BE' }} />
                <div style={{ width: isMobile ? 132 : 578, height: isMobile ? 34 : 82, left: isMobile ? 115 : 463, top: isMobile ? 12 : 27, position: 'absolute', background: '#D9D9D9', borderRadius: 5 }} />
                <div style={{ left: isMobile ? 130 : 526, top: isMobile ? 20 : 44, position: 'absolute' }}>
                    <span style={{ color: '#2596BE', fontSize: isMobile ? 10 : 40, fontFamily: 'Inter', fontWeight: '700', wordWrap: 'break-word' }}>{t("deals.header.taglinePart1")}</span>
                    <span style={{ color: 'black', fontSize: isMobile ? 10 : 40, fontFamily: 'Inter', fontWeight: '400', wordWrap: 'break-word' }}> </span>
                    <span style={{ color: '#FF0101', fontSize: isMobile ? 10 : 40, fontFamily: 'Inter', fontWeight: '700', wordWrap: 'break-word' }}>{t("deals.header.taglinePart2")}</span>
                    <span style={{ color: 'black', fontSize: isMobile ? 10 : 40, fontFamily: 'Inter', fontWeight: '400', wordWrap: 'break-word' }}> </span>
                    <span style={{ color: '#2596BE', fontSize: isMobile ? 10 : 40, fontFamily: 'Inter', fontWeight: '700', wordWrap: 'break-word' }}>{t("deals.header.taglinePart3")}</span>
                </div>
                <div style={{ left: isMobile ? 15 : 60, top: isMobile ? 9 : 9, position: 'absolute' }}>
                    <span style={{ color: '#FF0101', fontSize: isMobile ? 24 : 75, fontFamily: 'Mr Dafoe', fontWeight: '400', wordWrap: 'break-word', textShadow: isMobile ? '0px 4px 4px rgba(0, 0, 0, 0.25)' : undefined }}>Capri</span>
                    <span style={{ color: 'black', fontSize: isMobile ? 24 : 40, fontFamily: 'Mea Culpa', fontWeight: '400', wordWrap: 'break-word' }}> </span>
                </div>
                <div style={{ width: isMobile ? 44 : 121, height: isMobile ? 53 : 133, left: isMobile ? 306 : 1293, top: isMobile ? 1 : 1, position: 'absolute', background: '#D9D9D9', borderBottomRightRadius: 5, borderBottomLeftRadius: 5 }} />
                <div style={{ left: isMobile ? 298 : 1270, top: isMobile ? 5 : 17, position: 'absolute', textAlign: 'center', color: '#2596BE', fontSize: isMobile ? 6 : 18, fontFamily: 'Inter', fontWeight: '700', wordWrap: 'break-word' }}>
                    {i18n.language === 'es' ? "Página de Productos" : "Product Page"}
                </div>
            </div>
            {/* Back Button - Positioned after the content and centered */}
            <div style={{ textAlign: 'center', padding: '20px 0', marginTop: totalHeight }}>
                <Link to="/" style={{ display: 'inline-block', padding: '10px 20px', backgroundColor: '#00aaff', color: '#fff', textDecoration: 'none', borderRadius: 5 }}>
                    {t("backToKiosk")}
                </Link>
            </div>
        </div>
    );
}

export default ProductsPage;