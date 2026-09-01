import React, { useRef, useEffect } from 'react';

const VoiceVisualizer = ({ analyser, isRecording }) => {
    const canvasRef = useRef(null);
    const animationFrameId = useRef(null);

    useEffect(() => {
        // Stop any previous animation loop
        cancelAnimationFrame(animationFrameId.current);
        const canvas = canvasRef.current;
        const canvasCtx = canvas.getContext('2d');

        if (isRecording && analyser) {
            // Adjust the analyser settings for a nice visual
            analyser.fftSize = 256;
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            
            const draw = () => {
                // Schedule the next frame
                animationFrameId.current = requestAnimationFrame(draw);

                // Get the frequency data
                analyser.getByteFrequencyData(dataArray);

                // Clear the canvas
                canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
                
                const barWidth = (canvas.width / bufferLength) * 1.2;
                let barHeight;
                let x = 0;

                // Draw each bar of the wave
                for (let i = 0; i < bufferLength; i++) {
                    barHeight = dataArray[i] * 0.5; // Scale the height
                    
                    // Style the bars
                    canvasCtx.fillStyle = 'rgba(0, 123, 255, 0.7)';
                    canvasCtx.fillRect(x, (canvas.height - barHeight) / 2, barWidth, barHeight);
                    
                    x += barWidth + 2; // Move to the next bar
                }
            };
            draw();

        } else {
             // If not recording, clear the canvas
            canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
        }

        // Cleanup function to cancel animation when the component unmounts or props change
        return () => {
            cancelAnimationFrame(animationFrameId.current);
        };
    }, [isRecording, analyser]); // Rerun this effect if isRecording or the analyser changes

    return <canvas ref={canvasRef} className="voice-visualizer" />;
};

export default VoiceVisualizer;