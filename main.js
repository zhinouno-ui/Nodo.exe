const path    = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const AGENT_URL    = 'https://bo.casinodrex.com/agents/user_search';
const NEW_USER_URL = 'https://bo.casinodrex.com/agents/new_user';
const CHUNIOR_URL  = 'https://bo.chunior.com/transacciones/';

// Sesión propia para agentes (agentWindow + verifyWindow la comparten). Permite
// aplicar un PROXY y limpiar datos solo para agentes, sin afectar Reg ni Supabase.
const AGENT_PARTITION = 'persist:agentes';
function agentSession() { return session.fromPartition(AGENT_PARTITION); }

// Credenciales del proxy (si requiere auth). Solo en memoria, NUNCA se persisten a disco.
let proxyCreds = null; // { user, pass } | null

// true mientras navigateAgentTo está recargando agentes a propósito. Cualquier OTRA
// navegación de esa ventana (recarga a mitad de operación) aborta la op pendiente.
let navEsperada = false;

// Responde a los pedidos de autenticación del PROXY con las credenciales en memoria.
app.on('login', (event, _webContents, _details, authInfo, callback) => {
  if (authInfo && authInfo.isProxy && proxyCreds && proxyCreds.user) {
    event.preventDefault();
    callback(proxyCreds.user, proxyCreds.pass || '');
  }
  // Si no es proxy (o no hay creds), dejamos el comportamiento por defecto.
});

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

// Hace que la sesión de agentes parezca un Chrome real (no un Electron automatizado):
//   - User-Agent de Chrome SIN "Electron/..." ni el nombre de la app.
//   - Client hints (sec-ch-ua*) CONSISTENTES con ese UA (un UA de Chrome sin client
//     hints que coincidan es una señal clásica de bot que dispara el WAF de CloudFront).
//   - Accept-Language normal.
// Un solo hook por sesión (guard _uaHook).
function configurarSesionAgentes(win) {
  try {
    const cur       = win.webContents.getUserAgent();
    const chromeTok = (cur.match(/Chrome\/[\d.]+/) || ['Chrome/124.0.0.0'])[0];
    const major     = (chromeTok.match(/\d+/) || ['124'])[0];
    const ua        = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' + chromeTok + ' Safari/537.36';
    const secChUa   = '"Chromium";v="' + major + '", "Google Chrome";v="' + major + '", "Not.A/Brand";v="99"';

    const ses = agentSession();
    ses.setUserAgent(ua);
    win.webContents.setUserAgent(ua);

    if (!ses._uaHook) {
      ses._uaHook = true;
      ses.webRequest.onBeforeSendHeaders((details, cb) => {
        const h = details.requestHeaders;
        h['User-Agent']          = ua;
        h['sec-ch-ua']           = secChUa;
        h['sec-ch-ua-mobile']    = '?0';
        h['sec-ch-ua-platform']  = '"Windows"';
        if (!h['Accept-Language']) h['Accept-Language'] = 'es-AR,es;q=0.9,en;q=0.8';
        cb({ requestHeaders: h });
      });
    }
  } catch (e) { console.warn('[main] configurarSesionAgentes:', e && e.message); }
}

// ── Ventana del backoffice del casino (Bo) ────────────────────────────
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
      partition:            AGENT_PARTITION,
    }
  });

  configurarSesionAgentes(agentWindow);

  agentWindow.loadURL(url);

  // Si la ventana de agentes navega/recarga de forma INESPERADA (no fue navigateAgentTo)
  // con una operación pendiente, la abortamos al instante en vez de colgarnos esperando
  // un modal que la recarga ya borró. did-navigate NO dispara en navegaciones in-page del
  // SPA, así que solo cazamos recargas/redirects reales (incluido un redirect a login).
  agentWindow.webContents.on('did-navigate', (_e, navUrl) => {
    if (navEsperada) return;
    if (pendingAutomation.size) {
      console.warn('[main] navegación inesperada en agentes durante operación → aborto:', navUrl);
      for (const [, p] of pendingAutomation) {
        try { p.reject(new Error('La página de agentes se recargó durante la operación. Reintentá.')); } catch (_) {}
      }
      pendingAutomation.clear();
    }
  });

  agentWindow.on('closed', () => {
    agentWindow = null;
    pendingAutomation.clear();
  });

  return agentWindow;
}

// ── Ventana de Reg (backoffice secundario, VISIBLE) ───────────────────────
// Contiene la lógica de login + sync de billeteras + registro de cargas.
// El operador puede ver el flujo en vivo en esta ventana.
function createRegWindow() {
  chuniorWindow = new BrowserWindow({
    width:  1200,
    height: 800,
    title:  'Reg — Backoffice',
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation:     true,
      nodeIntegration:      false,
      sandbox:              true,
      backgroundThrottling: false, // que Reg siga refrescando aunque no esté enfocado
    }
  });
  chuniorWindow.loadURL(CHUNIOR_URL);
  chuniorWindow.on('closed', () => { chuniorWindow = null; });
  return chuniorWindow;
}

function getRegWindow() {
  if (chuniorWindow && !chuniorWindow.isDestroyed()) return chuniorWindow;
  return createRegWindow();
}

function whenRegReady(win, timeoutMs = 15000) {
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

// ⛔ FLUJO BLINDADO — NO MODIFICAR (core de carga/retiro estable).
// El did-finish-load antes de operar es lo que evita buscar sobre la página vieja.
// Tag git: estable-flujo-carga.
async function agentPageIsBlocked(win) {
  // Detecta páginas de error del CDN/servidor (CloudFront 403/404/5xx, "Request blocked")
  // SOLO si además no está la app cargada (una pantalla de login es válida, no error).
  try {
    return await win.webContents.executeJavaScript(`(function(){
      try {
        var hasApp = !!(document.querySelector('#searchButton') || document.querySelector('input[name="amount"]') || document.querySelector('[data-agenttree-user-type]') || document.querySelector('input[type="password"]') || document.querySelector('input[name="alias"]'));
        if (hasApp) return false;
        var body = (document.body && (document.body.innerText||document.body.textContent) || '').slice(0,2000).toLowerCase();
        var title = (document.title||'').toLowerCase();
        // 403/404/CDN  +  crash del propio SPA del casino (ErrorBoundary de React)
        return /(40[0-9]|50[0-9])\\s*error|request blocked|request could not be satisfied|generated by cloudfront|service unavailable|bad gateway|gateway timeout|access denied|forbidden|algo sali|cannot read properties|errorboundary/.test(body) || /\\b(403|404|500|502|503|error)\\b/.test(title);
      } catch(e){ return false; }
    })()`, true);
  } catch (_) { return false; }
}

// Espera a que el SPA de agentes REALMENTE monte (que aparezca el buscador o el login)
// antes de devolver. Evita interactuar "muy rápido" tras el refresh, que es lo que
// crashea la app (TypeError ... 'MAIN' en su ErrorBoundary). Si detecta error, corta.
async function agentWaitReady(win, timeoutMs = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await win.webContents.executeJavaScript(`(function(){
      try {
        if (document.querySelector('#searchButton') || document.querySelector('input.validationField') || document.querySelector('input[name="amount"]') || document.querySelector('input[type="password"]') || document.querySelector('input[name="alias"]') || document.querySelector('[data-agenttree-user-type]')) return 'ready';
        var b = (document.body && (document.body.innerText||document.body.textContent) || '').toLowerCase();
        if (/algo sali|cannot read properties|errorboundary|request blocked|generated by cloudfront|forbidden|\\b(403|404|50[0-9])\\b/.test(b)) return 'error';
        return 'wait';
      } catch(e){ return 'wait'; }
    })()`, true).catch(() => 'wait');
    if (st === 'ready') return true;
    if (st === 'error') return false;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function navigateAgentTo(url = AGENT_URL) {
  const win = getAgentWindow();
  navEsperada = true; // las navegaciones de acá son ESPERADAS (no deben abortar la op)
  try {
  // Siempre recargamos la página antes de operar para dejar el search limpio.
  // Configuramos el listener de 'did-finish-load' ANTES de loadURL para no perder
  // el evento (whenAgentReady a veces resolvía antes de que arrancara la carga).
  // Reintentamos hasta 3 veces si la página vuelve como error del CDN (403/404),
  // porque suele ser transitorio y un reload lo resuelve — así NO corremos el
  // script sobre una página rota.
  const MAX = 3;
  for (let intento = 1; intento <= MAX; intento++) {
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
    // Esperar a que el SPA monte (NO actuar "muy rápido" tras el refresh) + un respiro
    // extra para que React termine de pintar antes de tipear/leer.
    await agentWaitReady(win);
    await new Promise(r => setTimeout(r, 900));

    const blocked = await agentPageIsBlocked(win);
    if (!blocked) return;                 // página OK → listo
    if (intento < MAX) {
      console.warn('[main] agentes devolvió página de error (intento ' + intento + '/' + MAX + ') → reintento');
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  // Tras MAX intentos sigue bloqueada — el preload detectará pageError y abortará la operación.
  } finally { navEsperada = false; }
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
      partition:        AGENT_PARTITION,
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
  createRegWindow();
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

// Limpia los datos del navegador de AGENTES (cookies/localStorage/cache) y recarga
// para reingresar. Sirve para destrabar el 403 de CloudFront. Scopeado al origen de
// casinodrex para NO desloguear la ventana de Reg (comparte sesión por defecto).
ipcMain.handle('drex:clear-data', async () => {
  const ses = agentSession();
  try { await ses.clearStorageData(); } // toda la sesión de agentes (no afecta Reg ni NODO)
  catch (e) { console.warn('[main] clearStorageData falló:', e && e.message); }
  try { await ses.clearCache(); } catch (e) { console.warn('[main] clearCache falló:', e && e.message); }
  // Recargar la pantalla de agentes (quedará en el login para reingresar)
  await navigateAgentTo(AGENT_URL);
  return { ok: true };
});

// ── PROXY para agentes ────────────────────────────────────────────────────────
// Aplica un proxy SOLO a la sesión de agentes (no a Reg ni a Supabase/NODO).
// cfg: { protocolo, servidor, puerto, usuario, password, dns, bypass }
ipcMain.handle('proxy:set', async (_event, cfg = {}) => {
  const protocolo = String(cfg.protocolo || 'http').toLowerCase();
  const host = String(cfg.servidor || '').trim();
  const port = String(cfg.puerto || '').trim();
  if (!host || !port) return { ok: false, error: 'Falta servidor o puerto.' };

  // Construir proxyRules según el protocolo
  let proxyRules;
  if (protocolo === 'socks5')      proxyRules = 'socks5://' + host + ':' + port;
  else if (protocolo === 'socks4') proxyRules = 'socks4://' + host + ':' + port;
  else if (protocolo === 'https')  proxyRules = 'https=' + host + ':' + port;
  else                             proxyRules = 'http=' + host + ':' + port + ';https=' + host + ':' + port;

  // Credenciales (solo memoria). Si no hay usuario, limpiamos.
  proxyCreds = (cfg.usuario && String(cfg.usuario).trim())
    ? { user: String(cfg.usuario).trim(), pass: String(cfg.password || '') }
    : null;

  try {
    const ses = agentSession();
    await ses.setProxy({
      proxyRules,
      proxyBypassRules: cfg.bypass ? String(cfg.bypass) : '<local>'
    });
    // DNS por el proxy: con socks5 la resolución DNS ya se hace en el proxy (remota).
    // Para http/https el proxy resuelve el host del CONNECT. Guardamos la preferencia
    // pero Electron no expone un toggle fino; dejamos el comportamiento por scheme.
    // Forzar una verificación de credenciales recargando agentes.
    await navigateAgentTo(AGENT_URL);
    return { ok: true, proxyRules };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'No se pudo aplicar el proxy.' };
  }
});

ipcMain.handle('proxy:clear', async () => {
  proxyCreds = null;
  try {
    const ses = agentSession();
    await ses.setProxy({ mode: 'direct' });
    await navigateAgentTo(AGENT_URL);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'No se pudo quitar el proxy.' };
  }
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

// ── IPC handlers para Reg (ventana visible separada) ─────────────────────
// Ejecuta JS arbitrario en la ventana de Reg
ipcMain.handle('chunior:exec', async (_event, script) => {
  const win = getRegWindow();
  if (win.webContents.isLoading()) await whenRegReady(win);
  return win.webContents.executeJavaScript(script, true);
});

// Devuelve la URL actual de la ventana de Reg
ipcMain.handle('chunior:get-url', () => {
  const win = getRegWindow();
  return win.webContents.getURL();
});

// Navega la ventana de Reg a una URL nueva y espera a que cargue
ipcMain.handle('chunior:navigate', async (_event, url) => {
  const win = getRegWindow();
  win.loadURL(url);
  await whenRegReady(win);
  return { ok: true, url: win.webContents.getURL() };
});

// Recarga la ventana de Reg
ipcMain.handle('chunior:reload', async () => {
  const win = getRegWindow();
  win.reload();
  await whenRegReady(win);
  return { ok: true };
});

// Trae la ventana de Reg al frente
ipcMain.handle('chunior:focus', () => {
  const win = getRegWindow();
  win.show();
  win.focus();
  return { ok: true };
});
