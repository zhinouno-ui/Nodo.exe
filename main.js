const path    = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const AGENT_URL    = 'https://bo.casinodrex.com/agents/user_search';
const NEW_USER_URL = 'https://bo.casinodrex.com/agents/new_user';
const CHUNIOR_URL  = 'https://bo.chunior.com/transacciones/';

let mainWindow    = null;
let agentWindow   = null;
let verifyWindow  = null;
let chuniorWindow = null;
const pendingAutomation   = new Map();
const pendingVerification = new Map();

// ── Ventana principal (NODO panel) ────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width:    1440,
    height:   900,
    minWidth: 900,
    minHeight:600,
    title: 'NODO · OPERATIVO',
    backgroundColor: '#0e1014', // evita el flash blanco mientras carga / al despertar
    webPreferences: {
      preload:               path.join(__dirname, 'app-preload.js'),
      contextIsolation:      true,
      nodeIntegration:       false,
      webviewTag:            true,
      backgroundThrottling:  false, // que JS siga corriendo aunque la ventana no esté enfocada
    }
  });

  mainWindow.loadFile('NODO · OPERATIVO LITE.htm');
  mainWindow.on('closed', () => { mainWindow = null; });

  // Recovery: si el renderer se cuelga / crashea (esto causa la pantalla blanca)
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] render-process-gone:', details);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[main] renderer unresponsive — forcing reload');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });

  // Zoom Ctrl+= / Ctrl+- / Ctrl+0 (teclado)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input.control || input.type !== 'keyDown') return;
    const key = input.key;
    if (key === '=' || key === '+' || key === 'NumpadAdd') {
      const f = mainWindow.webContents.getZoomFactor();
      mainWindow.webContents.setZoomFactor(Math.min(parseFloat((f + 0.1).toFixed(1)), 3.0));
      event.preventDefault();
    } else if (key === '-' || key === 'NumpadSubtract') {
      const f = mainWindow.webContents.getZoomFactor();
      mainWindow.webContents.setZoomFactor(Math.max(parseFloat((f - 0.1).toFixed(1)), 0.3));
      event.preventDefault();
    } else if (key === '0') {
      mainWindow.webContents.setZoomFactor(1.0);
      event.preventDefault();
    }
  });

  // Zoom Ctrl+Rueda del mouse
  mainWindow.webContents.on('zoom-changed', (_event, direction) => {
    const f = mainWindow.webContents.getZoomFactor();
    if (direction === 'in')
      mainWindow.webContents.setZoomFactor(Math.min(parseFloat((f + 0.1).toFixed(1)), 3.0));
    else
      mainWindow.webContents.setZoomFactor(Math.max(parseFloat((f - 0.1).toFixed(1)), 0.3));
  });

  // Habilitar zoom visual (trackpad pinch)
  mainWindow.webContents.setVisualZoomLevelLimits(1, 5);
}

// ── Ventana del backoffice del casino (Casinodrex) ────────────────────────────
// OCULTA por defecto: contiene la lógica de cargas automáticas pero no se muestra.
function createAgentWindow(url = AGENT_URL) {
  agentWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    title:  'Agentes — Cargas automáticas',
    show:   false,
    webPreferences: {
      preload:              path.join(__dirname, 'agent-preload.js'),
      contextIsolation:     true,
      nodeIntegration:      false,
      sandbox:              true,
      backgroundThrottling: false,
    }
  });

  agentWindow.loadURL(url);
  agentWindow.on('closed', () => {
    agentWindow = null;
    pendingAutomation.clear();
  });

  return agentWindow;
}

// ── Ventana de Chunior (backoffice secundario, VISIBLE) ───────────────────────
// Contiene la lógica de login + sync de billeteras + registro de cargas.
// El operador puede ver el flujo en vivo en esta ventana.
function createChuniorWindow() {
  chuniorWindow = new BrowserWindow({
    width:  1200,
    height: 800,
    title:  'Chunior — Backoffice',
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation:     true,
      nodeIntegration:      false,
      sandbox:              true,
      backgroundThrottling: false, // que Chunior siga refrescando aunque no esté enfocado
    }
  });
  chuniorWindow.loadURL(CHUNIOR_URL);
  chuniorWindow.on('closed', () => { chuniorWindow = null; });
  return chuniorWindow;
}

function getChuniorWindow() {
  if (chuniorWindow && !chuniorWindow.isDestroyed()) return chuniorWindow;
  return createChuniorWindow();
}

function whenChuniorReady(win, timeoutMs = 15000) {
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    win.webContents.once('did-finish-load', finish);
    setTimeout(finish, timeoutMs);
  });
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
  // Siempre recargamos la página antes de operar para dejar el search limpio.
  // Configuramos el listener de 'did-finish-load' ANTES de loadURL para no perder
  // el evento (whenAgentReady a veces resolvía antes de que arrancara la carga).
  await new Promise((resolve) => {
    let resuelto = false;
    const finish = () => {
      if (resuelto) return;
      resuelto = true;
      win.webContents.removeListener('did-finish-load', finish);
      resolve();
    };
    win.webContents.once('did-finish-load', finish);
    // Fallback por si el evento no dispara (página cacheada, error de red, etc.)
    setTimeout(finish, 8000);
    try { win.loadURL(url); } catch (_) { finish(); }
  });
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

// ── Ventana de verificación (separada, corre en background) ──────────────────
function createVerifyWindow() {
  verifyWindow = new BrowserWindow({
    width:  1200,
    height: 800,
    title:  'Verificación — Login usuarios',
    show:   false,
    webPreferences: {
      preload:          path.join(__dirname, 'agent-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    }
  });
  verifyWindow.loadURL(AGENT_URL);
  verifyWindow.on('closed', () => { verifyWindow = null; pendingVerification.clear(); });
  return verifyWindow;
}

function getVerifyWindow() {
  if (verifyWindow && !verifyWindow.isDestroyed()) return verifyWindow;
  return createVerifyWindow();
}

async function sendVerification(usuario) {
  const win = getVerifyWindow();
  const currentUrl = win.webContents.getURL();
  if (!currentUrl.includes('user_search')) {
    win.loadURL(AGENT_URL);
    await whenAgentReady(win);
    await new Promise(r => setTimeout(r, 900));
  } else {
    await whenAgentReady(win);
  }
  const requestId = `v-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingVerification.delete(requestId);
      reject(new Error('Timeout en verificación.'));
    }, 30000);
    pendingVerification.set(requestId, {
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject:  e => { clearTimeout(timer); reject(e);  }
    });
    win.webContents.send('drex:verify:run', { requestId, method: 'buscarUsuario', args: [usuario] });
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createMainWindow();
  createChuniorWindow();
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

// Asegura que la ventana de agentes EXISTE (creándola hidden si hace falta) pero NO la muestra.
// Usado por automatizaciones (cargas, búsquedas) que solo necesitan que el webContents esté cargado.
ipcMain.handle('drex:open-agent-window', (_event, url) => {
  const win = getAgentWindow(url || AGENT_URL);
  if (url && win.webContents.getURL() !== url) win.loadURL(url);
  return { ok: true };
});

// Trae al frente la ventana de agentes (uso manual: botón "Abrir backoffice").
ipcMain.handle('drex:show-agent-window', (_event, url) => {
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

// Verifica si un usuario existe en el casino (ventana separada, no interfiere con cargas)
ipcMain.handle('drex:verify-user', async (_event, { usuario } = {}) => {
  return sendVerification(usuario);
});

// Recibe resultado de verificación desde la verifyWindow
ipcMain.on('drex:verify:result', (_event, response = {}) => {
  const pending = pendingVerification.get(response.requestId);
  if (!pending) return;
  pendingVerification.delete(response.requestId);
  if (response.ok !== false) pending.resolve(response.result ?? response);
  else pending.reject(new Error(response.error || 'Error en verificación.'));
});

// ── IPC handlers para Chunior (ventana visible separada) ─────────────────────
// Ejecuta JS arbitrario en la ventana de Chunior
ipcMain.handle('chunior:exec', async (_event, script) => {
  const win = getChuniorWindow();
  if (win.webContents.isLoading()) await whenChuniorReady(win);
  return win.webContents.executeJavaScript(script, true);
});

// Devuelve la URL actual de la ventana de Chunior
ipcMain.handle('chunior:get-url', () => {
  const win = getChuniorWindow();
  return win.webContents.getURL();
});

// Navega la ventana de Chunior a una URL nueva y espera a que cargue
ipcMain.handle('chunior:navigate', async (_event, url) => {
  const win = getChuniorWindow();
  win.loadURL(url);
  await whenChuniorReady(win);
  return { ok: true, url: win.webContents.getURL() };
});

// Recarga la ventana de Chunior
ipcMain.handle('chunior:reload', async () => {
  const win = getChuniorWindow();
  win.reload();
  await whenChuniorReady(win);
  return { ok: true };
});

// Trae la ventana de Chunior al frente
ipcMain.handle('chunior:focus', () => {
  const win = getChuniorWindow();
  win.show();
  win.focus();
  return { ok: true };
});
