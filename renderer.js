console.log('Renderer loaded');
document.body.insertAdjacentHTML('beforeend', `
  <div>
    <input id="commandInput" type="text" placeholder="Type a command (e.g. click, scroll down, type hello)" />
    <button id="commandBtn" type="button">Run Command</button>
  </div>
  
  <div id="voiceControl">
    <h3> Voice Control</h3>
    <button id="startVoiceBtn" type="button">Start Voice Recognition</button>
    <button id="stopVoiceBtn" type="button" disabled>Stop Voice Recognition</button>
    <button id="listenOnceBtn" type="button">Listen Once</button>
    <button id="testVoiceBtn" type="button">Test Voice Feedback</button>
    <div id="voiceStatus">Voice recognition: Inactive</div>
    <div id="voiceLog"></div>
  </div>
  
  <div id="commandHistory">
    <h3> Command History</h3>
    <div id="historyControls">
      <button id="refreshHistoryBtn" type="button">Refresh History</button>
      <button id="clearHistoryBtn" type="button">Clear History</button>
      <span id="historyCount">History: 0 commands</span>
    </div>
    <div id="historyList"></div>
  </div>
  
  <div>
    <input id="toInput" type="email" placeholder="Recipient Email" />
    <input id="subjectInput" type="text" placeholder="Subject" />
    <textarea id="bodyInput" placeholder="Email body"></textarea>
    <button id="sendMailBtn" type="button">Send Mail</button>
    <div id="mailStatus"></div>
  </div>
`);

const commandInput = document.getElementById('commandInput');
const commandBtn = document.getElementById('commandBtn');
const voiceLog = document.getElementById('voiceLog');
const commandBox = document.getElementById('command-box');

//  elements
const startVoiceBtn = document.getElementById('startVoiceBtn');
const stopVoiceBtn = document.getElementById('stopVoiceBtn');
const listenOnceBtn = document.getElementById('listenOnceBtn');
const testVoiceBtn = document.getElementById('testVoiceBtn');
const voiceStatus = document.getElementById('voiceStatus');

// History elements
const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const historyCount = document.getElementById('historyCount');
const historyList = document.getElementById('historyList');

const toInput = document.getElementById('toInput');
const subjectInput = document.getElementById('subjectInput');
const bodyInput = document.getElementById('bodyInput');
const sendMailBtn = document.getElementById('sendMailBtn');
const mailStatus = document.getElementById('mailStatus');

// Safe shims to prevent UI from breaking if preload APIs aren't available yet
if (!window.voiceAPI) {
  window.voiceAPI = {
    startListening: async () => ({ error: 'Voice API unavailable' }),
    stopListening: async () => ({ }),
    listenOnce: async () => ({ error: 'Voice API unavailable' }),
    speak: async () => ({ error: 'Voice API unavailable' }),
    getStatus: async () => ({ error: 'Voice API unavailable' }),
    getHistory: async () => ({ history: [], total: 0 }),
    clearHistory: async () => ({ }),
    onVoiceResult: () => {},
    onVoiceError: () => {},
    onVoiceCommandReceived: () => {},
    sendManualCommand: () => {},
    emitVoiceCommand: () => {}
  };
}
if (!window.eyeAPI) {
  window.eyeAPI = {
    start: async () => ({ running: false, error: 'Eye API unavailable' }),
    stop: async () => ({ running: false }),
    status: async () => ({ running: false })
  };
}
if (!window.intentAPI) {
  window.intentAPI = {
    processCommand: async () => ({ error: 'Intent API unavailable' }),
    onProcessed: () => {}
  };
}
if (!window.appAPI) {
  window.appAPI = {
    openWord: () => {},
    openGmail: () => {},
    sendMail: () => {},
    openNotepad: () => {},
    openCalculator: () => {},
    openPaint: () => {},
    openChrome: () => {},
    openEdge: () => {}
  };
}
if (!window.mouseAPI) {
  window.mouseAPI = {
    click: () => {},
    move: () => {},
    scrollUp: () => {},
    scrollDown: () => {}
  };
}
if (!window.robotAPI) {
  window.robotAPI = { type: () => {} };
}

// Track history polling state for continuous listening
let historyPollInterval = null;
const processedHistoryKeys = new Set();

async function pollHistoryForCommands() {
  try {
    const result = await window.voiceAPI.getHistory(10, 0);
    const history = result.history || [];
    for (const entry of history) {
      const key = `${entry.timestamp}|${entry.action}|${entry.text}`;
      if (processedHistoryKeys.has(key)) continue;
      processedHistoryKeys.add(key);
      if (!entry || !entry.action) continue;
      if (entry.action === 'unknown') {
        try {
          const intent = await window.intentAPI.processCommand(entry.text || '');
          if (intent && intent.action && intent.action !== 'unknown') {
            const cmdFromIntent = { action: intent.action, text: entry.text, feedback: '', data: intent.data };
            window.voiceAPI.emitVoiceCommand(cmdFromIntent);
            commandBox.textContent = `Intent: ${intent.action} | Data: ${JSON.stringify(intent.data || {})}`;
          }
        } catch (e) {
          // ignore
        }
        continue;
      }
      const cmd = {
        action: entry.action,
        text: entry.text,
        feedback: entry.feedback,
        data: entry.data
      };
      try {
        window.voiceAPI.emitVoiceCommand(cmd);
        if (cmd.action === 'email-compose-progress' && cmd.data) {
          const to = cmd.data.to || '(none)';
          const subject = cmd.data.subject || '(none)';
          const body = cmd.data.body || '(none)';
          commandBox.textContent = `Email compose → To: ${to} | Subject: ${subject} | Body: ${body}`;
        } else {
          commandBox.textContent = `Command: ${cmd.text} | Feedback: ${cmd.feedback || ''}`;
        }
      } catch (e) {
        console.error('Failed to emit command from history:', e);
      }
    }
  } catch (e) {
    // Silently ignore to avoid spamming logs
  }
}

// History management functions
async function loadHistory() {
  try {
    const result = await window.voiceAPI.getHistory(20, 0); // Get last 20 commands
    
    if (result.error) {
      historyList.innerHTML = `<p style="color: red;">Error loading history: ${result.error}</p>`;
      return;
    }
    
    const history = result.history || [];
    historyCount.innerText = `History: ${result.total} commands`;
    
    if (history.length === 0) {
      historyList.innerHTML = '<p style="color: gray;">No commands in history yet.</p>';
      return;
    }
    
    // Display history in reverse chronological order (newest first)
    const historyHtml = history.reverse().map(entry => {
      const timestamp = new Date(entry.timestamp).toLocaleString();
      const successIcon = entry.success ? '✅' : '❌';
      const actionText = entry.action || 'Unknown';
      
      return `
        <div class="history-item" style="border: 1px solid #ccc; margin: 5px 0; padding: 10px; border-radius: 5px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>${successIcon} <strong>${actionText}</strong></span>
            <span style="font-size: 0.8em; color: #666;">${timestamp}</span>
          </div>
          <div style="margin-top: 5px;">
            <strong>Command:</strong> "${entry.text}"
          </div>
          ${entry.feedback ? `<div style="margin-top: 3px; color: #0066cc;"><strong>Feedback:</strong> ${entry.feedback}</div>` : ''}
        </div>
      `;
    }).join('');
    
    historyList.innerHTML = historyHtml;
    
  } catch (error) {
    historyList.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
  }
}

async function clearHistory() {
  try {
    const result = await window.voiceAPI.clearHistory();
    
    if (result.error) {
      alert(`Error clearing history: ${result.error}`);
      return;
    }
    
    historyList.innerHTML = '<p style="color: gray;">History cleared.</p>';
    historyCount.innerText = 'History: 0 commands';
    
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

// Voice control functions
async function startVoiceRecognition() {
  try {
    voiceStatus.innerText = 'Starting voice recognition...';
    const result = await window.voiceAPI.startListening();
    
    if (result.error) {
      voiceStatus.innerText = `Error: ${result.error}`;
      return;
    }
    
    startVoiceBtn.disabled = true;
    stopVoiceBtn.disabled = false;
    voiceStatus.innerText = 'Voice recognition: Active - Speak commands!';
    voiceLog.innerText = ' Voice recognition started. Try saying:\n- "open notepad"\n- "click"\n- "scroll up"\n- "type hello world"';
    
    // Auto-refresh history after starting
    setTimeout(loadHistory, 1000);
    // Start polling history to execute recognized commands
    if (historyPollInterval) clearInterval(historyPollInterval);
    historyPollInterval = setInterval(pollHistoryForCommands, 1000);
  } catch (error) {
    voiceStatus.innerText = `Error: ${error.message}`;
  }
}

async function stopVoiceRecognition() {
  try {
    voiceStatus.innerText = 'Stopping voice recognition...';
    const result = await window.voiceAPI.stopListening();
    
    if (result.error) {
      voiceStatus.innerText = `Error: ${result.error}`;
      return;
    }
    
    startVoiceBtn.disabled = false;
    stopVoiceBtn.disabled = true;
    voiceStatus.innerText = 'Voice recognition: Inactive';
    voiceLog.innerText += '\n🛑 Voice recognition stopped.';
    
    // Refresh history after stopping
    setTimeout(loadHistory, 500);
    if (historyPollInterval) {
      clearInterval(historyPollInterval);
      historyPollInterval = null;
    }
  } catch (error) {
    voiceStatus.innerText = `Error: ${error.message}`;
  }
}

async function listenOnce() {
  try {
    voiceStatus.innerText = 'Listening for command...';
    voiceLog.innerText = ' Listening for command...';
    
    const result = await window.voiceAPI.listenOnce();
    
    if (result.error) {
      voiceStatus.innerText = `Error: ${result.error}`;
      voiceLog.innerText += `\n❌ Error: ${result.error}`;
      return;
    }
    
    if (result.text) {
      voiceLog.innerText += `\n🎯 Recognized: "${result.text}"`;
      if (result.command) {
        voiceLog.innerText += `\n📋 Action: ${result.command.action}`;
        if (result.command.feedback) {
          voiceLog.innerText += `\n🗣️ Feedback: ${result.command.feedback}`;
        }
        // Forward actionable commands to main for execution (e.g., send-mail-compose-v2)
        try {
          window.voiceAPI.emitVoiceCommand(result.command);
        } catch (e) {
          console.error('Failed to emit voice command to main:', e);
        }
      }
    } else {
      voiceLog.innerText += '\n🔇 No speech detected';
    }
    
    voiceStatus.innerText = 'Voice recognition: Ready';
    
    // Refresh history after command
    setTimeout(loadHistory, 500);
  } catch (error) {
    voiceStatus.innerText = `Error: ${error.message}`;
    voiceLog.innerText += `\n❌ Error: ${error.message}`;
  }
}

async function testVoiceFeedback() {
  try {
    voiceLog.innerText += '\n🗣️ Testing voice feedback...';
    const result = await window.voiceAPI.speak('Hello! This is a test of the voice feedback system.');
    
    if (result.error) {
      voiceLog.innerText += `\n❌ TTS Error: ${result.error}`;
    } else {
      voiceLog.innerText += `\n✅ ${result.message}`;
    }
  } catch (error) {
    voiceLog.innerText += `\n❌ Error: ${error.message}`;
  }
}

// Event listeners
startVoiceBtn.onclick = startVoiceRecognition;
stopVoiceBtn.onclick = stopVoiceRecognition;
listenOnceBtn.onclick = listenOnce;
testVoiceBtn.onclick = testVoiceFeedback;
refreshHistoryBtn.onclick = loadHistory;
clearHistoryBtn.onclick = clearHistory;

// Check voice server status on load
async function checkVoiceStatus() {
  try {
    const status = await window.voiceAPI.getStatus();
    if (status.error) {
      voiceStatus.innerText = `Voice server error: ${status.error}`;
    } else {
      const ttsStatus = status.tts_available ? '✅ TTS Available' : '❌ TTS Not Available';
      voiceStatus.innerText = `Voice server: ${status.status}, Recognizer: ${status.speech_recognizer_initialized ? 'Initialized' : 'Not Initialized'}, ${ttsStatus}`;
    }
  } catch (error) {
    voiceStatus.innerText = `Cannot connect to voice server: ${error.message}`;
  }
}

// Initialize on page load
checkVoiceStatus();
loadHistory();

sendMailBtn.onclick = () => {
  const to = toInput.value.trim();
  const subject = subjectInput.value.trim();
  const body = bodyInput.value.trim();
  if (!to) {
    mailStatus.innerText = 'Please enter a recipient email.';
    return;
  }
  window.appAPI.sendMail(to, subject, body);
  mailStatus.innerText = 'Opening mail client...';
};

commandBtn.onclick = () => {
  const text = commandInput.value.trim();
  if (/(open notepad|start notepad|launch notepad)/i.test(text)) {
    window.appAPI.openNotepad();
  } else if (/(open calculator|start calculator|launch calculator|open calc)/i.test(text)) {
    window.appAPI.openCalculator();
  } else if (/(open paint|start paint|launch paint|open mspaint)/i.test(text)) {
    window.appAPI.openPaint();
  } else if (/(open chrome|start chrome|launch chrome)/i.test(text)) {
    window.appAPI.openChrome();
  } else if (/(open edge|start edge|launch edge)/i.test(text)) {
    window.appAPI.openEdge();
  } else if (/(open gmail|open google mail|start gmail|launch gmail)/i.test(text)) {
    window.appAPI.openGmail();
  } else if (/(open mail|start mail|launch mail|open email|start email|launch email)/i.test(text)) {
    window.appAPI.openMail();
  } else if (/(open word|start word|launch word)/i.test(text)) {
    window.appAPI.openWord();
  } else if (/(click|clique|quick|klick)/i.test(text)) {
    window.mouseAPI.click();
  } else if (/(scroll down|scrolled down|school down|scroll dawn)/i.test(text)) {
    window.mouseAPI.scrollDown();
  } else if (/(scroll up|scrolled up|school up)/i.test(text)) {
    window.mouseAPI.scrollUp();
  } else if (/^move \d+ \d+/i.test(text)) {
    const parts = text.split(' ');
    if (parts.length === 3) {
      const x = parseInt(parts[1], 10);
      const y = parseInt(parts[2], 10);
      window.mouseAPI.move(x, y);
    }
  } else if (/^type /i.test(text)) {
    const toType = text.replace(/^type /i, '');
    window.robotAPI.type(toType);
  }
};

// Virtual Keyboard functionality
let virtualKeyboardVisible = false;

function showVirtualKeyboard() {
    try {
        console.log('showVirtualKeyboard called');
        const keyboard = document.getElementById('virtualKeyboard');
        console.log('Keyboard element:', keyboard);
        if (keyboard) {
            keyboard.classList.add('show');
            virtualKeyboardVisible = true;
            updateKeyboardStatus();
            console.log('Virtual keyboard should now be visible');
        } else {
            console.error('Virtual keyboard element not found!');
        }
    } catch (error) {
        console.error('Error in showVirtualKeyboard:', error);
    }
}

function hideVirtualKeyboard() {
    try {
        console.log('hideVirtualKeyboard called');
        const keyboard = document.getElementById('virtualKeyboard');
        if (keyboard) {
            keyboard.classList.remove('show');
            virtualKeyboardVisible = false;
            updateKeyboardStatus();
            console.log('Virtual keyboard should now be hidden');
        } else {
            console.error('Virtual keyboard element not found!');
        }
    } catch (error) {
        console.error('Error in hideVirtualKeyboard:', error);
    }
}

function updateKeyboardStatus() {
    try {
        console.log('updateKeyboardStatus called, visible:', virtualKeyboardVisible);
        const status = document.getElementById('keyboardStatus');
        console.log('Status element:', status);
        if (status) {
            if (virtualKeyboardVisible) {
                status.textContent = 'Virtual Keyboard: Visible';
                status.className = 'status running';
            } else {
                status.textContent = 'Virtual Keyboard: Hidden';
                status.className = 'status stopped';
            }
            console.log('Keyboard status updated');
        } else {
            console.error('Keyboard status element not found!');
        }
    } catch (error) {
        console.error('Error in updateKeyboardStatus:', error);
    }
}

// Listen for virtual keyboard IPC messages
if (window.electronAPI) {
  console.log('electronAPI found, setting up virtual keyboard listeners...');
  
  window.electronAPI.on('show-virtual-keyboard', () => {
    console.log('Received show-virtual-keyboard message in renderer');
    showVirtualKeyboard();
  });
  
  window.electronAPI.on('hide-virtual-keyboard', () => {
    console.log('Received hide-virtual-keyboard message in renderer');
    hideVirtualKeyboard();
  });
  
  window.electronAPI.on('toggle-virtual-keyboard', () => {
    console.log('Received toggle-virtual-keyboard message in renderer');
    if (virtualKeyboardVisible) {
      hideVirtualKeyboard();
    } else {
      showVirtualKeyboard();
    }
  });
  
  console.log('Virtual keyboard IPC listeners set up');
} else {
  console.error('electronAPI not found! Virtual keyboard IPC won\'t work');
}

// Also listen for direct IPC messages from virtualKeyboardAPI
if (window.virtualKeyboardAPI) {
  console.log('virtualKeyboardAPI found, setting up direct listeners...');
  
  // Listen for direct messages
  if (window.electronAPI) {
    window.electronAPI.on('show-virtual-keyboard', () => {
      console.log('Direct show-virtual-keyboard message received');
      showVirtualKeyboard();
    });
    
    window.electronAPI.on('hide-virtual-keyboard', () => {
      console.log('Direct hide-virtual-keyboard message received');
      hideVirtualKeyboard();
    });
  }
  
  console.log('Direct virtual keyboard listeners set up');
}

// Update handleKeyClick to use voiceAPI if available, otherwise use virtualKeyboardAPI
function handleKeyClick(key) {
    console.log('Virtual keyboard key clicked:', key);
    
    // Try to use voiceAPI first, fallback to direct key sending
    if (window.voiceAPI && window.voiceAPI.sendCommand) {
        window.voiceAPI.sendCommand(key)
            .then(response => {
                console.log('Key sent via voice API:', response);
                showKeyFeedback(key, true);
            })
            .catch(error => {
                console.error('Failed to send key via voice API:', error);
                // Fallback to direct key sending
                sendKeyDirectly(key);
            });
    } else {
        // Direct key sending fallback
        sendKeyDirectly(key);
    }
}

function sendKeyDirectly(key) {
    // This would need to be implemented based on your key sending mechanism
    console.log('Sending key directly:', key);
    // For now, just show feedback
    showKeyFeedback(key, true);
}

function showKeyFeedback(key, success) {
    const keyElement = document.querySelector(`[data-key="${key}"]`);
    if (keyElement) {
        if (success) {
            keyElement.style.background = '#28a745';
            keyElement.style.color = 'white';
        } else {
            keyElement.style.background = '#dc3545';
            keyElement.style.color = 'white';
        }
        setTimeout(() => {
            keyElement.style.background = '';
            keyElement.style.color = '';
        }, 200);
    }
}

// Initialize virtual keyboard event listeners
function initializeVirtualKeyboard() {
    try {
        console.log('Initializing virtual keyboard...');
        
        // Show/Hide buttons
        const showBtn = document.getElementById('showKeyboardBtn');
        const hideBtn = document.getElementById('hideKeyboardBtn');
        const closeBtn = document.getElementById('keyboardCloseBtn');
        
        console.log('Show button:', showBtn);
        console.log('Hide button:', hideBtn);
        console.log('Close button:', closeBtn);
        
        if (showBtn) {
            showBtn.addEventListener('click', showVirtualKeyboard);
            console.log('Show button event listener added');
        }
        
        if (hideBtn) {
            hideBtn.addEventListener('click', hideVirtualKeyboard);
            console.log('Hide button event listener added');
        }
        
        if (closeBtn) {
            closeBtn.addEventListener('click', hideVirtualKeyboard);
            console.log('Close button event listener added');
        }
        
        // Key click handlers
        const keys = document.querySelectorAll('.keyboard-key');
        console.log('Found keyboard keys:', keys.length);
        keys.forEach(key => {
            key.addEventListener('click', () => {
                const keyValue = key.getAttribute('data-key');
                handleKeyClick(keyValue);
            });
        });
        
        // Close keyboard when clicking outside
        document.addEventListener('click', (e) => {
            const keyboard = document.getElementById('virtualKeyboard');
            if (keyboard && !keyboard.contains(e.target) && !e.target.closest('#showKeyboardBtn')) {
                hideVirtualKeyboard();
            }
        });
        
        // Escape key to close keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && virtualKeyboardVisible) {
                hideVirtualKeyboard();
            }
        });
        
        console.log('Virtual keyboard initialization complete');
    } catch (error) {
        console.error('Error in initializeVirtualKeyboard:', error);
    }
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('DOM Content Loaded - Starting initialization...');
  
  // Get button references
  const startVoiceBtn = document.getElementById('startVoiceBtn');
  const stopVoiceBtn = document.getElementById('stopVoiceBtn');
  const listenOnceBtn = document.getElementById('listenOnceBtn');
  const speakBtn = document.getElementById('speakBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const startEyeBtn = document.getElementById('startEyeBtn');
  const stopEyeBtn = document.getElementById('stopEyeBtn');
  
  console.log('Button references:', { startVoiceBtn, stopVoiceBtn, listenOnceBtn, speakBtn, clearHistoryBtn, startEyeBtn, stopEyeBtn });
  
  // Initialize voice recognition buttons
  if (startVoiceBtn) startVoiceBtn.onclick = async () => { await window.voiceAPI.startListening(); refreshVoiceStatus(); };
  if (stopVoiceBtn) stopVoiceBtn.onclick = async () => { await window.voiceAPI.stopListening(); refreshVoiceStatus(); };
  if (listenOnceBtn) listenOnceBtn.onclick = async () => { await window.voiceAPI.listenOnce(); refreshVoiceStatus(); };
  if (speakBtn) speakBtn.onclick = async () => { 
    const text = prompt('Enter text to speak:');
    if (text) await window.voiceAPI.speak(text);
  };
  if (clearHistoryBtn) clearHistoryBtn.onclick = async () => { await window.voiceAPI.clearHistory(); refreshVoiceHistory(); };
  
  // Initialize eye control buttons
  if (startEyeBtn) startEyeBtn.onclick = async () => { await window.eyeAPI.start(); refreshEye(); };
  if (stopEyeBtn) stopEyeBtn.onclick = async () => { await window.eyeAPI.stop(); refreshEye(); };
  
  // Initial eye status refresh
  refreshEye();
  
  // Initialize virtual keyboard
  console.log('About to initialize virtual keyboard...');
  initializeVirtualKeyboard();
  console.log('Virtual keyboard initialization called');
  
  // Test virtual keyboard manually
  const showKeyboardBtn = document.getElementById('showKeyboardBtn');
  if (showKeyboardBtn) {
    showKeyboardBtn.onclick = () => {
      console.log('Manual show keyboard button clicked');
      showVirtualKeyboard();
    };
    console.log('Manual show keyboard button handler added');
  }
  
  // Test virtual keyboard voice command
  const testVirtualKeyboardBtn = document.getElementById('testVirtualKeyboardBtn');
  if (testVirtualKeyboardBtn) {
    testVirtualKeyboardBtn.onclick = async () => {
      console.log('Test virtual keyboard button clicked');
      try {
        // Test the main process test endpoint
        if (window.virtualKeyboardAPI) {
          console.log('Testing virtual keyboard via main process...');
          const result = await window.virtualKeyboardAPI.test();
          console.log('Test result:', result);
        } else {
          console.log('virtualKeyboardAPI not found, falling back to manual show');
          showVirtualKeyboard();
        }
      } catch (error) {
        console.error('Error testing virtual keyboard:', error);
        // Fallback to manual show
        showVirtualKeyboard();
      }
    };
    console.log('Test virtual keyboard button handler added');
  }
  
  // Simulate voice command button
  const simulateVoiceCommandBtn = document.getElementById('simulateVoiceCommandBtn');
  if (simulateVoiceCommandBtn) {
    simulateVoiceCommandBtn.onclick = async () => {
      console.log('Simulate voice command button clicked');
      try {
        // Simulate the "virtual keyboard" voice command
        const response = await fetch('http://localhost:5005/simulate-voice-command', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ command: 'virtual keyboard' })
        });
        
        const result = await response.json();
        console.log('Simulated voice command result:', result);
        
        // The command should now be in the queue and picked up by the main process
        console.log('Command sent to voice server queue. Main process should pick it up within 1 second.');
        
      } catch (error) {
        console.error('Error simulating voice command:', error);
        // Fallback to manual show
        showVirtualKeyboard();
      }
    };
    console.log('Simulate voice command button handler added');
  }
  
  // Check queue status button
  const checkQueueStatusBtn = document.getElementById('checkQueueStatusBtn');
  if (checkQueueStatusBtn) {
    checkQueueStatusBtn.onclick = async () => {
      console.log('Check queue status button clicked');
      try {
        const response = await fetch('http://localhost:5005/queue-status');
        const status = await response.json();
        console.log('Queue status:', status);
        
        if (status.queue_size > 0) {
          console.log('Commands in queue:', status.queue_contents);
        } else {
          console.log('Queue is empty');
        }
        
      } catch (error) {
        console.error('Error checking queue status:', error);
      }
    };
    console.log('Check queue status button handler added');
  }
  
  // Test if virtual keyboard element exists
  const keyboardElement = document.getElementById('virtualKeyboard');
  console.log('Virtual keyboard element found:', keyboardElement);
  if (keyboardElement) {
    console.log('Virtual keyboard classes:', keyboardElement.className);
    console.log('Virtual keyboard style:', keyboardElement.style.display);
    
    // Test virtual keyboard after a short delay
    setTimeout(() => {
      console.log('Testing virtual keyboard show function...');
      showVirtualKeyboard();
    }, 2000);
  }
  
  // Initial status refresh
  refreshVoiceStatus();
  refreshVoiceHistory();
  
  console.log('Initialization complete');
});

// Voice status and history refresh functions
async function refreshVoiceStatus() {
  try {
    const status = await window.voiceAPI.getStatus();
    const statusElement = document.getElementById('voiceStatus');
    if (statusElement) {
      if (status && status.is_listening) {
        statusElement.textContent = 'Voice Recognition: Active';
        statusElement.className = 'status running';
      } else {
        statusElement.textContent = 'Voice Recognition: Stopped';
        statusElement.className = 'status stopped';
      }
    }
  } catch (error) {
    console.error('Failed to refresh voice status:', error);
    const statusElement = document.getElementById('voiceStatus');
    if (statusElement) {
      statusElement.textContent = 'Voice Recognition: Error';
      statusElement.className = 'status stopped';
    }
  }
}

async function refreshVoiceHistory() {
  try {
    const history = await window.voiceAPI.getHistory(20, 0);
    const historyElement = document.getElementById('voiceHistory');
    if (historyElement && history && history.commands) {
      historyElement.innerHTML = '';
      history.commands.forEach(cmd => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
          <strong>${cmd.text}</strong><br>
          <small>Action: ${cmd.action || 'none'} | Feedback: ${cmd.feedback || 'none'}</small>
        `;
        historyElement.appendChild(item);
      });
    }
  } catch (error) {
    console.error('Failed to refresh voice history:', error);
  }
}

// Eye control refresh function
async function refreshEye() {
  try {
    const s = await window.eyeAPI.status();
    const statusElement = document.getElementById('eyeStatus');
    const startBtn = document.getElementById('startEyeBtn');
    const stopBtn = document.getElementById('stopEyeBtn');
    
    if (statusElement) {
      if (s && s.running) {
        statusElement.textContent = 'Eye Control: Active';
        statusElement.className = 'status running';
        if (startBtn) startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;
      } else {
        statusElement.textContent = 'Eye Control: Stopped';
        statusElement.className = 'status stopped';
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
      }
    }
  } catch (error) {
    console.error('Failed to refresh eye status:', error);
    const statusElement = document.getElementById('eyeStatus');
    if (statusElement) {
      statusElement.textContent = 'Eye Control: Error';
      statusElement.className = 'status stopped';
    }
  }
}