# Motionroom

An in-browser, audio-reactive beat visualizer studio.

## Run it

Serve the folder with any static server, for example:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Create a visual

1. Drop in an MP3, WAV, or M4A beat.
2. Choose a three-color palette or use **Randomize**.
3. Add up to four reference images. Their sampled colors and image texture influence the canvas.
4. Toggle visual layers, set motion, and add the title and caption.
   Choose a reactive center figure, lighting engine, bloom, geometry warp, and beam angle. The waveform wraps the core figure, rests while paused, and offers smooth, bar, ribbon, dot, and glitch styles. The center pulse responds to kick/808 transients.
   Pick a built-in display font, enter any installed font family, or upload multiple TTF, OTF, WOFF, or WOFF2 files. Select individual title words to control their font, color, weight, size, tracking, position, and rotation independently.
5. Choose 16:9, square, or vertical output.
6. Choose a video length and select **Export 1080P MP4**. Supported browsers render frames offline with hardware encoding, without playing through the track in real time. Use **Download PNG** for an instant high-resolution cover frame.

Everything runs locally in the browser; uploaded audio and images are not sent anywhere.
