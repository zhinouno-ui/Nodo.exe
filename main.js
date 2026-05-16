const path    = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const AGENT_URL    = 'https://bo.casinodrex.com/agents/user_search';
const NEW_USER_URL = 'https://bo.casinodrex.com/agents/new_user';

let mainWindow  = null;
let agentWindow = null;
const pendingAutomation = new Map();

// ── Ventana principal (NODO panel) ────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width:    1440,
    height:   900,
    minWidth: 900,
    minHeight:600,
    title: 'NODO · OPERATIVO',
    webPreferences: {
      preload:          path.join(__dirname, 'app-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    }
  });

  mainWindow.loadFile('NODO · OPERATIVO LITE.htm');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Ventana del backoffice del casino ─────────────────────────────────────────
function createAgentWindow(url = AGENT_URL) {
  agentWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    title:  'Agentes — Cargas automáticas',
    webPreferences: {
      preload:          path.join(__dirname, 'agent-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    }
  });

  agentWindow.loadURL(url);
  agentWindow.on('closed', () => {
    agentWindow = null;
    pendingAutomation.clear();
  });

  return agentWindow;
}

function getAgentWindow(url = AGENT_URL) {
  if (agentWindow && !agentWindow.isDestroyed()) return agentWindow;
  return createAgentWindow(url);
}

function whenAgentReady(win) {
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise(resolve => win.webContents.once('did-finish-load', resolve));
}

async function navigateAgentTo(url = AGENT_URL) {
  const win = getAgentWindow();
  win.loadURL(url);
  await whenAgentReady(win);
  await new Promise(r => setTimeout(r, 800)); // margen para que React monte
}

function sendAutomation(method, ...args) {
  const win = getAgentWindow();
  // Algunos métodos requieren estar en una URL específica → navegamos primero
  let preNav;
  if      (method === 'buscarUsuario')       preNav = navigateAgentTo(AGENT_URL);
  else if (method === 'crearUsuario')        preNav = navigateAgentTo(NEW_USER_URL);
  else if (method === 'obtenerSaldoAgente')  preNav = navigateAgentTo(AGENT_URL);
  else                                       preNav = whenAgentReady(win);
  return preNav.then(() => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingAutomation.delete(requestId);
        reject(new Error('Timeout: la automatización tardó demasiado.'));
      }, 30000);

      pendingAutomation.set(requestId, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject:  e => { clearTimeout(timer); reject(e);  }
      });

      win.webContents.send('drex:automation:run', { requestId, method, args });
    });
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC handlers ──────────────────────────────────────────────────────────────

// Abre/enfoca la ventana del backoffice
// Navega la ventana del backoffice a la URL de búsqueda y espera a que cargue
ipcMain.handle('drex:navigate', async (_event, url) => {
  await navigateAgentTo(url || AGENT_URL);
  return { ok: true };
});

ipcMain.handle('drex:open-agent-window', (_event, url) => {
  const win = getAgentWindow(url || AGENT_URL);
  if (url && win.webContents.getURL() !== url) win.loadURL(url);
  win.show();
  win.focus();
  return { ok: true };
});

// Ejecuta un método de automatización en el backoffice
ipcMain.handle('drex:automation', async (_event, { method, args = [] } = {}) => {
  return sendAutomation(method, ...args);
});

// Recibe el resultado de la automatización desde agent-preload.js
ipcMain.on('drex:automation:result', (_event, response = {}) => {
  const pending = pendingAutomation.get(response.requestId);
  if (!pending) return;
  pendingAutomation.delete(response.requestId);
  if (response.ok !== false) pending.resolve(response.result ?? response);
  else pending.reject(new Error(response.error || 'Error en automatización.'));
});
