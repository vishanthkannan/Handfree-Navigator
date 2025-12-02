const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, exec, spawn } = require('child_process');
const keySender = require('node-key-sender');
const fetch = require('node-fetch');

// Global mainWindow reference
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  mainWindow.loadFile('index.html');
}

// Manage Python voice server lifecycle
let voiceServerProcess = null;
let voiceServerPid = null; // Windows detached console PID
let voiceServerLaunched = false;
let voiceServerStarting = false;
// Track Gmail compose state for progressive email filling
let gmailComposeOpened = false;
let lastComposeState = { to: '', subject: '', body: '' };
// Eye control process
let eyeProcess = null;
let eyeProcessPid = null; // Windows detached console PID
let eyeLaunched = false;

function startVoiceServer() {
  if (voiceServerProcess) {
    return;
  }
  if (process.platform === 'win32' && (voiceServerLaunched || voiceServerStarting)) {
    return;
  }
  try {
    const serverScript = path.join(__dirname, 'voice_server.py');
    if (process.platform === 'win32') {
      // Prefer system 'python' since user confirmed it works manually
      // Fall back to bundled venvs if desired later
      const pyCandidates = ['python', path.join(__dirname, 'venv', 'Scripts', 'python.exe'), path.join(__dirname, '.venv311', 'Scripts', 'python.exe')];
      const py = pyCandidates[0];
      voiceServerStarting = true;
      const cmd = `start "" cmd /k set PYTHONIOENCODING=utf-8 ^& "${py}" "${serverScript}"`;
      exec(cmd, { cwd: __dirname }, (err) => {
        if (err) console.error('voice-start error:', err);
      });
      // Mark as launched (we'll still health-check before calls)
      setTimeout(() => { voiceServerLaunched = true; voiceServerStarting = false; }, 500);
    } else {
      const pythonExecutable = 'python3';
      voiceServerProcess = spawn(pythonExecutable, [serverScript], {
        cwd: __dirname,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      voiceServerProcess.stdout.on('data', (data) => {
        console.log(`[voice_server] ${data.toString().trim()}`);
      });
      voiceServerProcess.stderr.on('data', (data) => {
        console.error(`[voice_server:error] ${data.toString().trim()}`);
      });
      voiceServerProcess.on('exit', (code, signal) => {
        console.log(`Voice server exited with code ${code} signal ${signal}`);
        voiceServerProcess = null;
      });
    }
  } catch (error) {
    console.error('Failed to start voice server:', error);
  }
}

function stopVoiceServer() {
  try {
    if (process.platform === 'win32') {
      if (voiceServerPid) {
        exec(`taskkill /pid ${voiceServerPid} /T /F`);
        voiceServerPid = null;
        voiceServerLaunched = false;
      }
    } else if (voiceServerProcess) {
      voiceServerProcess.kill('SIGTERM');
      voiceServerProcess = null;
    }
  } catch (e) {
    console.error('Error stopping voice server:', e);
  }
}

app.whenReady().then(() => {
  createWindow();
  
  // Start polling for commands from voice server
  startCommandPolling();
  
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopVoiceServer();
  if (eyeProcess) {
    if (process.platform === 'win32') {
      if (eyeProcessPid) {
        exec(`taskkill /pid ${eyeProcessPid} /T /F`);
      }
    } else {
      eyeProcess.kill('SIGTERM');
    }
  }
  stopCommandPolling();
});

// (No additional lifecycle handlers in original)

// --- Existing IPC Handlers --- //
ipcMain.on('robot-type', (event, text) => {
  keySender.sendText(text);
});

ipcMain.on('mouse-action', (event, action, ...args) => {
  execFile('python', ['mouse_control.py', action, ...args], (error, stdout, stderr) => {
    if (error) {
      console.error('pyautogui error:', error);
    }
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  });
});

ipcMain.on('open-word', () => {
  exec('start winword', (error) => {
    if (error) {
      console.error('Failed to open Word:', error);
    }
  });
});

ipcMain.on('open-mail', () => {
  exec('start mailto:', (error) => {
    if (error) {
      console.error('Failed to open mail client:', error);
    }
  });
});

ipcMain.on('open-gmail', () => {
  exec('start msedge https://mail.google.com/', (error) => {
    if (error) {
      console.error('Failed to open Gmail in Edge:', error);
    }
  });
});

ipcMain.on('send-mail', (event, to, subject, body) => {
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  exec(`start msedge "${gmailUrl}"`);
});

ipcMain.on('open-notepad', () => {
  exec('start notepad');
});

ipcMain.on('open-calculator', () => {
  exec('start calc');
});

ipcMain.on('open-paint', () => {
  exec('start mspaint');
});

ipcMain.on('open-chrome', () => {
  exec('start chrome');
});

ipcMain.on('open-edge', () => {
  exec('start msedge');
});

// --- NEW Voice Server IPC Handlers --- //
const VOICE_SERVER_URL = 'http://localhost:5005';

async function callVoiceServer(endpoint, method = 'GET', body = null) {
  try {
    const options = { method };
    if (body) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    } else if (method === 'POST') {
      // Ensure POST has a body to avoid odd server handling; server ignores unknown JSON
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({});
    }
    const response = await fetch(`${VOICE_SERVER_URL}${endpoint}`, options);
    return await response.json();
  } catch (error) {
    console.error(`Error calling voice server ${endpoint}:`, error);
    return { error: `Failed to connect to voice server: ${error.message}` };
  }
}

// Ensure voice server is reachable before sending control commands
async function waitForVoiceServerReady(timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${VOICE_SERVER_URL}/health`);
      if (r.ok) return true;
    } catch (_) {}
    await new Promise(res => setTimeout(res, 300));
  }
  return false;
}

// ================= NLP INTENT PARSER ================= //
const APPLICATION_SYNONYMS = {
  edge: ['edge', 'microsoft edge', 'ms edge'],
  chrome: ['chrome', 'google chrome'],
  word: ['word', 'microsoft word'],
  notepad: ['notepad'],
  calculator: ['calculator', 'calc'],
  paint: ['paint', 'mspaint'],
  spotify: ['spotify'],
  camera: ['camera'],
  youtube: ['youtube', 'you tube']
};

function normalize(text) {
  return (text || '').toLowerCase().trim();
}

function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : '';
}

function matchApplication(text) {
  const t = normalize(text);
  for (const [app, variants] of Object.entries(APPLICATION_SYNONYMS)) {
    if (variants.some(v => t.includes(v))) return app;
  }
  return '';
}

function extractSubject(text) {
  // subject ... or subject is ... or with subject ...
  const m = text.match(/subject(?:\s+is)?\s+([^,]+?)(?=\s+and\s+body|\s+body|$)/i);
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

function extractBody(text) {
  const m = text.match(/body(?:\s+is)?\s+(.+)$/i);
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

function extractSearchQuery(text) {
  const m = text.match(/(?:search\s+(?:for)?|find)\s+(.+)/i);
  return m ? m[1].trim() : '';
}

function extractCalcExpression(text) {
  // e.g., add 2 plus 2, calculate 5 times 3, 10 divided by 2
  let t = normalize(text)
    .replace(/plus/g, '+')
    .replace(/minus/g, '-')
    .replace(/times|x/g, '*')
    .replace(/divided by|over/g, '/')
    .replace(/equals|is/g, '=');
  const m = t.match(/(?:calculate|calc|what's|what is|compute|add|subtract|multiply|divide)?\s*([0-9+\-*/().\s]+)=?/);
  return m ? m[1].trim() : '';
}

function extractMusic(text) {
  const service = /youtube/i.test(text) ? 'youtube' : (/spotify/i.test(text) ? 'spotify' : '');
  const m = text.match(/play\s+(.*?)(?:\s+on\s+(?:youtube|spotify))?$/i);
  return { song: m ? m[1].trim() : '', service };
}

function classifyIntent(text) {
  const t = normalize(text);
  if (/^(open|launch|start)\b/.test(t)) return 'open_application';
  if (/^send\s+(?:an\s+)?(?:email|mail)\b/.test(t) || /send\s+.*@/.test(t)) return 'send_email';
  if (/^play\b/.test(t)) return 'play_music';
  if (/^(search|find)\b/.test(t)) return 'search_web';
  if (/(calculate|what's|what is|compute|add|subtract|multiply|divide)/.test(t)) return 'calculate_expression';
  return 'unknown';
}

function parseEntities(intent, text) {
  switch (intent) {
    case 'open_application':
      return { name: matchApplication(text) };
    case 'send_email':
      return {
        recipient: extractEmail(text),
        subject: extractSubject(text),
        body: extractBody(text)
      };
    case 'play_music':
      return extractMusic(text);
    case 'search_web':
      return { query: extractSearchQuery(text) };
    case 'calculate_expression':
      return { expression: extractCalcExpression(text) };
    default:
      return {};
  }
}

async function handleIntent(event, intent, entities, rawText) {
  switch (intent) {
    case 'open_application': {
      const app = entities.name;
      if (!app) break;
      switch (app) {
        case 'edge': ipcMain.emit('open-edge'); break;
        case 'chrome': ipcMain.emit('open-chrome'); break;
        case 'word': ipcMain.emit('open-word'); break;
        case 'notepad': ipcMain.emit('open-notepad'); break;
        case 'calculator': ipcMain.emit('open-calculator'); break;
        case 'paint': ipcMain.emit('open-paint'); break;
        case 'spotify': ipcMain.emit('open-spotify'); break;
        case 'camera': exec('start microsoft.windows.camera:'); break;
        case 'youtube': exec('start msedge https://www.youtube.com/'); break;
        default: break;
      }
      return { action: 'open_application', data: { name: app } };
    }
    case 'send_email': {
      const { recipient, subject, body } = entities;
      if (!recipient) break;
      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(recipient)}&su=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
      exec(`start msedge "${gmailUrl}"`);
      return { action: 'send_email', data: { recipient, subject, body } };
    }
    case 'play_music': {
      const { song, service } = entities;
      if (!song && !service) break;
      if (service === 'spotify') {
        const url = `https://open.spotify.com/search/${encodeURIComponent(song)}`;
        exec(`start msedge "${url}"`);
      } else {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(song)}`;
        exec(`start msedge "${url}"`);
      }
      return { action: 'play_music', data: { song, service } };
    }
    case 'search_web': {
      const { query } = entities;
      if (!query) break;
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      exec(`start msedge "${url}"`);
      return { action: 'search_web', data: { query } };
    }
      case 'search-web': {
        const q = (commandData.data && commandData.data.query) ? commandData.data.query : '';
        if (q) {
          const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
          exec(`start msedge "${url}"`);
        }
        break;
      }
    case 'calculate_expression': {
      const { expression } = entities;
      if (!expression) break;
      exec('start calc');
      setTimeout(() => {
        try {
          keySender.sendText(expression.replace(/\s+/g, '') + '=');
        } catch (e) {
          console.error('keySender typing failed:', e);
        }
      }, 1200);
      return { action: 'calculate_expression', data: { expression } };
    }
    default:
      return { action: 'unknown', data: { text: rawText } };
  }
}

ipcMain.handle('process-command', async (event, text) => {
  const intent = classifyIntent(text || '');
  const entities = parseEntities(intent, text || '');
  const result = await handleIntent(event, intent, entities, text || '');
  if (!result || result.action === 'unknown') {
    return { error: "I didn’t understand, could you rephrase?", raw: text };
  }
  event.sender.send('command-processed', result);
  return result;
});

// Handler for continuous listening (start)
ipcMain.handle('voice-start-listening', async () => {
  // Try to start server if not launched on Windows
  if (process.platform === 'win32' && !voiceServerLaunched) {
    startVoiceServer();
  }
  const ready = await waitForVoiceServerReady(8000);
  if (!ready) return { error: 'Voice server not reachable' };
  return callVoiceServer('/start-listening', 'POST');
});

// Handler for continuous listening (stop)
ipcMain.handle('voice-stop-listening', async () => {
  return callVoiceServer('/stop-listening', 'POST');
});

// Handler for single command listening
ipcMain.handle('voice-listen-once', async (event) => {
  if (process.platform === 'win32' && !voiceServerLaunched) {
    startVoiceServer();
  }
  const ready = await waitForVoiceServerReady(8000);
  if (!ready) return { error: 'Voice server not reachable' };
  const result = await callVoiceServer('/listen-once', 'POST');
  // Pass command result back to renderer for action processing
  if (result.command && result.command.action && result.command.action !== 'unknown') {
    // We'll let renderer handle actions based on text and command object
    // The voice-result event will trigger the existing command parsing in renderer
  }
  return result; // Return the full result to the renderer
});

// Handler for text-to-speech
ipcMain.handle('voice-speak', async (event, text) => {
  return callVoiceServer('/speak', 'POST', { text });
});

// Handler for getting server status
ipcMain.handle('voice-get-status', async () => {
  if (process.platform === 'win32' && !voiceServerLaunched) {
    startVoiceServer();
  }
  const ready = await waitForVoiceServerReady(8000);
  if (!ready) return { error: 'Voice server not reachable' };
  return callVoiceServer('/status');
});

// Handler for getting command history
ipcMain.handle('voice-get-history', async (event, limit, offset) => {
  if (process.platform === 'win32' && !voiceServerLaunched) {
    startVoiceServer();
  }
  const ready = await waitForVoiceServerReady(8000);
  if (!ready) return { error: 'Voice server not reachable' };
  return callVoiceServer(`/history?limit=${limit}&offset=${offset}`);
});

// Handler for clearing command history
ipcMain.handle('voice-clear-history', async () => {
  if (process.platform === 'win32' && !voiceServerLaunched) {
    startVoiceServer();
  }
  const ready = await waitForVoiceServerReady(8000);
  if (!ready) return { error: 'Voice server not reachable' };
  return callVoiceServer('/history/clear', 'POST');
});

// --- NEW Eye Control IPC Handlers --- //
ipcMain.handle('eye-start', async () => {
  try {
    if (process.platform === 'win32') {
      const script = path.join(__dirname, 'eye_control.py');
      const venvPy = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
      const venv311Py = path.join(__dirname, '.venv311', 'Scripts', 'python.exe');
      const py = fs.existsSync(venvPy) ? venvPy : (fs.existsSync(venv311Py) ? venv311Py : 'python');
      const esc = (s) => s.replace(/'/g, "''");
      const pwshArgs = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `Start-Process -FilePath '${esc(py)}' -ArgumentList @('${esc(script)}') -WorkingDirectory '${esc(__dirname)}' -WindowStyle Normal -PassThru | Select-Object -Expand Id`
      ];
      execFile('powershell.exe', pwshArgs, (err, stdout) => {
        if (err) {
          console.error('eye-start error:', err);
          return;
        }
        const pid = parseInt(String(stdout).trim(), 10);
        if (!Number.isNaN(pid)) {
          eyeProcessPid = pid;
          eyeLaunched = true;
        }
      });
      return { running: true };
    }
    if (eyeProcess) return { running: true };
    const pythonExecutable = 'python3';
    const script = path.join(__dirname, 'eye_control.py');
    eyeProcess = spawn(pythonExecutable, [script], { cwd: __dirname, env: process.env, stdio: 'inherit' });
    eyeProcess.on('exit', () => { eyeProcess = null; });
    return { running: true };
  } catch (e) {
    return { running: false, error: e.message };
  }
});

ipcMain.handle('eye-stop', async () => {
  try {
    if (process.platform === 'win32') {
      if (eyeProcessPid) {
        exec(`taskkill /pid ${eyeProcessPid} /T /F`);
        eyeProcessPid = null;
      }
      return { running: false };
    }
    if (eyeProcess) {
      eyeProcess.kill('SIGTERM');
      eyeProcess = null;
    }
    return { running: false };
  } catch (e) {
    return { running: !!(eyeProcess || eyeProcessPid), error: e.message };
  }
});

ipcMain.handle('eye-status', async () => {
  return { running: process.platform === 'win32' ? !!eyeLaunched : !!eyeProcess };
});

function executeVoiceCommand(event, commandData) {
  // Map server-processed commands to existing Electron actions
  if (commandData && commandData.action) {
    switch (commandData.action) {
      case 'email-compose-progress': {
        // Update tracked compose state and open/update Gmail compose immediately
        const data = commandData.data || {};
        lastComposeState = {
          to: data.to || lastComposeState.to || '',
          subject: data.subject || lastComposeState.subject || '',
          body: data.body || lastComposeState.body || ''
        };
        const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lastComposeState.to)}&su=${encodeURIComponent(lastComposeState.subject)}&body=${encodeURIComponent(lastComposeState.body)}`;
        exec(`start msedge "${gmailUrl}"`);
        gmailComposeOpened = true;
        // Also notify renderer to update UI
        event.sender.send('voice-command-received', commandData);
        break;
      }
      case 'open-word':
        exec('start winword');
        break;
      case 'open-mail':
        exec('start mailto:');
        break;
      case 'open-gmail':
        exec('start msedge https://mail.google.com/');
        break;
      case 'open-notepad':
        exec('start notepad');
        break;
      case 'open-calculator':
        exec('start calc');
        // If a number, type it into calculator
        if (commandData.text && /^[\d+\-*/().\\s]+$/.test(commandData.text)) {
          const expr = (commandData.text || '').replace(/\s+/g, '') + '=';
          setTimeout(() => {
            try {
              keySender.sendText(expr);
            } catch (e) {
              console.error('keySender typing failed:', e);
            }
          }, 1200);
        }
        break;
      case 'open-paint':
        exec('start mspaint');
        break;
      case 'open-chrome':
        exec('start chrome');
        break;
      case 'open-edge':
        exec('start msedge');
        break;
      case 'open-spotify':
        exec('start spotify');
        break;
      case 'play-spotify-song': {
        const q = (commandData.data && commandData.data.query) ? commandData.data.query : '';
        if (q) {
          const url = `https://open.spotify.com/search/${encodeURIComponent(q)}`;
          exec(`start msedge "${url}"`);
        } else {
          exec('start spotify');
        }
        break;
      }
      case 'play-youtube-song': {
        const q = (commandData.data && commandData.data.query) ? commandData.data.query : '';
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
        exec(`start msedge "${url}"`);
        break;
      }
      case 'mouse-click':
        execFile('python', ['mouse_control.py', 'click']);
        break;
      case 'scroll-up':
        execFile('python', ['mouse_control.py', 'scrollup']);
        break;
      case 'scroll-down':
        execFile('python', ['mouse_control.py', 'scrolldown']);
        break;
      case 'mouse-move':
        // Assuming format like "move mouse 100 200" or "move to 100 200"
        const coordsMatch = commandData.text.match(/(\d+)\s+(\d+)/);
        if (coordsMatch) {
          const x = parseInt(coordsMatch[1]);
          const y = parseInt(coordsMatch[2]);
          execFile('python', ['mouse_control.py', 'move', x.toString(), y.toString()]);
        }
        break;
      case 'type-text':
        keySender.sendText(commandData.text);
        break;
      case 'key-press': {
        const key = commandData?.data?.key;
        if (key) {
          if (key === 'space') {
            try { keySender.sendText(' '); } catch (e) { console.error('keySender space failed:', e); }
          } else if (key === 'enter') {
            try { keySender.sendKey('enter'); }
            catch (e1) { try { keySender.sendText('\n'); } catch (e2) { console.error('enter fallback failed:', e1, e2); } }
          } else if (key === 'backspace') {
            try { keySender.sendKey('backspace'); }
            catch (e1) { try { keySender.sendKey('back_space'); } catch (e2) { console.error('backspace failed:', e1, e2); } }
          } else if (key === 'tab') {
            try { keySender.sendKey('tab'); } catch (e) { console.error('tab failed:', e); }
          } else if (key === 'escape') {
            try { keySender.sendKey('escape'); } catch (e) { console.error('escape failed:', e); }
          } else {
            try { keySender.sendKey(key); } catch (e) { console.error('keySender sendKey failed:', e, 'for key:', key); }
          }
        }
        break;
      }
      case 'key-combo': {
        const keys = commandData?.data?.keys;
        if (Array.isArray(keys) && keys.length >= 2) {
          // node-key-sender hotkey ordering: modifier first then key
          try { keySender.sendCombination(keys); } catch (e) { console.error('sendCombination failed:', e); }
        }
        break;
      }
      case 'type-mode': // This might require more complex logic in renderer if it implies a state change
        break;
      case 'key-mode': {
        const enabled = !!(commandData?.data?.enabled);
        event.sender.send('voice-command-received', { action: 'key-mode', data: { enabled }, text: commandData.text, feedback: enabled ? 'Key mode ON' : 'Key mode OFF' });
        break;
      }
      case 'virtual-keyboard': {
        console.log('🎤 MAIN PROCESS: Processing virtual-keyboard action in executeVoiceCommand:', commandData);
        const keyboardAction = commandData?.command;
        console.log('🎤 MAIN PROCESS: Keyboard action:', keyboardAction);
        if (keyboardAction === 'show-keyboard') {
          console.log('🎤 MAIN PROCESS: Sending show-virtual-keyboard message to renderer from executeVoiceCommand');
          // Send message to renderer to show virtual keyboard
          event.sender.send('show-virtual-keyboard');
        } else if (keyboardAction === 'hide-keyboard') {
          console.log('🎤 MAIN PROCESS: Sending hide-virtual-keyboard message to renderer from executeVoiceCommand');
          // Send message to renderer to hide virtual keyboard
          event.sender.send('hide-virtual-keyboard');
        }
        break;
      }
      case 'stop-listening':
        // This is handled by the server itself, no action needed in Electron main
        break;
      case 'unknown':
        console.log('Unknown command from voice server:', commandData.text);
        break;
      case 'send-mail-compose-v2':
        if (commandData.data) {
          const { to, subject, body } = commandData.data;
          const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
          exec(`start msedge "${gmailUrl}"`);
          gmailComposeOpened = true;
          lastComposeState = { to, subject, body };
        }
        break;
      case 'gmail-send-shortcut':
        // Trigger Ctrl+Enter to send in Gmail compose
        // Give a short delay to ensure focus is on Gmail window
        setTimeout(() => {
          execFile('python', ['mouse_control.py', 'hotkey', 'ctrl', 'enter']);
        }, 800);
        event.sender.send('voice-command-received', commandData);
        break;
      default:
        console.warn(`Unhandled action from voice server: ${commandData.action}`);
    }
  }
}

// --- NEW: Handle commands received from voice server (e.g., continuous listening) ---
// This IPC communication is vital for the main process to receive commands
// that the Python server has processed and then dispatch actions.
ipcMain.on('voice-command-received', (event, commandData) => {
  console.log('🎤 MAIN PROCESS: Received command from Python voice server:', commandData);
  console.log('🎤 MAIN PROCESS: Command action:', commandData?.action);
  console.log('🎤 MAIN PROCESS: Command text:', commandData?.text);
  
  // Special handling for virtual keyboard commands
  if (commandData?.action === 'virtual-keyboard') {
    console.log('🎤 MAIN PROCESS: Virtual keyboard command detected, processing...');
    const keyboardAction = commandData?.command;
    if (keyboardAction === 'show-keyboard') {
      console.log('🎤 MAIN PROCESS: Sending show-virtual-keyboard message to renderer from voice-command-received');
      event.sender.send('show-virtual-keyboard');
    } else if (keyboardAction === 'hide-keyboard') {
      console.log('🎤 MAIN PROCESS: Sending hide-virtual-keyboard message to renderer from voice-command-received');
      event.sender.send('hide-virtual-keyboard');
    }
  }
  
  // Inform renderer
  if (commandData && commandData.text) {
    event.sender.send('display-command', commandData.text);
  }
  executeVoiceCommand(event, commandData);
});

// NEW: Handle manual command input from the renderer process
ipcMain.on('manual-command-input', async (event, commandText) => {
  console.log('Received manual command from renderer:', commandText);
  try {
    // Send the manual command to the Python voice server for processing
    const commandResult = await callVoiceServer('/process-manual-command', 'POST', { text: commandText });
    console.log('Manual command processed by voice server:', commandResult);

    // If we got a structured command back, optionally execute it here
    const cmd = commandResult && commandResult.command;
    if (cmd) executeVoiceCommand(event, cmd);

    // Send the result back to the renderer for display in the command box
    event.sender.send('voice-command-received', cmd || { text: commandText, feedback: 'Command processed' });
  } catch (error) {
    console.error('Error processing manual command:', error);
    event.sender.send('voice-command-received', { text: commandText, feedback: 'Error processing command' });
  }
}); 

// Virtual Keyboard IPC handlers
ipcMain.handle('show-virtual-keyboard', (event) => {
  // Send message to renderer to show virtual keyboard
  event.sender.send('show-virtual-keyboard');
  return { success: true };
});

ipcMain.handle('hide-virtual-keyboard', (event) => {
  // Send message to renderer to hide virtual keyboard
  event.sender.send('hide-virtual-keyboard');
  return { success: true };
});

ipcMain.handle('toggle-virtual-keyboard', (event) => {
  // Send message to renderer to toggle virtual keyboard
  event.sender.send('toggle-virtual-keyboard');
  return { success: true };
}); 

ipcMain.handle('voice-send-command', async (event, command) => {
  try {
    // Send the command to the voice server for processing
    const response = await callVoiceServer('POST', '/process-command', { command: command });
    return response;
  } catch (error) {
    console.error('Failed to send command to voice server:', error);
    throw error;
  }
}); 

// Test endpoint for virtual keyboard
ipcMain.handle('test-virtual-keyboard', async (event) => {
  try {
    console.log('Testing virtual keyboard from main process...');
    // Simulate a virtual keyboard command
    const testCommand = {
      action: 'virtual-keyboard',
      command: 'show-keyboard',
      text: 'test virtual keyboard',
      feedback: 'Test virtual keyboard command',
      data: { visible: true }
    };
    
    console.log('Sending test command to renderer:', testCommand);
    event.sender.send('show-virtual-keyboard');
    
    return { success: true, message: 'Test command sent' };
  } catch (error) {
    console.error('Error in test-virtual-keyboard:', error);
    return { success: false, error: error.message };
  }
}); 

// Poll for commands from voice server
let commandPollingInterval = null;

function startCommandPolling() {
  if (commandPollingInterval) {
    clearInterval(commandPollingInterval);
  }
  
  commandPollingInterval = setInterval(async () => {
    try {
      const response = await callVoiceServer('GET', '/get-command-queue');
      if (response && response.commands && response.commands.length > 0) {
        console.log('🎤 MAIN PROCESS: Found commands in queue:', response.commands);
        
        // Process each command
        response.commands.forEach(commandData => {
          console.log('🎤 MAIN PROCESS: Processing queued command:', commandData);
          
          // Special handling for virtual keyboard commands
          if (commandData?.action === 'virtual-keyboard') {
            console.log('🎤 MAIN PROCESS: Virtual keyboard command from queue, processing...');
            const keyboardAction = commandData?.command;
            if (keyboardAction === 'show-keyboard') {
              console.log('🎤 MAIN PROCESS: Sending show-virtual-keyboard message to renderer from queue');
              // Send message to renderer to show virtual keyboard
              if (mainWindow) {
                mainWindow.webContents.send('show-virtual-keyboard');
              }
            } else if (keyboardAction === 'hide-keyboard') {
              console.log('🎤 MAIN PROCESS: Sending hide-virtual-keyboard message to renderer from queue');
              // Send message to renderer to hide virtual keyboard
              if (mainWindow) {
                mainWindow.webContents.send('hide-virtual-keyboard');
              }
            }
          }
        });
      }
    } catch (error) {
      // Ignore errors, voice server might not be running
      // console.log('No commands in queue or voice server not running');
    }
  }, 1000); // Check every second
  
  console.log('🎤 MAIN PROCESS: Started command polling');
}

function stopCommandPolling() {
  if (commandPollingInterval) {
    clearInterval(commandPollingInterval);
    commandPollingInterval = null;
    console.log('🎤 MAIN PROCESS: Stopped command polling');
  }
} 