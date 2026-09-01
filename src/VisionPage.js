import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import axios from "axios";
import { FaMicrophone, FaCamera } from "react-icons/fa";
import "./VisionPage.css"; // Make sure this CSS file exists and is styled
import { debounce } from 'lodash'; // Ensure lodash is installed: npm install lodash
import { Link } from "react-router-dom";

// --- Configuration ---
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com"; // Replace if needed
const MAX_IMAGE_WIDTH = 1024;
const MAX_IMAGE_HEIGHT = 1024;
const IMAGE_QUALITY = 0.8;
const CAMERA_INIT_DELAY = 300; // Delay after successful init before capture
const VOICE_TOGGLE_DEBOUNCE_DELAY = 300;

// --- Utility: blobToBase64 ---
// Converts a Blob object to a Base64 string (without the data: prefix)
const blobToBase64 = (blob) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result;
            if (typeof result === 'string') {
                resolve(result.split(",")[1]); // Return only the Base64 part
            } else {
                reject(new Error("FileReader result not a string."));
            }
        };
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(blob);
    });
};

// --- The React Component ---
function VisionPage() {
    // --- Hooks ---
    const { t, i18n } = useTranslation(); // For internationalization
    const [isMobile, setIsMobile] = useState(window.innerWidth <= 768); // Check for mobile screen size

    // --- State Variables ---
    const [capturedImageDataUrl, setCapturedImageDataUrl] = useState(null); // Holds the base64 data URL of the confirmed captured image for display
    const [description, setDescription] = useState(""); // Holds the description text received from the backend (image analysis or voice query reply)
    const [lastImageDescription, setLastImageDescription] = useState(""); // Holds the description from the *last successful image analysis* to provide context for voice queries
    const [productContext, setProductContext] = useState([]); // Holds product information extracted from the analysis
    const [isRecording, setIsRecording] = useState(false); // Is the microphone actively recording (based on MediaRecorder state)?
    const [isProcessing, setIsProcessing] = useState(false); // Is the app busy with a backend task (image analysis, STT, TTS, Ask)? Excludes initialization.
    const [isInitializing, setIsInitializing] = useState(false); // Is the app busy initializing camera or microphone hardware?
    const [processingStatus, setProcessingStatus] = useState(""); // User-facing message about the current background task (e.g., "Analyzing...", "Listening...")
    const [error, setError] = useState(null); // Holds the current user-facing error message string
    const [captureTrigger, setCaptureTrigger] = useState(0); // Counter to trigger the capture useEffect hook
    const [previewMode, setPreviewMode] = useState(false); // Is the live camera feed shown for capture confirmation?

    // --- Refs ---
    const cameraStreamRef = useRef(null); // Holds the active camera MediaStream object
    const audioStreamRef = useRef(null); // Holds the active audio MediaStream object
    const videoRef = useRef(null); // Ref attached to the <video> element displaying the camera feed
    const canvasRef = useRef(null); // Ref attached to the hidden <canvas> used for capturing frames
    const mediaRecorderRef = useRef(null); // Holds the MediaRecorder instance for audio recording
    const audioChunksRef = useRef([]); // Array to store Blob chunks of recorded audio data

    // --- Effects ---

    // Log language changes
    useEffect(() => { console.log("Language set to:", i18n.language); }, [i18n.language]);

    // Detect mobile based on resize
    useEffect(() => {
        const handleResize = () => setIsMobile(window.innerWidth <= 768);
        window.addEventListener("resize", handleResize);
        handleResize(); // Initial check
        return () => window.removeEventListener("resize", handleResize);
    }, []); // Empty dependency array, runs once on mount

    // --- Helper: Format Error ---
    // Creates a structured object from an error for better logging
    const formatError = useCallback((err) => ({
        message: err?.message ?? 'Unknown error',
        name: err?.name ?? 'UnknownName',
        code: err?.code,
        status: err?.response?.status,
        response_data: err?.response?.data,
        stack: typeof err?.stack === 'string' ? err.stack.substring(0, 300) + '...' : 'No stack',
    }), []); // Empty dependency array, created once

    // --- Stream Cleanup Functions ---

    // Stops camera tracks, detaches from video element, clears refs
    const stopCameraStream = useCallback(() => {
        if (cameraStreamRef.current) {
            console.log("Stopping active camera stream tracks...");
            cameraStreamRef.current.getTracks().forEach(track => track.stop());
            cameraStreamRef.current = null;
            if (videoRef.current && videoRef.current.srcObject) {
                videoRef.current.srcObject = null;
                videoRef.current.onloadedmetadata = null; // Clear listeners too
                videoRef.current.onerror = null;
            }
             console.log("Camera stream stopped and detached.");
        } else {
            // console.log("stopCameraStream called but no active stream found.");
        }
    }, []); // No dependencies, created once

    // Stops audio recorder, audio tracks, clears refs and resets related state
    const stopAudioStream = useCallback((calledFrom) => {
        console.log(`stopAudioStream called from: ${calledFrom}`);
        // 1. Stop MediaRecorder if active
        if (mediaRecorderRef.current) {
            const recorder = mediaRecorderRef.current;
            const currentState = recorder.state;
            console.log(`Current MediaRecorder state: ${currentState}`);
            if (currentState !== "inactive") {
                console.log("Attempting to stop MediaRecorder...");
                try {
                    // Clear handlers BEFORE stopping during explicit cleanup to prevent conflicts
                    recorder.ondataavailable = null;
                    recorder.onerror = null;
                    recorder.onstop = null;
                    recorder.stop(); // Attempt to stop it
                    console.log(`MediaRecorder stopped via stopAudioStream (was ${currentState}).`);
                } catch (e) {
                    console.error("Error stopping MediaRecorder during cleanup:", formatError(e));
                }
            }
            mediaRecorderRef.current = null; // Clear the ref
        }

        // 2. Stop Audio Stream Tracks
        if (audioStreamRef.current) {
            console.log("Stopping active audio stream tracks...");
            audioStreamRef.current.getTracks().forEach(track => {
                track.stop();
                console.log(`Track ${track.id} (${track.kind}) stopped.`);
            });
            audioStreamRef.current = null; // Clear the stream ref
        }

        // 3. Reset related state and refs
        console.log("Resetting audio-related state in stopAudioStream.");
        setIsRecording(false); // Ensure recording intention state is false
        audioChunksRef.current = []; // Clear any residual chunks
        // Note: isInitializing state is handled by the function that called stopAudioStream if necessary
    }, [formatError]); // Dependency for logging helper

    // --- Initialization Functions ---

    // Initializes Camera: Gets stream, attaches to video element, starts playback
    const initCamera = useCallback(async () => {
        console.log("Attempting camera init...");
        setIsInitializing(true); // Set flag *before* async operation
        setProcessingStatus(t("visionPage.cameraNotReady", "Initializing Camera..."));
        setError(null); // Clear previous camera errors

        // Cleanup existing stream *before* getting a new one
        stopCameraStream();

        try {
            // Request Camera Access
            const constraints = { video: { facingMode: isMobile ? "environment" : "user" } };
            console.log("Requesting media stream with constraints:", constraints);
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log("Camera stream acquired:", stream.id);
            cameraStreamRef.current = stream; // Store the stream

            // Attach to Video Element
            const videoEl = videoRef.current;
            if (!videoEl) {
                throw new Error("Video element reference is not available.");
            }

            console.log("Assigning stream to video element...");
            videoEl.srcObject = stream;

            // Optional: Add listeners directly for debugging
            videoEl.onloadedmetadata = () => {
                console.log(`Video metadata loaded: ${videoEl.videoWidth}x${videoEl.videoHeight}. ReadyState: ${videoEl.readyState}`);
            };
            videoEl.onerror = (e) => {
                console.error("Video element error event:", e);
                setError(t("visionPage.videoElementError", "Video element failed to load stream."));
            };

            // Play the Video
            console.log("Attempting to play video element...");
            await videoEl.play(); // play() returns a promise
            console.log("Video playback successfully started.");

            // Success: Clear status (isInitializing will be set false in finally)
            setProcessingStatus("");
            return stream; // Return stream maybe useful for caller

        } catch (err) {
            // Handle Errors
            console.error("Error during camera initialization:", formatError(err));
            let errorMsg = t("visionPage.cameraAccessError", "Could not access camera."); // Default
            if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") { errorMsg = t("visionPage.cameraPermissionDenied", "Camera permission denied. Please enable camera access in browser settings."); }
            else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") { errorMsg = t("visionPage.cameraNotFound", "No camera found. Ensure it's connected and enabled."); }
            else if (err.name === "NotReadableError" || err.name === "TrackStartError") { errorMsg = t("visionPage.cameraInUse", "Camera might be already in use by another application or browser tab."); }
            else if (err.name === "OverconstrainedError" || err.name === "ConstraintNotSatisfiedError") { errorMsg = t("visionPage.cameraConstraintsError", "The camera doesn't support the requested settings (e.g., resolution, facing mode)."); }
            else if (err.name === "AbortError") { errorMsg = t("visionPage.cameraAbortError", "Camera access was aborted, possibly due to device disconnection."); }
            else if (err.message?.includes("Video playback failed")) { errorMsg = t("visionPage.videoPlayError", "Could not start video playback. Try again or check browser compatibility."); }
            else { errorMsg = err.message || errorMsg; }
            setError(errorMsg);
            stopCameraStream(); // Ensure cleanup on error
            throw err; // Re-throw the error so calling functions know it failed
        } finally {
            // ALWAYS Reset the initializing flag
            console.log("Resetting isInitializing flag in initCamera finally block.");
            setIsInitializing(false);
        }
    }, [isMobile, t, stopCameraStream, formatError]); // Stable dependencies

    // Initializes Audio: Gets stream, creates MediaRecorder, sets up listeners
    const initAudio = useCallback(async () => {
        if (isInitializing) { // Avoid concurrent initializations
            console.log("initAudio skipped: another initialization in progress.");
            return null;
        }
        setIsInitializing(true); // Set flag
        setProcessingStatus(t("visionPage.micNotReady", "Initializing Mic..."));
        console.log("Initializing audio recorder...");
        setError(null); // Clear previous audio errors
        stopAudioStream("initAudioStart"); // Clean up previous audio resources first

        try {
            // Get audio stream
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log("Mic stream acquired.");
            audioStreamRef.current = stream; // Store active stream

            // Create MediaRecorder
            const options = { mimeType: "audio/webm;codecs=opus" }; // Prefer opus/webm
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                console.warn(`${options.mimeType} not supported, trying default.`);
                delete options.mimeType; // Fallback to browser default
            }
            console.log("Creating MediaRecorder with options:", options);
            const recorder = new MediaRecorder(stream, options);
            mediaRecorderRef.current = recorder; // Store active recorder

            // Setup listeners immediately after creation
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data); // Collect audio data chunks
                }
            };
            recorder.onerror = (event) => { // Handle recorder errors
                console.error("MediaRecorder Error:", event.error);
                setError(t("visionPage.recordingError", `Recording error: ${event.error?.name || 'Unknown'}`));
                stopAudioStream("recorder.onerror"); // Critical: Clean up on error
                setIsInitializing(false); // Ensure init flag is cleared
                setProcessingStatus("");
            };
            recorder.onstart = () => { // Handle successful start
                console.log("MediaRecorder started successfully (onstart event). State:", recorder.state);
                setIsRecording(true); // Set state *when* recording actually starts
                setIsInitializing(false); // No longer initializing
                setProcessingStatus(t("visionPage.listening", "Listening...")); // Update status
            };

            console.log("Audio recorder initialized and ready. State:", recorder.state);
            // Return the stream and recorder (needed by startRecording)
            return { stream, recorder };

        } catch (err) { // Handle errors getting user media
            console.error("Error accessing microphone:", formatError(err));
            let errorMsg = t("visionPage.micAccessError", "Could not access microphone.");
            if (err.name === "NotAllowedError") errorMsg = t("visionPage.micPermissionDenied", "Mic permission denied.");
            else if (err.name === "NotFoundError") errorMsg = t("visionPage.micNotFound", "No microphone found.");
            else if (err.name === "NotReadableError") errorMsg = t("visionPage.micInUse", "Mic already in use.");
            else errorMsg = err.message || errorMsg;
            setError(errorMsg);
            setIsRecording(false); // Ensure state is correct on failure
            stopAudioStream("initAudioCatch"); // Cleanup on error
            throw err; // Re-throw so caller knows it failed
        } finally {
            // Reset initializing flag ONLY if it wasn't already reset by onstart or onerror
            // This handles cases where getUserMedia might succeed but recorder creation fails, etc.
            if (isInitializing && !isRecording) {
                 setIsInitializing(false);
                 setProcessingStatus(""); // Clear status if init failed silently
            }
        }
    }, [t, stopAudioStream, isInitializing, formatError]); // Dependencies: isInitializing state is read

    // --- Mount Effects ---

    // Initialize camera on initial mount
    useEffect(() => {
        console.log("Initial mount effect running...");
        initCamera()
            .then(() => {
                console.log("Initial camera initialization successful.");
            })
            .catch(err => {
                // Error state is set within initCamera's catch block
                console.error("Initial camera initialization failed in mount effect.");
            });
        // Cleanup function for when the component unmounts
        return () => {
            console.log("VisionPage unmounting. Cleaning up camera stream.");
            stopCameraStream();
        };
    }, [initCamera]); // Dependency: initCamera (stable)

    // Cleanup audio stream/recorder on unmount
    useEffect(() => {
        return () => {
            console.log("VisionPage unmounting. Cleaning up audio stream/recorder.");
            stopAudioStream("unmount"); // Call cleanup
        };
    }, [stopAudioStream]); // Dependency: stopAudioStream (stable)

    // --- Image Handling ---

    // Resizes an image blob to specified dimensions and quality, returns base64 data
    const resizeImage = useCallback((blob, maxWidth, maxHeight, quality) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            let objectUrl = null; // Keep track to revoke it
            img.onload = () => {
                if(objectUrl) URL.revokeObjectURL(objectUrl); // Clean up URL
                let width = img.width; let height = img.height;
                const aspectRatio = width / height;
                // Calculate new dimensions maintaining aspect ratio
                if (width > maxWidth) { width = maxWidth; height = width / aspectRatio; }
                if (height > maxHeight) { height = maxHeight; width = height * aspectRatio; }
                width = Math.round(width); height = Math.round(height);
                // Use canvas to draw resized image
                const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
                // Get Base64 data URL
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                const base64Data = dataUrl.split(',')[1]; // Extract only base64 part
                if (base64Data) { resolve(base64Data); } else { reject(new Error("Resize fail: Could not extract base64 data.")); }
            };
            img.onerror = (e) => { // Handle image load errors
                console.error("Image load error in resize:", e);
                if(objectUrl) URL.revokeObjectURL(objectUrl); // Clean up URL on error
                reject(new Error("Resize: Image load error."));
            };
            try { // Create temporary URL for the blob
                objectUrl = URL.createObjectURL(blob);
                img.src = objectUrl;
            } catch (urlError) {
                console.error("CreateObjectURL error:", urlError);
                reject(new Error("Resize: Could not create object URL from blob."));
            }
        });
     }, []); // No dependencies, created once

    // Processes the captured and resized image: sends to API, gets description, handles TTS
     const processImage = useCallback(async (resizedBase64Image) => {
        console.log("[processImage] Entered function.");
        if (!resizedBase64Image) {
            setError(t("visionPage.processErrorNoImage", "Cannot process: No image data provided."));
            setIsProcessing(false); setProcessingStatus(""); return;
        }
        setIsProcessing(true);
        setProcessingStatus(t("visionPage.analyzing", "Analyzing image..."));
        setError(null);
        setDescription("");
        setProductContext([]);
        // No need to clear lastImageDescription here proactively

        let analysisSuccess = false;
        console.log("[processImage] Starting analysis try block...");

        try {
            console.log("[processImage] Sending image to /ask, length approx:", resizedBase64Image.length);
            const response = await axios.post(`${API_BASE_URL}/ask`, {
                query: "Describe this image focusing on identifiable products, brands, and arrangement.",
                language: i18n.language,
                image: resizedBase64Image,
            });

            console.log("[processImage] Raw /ask response status:", response.status);
            // console.log("[processImage] Raw /ask response data:", JSON.stringify(response.data));

            const reply = response?.data?.reply ?? null;
            const products = response?.data?.products ?? [];

            console.log(`[processImage] Extracted reply: "${reply}" (Type: ${typeof reply})`);
            console.log("[processImage] Extracted products:", products);

            const descText = (reply && String(reply).trim())
                ? String(reply).trim()
                : t("visionPage.noDescription", "No description available.");
            console.log(`[processImage] Determined description text (descText): "${descText}"`);

            setDescription(descText);
            setProductContext(products);

            // *** ADD/VERIFY THIS LOG ***
            console.log(`%c[CLIENT VisionPage.processImage] SETTING CONTEXT: lastImageDescription = "${descText}"`, "color: blue; font-weight: bold;");
            setLastImageDescription(descText); 
            analysisSuccess = true;

            // CRITICAL: Set the state
            console.log(`%c[processImage] ---> QUEUING state update: setLastImageDescription("${descText}") <---`, "color: blue; font-weight: bold;");
            setLastImageDescription(descText); // Queue the update
            analysisSuccess = true;
            console.log("[processImage] State update for lastImageDescription queued.");

            // Optional: TTS
            if (reply && String(reply).trim()) {
                setProcessingStatus(t("visionPage.generatingAudio", "Generating description audio..."));
                 try {
                     console.log("[processImage] Requesting TTS for description...");
                     const ttsResponse = await axios.post(`${API_BASE_URL}/text-to-speech`, { text: descText, language: i18n.language });
                     const audioContent = ttsResponse?.data?.audio;
                     if (audioContent) {
                         const audio = new Audio(`data:audio/mp3;base64,${audioContent}`);
                         console.log("[processImage] Attempting audio playback for description...");
                         audio.play().catch(e => console.error("Description audio play error:", e));
                         console.log("[processImage] Description audio playback initiated.");
                     } else { console.warn("[processImage] TTS request successful but no audio content received."); }
                 } catch (ttsError) {
                     console.error("[processImage] Error during Text-to-Speech request:", formatError(ttsError)); /* Allow process to continue */
                 }

            } else {
                console.log("[processImage] No valid reply text, skipping TTS for description.");
            }

        } catch (err) {
            console.error("[processImage] === ERROR in try block ===", formatError(err));
            let errorMsg = t("visionPage.imageProcessingError", "Failed to analyze image.");
            if(err?.response?.status === 413) { errorMsg = t("visionPage.imageTooLarge", "Image is too large after processing. Please try a different image."); }
            else if (err?.response?.status >= 500) { errorMsg = t("visionPage.serverError", "Server error during analysis. Please try again later."); }
            else if (err?.message?.includes("Network Error")) { errorMsg = t("visionPage.networkError", "Network error during image analysis. Check connection."); }
            // Safer access to nested error properties
            else if (err?.response?.data?.error) { errorMsg = String(err.response.data.error); } // Show specific backend error if available
            else { errorMsg = err?.message || errorMsg; }
            setError(errorMsg);
            setDescription("");
            console.warn("[processImage] === CLEARING lastImageDescription due to error ===");
            setLastImageDescription(""); // Clear context on error
            setProductContext([]);
            setCapturedImageDataUrl(null);
            analysisSuccess = false;
        } finally {
            console.log(`[processImage] Finally block. Analysis Success Flag: ${analysisSuccess}`);
            setIsProcessing(false);
            setProcessingStatus("");
            console.log("[processImage] Exiting function.");
        }
    }, [t, i18n.language, formatError, API_BASE_URL]); // Dependencies look ok


    // --- Capture Handlers ---

    // Handler for the main Capture/Recapture button click
    const handleCaptureButtonClick = useCallback(() => {
        // Prevent action if busy initializing or already recording
        if (isRecording || isInitializing) {
            console.log(`Capture button ignored: isRecording=${isRecording}, isInitializing=${isInitializing}`);
            setError(isRecording ? t("visionPage.stopRecordingFirst", "Please stop recording first.") : t("visionPage.waitForInit", "Please wait for initialization."));
            return;
        }
        console.log("Entering preview mode...");
        // Reset state for preview
        setError(null);
        setDescription(""); // Clear previous results
        setProductContext([]);
        // lastImageDescription is NOT cleared here, only on confirm
        setCapturedImageDataUrl(null); // Clear old static image to show live feed
        setPreviewMode(true); // Enter preview mode
    }, [isRecording, isInitializing, t]); // Dependencies on states read

    // Handler for the "Confirm Capture" button click (only visible in preview mode)
    const handleConfirmCapture = useCallback(() => {
        // Prevent action if already processing, recording, initializing, or not in preview
        if (isProcessing || isRecording || !previewMode || isInitializing) {
            console.log(`Confirm capture aborted: isProcessing=${isProcessing}, isRecording=${isRecording}, previewMode=${previewMode}, isInitializing=${isInitializing}`);
            return;
        }
        console.log("Confirming capture...");
        setPreviewMode(false); // Exit preview mode immediately

        setCaptureTrigger(prev => { // Increment trigger to run the capture useEffect
             console.log(`%c>>> SETTING CAPTURE TRIGGER from ${prev} to ${prev + 1} <<<`, 'color: red; font-weight: bold;');
             return prev + 1;
        });
    }, [isProcessing, isRecording, previewMode, isInitializing]); // Dependencies on states read

    // --- Capture useEffect ---
    // This effect runs when 'captureTrigger' changes. It orchestrates the capture process.
    useEffect(() => {
        if (captureTrigger === 0) return; // Don't run on initial render

        let isActive = true; // Flag to prevent state updates if component unmounts or effect re-runs

        const performCapture = async () => {
            console.log(`Capture useEffect running (trigger: ${captureTrigger})...`);
            if (!isActive) return; // Check if component is still mounted/active

            // Set busy state for this capture process
            setIsProcessing(true);
            setProcessingStatus(t("visionPage.preparingCapture", "Preparing capture..."));
            setError(null); // Clear previous errors for this attempt

            try {
                // Get canvas context
                const canvas = canvasRef.current;
                if (!canvas) throw new Error("Canvas ref is missing.");
                const ctx = canvas.getContext("2d");
                ctx.clearRect(0, 0, canvas.width, canvas.height); // Ensure canvas is clear

                // Check camera readiness and initialize if needed
                let currentStream = cameraStreamRef.current;
                if (!currentStream?.active || !videoRef.current || videoRef.current.readyState < videoRef.current.HAVE_CURRENT_DATA) { // HAVE_CURRENT_DATA = 2
                    console.log("Capture effect: Camera inactive/not ready, re-initializing...");
                    if (!isActive) return;
                    try {
                        currentStream = await initCamera(); // This handles its own flags/status
                        if (!isActive) return;
                        console.log("Capture effect: Camera re-initialized.");
                        // Give browser a moment after init before capturing
                        await new Promise(res => setTimeout(res, CAMERA_INIT_DELAY));
                        if (!isActive) return;
                    } catch (initError) {
                        console.error("Camera initialization failed within capture effect:", formatError(initError));
                        // Error state should have been set by initCamera
                        throw new Error(t("visionPage.cameraNotReady", "Camera failed to initialize for capture.")); // Propagate error
                    }
                }

                // Final check after potential init
                if (!isActive || !cameraStreamRef.current?.active || !videoRef.current || videoRef.current.readyState < videoRef.current.HAVE_CURRENT_DATA) {
                    throw new Error(t("visionPage.cameraNotReady", "Camera stream not available for capture."));
                }

                // Get video dimensions
                const videoEl = videoRef.current;
                const videoWidth = videoEl.videoWidth;
                const videoHeight = videoEl.videoHeight;
                if (!videoWidth || !videoHeight) { // Check for valid dimensions
                    throw new Error(t("visionPage.cameraNotReady", "Camera dimensions unavailable or zero."));
                }

                if (!isActive) return;
                setProcessingStatus(t("visionPage.capturing", "Capturing image..."));

                // Set canvas size and draw the current video frame onto it
                canvas.width = videoWidth; canvas.height = videoHeight;
                ctx.drawImage(videoEl, 0, 0, videoWidth, videoHeight);
                console.log(`Drew video frame (${videoWidth}x${videoHeight}) to canvas.`);

                // Get the captured image data URL for immediate display
                const originalImageDataUrl = canvas.toDataURL("image/jpeg");
                if (!isActive) return;
                setCapturedImageDataUrl(originalImageDataUrl); // Show the user what was captured

                // Convert canvas to Blob for resizing (this is async)
                canvas.toBlob(async (blob) => {
                    if (!isActive) return; // Check again inside async callback
                    if (!blob) { // Handle blob creation failure
                        console.error("Canvas toBlob failed.");
                        if (isActive) {
                             setError(t("visionPage.captureError", "Failed to get image data from canvas."));
                             setIsProcessing(false); setProcessingStatus(""); setCapturedImageDataUrl(null); // Reset state on failure
                        }
                        return;
                    }

                    if (!isActive) return;
                    console.log(`Canvas blob created (type: ${blob.type}, size: ${blob.size}). Resizing...`);
                    setProcessingStatus(t("visionPage.resizing", "Optimizing image..."));

                    try {
                        // Resize the image blob
                        const resizedBase64 = await resizeImage(blob, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, IMAGE_QUALITY);
                        if (!isActive) return;
                        console.log("Image resized successfully. Processing...");
                        // Process the resized image (sends to backend, etc.)
                        await processImage(resizedBase64); // processImage handles its own state changes (isProcessing, status, results)
                    } catch (resizeOrProcessError) { // Handle errors during resize or processing
                        if (!isActive) return;
                        console.error("Error during resize or processImage:", formatError(resizeOrProcessError));
                        setError(resizeOrProcessError.message || t("visionPage.processingError", "Image processing failed."));
                        setIsProcessing(false); setProcessingStatus("");
                        // Decide whether to keep captured image displayed on processing error (currently yes)
                    }
                }, 'image/jpeg', IMAGE_QUALITY); // Specify blob type and quality

            } catch (captureError) { // Catch errors during the main capture logic (init, draw, etc.)
                if (!isActive) return;
                console.error("Capture useEffect main error catch:", formatError(captureError));
                setError(captureError.message || t("visionPage.captureError", "Failed to capture image."));
                // Ensure processing state is reset on capture failure
                setIsProcessing(false);
                setProcessingStatus("");
                setCapturedImageDataUrl(null); // Clear image display on capture failure
                // Maybe return to preview mode on capture failure? Optional.
                // setPreviewMode(true);
            }
            // No finally block needed here; state resets happen within processImage or catch blocks
        };

        // Use a short timeout to allow initial state updates (like previewMode=false) to render before heavy work
        const captureTimeout = setTimeout(performCapture, 50);

        // Cleanup function for the effect
        return () => {
            isActive = false; // Set flag to prevent updates from ongoing async ops
            clearTimeout(captureTimeout); // Clear the timeout if effect re-runs or unmounts
            console.log(`Capture useEffect cleanup (trigger: ${captureTrigger}).`);
            // Avoid resetting processing state here directly, as it might interrupt ongoing valid processes
            // if capture finishes quickly and trigger changes again. Let the process manage its own state.
        };
    // Dependency array for the capture effect - runs only when captureTrigger changes
    // Other dependencies (initCamera, etc.) are stable callbacks
    }, [captureTrigger, initCamera, resizeImage, processImage, t, formatError]);


    // --- Voice Recording Controls ---

    // Starts the audio recording process
    const startRecording = useCallback(async () => {
        // Prevent starting if already recording, initializing, processing, or no image context
        if (isRecording || isInitializing || isProcessing) {
            console.warn(`startRecording aborted: isRecording=${isRecording}, isInitializing=${isInitializing}, isProcessing=${isProcessing}`);
            return;
        }
        // Check context *before* starting
        if (!lastImageDescription) {
            console.warn("startRecording aborted: No image context (lastImageDescription is empty).");
            setError(t("visionPage.analyzeImageFirst", "Please analyze an image first."));
            return;
        }
        console.log("Attempting to start recording...");
        setError(null); // Clear previous errors
        setDescription(""); // Clear previous text results

        try {
            let recorder = mediaRecorderRef.current;
            let stream = audioStreamRef.current;
            // Check if recorder/stream exists, is active, and recorder is ready
            let needsReInit = !recorder || !stream || !stream.active || recorder.stream !== stream || recorder.state !== "inactive";

            if (needsReInit) {
                console.log("Audio stream/recorder missing, inactive, or mismatched. Re-initializing...");
                const initResult = await initAudio(); // initAudio handles its own status/flags
                if (!initResult) throw new Error("Mic initialization was skipped or failed."); // Check if initAudio returned null
                recorder = initResult.recorder; // Update local recorder variable from init result
                if (!recorder || recorder.state !== 'inactive') { // Re-check state after init
                    throw new Error("Mic initialization succeeded but recorder is not ready.");
                }
                console.log("Mic re-initialized successfully.");
                await new Promise(res => setTimeout(res, 100)); // Brief pause after init
            } else {
                console.log("Using existing inactive recorder and active stream.");
            }

            // Final check before starting
            if (recorder && recorder.state === "inactive") {
                console.log("Recorder is inactive. Starting recording...");
                audioChunksRef.current = []; // Clear previous chunks just before starting
                recorder.start(); // Start the recording
                // State updates (isRecording=true, isInitializing=false, status="Listening...") are handled by recorder.onstart event handler set in initAudio
                console.log("recorder.start() called. Waiting for onstart event...");
            } else {
                // This case should be less likely now with the checks and re-init logic
                console.error(`Cannot start recording. Recorder state is "${recorder?.state}".`);
                throw new Error(`Recorder is not ready to start (state: ${recorder?.state}).`);
            }

        } catch (err) { // Catch errors during start process
            console.error("Failed to start recording:", formatError(err));
            setError(err.message || t("visionPage.micStartError", "Could not start microphone recording."));
            // Ensure all related states are reset on failure
            setIsRecording(false);
            setIsInitializing(false); // Ensure init flag is off
            setIsProcessing(false); // Ensure processing flag is off
            setProcessingStatus("");
            // initAudio calls stopAudioStream on its failure, but call again JIC error is after successful init but before recorder.start()
            stopAudioStream("startRecordingCatch");
        }
    // Minimal stable dependencies
    }, [isRecording, isInitializing, isProcessing, lastImageDescription, t, initAudio, stopAudioStream, setError, formatError]);

    // Stops the audio recording, triggers processing of the recorded audio
    const stopRecording = useCallback(async () => {
        const recorder = mediaRecorderRef.current;
        console.log("stopRecording function called.");

        // Check if we have a recorder and it's actually recording
        if (recorder && recorder.state === "recording") {
            console.log("MediaRecorder is 'recording'. Setting onstop and calling stop().");

            // Define the onstop handler *before* calling stop()
            // This function will execute asynchronously after recording actually stops
            recorder.onstop = async () => {
                console.log("MediaRecorder stopped (onstop event triggered). State:", recorder.state);
                // Get chunks *immediately* after stop.
                const currentChunks = [...audioChunksRef.current];
                audioChunksRef.current = []; // Clear chunks ref immediately after copying

                // Update state: No longer recording. Now entering processing phase.
                setIsRecording(false);
                // Note: isInitializing should already be false if recording was active

                if (currentChunks.length === 0) { // Check if any audio was recorded
                    console.warn("No audio chunks were recorded.");
                    setError(t("visionPage.noSpeechDetected", "No speech detected or recording too short."));
                    setIsProcessing(false); // Ensure processing is false
                    setProcessingStatus("");
                    stopAudioStream("onstop-noChunks"); // Clean up stream/recorder now since there's nothing to process
                    return; // Exit onstop handler
                }

                // Start processing the audio chunks
                setIsProcessing(true); // Indicate voice processing has started
                setProcessingStatus(t("visionPage.processingVoice", "Processing voice..."));
                setError(null); // Clear previous errors

                try {
                    // Get mime type from the recorder instance that just stopped
                    const recordedMimeType = recorder.mimeType || 'audio/webm';
                    const audioBlob = new Blob(currentChunks, { type: recordedMimeType });
                    console.log(`Created audio blob (type: ${recordedMimeType}, size: ${audioBlob.size}).`);

                    // --- Speech-to-Text ---
                    setProcessingStatus(t("visionPage.transcribing", "Transcribing audio..."));
                    const audioBase64 = await blobToBase64(audioBlob); // Convert blob to base64
                    const currentLanguage = i18n.language;
                    console.log("Sending audio to /speech-to-text...");
                    const sttResponse = await axios.post(`${API_BASE_URL}/speech-to-text`, { audio: audioBase64, language: currentLanguage });
                    const userQuery = sttResponse?.data?.transcript; // Safer access
                    console.log("Transcription received:", userQuery);
                    // --- End Speech-to-Text ---

                    if (userQuery && String(userQuery).trim()) { // Check if transcription is valid
                        // --- Call Ask API with Context ---
                        // Read the context state *here* right before the API call
                        const currentContextDesc = lastImageDescription;
                        console.log(`%c[stopRecording] Using context for /ask: "${currentContextDesc}"`, "color: purple; font-weight: bold;"); // Log the context being used
                        console.log(`%c[CLIENT VisionPage.recorder.onstop] USING CONTEXT: currentContextDesc (from lastImageDescription) = "${currentContextDesc}"`, "color: purple; font-weight: bold;");
                        setProcessingStatus(t("visionPage.generatingResponse", "Generating response..."));
                        const requestBody = {
                            query: userQuery,
                            language: currentLanguage,
                            // IMPORTANT: Include context from the last image analysis read above
                            ...(currentContextDesc && { previousDescription: currentContextDesc })
                        };
                        console.log("Sending transcribed query to /ask with context:", requestBody);
                        console.log("[CLIENT VisionPage.recorder.onstop] FINAL requestBody for /ask:", JSON.stringify(requestBody, null, 2));
                        const askResponse = await axios.post(`${API_BASE_URL}/ask`, requestBody);
                        const reply = askResponse?.data?.reply; // Safer access
                        const products = askResponse?.data?.products; // Safer access
                        console.log("AI Reply received:", reply);
                        console.log("Associated products:", products);
                        // Update UI with response
                        setDescription(reply || t("visionPage.noResponse", "Assistant did not provide a response."));
                        setProductContext(products || []);
                        // --- End Ask API ---

                        // --- Text-to-Speech for Reply ---
                        if (reply && String(reply).trim()) { // Only speak if there was a real reply
                            setProcessingStatus(t("visionPage.generatingAudio", "Generating response audio..."));
                            try {
                                const ttsResponse = await axios.post(`${API_BASE_URL}/text-to-speech`, { text: reply, language: currentLanguage });
                                const audioContent = ttsResponse?.data?.audio; // Safer access
                                if (audioContent) {
                                    const audio = new Audio(`data:audio/mp3;base64,${audioContent}`);
                                    console.log("Attempting audio playback for AI reply...");
                                    // Don't necessarily await playback - let it potentially overlap with cleanup
                                    audio.play().catch(e => console.error("AI reply audio play error:", e));
                                    console.log("AI reply audio playback initiated.");
                                } else { console.warn("TTS for AI reply successful but no audio content received."); }
                            } catch (ttsError) { console.error("Error during Text-to-Speech for AI reply:", formatError(ttsError)); /* Non-fatal */ }
                        } else { console.log("No AI reply text, skipping TTS."); }
                        // --- End TTS for Reply ---

                    } else { // Handle empty transcription
                        console.warn("Transcription was empty or only whitespace.");
                        setError(t("visionPage.noTranscription", "Could not understand speech or speech was empty."));
                        setDescription(""); // Clear any previous description
                        setProductContext([]);
                    }
                } catch (err) { // Catch errors during STT, Ask, or TTS processing
                    console.error("Error processing voice query (STT, Ask, or TTS):", formatError(err));
                    let processingErrorMsg = t("visionPage.voiceProcessingError", "Failed to process voice query.");
                    if (err?.response?.status === 400 && err?.response?.data?.error?.includes("language")) { processingErrorMsg = t("visionPage.languageError", "Unsupported language or audio format for STT."); }
                    else if (err?.message?.includes("Network Error")) { processingErrorMsg = t("visionPage.networkError", "Network error during voice processing."); }
                    else { processingErrorMsg = err.message || processingErrorMsg; }
                    setError(processingErrorMsg);
                    setDescription(""); // Clear description on error
                    setProductContext([]);
                } finally {
                    console.log("Voice processing finished (within onstop finally).");
                    // CRITICAL: Clean up the audio stream and recorder *after* all processing is done.
                    setIsProcessing(false); // Ensure processing flag is cleared
                    setProcessingStatus("");
                    stopAudioStream("onstop-finally"); // Cleanup audio resources now
                }
            }; // --- End of onstop handler definition ---

            // Set the onstop handler *just before* calling stop()
            // Ensure the recorder object still exists before assigning the handler
            if (mediaRecorderRef.current) {
                 mediaRecorderRef.current.onstop = recorder.onstop; // Assign the function defined above
            } else {
                 console.error("MediaRecorder ref became null before onstop could be assigned in stopRecording!");
                 setIsRecording(false); setIsProcessing(false); setProcessingStatus("");
                 stopAudioStream("stopRecordingRefNull"); // Force cleanup if ref is lost
                 return;
            }

            // Now, actually stop the recording
            try {
                console.log("Calling recorder.stop()...");
                // Check state again right before stop, JIC it changed (e.g., disconnected device)
                if (recorder.state === "recording") {
                    recorder.stop(); // This will asynchronously trigger the onstop handler we just set
                } else {
                     console.warn(`Recorder state changed to ${recorder.state} just before stop() call. Aborting stop action, forcing cleanup.`);
                      // Manually trigger cleanup if state is wrong to avoid inconsistent state
                      setIsRecording(false);
                      // Don't call onstop manually here
                      setIsProcessing(false);
                      setProcessingStatus("");
                      stopAudioStream("stopRecordingStateChanged"); // Force cleanup
                }
            } catch (stopError) { // Catch rare errors from the stop() call itself
                 console.error("Error directly calling recorder.stop():", formatError(stopError));
                 setError(t("visionPage.stopError", "Failed to stop recording cleanly."));
                 setIsRecording(false); setIsProcessing(false); setProcessingStatus("");
                 stopAudioStream("stopRecordingCatch"); // Force cleanup
            }

        } else if (isRecording) { // Handle state mismatch: Our state thinks recording, but browser API doesn't
            console.warn("stopRecording called while isRecording=true, but recorder was not in 'recording' state. State:", recorder?.state, ". Forcing cleanup.");
            setError(t("visionPage.stateMismatchError", "Recording state mismatch. Resetting audio."));
            setIsRecording(false); // Correct our state
            setIsProcessing(false);
            setProcessingStatus("");
            stopAudioStream("stopRecordingStateMismatch"); // Clean up thoroughly
        } else { // stopRecording called when not recording
            console.log("stopRecording called but not currently recording (isRecording=false). Ignoring.");
        }
    // Dependencies required by the logic inside, including the context read for API call
    }, [isRecording, t, i18n.language, lastImageDescription, formatError, stopAudioStream, API_BASE_URL]);


    // --- Voice Query Toggle Handler (Debounced) ---
    // MODIFIED: Pass state into the debounced function
    const debouncedToggleRef = useRef(
        // Add parameters for state/functions needed inside
        debounce((
            currentIsRecording,
            currentIsProcessing,
            currentIsInitializing,
            recorderState,
            currentLastImageDescription, // <-- Pass the actual description state
            tFunction,                  // <-- Pass t function
            startRecFunc,               // <-- Pass startRecording function
            stopRecFunc                   // <-- Pass stopRecording function
        ) => {
            console.log(`[Debounced] Toggling Voice Query. isRecording=${currentIsRecording}, isProcessing=${currentIsProcessing}, isInitializing=${currentIsInitializing}, recorderState=${recorderState}`);
            console.log(`%c[Debounced] Checking context received: currentLastImageDescription = "${currentLastImageDescription}"`, "color: green; font-weight: bold;"); // <-- Log the received value

            // Don't toggle if busy processing/initializing
            if (currentIsProcessing || currentIsInitializing) {
                console.log("[Debounced] Toggle aborted: Currently processing or initializing.");
                return;
            }

            // *** Check the PASSED-IN value ***
            if (!currentLastImageDescription) { // Check the argument, not the closed-over variable
                console.log("[Debounced] Toggle aborted: No image context was passed.");
                // Use the passed t function
                setError(tFunction("visionPage.analyzeImageFirst", "Please analyze an image first.")); // Use setError passed via closure (fine here)
                return;
            }

            // Decide whether to start or stop based on the *current* state passed to it
            if (currentIsRecording && recorderState === 'recording') {
                console.log("[Debounced] Action: Stopping recording...");
                stopRecFunc(); // Call the passed stop function
            } else if (!currentIsRecording && (recorderState === 'inactive' || !recorderState)) {
                console.log("[Debounced] Action: Starting recording...");
                startRecFunc(); // Call the passed start function
            } else {
                console.warn(`[Debounced] Toggle ignored due to unexpected state combination. isRecording: ${currentIsRecording}, recorderState: ${recorderState}, isInitializing: ${currentIsInitializing}`);
            }
        }, VOICE_TOGGLE_DEBOUNCE_DELAY, { leading: true, trailing: false })
    );

    // Click handler for the microphone button - calls the debounced function
    // MODIFIED: Read state here and pass it to the debounced function call
    const handleVoiceQueryToggle = useCallback(() => {
        // Get the *current* state values when the button is actually clicked
        const currentIsRecording = isRecording;
        const currentIsProcessing = isProcessing;
        const currentIsInitializing = isInitializing;
        const recorderState = mediaRecorderRef.current?.state; // Check current recorder state if exists
        const currentLastImageDescription = lastImageDescription; // <<< Read the current state here

        console.log(`handleVoiceQueryToggle: Passing lastImageDescription = "${currentLastImageDescription}" to debounced function.`); // <-- Log before calling

        // Call the debounced function stored in the ref, passing the current state values AND functions
        debouncedToggleRef.current(
            currentIsRecording,
            currentIsProcessing,
            currentIsInitializing,
            recorderState,
            currentLastImageDescription, // Pass the current description state
            t,                          // Pass the t function (stable)
            startRecording,             // Pass the stable startRecording callback
            stopRecording               // Pass the stable stopRecording callback
        );

    // Dependencies: Include state variables read directly here.
    // start/stopRecording and t are stable but included as they are passed.
    }, [isRecording, isProcessing, isInitializing, lastImageDescription, t, startRecording, stopRecording]);


    // --- Render Logic ---

    // Determine tooltip text for the Ask button based on state
    const askButtonTitle = !lastImageDescription
        ? t('visionPage.analyzeImageFirstTooltip', 'Please analyze an image first to enable voice questions.')
        : (isRecording
            ? t('visionPage.stopTooltip', 'Stop listening')
            : t('visionPage.askTooltip', 'Ask a question about the image (requires mic permission)'));

    // Combine flags for disabling actions
    const isBusy = isProcessing || isInitializing; // Busy if processing analysis/voice OR initializing hardware
    const isCameraActionDisabled = isBusy || isRecording; // Disable camera actions if busy or already recording audio
     // This relies on lastImageDescription state being updated correctly after processImage causes a re-render
    const isVoiceActionDisabled = isBusy || !lastImageDescription;

    // --- JSX Output ---
    return (
        <div className="vision-page">
            {/* New Header Container for Back Button and Title */}
            <div className="header-container-vision">
                <Link to="/" className="top-back-button">
                    <span className="arrow-icon">←</span>
                    {t("visionPage.topBackButtonText", "Back")} {/* New translation key */}
                </Link>
                {/* Page Title (existing) */}
            {/* Page Title */}
            <h2>{t("visionPage.title", "Visual Assistant")}</h2>
            </div>
            
            {/* Error Display Area */}
            {error && (
                 <div className="error-message">
                      {error}
                      {/* Button to manually dismiss error */}
                      <button onClick={() => setError(null)} className="dismiss-error" title={t('visionPage.dismissError', 'Dismiss error')}>X</button>
                 </div>
            )}

            
            {/* Camera / Image Display Area */}
            <div className="camera-container">
                {/* Live Video Feed */}
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted // Muted crucial to prevent feedback loop when recording audio
                    className="video-feed"
                    // Show video if: in preview mode OR (no image has been captured yet AND not busy)
                    style={{ display: (previewMode || (!capturedImageDataUrl && !isBusy)) ? 'block' : 'none' }}
                />
                {/* Display Captured Static Image */}
                {capturedImageDataUrl && !previewMode && !(isBusy && processingStatus.includes('Capturing')) && ( // Show if NOT in preview, image exists, and not actively capturing
                    <img
                        src={capturedImageDataUrl}
                        alt={t('visionPage.capturedImageAlt', 'Captured Scene')}
                        className="captured-image"
                    />
                )}
                 {/* Placeholder/Spinner during image capture/analysis (when not in preview and no image shown yet) */}
                 {isBusy && !previewMode && !capturedImageDataUrl && (
                      <div className="image-placeholder loading-placeholder">
                           <div className="spinner"></div> {/* Add CSS for spinner animation */}
                           <p>{processingStatus || t("visionPage.loading", "Loading...")}</p>
                      </div>
                 )}
                {/* Hidden Canvas for Image Capture */}
                <canvas ref={canvasRef} style={{ display: 'none' }} />
            </div>

            {/* Control Buttons Area */}
            <div className="controls">
                {/* Capture/Recapture Button (Shows when NOT in preview mode) */}
                {!previewMode && (
                    <button
                        onClick={handleCaptureButtonClick}
                        disabled={isCameraActionDisabled} // Disable if busy or recording
                        className="capture-button control-button"
                        title={capturedImageDataUrl ? t("visionPage.recaptureTooltip", "Recapture image") : t("visionPage.captureTooltip", "Capture image")}
                    >
                        <FaCamera /> {capturedImageDataUrl ? t("visionPage.recapture", "Recapture") : t("visionPage.capture", "Capture")}
                    </button>
                )}

                {/* Confirm Capture Button (Shows ONLY in preview mode) */}
                {previewMode && (
                    <button
                        onClick={handleConfirmCapture}
                        disabled={isCameraActionDisabled} // Disable if busy or recording
                        className="confirm-capture-button control-button"
                        title={t("visionPage.confirmCaptureTooltip", "Confirm capture and analyze")}
                    >
                        <FaCamera /> {t("visionPage.confirmCapture", "Confirm")}
                    </button>
                )}

                {/* Cancel Preview Button (Optional, Shows ONLY in preview mode) */}
                {previewMode && (
                    <button
                          onClick={() => { setPreviewMode(false); setError(null); /* Clears preview */ }}
                          disabled={isBusy} // Disable if busy
                          className="cancel-preview-button control-button secondary" // Style as secondary action
                          title={t("visionPage.cancelPreviewTooltip", "Cancel capture")}
                    >
                          {t("visionPage.cancel", "Cancel")}
                    </button>
                )}

                {/* Voice Query Button (Ask/Stop) */}
                <button
                    onClick={handleVoiceQueryToggle}
                    // This disabled check relies on the re-render after processImage sets the state
                    disabled={isVoiceActionDisabled}
                    className={`voice-button control-button ${isRecording ? 'recording' : ''} ${isInitializing && !isRecording ? 'initializing' : ''}`}
                    title={askButtonTitle} // Dynamic tooltip
                >
                    <FaMicrophone />
                    {/* Dynamically change button text */}
                    {isRecording
                        ? t("visionPage.stop", "Stop")
                        : (isInitializing && !isRecording // Show initializing specifically if trying to start mic
                            ? t("visionPage.startingMic", "Starting...")
                            : t("visionPage.ask", "Ask"))
                    }
                </button>
            </div>

            {/* Status and Description Text Area */}
            <div className="status-description-area">
                {/* Loading/Processing/Initializing Indicator (Shows when 'isBusy' is true) */}
                {isBusy && (
                     <div className="loading-indicator">
                          <div className="spinner"></div> {/* Optional spinner */}
                          {/* Display specific status message */}
                          {processingStatus || (isInitializing ? t("visionPage.initializing", "Initializing...") : t("visionPage.processing", "Processing..."))}
                     </div>
                )}

                {/* Listening Indicator (Shows ONLY when actually recording and NOT busy with other processing) */}
                {isRecording && !isBusy && (
                     <div className="placeholder-text recording">
                          {/* Use status if available (e.g., from onstart), otherwise default */}
                          {processingStatus || t("visionPage.listeningPrompt", "Listening...")}
                     </div>
                     )}

                {/* Assistant Response / Prompt Text (Shows ONLY when idle - not busy AND not recording) */}
                {!isBusy && !isRecording && (
                     <>
                          {/* Display description if available */}
                          {description && (
                               <div className="description">
                                    <h3>{t("visionPage.assistantResponse", "Assistant:")}</h3>
                                    <p>{description}</p>
                               </div>
                          )}

                          {/* Show prompts based on state only if no description is currently shown */}
                          {!description && !error && lastImageDescription && ( // Analyzed, ready for question
                               <div className="placeholder-text">{t("visionPage.askAboutImagePrompt", "Image analyzed. Press the microphone to ask a question.")}</div>
                          )}
                          {!description && !error && !lastImageDescription && ( // Initial state, needs capture
                               <div className="placeholder-text">{t("visionPage.initialPrompt", "Capture an image using the button above to begin.")}</div>
                          )}
                          {/* Note: Error state is handled by the dedicated error display div */}
                     </>
                )}
            </div>

            {/* Optional Product Context Display Area (Shows only when idle and products exist) */}
            {!isBusy && !isRecording && productContext.length > 0 && (
                 <div className="product-context">
                      <h4>{t("visionPage.relatedProducts", "Identified Products:")}</h4>
                      <ul>
                           {productContext.map((product, index) => (
                                // Ensure product object has a unique 'id' or use index as fallback key
                                // Ensure product object has a 'name' property or adjust display
                                <li key={product.id || index}>{product.name || `Product ${index + 1}`}</li>
                           ))}
                      </ul>
                 </div>
            )}
        </div>
    );
}

export default VisionPage;