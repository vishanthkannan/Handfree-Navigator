# Hands-Free Voice Control Application

A multi-modal, hands-free desktop automation application built with Electron and Python Flask. Features Google Speech Recognition (with optional CMU Sphinx offline fallback), eye tracking, and a virtual keyboard for accessibility and productivity.

---

## Features

- 🎤 **Voice Recognition**: Control your computer with voice commands (Google Speech Recognition, with offline fallback via CMU Sphinx)
- 👁️ **Eye Tracking**: Move mouse and click using real-time eye tracking (MediaPipe)
- ⌨️ **Virtual Keyboard**: On-screen keyboard controllable by voice and eye gaze
- 🖱️ **Mouse Control**: Click, scroll, and move mouse with voice or eye
- 📱 **App Launcher**: Open applications with voice commands
- 📧 **Email Integration**: Compose and send emails using voice commands
- 🔄 **Mode Switching**: Switch between typing, key, and navigation modes by voice

---

## Modes

The application supports multiple input modes for flexible control:

- **Type Mode**: Dictate and type text using your voice.
- **Key Mode**: Issue keyboard shortcut commands (e.g., "press control c").
- **Navigation Mode**: Control mouse movement and clicks.
- **Eye Mode**: Use eye tracking for mouse movement and selection.
- **Virtual Keyboard Mode**: Use an on-screen keyboard, controllable by voice or gaze.

**Switching Modes:**  
Use voice commands such as:
- "type mode" – Switch to typing mode
- "key mode" – Switch to key/shortcut mode
- "navigation mode" – Switch to navigation/mouse mode
- "start eye control" / "stop eye control" – Toggle eye tracking
- "show virtual keyboard" / "hide virtual keyboard" – Toggle on-screen keyboard

---

## Voice Commands

### Application Commands
- "open notepad"
- "open calculator"
- "open paint"
- "open chrome"
- "open edge"
- "open word"
- "open mail"
- "open gmail"

### Mouse Commands
- "click"
- "double click"
- "right click"
- "scroll up"
- "scroll down"
- "move mouse to X Y"

### Typing & Keyboard Commands
- "type [text]"  
  Example: "type hello world"
- "press [key]"  
  Example: "press enter", "press control c"

### Control & Mode Commands
- "stop listening"
- "type mode"
- "key mode"
- "navigation mode"
- "start eye control"
- "stop eye control"
- "show virtual keyboard"
- "hide virtual keyboard"

---

## Setup Instructions

### Prerequisites

- **Node.js** (v14 or higher)
- **Python** (v3.7 or higher)
- **Microphone** (for voice input)
- **Webcam** (for eye tracking, if used)

### Installation

1. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

2. **Install Python dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

3. **(Optional) Enable offline fallback:**
   ```bash
   pip install pocketsphinx
   ```
   - The default recognizer uses Google Speech Recognition and requires an active internet connection.
   - Installing `pocketsphinx` enables an offline fallback with lower accuracy.

### Running the Application

1. **Start the application:**
   ```bash
   npm start
   ```
   - Starts the Electron app and Python Flask voice server.

2. **Using Controls:**
   - Click "Start Voice Recognition" to begin listening.
   - Use "Listen Once" for single commands.
   - Use "Start Eye Control" and "Stop Eye Control" to toggle eye tracking.
   - Use "Show Virtual Keyboard" and "Hide Virtual Keyboard" as needed.
   - Switch between modes using the appropriate voice commands.

---

## Troubleshooting

### Voice Recognition Issues

- **Google Speech RequestError / connectivity issues:**
  - Ensure you have a stable internet connection.
  - Retry after a short while (temporary rate limits can occur).
  - Reduce background noise and speak clearly.

- **"Cannot connect to voice server" error:**
  - Make sure port 5005 is not in use by another application.
  - Check that Python and all dependencies are installed correctly.

- **Microphone not working:**
  - Check your microphone permissions.
  - Ensure your microphone is set as the default input device.
  - Test your microphone in other applications.

### Eye Tracking Issues

- **Webcam not detected:**
  - Ensure your webcam is connected and accessible.
  - Check OS permissions for camera access.

- **Eye tracking inaccurate:**
  - Ensure good lighting and face is visible to the camera.
  - Adjust your position for better detection.

### Audio Issues

- **No audio input detected:**
  - Check microphone permissions in your OS.
  - Ensure microphone is not muted.
  - Try restarting the application.

- **Poor recognition accuracy:**
  - Speak clearly and at a normal volume.
  - Reduce background noise / use a better microphone.
  - (Optional) Install `pocketsphinx` for an offline fallback.

### Performance Issues

- **Slow response:**
  - Close unnecessary applications.
  - Ensure adequate system resources.

---

## Development

### Project Structure

```
handsfree-electron/
├── main.js              # Electron main process
├── preload.js           # Preload script for IPC
├── renderer.js          # Renderer process (UI logic)
├── voice_server.py      # Python Flask voice server (Google SR + optional Sphinx)
├── mouse_control.py     # Mouse automation script
├── eye_control.py       # Eye tracking server (MediaPipe)
├── requirements.txt     # Python dependencies
├── package.json         # Node.js dependencies
├── index.html           # Main UI
├── style.css            # Styling
└── ...                  # Other supporting files
```

### Adding New Voice Commands

1. **Update `voice_server.py`:**
   - Add new commands and parsing to `process_voice_command()`
   - Define the action mapping

2. **Update `main.js`:**
   - Add new command handling in `handleVoiceCommand()`
   - Implement the actual functionality

3. **Update UI:**
   - Add new buttons or controls in `renderer.js` if needed

### Customizing the Voice Server

The voice server (`voice_server.py`) can be customized for:
- Different speech recognition models
- Custom command processing
- Additional API endpoints
- Integration with other services

---

## License

This project is open source and available under the MIT License.

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues for bugs and feature requests.