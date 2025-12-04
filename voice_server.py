from flask import Flask, jsonify, request
from flask_cors import CORS
import queue
import json
import threading
import time
import os
import sys
# import pyttsx3 # Commented out
from datetime import datetime
import webbrowser
# import smtplib # Commented out
# from email.mime.text import MIMEText # Commented out
# from dotenv import load_dotenv # Commented out

import speech_recognition as sr
import sounddevice as sd
import numpy as np
import re # Added import for regex
import threading
import time
import queue
import re
import json
import subprocess
import webbrowser
import os
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS

# Try to import pocketsphinx for offline recognition
try:
    import pocketsphinx
    SPHINX_AVAILABLE = True
    print("✅ CMU Sphinx (offline recognition) available")
except ImportError:
    SPHINX_AVAILABLE = False
    print("⚠️ CMU Sphinx not available, will use Google Speech Recognition only")


app = Flask(__name__)
CORS(app)  # Enable CORS for cross-origin requests

# Load environment variables (Not needed if direct email sending is removed)
# load_dotenv()
# EMAIL = os.getenv("EMAIL")
# PASSWORD = os.getenv("PASSWORD")

# Global variables
recognizer = None
microphone = None # We won't use SpeechRecognition's Microphone class directly
is_listening = False
is_typing_mode = False  # When true, free-form speech will be typed into the active window
is_key_mode = False  # When true, interpret utterances as key presses/combos
tts_engine = None # Will remain None
command_history = []  # Store command history
MAX_HISTORY = 50  # Maximum number of commands to keep
q = queue.Queue() # Queue to hold audio chunks from sounddevice
audio_stream = None # Global to manage the sounddevice stream
# tts_queue = queue.Queue() # New: Queue for TTS messages

# In-memory custom commands store
custom_commands = {}

# Stateful email composition store
compose_email_state = {
    'to': '',
    'subject': '',
    'body': ''
}

def reset_compose_email_state():
    compose_email_state['to'] = ''
    compose_email_state['subject'] = ''
    compose_email_state['body'] = ''

# --- TTS Loop --- # Commented out
# def tts_loop():
#     while True:
#         message = tts_queue.get()
#         if tts_engine:
#             try:
#                 tts_engine.say(message)
#                 tts_engine.runAndWait()
#             except Exception as e:
#                 print(f"TTS loop error: {e}")
#         tts_queue.task_done()

# --- Email Sending Function (Removed) ---
# def send_email(to_email, subject, body):
#     msg = MIMEText(body)
#     msg["Subject"] = subject
#     msg["From"] = EMAIL
#     msg["To"] = to_email

#     try:
#         with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
#             server.login(EMAIL, PASSWORD)
#             server.sendmail(EMAIL, to_email, msg.as_string())
#         print(f"📧 Email sent to {to_email}")
#         return "Email sent successfully!"
#     except Exception as e:
#         print(f"❌ Failed to send email: {e}")
#         raise  # Re-raise to be caught by the caller

# --- Email Parsing Function (Modified for sending data to Electron) ---
def parse_email_for_electron(text):
    to_email = ""
    subject = ""
    body = ""

    # Expect patterns like:
    # send the mail to user@example.com and sub = Subject here finally message = Body here
    # 1) To email (capture right after 'send (the) mail to')
    to_match = re.search(r"send\s+(?:the\s+)?mail\s+to\s*=?\s*(.+?)(?=\s+(?:sub(?:ject)?|finally)|$)", text, re.IGNORECASE)
    if to_match:
        to_raw = to_match.group(1)
        to_email = to_raw.replace(" at ", "@").replace(" dot ", ".")
        to_email = re.sub(r"\s+", "", to_email)

    # 2) Subject (capture text after 'sub =' up to 'finally message =' or end)
    sub_match = re.search(r"(?:sub(?:ject)?|sub)\s*=\s*(.+?)(?=\s+finally\s+message\s*=|$)", text, re.IGNORECASE | re.DOTALL)
    if sub_match:
        subject = sub_match.group(1).strip()

    # 3) Body (capture text after 'finally message =')
    body_match = re.search(r"finally\s+message\s*=\s*(.+)$", text, re.IGNORECASE | re.DOTALL)
    if body_match:
        body = body_match.group(1).strip()

    return {"to": to_email, "subject": subject, "body": body}

# --- Command Mapping Dictionary ---
COMMANDS = {
    "open notepad": lambda: os.system("start notepad"),
    "open calculator": lambda: os.system("start calc"),
    "open word": lambda: os.system("start winword"),
    "open spotify": lambda: os.system("start spotify"),
    "open edge": lambda: os.system("start msedge"),
    "open mail in edge": lambda: webbrowser.open("https://mail.google.com"),
    "open gmail": lambda: webbrowser.open("https://mail.google.com"),
    "open gmail in edge": lambda: webbrowser.open("https://mail.google.com"),
    "open youtube": lambda: webbrowser.open("https://www.youtube.com")
}

def initialize_tts():
    """Initialize text-to-speech engine - now a dummy function"""
    # global tts_engine # No longer needed if not using pyttsx3
    print("✅ Text-to-speech engine initialized (dummy). Speech feedback disabled.")
    return True

def speak_response(message):
    """Speak a response message - now a dummy function"""
    # if tts_engine: # No longer needed
    #     tts_queue.put(message)
    print(f"[TTS Disabled] Would have spoken: {message}")

def add_to_history(command_data):
    """Add command to history"""
    global command_history
    history_entry = {
        'timestamp': datetime.now().isoformat(),
        'text': command_data.get('text', ''),
        'action': command_data.get('action', ''),
        'feedback': command_data.get('feedback', ''),
        'success': command_data.get('action') != 'unknown',
        'data': command_data.get('data')
    }
    command_history.append(history_entry)
    if len(command_history) > MAX_HISTORY:
        command_history = command_history[-MAX_HISTORY:]
    print(f"📝 Added to history: {history_entry}")

def initialize_speech_recognizer():
    """Initialize SpeechRecognition recognizer"""
    global recognizer
    try:
        recognizer = sr.Recognizer()
        print("✅ SpeechRecognition recognizer initialized.")
        print("Will use sounddevice for audio capture with Google Speech Recognition.")
        return True
    except Exception as e:
        print(f"❌ Error initializing speech recognizer: {e}")
        return False

def audio_callback(indata, frames, time, status):
    """Callback for audio input, puts raw bytes into queue"""
    if status:
        print(f"Audio callback status: {status}")
    q.put(bytes(indata))

def transcribe_audio_from_queue():
    """Transcribe audio from the queue using Google Speech Recognition or CMU Sphinx fallback"""
    if recognizer is None:
        print("Speech recognizer not initialized.")
        return ""

    # Collect audio for a short duration or until brief silence detected
    audio_chunks = []
    start_time = time.time()
    silence_start = None
    max_window_s = 2.4
    silence_break_s = 0.7
    while time.time() - start_time < max_window_s:
        try:
            audio_chunk = q.get(timeout=0.08)
            audio_chunks.append(audio_chunk)
            silence_start = None
        except queue.Empty:
            if audio_chunks:
                if silence_start is None:
                    silence_start = time.time()
                elif time.time() - silence_start > silence_break_s:
                    break
            continue

    if not audio_chunks:
        return ""

    combined_audio_data = b"".join(audio_chunks)
    
    # Create an AudioData object from raw audio bytes
    # Assuming 16kHz, 16-bit, mono for Sphinx. Adjust if your sounddevice setup is different.
    audio_data = sr.AudioData(combined_audio_data, 16000, 2) # 16000 Hz, 2 bytes (16-bit) per sample

    # Try Google Speech Recognition first
    try:
        print("🎤 Trying Google Speech Recognition...")
        text = recognizer.recognize_google(audio_data)
        print(f"🎯 Google recognized: '{text}'")
        return text.strip()
    except sr.UnknownValueError:
        print("🔇 Google Speech Recognition could not understand audio.")
    except sr.RequestError as e:
        print(f"❌ Google Speech Recognition service error: {e}")
        
        # Fallback to CMU Sphinx if available
        if SPHINX_AVAILABLE:
            try:
                print("🔄 Falling back to CMU Sphinx (offline recognition)...")
                text = recognizer.recognize_sphinx(audio_data)
                print(f"🎯 Sphinx recognized: '{text}'")
                return text.strip()
            except sr.UnknownValueError:
                print("🔇 CMU Sphinx could not understand audio.")
            except Exception as e:
                print(f"❌ CMU Sphinx error: {e}")
        else:
            print("⚠️ CMU Sphinx not available for fallback")
    except Exception as e:
        print(f"❌ An unexpected error occurred during transcription: {e}")
    
    return ""

def process_voice_command(text):
    """Process recognized voice commands"""
    global is_typing_mode, is_key_mode
    text = text.lower().strip()

    # --- Typing mode controls ---
    if text in ("type", "start typing", "start type mode", "enable typing", "enable type mode"):
        is_typing_mode = True
        return {
            'action': 'type-mode',
            'command': 'type-mode-on',
            'text': text,
            'feedback': 'Typing mode enabled',
            'data': {'enabled': True}
        }
    if text in ("stop typing", "end typing", "disable typing", "stop type mode", "disable type mode"):
        is_typing_mode = False
        return {
            'action': 'type-mode',
            'command': 'type-mode-off',
            'text': text,
            'feedback': 'Typing mode disabled',
            'data': {'enabled': False}
        }
    # Toggle command (from this morning)
    if text in ("toggle type mode", "toggle typing", "toggle type"):
        is_typing_mode = not is_typing_mode
        return {
            'action': 'type-mode',
            'command': 'type-mode-toggle',
            'text': text,
            'feedback': f'Typing mode {"enabled" if is_typing_mode else "disabled"}',
            'data': {'enabled': is_typing_mode}
        }

    # If typing mode is enabled, treat free-form speech as text to type (PRIORITY)
    # This must run before other intent matchers like search/play/etc.
    if is_typing_mode and text:
        # Simple replacements for common dictation terms
        replacements = {
            ' new line': '\n',
            'newline': '\n',
            ' tab ': '\t',
            ' comma': ',',
            ' period': '.',
        }
        typed = text
        for k, v in replacements.items():
            typed = typed.replace(k, v)
        result = {
            'action': 'type-text',
            'command': 'type-freeform',
            'text': typed,
            'feedback': 'Typing'
        }
        # Enqueue so Electron main can execute typing immediately
        add_to_command_queue(result)
        return result

    # --- Key mode controls ---
    if text in ("key", "key mode", "start key mode", "enable key mode", "key-mode on", "start keyboard mode"):
        is_key_mode = True
        result = {
            'action': 'key-mode',
            'command': 'key-mode-on',
            'text': text,
            'feedback': 'Key mode enabled',
            'data': {'enabled': True}
        }
        # Enqueue so UI gets updated
        add_to_command_queue(result)
        return result
    if text in ("stop key mode", "disable key mode", "key-mode off", "end key mode", "stop keyboard mode"):
        is_key_mode = False
        result = {
            'action': 'key-mode',
            'command': 'key-mode-off',
            'text': text,
            'feedback': 'Key mode disabled',
            'data': {'enabled': False}
        }
        # Enqueue so UI gets updated
        add_to_command_queue(result)
        return result
    # Toggle command (from this morning)
    if text in ("toggle key mode", "toggle key", "toggle keyboard mode"):
        is_key_mode = not is_key_mode
        result = {
            'action': 'key-mode',
            'command': 'key-mode-toggle',
            'text': text,
            'feedback': f'Key mode {"enabled" if is_key_mode else "disabled"}',
            'data': {'enabled': is_key_mode}
        }
        # Enqueue so UI gets updated
        add_to_command_queue(result)
        return result

    # --- Virtual Keyboard controls ---
    if text in ("virtual keyboard", "show virtual keyboard", "open virtual keyboard", "display virtual keyboard"):
        result = {
            'action': 'virtual-keyboard',
            'command': 'show-keyboard',
            'text': text,
            'feedback': 'Virtual keyboard shown',
            'data': {'visible': True}
        }
        add_to_command_queue(result)
        return result
    if text in ("hide virtual keyboard", "close virtual keyboard", "remove virtual keyboard"):
        result = {
            'action': 'virtual-keyboard',
            'command': 'hide-keyboard',
            'text': text,
            'feedback': 'Virtual keyboard hidden',
            'data': {'visible': False}
        }
        add_to_command_queue(result)
        return result

    # Spotify playback intents
    # Examples: "open spotify and play song believer", "play believer on spotify", "play spotify believer"
    m_spotify_play = re.search(r"(?:open\s+spotify\s+and\s+)?(?:play\s+(?:song\s+)?)?(.*?)(?:\s+on\s+spotify)?$", text)
    if ('spotify' in text and 'play' in text) or text.startswith('play spotify'):
        query = ''
        # Extract after 'play' and before 'on spotify'
        m = re.search(r"play\s+(?:song\s+)?(.+?)(?:\s+on\s+spotify)?$", text)
        if m:
            query = m.group(1).strip()
        elif m_spotify_play:
            query = m_spotify_play.group(1).strip()
        if query:
            return {
                'action': 'play-spotify-song',
                'command': 'play-spotify-song',
                'text': text,
                'feedback': f'Opening Spotify search for {query}',
                'data': { 'query': query }
            }
        # If no query, just open spotify
        return {
            'action': 'open-spotify',
            'command': 'open spotify',
            'text': text,
            'feedback': 'Opening Spotify'
        }

    # YouTube playback intents
    # Examples: "play believer on youtube", "play on youtube believer", "play believer"
    if 'play' in text and 'youtube' in text:
        yt_match = re.search(r"play\s+(?:song\s+)?(.+?)(?:\s+on\s+youtube)?$", text)
        query = yt_match.group(1).strip() if yt_match else ''
        if query:
            return {
                'action': 'play-youtube-song',
                'command': 'play-youtube-song',
                'text': text,
                'feedback': f'Opening YouTube search for {query}',
                'data': { 'query': query }
            }

    # Generic play fallback → YouTube if no service specified
    if text.startswith('play '):
        qmatch = re.search(r"play\s+(?:song\s+)?(.+)$", text)
        query = qmatch.group(1).strip() if qmatch else ''
        if query:
            return {
                'action': 'play-youtube-song',
                'command': 'play',
                'text': text,
                'feedback': f'Opening YouTube search for {query}',
                'data': { 'query': query }
            }

    # Web search intents
    # Examples: "search \"python tutorials\"", "search for latest news", "find weather chennai"
    if re.match(r"^(search|find)\b", text):
        m = re.search(r"^(?:search|find)(?:\s+for)?\s+\"([^\"]+)\"$", text)
        query = ''
        if m:
            query = m.group(1).strip()
        else:
            m2 = re.search(r"^(?:search|find)(?:\s+for)?\s+(.+)$", text)
            if m2:
                query = m2.group(1).strip()
        if query:
            return {
                'action': 'search-web',
                'command': 'search',
                'text': text,
                'feedback': f'Searching for {query}',
                'data': { 'query': query }
            }

    # Math-only expressions → open calculator and type
    # Example: "3 + 5", "(12*4) - 3"
    if re.fullmatch(r"[0-9+\-*/().\s]+", text):
        return {
            'action': 'open-calculator',
            'command': 'open calculator',
            'text': text,
            'feedback': 'Opening calculator and typing expression'
        }

    # Verbal math intent → parse to expression and open calculator
    m_calc = re.search(r"^(?:calculate|what(?:'| i)?s|write)\s+(.+)$", text)
    if m_calc:
        phrase = m_calc.group(1).strip()
        expr = (phrase
                .replace(' plus ', ' + ')
                .replace(' minus ', ' - ')
                .replace(' times ', ' * ')
                .replace(' x ', ' * ')
                .replace(' into ', ' * ')
                .replace(' divided by ', ' / ')
                .replace(' over ', ' / ')
                .replace(' equals', '')
                .replace(' is', ''))
        # Keep only safe math chars
        expr = re.sub(r"[^0-9+\-*/().]", "", expr)
        if expr:
            return {
                'action': 'open-calculator',
                'command': 'open calculator',
                'text': expr,
                'feedback': 'Opening calculator and typing expression'
            }

    # Step-by-step email composition commands
    # 1) Set recipient
    to_match_step = re.search(r"(?:send\s+)?(?:the\s+)?(?:mail|email|mai)\s+to\s*=?\s*(.+)$", text, re.IGNORECASE)
    if to_match_step:
        to_raw = to_match_step.group(1)
        to_email = to_raw.replace(" at ", "@").replace(" dot ", ".")
        to_email = re.sub(r"\s+", "", to_email)
        compose_email_state['to'] = to_email
        return {
            'action': 'email-compose-progress',
            'command': 'email-to',
            'text': text,
            'feedback': f"Recipient set to {to_email}",
            'data': dict(compose_email_state)
        }

    # 2) Set subject
    subj_match_step = re.search(r"(?:subject|sub)\s*(?:is|=)\s*\"?(.*?)\"?$", text, re.IGNORECASE)
    if subj_match_step and subj_match_step.group(1):
        subject_val = subj_match_step.group(1).strip()
        # Common speech artifacts cleanup
        subject_val = subject_val.replace(' double quote ', '"').replace(' quote ', '"')
        compose_email_state['subject'] = subject_val
        return {
            'action': 'email-compose-progress',
            'command': 'email-subject',
            'text': text,
            'feedback': f"Subject set",
            'data': dict(compose_email_state)
        }

    # 3) Set body/details
    body_match_step = re.search(r"(?:details|detail|message|body)\s*(?:is|are|=)?\s*(.*)$", text, re.IGNORECASE)
    if body_match_step and body_match_step.group(1):
        body_val = body_match_step.group(1).strip()
        compose_email_state['body'] = body_val
        return {
            'action': 'email-compose-progress',
            'command': 'email-body',
            'text': text,
            'feedback': "Message body set",
            'data': dict(compose_email_state)
        }

    # 4) Clear/reset email composition
    if 'clear mail' in text or 'reset mail' in text:
        reset_compose_email_state()
        return {
            'action': 'email-compose-progress',
            'command': 'email-clear',
            'text': text,
            'feedback': 'Email composition cleared',
            'data': dict(compose_email_state)
        }

    # 5) Send/open compose using accumulated state
    if (
        re.search(r"^(send)\s+mail$", text) or
        re.search(r"^(send)\s+email$", text) or
        re.search(r"^compose\s+(?:the\s+)?(?:mail|email)(?:\s+now)?$", text)
    ):
        if compose_email_state['to']:
            if re.search(r"^send\s+(?:mail|email)$", text):
                # Attempt to send via Gmail shortcut (Ctrl+Enter)
                return {
                    'action': 'gmail-send-shortcut',
                    'command': 'gmail-send',
                    'text': text,
                    'feedback': 'Sending email via shortcut (Ctrl+Enter)',
                    'data': dict(compose_email_state)
                }
            else:
                result = {
                    'action': 'send-mail-compose-v2',
                    'command': 'send mail',
                    'text': text,
                    'feedback': 'Opening Gmail compose',
                    'data': dict(compose_email_state)
                }
                # Do not reset automatically to allow quick edits; user can say clear mail
                return result
        else:
            return {
                'action': 'email-compose-progress',
                'command': 'email-missing-to',
                'text': text,
                'feedback': 'Please specify recipient using "send mail to ..."',
                'data': dict(compose_email_state)
            }

    # Priority 1: Complex, multi-part commands
    if re.search(r'send\s+(?:the\s+)?mail\s+to', text, re.IGNORECASE):
        email_data = parse_email_for_electron(text)
        return {
            'action': 'send-mail-compose-v2', # This tells Electron to open compose window
            'command': 'send mail to',
            'text': text,
            'feedback': 'Opening Gmail compose with details',
            'data': email_data # Pass parsed data to Electron
        }
    elif text.startswith('type '):
        text_to_type = text[5:]
        return {
            'action': 'type-text',
            'command': 'type',
            'text': text_to_type,
            'feedback': f'Typing: {text_to_type}'
        }
    
    elif 'move mouse' in text or 'move to' in text: # Order matters for partial matches
        return {'action': 'mouse-move', 'command': 'move', 'text': text, 'feedback': 'Moving mouse'}
    
    # If key mode is enabled, interpret utterances as key events where possible
    if is_key_mode and text:
        # Try modifier combinations first: shift/ctrl/alt + key (digits, letters, function keys, tab, space, etc.)
        # More flexible patterns to catch "control a", "ctrl c", "control plus a", etc.
        m_combo_any = re.search(r"\b(shift|ctrl|control|alt)(?:\s*\+|\s+plus\s*|\s+and\s*|\s+)(.+)", text, re.IGNORECASE)
        if not m_combo_any:
            # Also try patterns like "ctrl a" or "control a" (no explicit connector)
            m_combo_any = re.search(r"\b(shift|ctrl|control|alt)\s+([a-z0-9])\b", text, re.IGNORECASE)
        
        if m_combo_any:
            mod = m_combo_any.group(1).lower()
            raw_key = m_combo_any.group(2).strip().lower()
            mod = 'control' if mod in ('ctrl', 'control') else mod
            spoken_map = {
                'space': 'space', 'spacebar': 'space', 'space bar': 'space',
                'enter': 'enter', 'return': 'enter', 'tab': 'tab',
                'escape': 'escape', 'esc': 'escape', 'backspace': 'backspace',
                'caps lock': 'caps_lock', 'num lock': 'num_lock'
            }
            key = spoken_map.get(raw_key, raw_key)
            m_f = re.fullmatch(r"f\s*(1[0-2]|[1-9])", key)
            if m_f:
                key = f"f{m_f.group(1)}"
            result = {
                'action': 'key-combo',
                'command': 'key-combo',
                'text': text,
                'feedback': f'Pressing {mod} + {key}',
                'data': { 'keys': [mod, key] }
            }
            add_to_command_queue(result)
            return result
        # Single common keys inside the phrase
        common_keys = {
            'tab': 'tab', 'space': 'space', 'spacebar': 'space', 'space bar': 'space',
            'enter': 'enter', 'return': 'enter', 'backspace': 'backspace',
            'escape': 'escape', 'esc': 'escape', 'delete': 'delete'
        }
        for spoken, keyval in common_keys.items():
            if re.search(rf"\b{re.escape(spoken)}\b", text):
                result = {
                    'action': 'key-press',
                    'command': 'key-press',
                    'text': text,
                    'feedback': f'Pressing {keyval}',
                    'data': { 'key': keyval }
                }
                add_to_command_queue(result)
                return result
    
    # --- Single key presses (keyboard) ---
    # Common key names and synonyms
    key_aliases = {
        'enter': ['enter', 'return', 'next line', 'new line'],
        'backspace': ['backspace'],
        'tab': ['tab'],
        'space': ['space', 'spacebar', 'space bar'],
        'escape': ['escape', 'esc'],
        'delete': ['delete', 'del'],
        'caps_lock': ['caps lock', 'capslock'],
        'num_lock': ['num lock', 'numlock'],
        'up': ['arrow up', 'up arrow', 'up'],
        'down': ['arrow down', 'down arrow', 'down'],
        'left': ['arrow left', 'left arrow', 'left'],
        'right': ['arrow right', 'right arrow', 'right']
    }
    for key, variants in key_aliases.items():
        for v in variants:
            if text == v or text == f'press {v}' or text == f'hit {v}':
                result = {
                    'action': 'key-press',
                    'command': 'key-press',
                    'text': text,
                    'feedback': f'Pressing {key}',
                    'data': { 'key': key }
                }
                add_to_command_queue(result)
                return result

    # Function keys: f1..f12
    m_fn = re.fullmatch(r"(?:press\s+|hit\s+)?f\s*(1[0-2]|[1-9])", text)
    if m_fn:
        result = {
            'action': 'key-press',
            'command': 'key-press',
            'text': text,
            'feedback': f"Pressing F{m_fn.group(1)}",
            'data': { 'key': f"f{m_fn.group(1)}" }
        }
        add_to_command_queue(result)
        return result

    # Modifier combinations: shift/control/alt + key (e.g., shift a, ctrl c, alt f4, shift tab, shift space)
    m_combo = re.fullmatch(r"(?:press\s+|hit\s+)?(shift|ctrl|control|alt)(?:\s*\+|\s+plus\s+|\s+and\s+|\s+)\s*(.+)", text)
    if m_combo:
        mod = m_combo.group(1)
        raw_key = m_combo.group(2).strip()
        mod = 'control' if mod in ('ctrl', 'control') else mod
        # Normalize common spoken keys
        spoken_map = {
            'space': 'space', 'spacebar': 'space', 'space bar': 'space',
            'enter': 'enter', 'return': 'enter', 'tab': 'tab',
            'escape': 'escape', 'esc': 'escape', 'backspace': 'backspace',
            'caps lock': 'caps_lock', 'num lock': 'num_lock'
        }
        key = spoken_map.get(raw_key, raw_key)
        # F-keys in combo like alt f4
        m_f = re.fullmatch(r"f\s*(1[0-2]|[1-9])", key)
        if m_f:
            key = f"f{m_f.group(1)}"
        # Single letters or digits fine as-is
        result = {
            'action': 'key-combo',
            'command': 'key-combo',
            'text': text,
            'feedback': f'Pressing {mod} + {key}',
            'data': { 'keys': [mod, key] }
        }
        add_to_command_queue(result)
        return result
    
    # Apply custom commands first, if any phrase matches within text
    for phrase, details in custom_commands.items():
        if phrase in text:
            return {
                'action': details.get('action', 'custom-command'),
                'command': phrase,
                'text': text,
                'feedback': details.get('feedback', f'Executing {phrase}')
            }

    # Priority 2: Simple, single-phrase commands (check 'in text' for flexibility)
    if 'click' in text:
        return {'action': 'mouse-click', 'command': 'click', 'text': text, 'feedback': 'Clicking mouse'}
    elif 'scroll up' in text:
        return {'action': 'scroll-up', 'command': 'scroll up', 'text': text, 'feedback': 'Scrolling up'}
    elif 'scroll down' in text:
        return {'action': 'scroll-down', 'command': 'scroll down', 'text': text, 'feedback': 'Scrolling down'}
    elif 'stop listening' in text:
        return {'action': 'stop-listening', 'command': 'stop listening', 'text': text, 'feedback': 'Stopping voice recognition'}
    elif text == 'space' or text == 'spacebar' or text == 'space bar':
        return {'action': 'key-press', 'command': 'key-press', 'text': text, 'feedback': 'Pressing space', 'data': {'key': 'space'}}
    
    # Priority 3: App opening commands (as lambda functions) - these are executed directly by Python
    for command_phrase, action_func in COMMANDS.items():
        if command_phrase in text:
            action_func() # Execute the command directly
            return {
                'action': command_phrase.replace(' ', '-'), # Convert to slug-like action name
                'command': command_phrase,
                'text': text,
                'feedback': f'Opening {command_phrase.replace("open ", "")}'
            }
    
    return {
        'action': 'unknown',
        'command': None,
        'text': text,
        'feedback': f'I heard: {text}. Please try a different command.'
    }

# ---- Custom Commands CRUD API ----
@app.route('/custom-commands', methods=['GET'])
def list_custom_commands():
    try:
        return jsonify({
            'commands': custom_commands,
            'count': len(custom_commands)
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/custom-commands', methods=['POST'])
def add_custom_command():
    try:
        data = request.get_json() or {}
        phrase = data.get('phrase', '').strip().lower()
        action = data.get('action', '').strip()
        feedback = data.get('feedback', '').strip()
        if not phrase or not action:
            return jsonify({'error': 'phrase and action are required'}), 400
        custom_commands[phrase] = {'action': action, 'feedback': feedback}
        return jsonify({'message': 'Custom command added', 'phrase': phrase, 'details': custom_commands[phrase]}), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/custom-commands/<path:phrase>', methods=['PUT'])
def update_custom_command(phrase):
    try:
        key = phrase.strip().lower()
        if key not in custom_commands:
            return jsonify({'error': 'Command not found'}), 404
        data = request.get_json() or {}
        if 'action' in data:
            custom_commands[key]['action'] = data['action']
        if 'feedback' in data:
            custom_commands[key]['feedback'] = data['feedback']
        return jsonify({'message': 'Custom command updated', 'phrase': key, 'details': custom_commands[key]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/custom-commands/<path:phrase>', methods=['DELETE'])
def delete_custom_command(phrase):
    try:
        key = phrase.strip().lower()
        if key in custom_commands:
            del custom_commands[key]
            return jsonify({'message': 'Custom command deleted', 'phrase': key})
        return jsonify({'error': 'Command not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/process-manual-command', methods=['POST'])
def process_manual_command_route():
    """Process a manual text command directly without audio recognition"""
    try:
        data = request.get_json()
        text = data.get('text', '')
        if not text:
            return jsonify({'error': 'No text provided for manual command'}), 400

        print(f"⚙️ Processing manual command: '{text}'")
        command_result = process_voice_command(text)
        add_to_history(command_result)
        if command_result.get('feedback'):
            speak_response(command_result['feedback'])
        return jsonify({'text': text, 'command': command_result})
    except Exception as e:
        print(f"❌ Error processing manual command: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/process-command', methods=['POST'])
def process_command():
    try:
        data = request.get_json()
        command = data.get('command', '').strip()
        
        if not command:
            return jsonify({'error': 'No command provided'}), 400
        
        # Process the command as if it was spoken
        result = process_voice_command(command)
        
        # Add to history
        add_to_history(result)
        
        return jsonify(result)
    except Exception as e:
        print(f"Error processing command: {e}")
        return jsonify({'error': str(e)}), 500

def listen_continuously_sd():
    """Continuous listening function using sounddevice for audio capture"""
    global is_listening, audio_stream
    if recognizer is None:
        print("Speech recognizer not initialized.")
        return

    # Clear the queue before starting continuous listening
    while not q.empty():
        try:
            q.get_nowait()
        except queue.Empty:
            break

    try:
        # Open sounddevice stream
        audio_stream = sd.InputStream(
            samplerate=16000, # 16kHz
            channels=1, # Mono
            dtype='int16', # 16-bit
            callback=audio_callback,
            blocksize=8192 # Slower but more stable capture window
        )
        audio_stream.start()
        print("🎤 Voice recognition active (continuous - sounddevice) - Speak commands...")
        speak_response("Voice recognition is now active. Speak your commands.")

        while is_listening:
            # Transcribe every few seconds based on collected audio
            text = transcribe_audio_from_queue()
            if text:
                command_result = process_voice_command(text)
                print(f"📋 Command: {command_result}")
                add_to_history(command_result)
                if command_result.get('feedback'):
                    speak_response(command_result['feedback'])
            time.sleep(0.5) # Slower loop for stability

    except Exception as e:
        print(f"Error in continuous listening (sounddevice): {e}")
    finally:
        if audio_stream and audio_stream.running:
            audio_stream.stop()
            audio_stream.close()
        print("Continuous listening stopped.")

@app.route('/start-listening', methods=['POST'])
def start_listening():
    """Start continuous voice recognition"""
    global is_listening
    if recognizer is None:
        return jsonify({'error': 'Speech recognizer not initialized'}), 500
    if is_listening:
        return jsonify({'message': 'Already listening'}), 200
    is_listening = True
    threading.Thread(target=listen_continuously_sd, daemon=True).start()
    return jsonify({'message': 'Voice recognition started'})

@app.route('/stop-listening', methods=['POST'])
def stop_listening():
    """Stop continuous voice recognition"""
    global is_listening, audio_stream
    is_listening = False # Signal the background thread to stop
    if audio_stream and audio_stream.running:
        audio_stream.stop()
        audio_stream.close()
    speak_response("Voice recognition stopped")
    return jsonify({'message': 'Voice recognition stopped'})

@app.route('/listen-once', methods=['POST'])
def listen_once():
    """Listen for a single command"""
    if recognizer is None:
        return jsonify({'error': 'Speech recognizer not initialized'}), 500
    try:
        speak_response("Listening for your command")
        
        # Ensure queue is clear before starting to listen for a single command
        while not q.empty():
            try:
                q.get_nowait()
            except queue.Empty:
                break

        with sd.InputStream(
            samplerate=16000, 
            channels=1,
            dtype='int16',
            callback=audio_callback,
            blocksize=8192
        ) as stream:
            stream.start()
            text = transcribe_audio_from_queue()
            stream.stop()
            stream.close()
        
        if text:
            command_result = process_voice_command(text)
            add_to_history(command_result)
            if command_result.get('feedback'):
                speak_response(command_result['feedback'])
            return jsonify({'text': text, 'command': command_result})
        else:
            speak_response("I didn't hear anything. Please try again.")
            return jsonify({'text': '', 'command': None})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/speak', methods=['POST'])
def speak_text():
    """Speak custom text"""
    try:
        data = request.get_json()
        text = data.get('text', '')
        if text:
            speak_response(text)
            return jsonify({'message': f'Speaking: {text}'})
        else:
            return jsonify({'error': 'No text provided'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/history', methods=['GET'])
def get_history():
    """Get command history"""
    try:
        limit = request.args.get('limit', 10, type=int)
        offset = request.args.get('offset', 0, type=int)
        recent_history = command_history[-(limit + offset):-offset] if offset > 0 else command_history[-limit:]
        return jsonify({
            'history': recent_history,
            'total': len(command_history),
            'limit': limit,
            'offset': offset
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/history/clear', methods=['POST'])
def clear_history():
    """Clear command history"""
    global command_history
    try:
        command_history.clear()
        return jsonify({'message': 'History cleared'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/status', methods=['GET'])
def get_status():
    """Get server status"""
    return jsonify({
        'status': 'running',
        'speech_recognizer_initialized': recognizer is not None,
        'tts_available': tts_engine is not None,
        'is_listening': is_listening,
        'history_count': len(command_history)
    })

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({'status': 'healthy'})

@app.route('/test-virtual-keyboard', methods=['GET'])
def test_virtual_keyboard():
    """Test endpoint for virtual keyboard commands"""
    try:
        # Simulate a virtual keyboard command
        test_command = {
            'action': 'virtual-keyboard',
            'command': 'show-keyboard',
            'text': 'test virtual keyboard',
            'feedback': 'Test virtual keyboard command',
            'data': {'visible': True}
        }
        print(f"🧪 Test virtual keyboard command: {test_command}")
        
        # Add to command queue so main process can pick it up
        add_to_command_queue(test_command)
        
        return jsonify(test_command)
    except Exception as e:
        print(f"Error in test endpoint: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/simulate-voice-command', methods=['POST'])
def simulate_voice_command():
    """Simulate a voice command for testing"""
    try:
        data = request.get_json()
        command_text = data.get('command', '').strip()
        
        if not command_text:
            return jsonify({'error': 'No command provided'}), 400
        
        print(f"🎤 Simulating voice command: '{command_text}'")

        # Process the command as if it was spoken
        result = process_voice_command(command_text)

        # Add to history
        add_to_history(result)

        # Add to command queue for main process
        add_to_command_queue(result)
        
        return jsonify(result)
    except Exception as e:
        print(f"Error simulating voice command: {e}")
        return jsonify({'error': str(e)}), 500

# Global command queue for main process communication
command_queue = []
MAX_QUEUE_SIZE = 10

def add_to_command_queue(command_data):
    """Add command to queue for main process to retrieve"""
    global command_queue
    command_queue.append(command_data)
    if len(command_queue) > MAX_QUEUE_SIZE:
        command_queue = command_queue[-MAX_QUEUE_SIZE:]
    print(f"📥 Added to command queue: {command_data}")

@app.route('/get-command-queue', methods=['GET'])
def get_command_queue():
    """Get commands from the queue for main process"""
    global command_queue
    try:
        # Return and clear the queue
        commands = command_queue.copy()
        command_queue.clear()
        return jsonify({
            'commands': commands,
            'count': len(commands)
        })
    except Exception as e:
        print(f"Error getting command queue: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/queue-status', methods=['GET'])
def queue_status():
    """Get current status of the command queue"""
    try:
        return jsonify({
            'queue_size': len(command_queue),
            'queue_contents': command_queue,
            'sphinx_available': SPHINX_AVAILABLE,
            'recognizer_initialized': recognizer is not None
        })
    except Exception as e:
        print(f"Error getting queue status: {e}")
        return jsonify({'error': str(e)}), 500



if __name__ == '__main__':
    print("🚀 Starting Voice Recognition Server with Google Speech Recognition (via sounddevice)...")
    if not initialize_tts():
        print("⚠️  Text-to-speech not available, continuing without voice feedback")
    if not initialize_speech_recognizer():
        print("❌ Failed to initialize speech recognizer. Exiting...")
        sys.exit(1)
    print("✅ Voice server ready on http://localhost:5005")
    print("📝 Available endpoints:")
    print("   POST /start-listening - Start continuous listening")
    print("   POST /stop-listening - Stop continuous listening")
    print("   POST /listen-once - Listen for single command")
    print("   POST /speak - Speak custom text")
    print("   GET  /history - Get command history")
    print("   POST /history/clear - Clear command history")
    print("   GET  /status - Get server status")
    print("   GET  /health - Health check")
    app.run(host='0.0.0.0', port=5005, debug=False)