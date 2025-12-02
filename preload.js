const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('robotAPI', {
  type: (text) => ipcRenderer.send('robot-type', text)
});

contextBridge.exposeInMainWorld('mouseAPI', {
  click: () => ipcRenderer.send('mouse-action', 'click'),
  move: (x, y) => ipcRenderer.send('mouse-action', 'move', x, y),
  scrollUp: () => ipcRenderer.send('mouse-action', 'scrollup'),
  scrollDown: () => ipcRenderer.send('mouse-action', 'scrolldown')
});

contextBridge.exposeInMainWorld('appAPI', {
  openWord: () => ipcRenderer.send('open-word'),
  openGmail: () => ipcRenderer.send('open-gmail'),
  sendMail: (to, subject, body) => ipcRenderer.send('send-mail', to, subject, body),
  openNotepad: () => ipcRenderer.send('open-notepad'),
  openCalculator: () => ipcRenderer.send('open-calculator'),
  openPaint: () => ipcRenderer.send('open-paint'),
  openChrome: () => ipcRenderer.send('open-chrome'),
  openEdge: () => ipcRenderer.send('open-edge')
});

// NEW: Expose all voice control and history APIs
contextBridge.exposeInMainWorld('voiceAPI', {
  startListening: async () => ipcRenderer.invoke('voice-start-listening'),
  stopListening: async () => ipcRenderer.invoke('voice-stop-listening'),
  listenOnce: async () => ipcRenderer.invoke('voice-listen-once'),
  speak: async (text) => ipcRenderer.invoke('voice-speak', text),
  getStatus: async () => ipcRenderer.invoke('voice-get-status'),
  getHistory: async (limit, offset) => ipcRenderer.invoke('voice-get-history', limit, offset),
  clearHistory: async () => ipcRenderer.invoke('voice-clear-history'),
  sendCommand: async (command) => ipcRenderer.invoke('voice-send-command', command)
});

// NEW: Intent-based NLP processor
contextBridge.exposeInMainWorld('intentAPI', {
  processCommand: async (text) => ipcRenderer.invoke('process-command', text),
  onProcessed: (callback) => ipcRenderer.on('command-processed', (event, data) => callback(data))
});

// NEW: Eye control API
contextBridge.exposeInMainWorld('eyeAPI', {
  start: async () => ipcRenderer.invoke('eye-start'),
  stop: async () => ipcRenderer.invoke('eye-stop'),
  status: async () => ipcRenderer.invoke('eye-status')
});

contextBridge.exposeInMainWorld('virtualKeyboardAPI', {
  show: () => ipcRenderer.invoke('show-virtual-keyboard'),
  hide: () => ipcRenderer.invoke('hide-virtual-keyboard'),
  toggle: () => ipcRenderer.invoke('toggle-virtual-keyboard'),
  test: () => ipcRenderer.invoke('test-virtual-keyboard'),
  // Direct method to show/hide without IPC
  showDirect: () => {
    // Send a message to the renderer directly
    ipcRenderer.send('show-virtual-keyboard');
  },
  hideDirect: () => {
    ipcRenderer.send('hide-virtual-keyboard');
  }
});

contextBridge.exposeInMainWorld('electronAPI', {
  on: (channel, callback) => {
    // Whitelist channels
    const validChannels = ['show-virtual-keyboard', 'hide-virtual-keyboard', 'toggle-virtual-keyboard', 'voice-command-received', 'display-command'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  removeAllListeners: (channel) => {
    const validChannels = ['show-virtual-keyboard', 'hide-virtual-keyboard', 'toggle-virtual-keyboard', 'voice-command-received', 'display-command'];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  }
});