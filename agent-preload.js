const { contextBridge, ipcRenderer } = require('electron');

const USER_SEARCH_URL = 'https://bo.casinodrex.com/agents/user_search';
const DEFAULT_TIMEOUT = 12000;
const STEP_DELAY = 180;

const SELECTORS = {
  searchButton: '#searchButton',
  noResults: '.crmpam_no_data_found',
  playerAlias: '[data-agenttree-user-type="player"], .agents-alias-text',
  amountInput: 'input[name="amount"]:not([disabled]):not([readonly])',
  password: 'input#password[name="password"], input[name="password"][type="password"]',
  passwordRepeat: 'input[name="pasword2"][type="password"], input[name="password2"][type="password"]'
};

function delay(ms = STEP_DELAY) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function now() {
  return Date.now();
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
}

function visibleElements(selector, root = document) {
  return Array.from(root.querySelectorAll(selector)).filter(isVisible);
}

function firstVisible(selector, root = document) {
  return visibleElements(selector, root)[0] || null;
}

async function waitFor(predicate, timeout = DEFAULT_TIMEOUT, interval = 120) {
  const started = now();
  while (now() - started < timeout) {
    const value = typeof predicate === 'function' ? predicate() : document.querySelector(predicate);
    if (value) return value;
    await delay(interval);
  }
  throw new Error('Tiempo de espera agotado esperando la página externa.');
}

function nativeSetValue(input, value) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
}

function setReactInputValue(input, value) {
  if (!input) throw new Error('No se encontró el input requerido.');
  input.focus();
  nativeSetValue(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  nativeSetValue(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function clickElement(el) {
  if (!el) throw new Error('No se encontró el elemento clickeable.');
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  el.click();
}

function clickButtonByIcon(iconName) {
  const selector = `svg[data-icon="${iconName}"], [data-icon="${iconName}"]`;
  const icon = firstVisible(selector);
  if (!icon) {
    throw new Error(`No se encontró el icono ${iconName}.`);
  }
  const button = icon.closest('button, [role="button"], a') || icon.parentElement;
  clickElement(button);
  return true;
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function parseMoney(value) {
  // Formato argentino: "ARS 1.000,50" → 1000.50
  let s = String(value || '').replace(/ /g, ' ').replace(/[^\d,.]/g, '');
  if (s.includes(',')) {
    // punto = separador de miles, coma = decimal
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const number = Number.parseFloat(s);
  return Number.isFinite(number) ? number : 0;
}

function readVisibleBalance() {
  // Selector específico del backoffice: input MUI deshabilitado con el saldo
  const specific = firstVisible('input.MuiInputBase-input.Mui-disabled[disabled], input.Mui-disabled[disabled][type="text"]');
  if (specific && /ARS|^\$|\d{1,}/.test(specific.value || '')) {
    return { raw: specific.value, value: parseMoney(specific.value) };
  }
  // Fallback genérico
  const candidates = visibleElements('input:disabled, input[readonly], input[aria-disabled="true"]');
  const balanceInput = candidates.find(el => /ARS|\$/.test(el.value || ''));
  const raw = balanceInput ? balanceInput.value : '';
  return { raw, value: parseMoney(raw) };
}

function readBalanceFromPlayerRow(playerEl) {
  // Sube por el DOM hasta encontrar la fila (tr, li, o rol=row)
  let row = playerEl;
  for (let i = 0; i < 8; i++) {
    const tag  = (row.tagName || '').toLowerCase();
    const role = row.getAttribute?.('role') || '';
    if (tag === 'tr' || role === 'row' || tag === 'li') break;
    if (!row.parentElement) break;
    row = row.parentElement;
  }

  // Intenta inputs deshabilitados dentro de la fila (columna Cantidad)
  const inputs = Array.from(row.querySelectorAll('input:disabled, input[readonly], input[aria-disabled="true"]'));
  const balInput = inputs.find(el => /ARS|^\$|\d{2,}/.test(el.value || ''));
  if (balInput) return { raw: balInput.value, value: parseMoney(balInput.value) };

  // Intenta celdas de texto con formato de dinero
  const cells = Array.from(row.querySelectorAll('td, [role="cell"]'));
  for (const cell of cells) {
    const text = (cell.textContent || '').trim();
    if (/ARS\s*[\d.,]/.test(text) || /^\$\s*[\d.,]/.test(text)) {
      return { raw: text, value: parseMoney(text) };
    }
  }
  return null;
}

async function leerSaldoViaModal() {
  // Abre el modal de depósito, lee el saldo mostrado, cierra el modal
  try {
    clickButtonByIcon('circle-plus');
    await delay(600);
    const balance = readVisibleBalance();
    // Cierra el modal con Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    await delay(400);
    // Fallback: busca botón de cancelar en el modal
    const cancelBtn = Array.from(visibleElements('button')).find(b => /cancelar|cancel|cerrar|close/i.test(b.textContent || ''));
    if (cancelBtn) { clickElement(cancelBtn); await delay(300); }
    return balance;
  } catch (_) {
    return { raw: '', value: 0 };
  }
}

function findSearchInput() {
  // Primero: busca input con validationField (es el del usuario)
  const validationInput = firstVisible('input.validationField[type="text"]');
  if (validationInput && validationInput.name !== 'amount' && validationInput.id !== 'password') {
    return validationInput;
  }

  // Segundo: busca por legend/placeholder específico "Introduzca un término"
  const allInputs = visibleElements('input[type="text"]');
  const withLabel = allInputs.find(input => {
    const parent = input.closest('.MuiInputBase-root, .MuiOutlinedInput-root');
    if (!parent) return false;
    const legend = parent.querySelector('legend span');
    const placeholder = input.getAttribute('placeholder') || '';
    return (legend && legend.textContent.includes('Introduzca un término')) ||
           placeholder.includes('Introduzca un término') ||
           placeholder.includes('búsqueda');
  });
  if (withLabel && withLabel.name !== 'amount' && withLabel.id !== 'password') {
    return withLabel;
  }

  // Tercero: fallback a busca genérica pero excluyendo el casino
  const searchSelectors = [
    'input[id*="search"]',
    'input[name*="search"]',
    'input[placeholder*="Buscar"]',
    'input[placeholder*="buscar"]',
    'input[placeholder*="Usuario"]',
    'input[placeholder*="usuario"]',
    'input[aria-label*="Buscar"]',
    'input[aria-label*="buscar"]',
    'input[aria-label*="Usuario"]',
    'input[aria-label*="usuario"]',
    'input[type="search"]'
  ];

  for (const selector of searchSelectors) {
    const input = firstVisible(selector);
    if (input && input.name !== 'amount' && input.id !== 'password') return input;
  }

  const candidates = visibleElements('input[type="text"], input:not([type])');
  return candidates.find(input => input.name !== 'amount' && input.id !== 'password' && input.minLength >= 3)
    || candidates.find(input => input.name !== 'amount' && input.id !== 'password')
    || null;
}

function pageNeedsLogin() {
  // Modal de sesión inválida (aparece cuando la sesión expira abruptamente)
  const modal = document.querySelector('.ReactModal__Content');
  if (modal && /session is invalid/i.test(modal.textContent || '')) return true;

  // Pantalla de login — h4 con clase loginTitle o texto "login agente"
  const allH4 = Array.from(document.querySelectorAll('h4'));
  const loginH4 = allH4.find(h => /login agente/i.test(h.textContent || ''));
  if (loginH4) return true;

  // URL apunta a una ruta de login
  if (/login|signin|sign-in/i.test(window.location.href)) return true;

  // Botón "ENTRAR" visible sin botón de búsqueda = pantalla de login
  const hasSearch = document.querySelector(SELECTORS.searchButton) || firstVisible(SELECTORS.playerAlias);
  if (hasSearch) return false;

  const entrarBtn = Array.from(document.querySelectorAll('button')).find(btn => /entrar|ingresar|login|iniciar|sign in/i.test(btn.textContent || ''));
  const password  = document.querySelector('input[type="password"]');
  return Boolean(entrarBtn || password);
}

// Cierra el modal de sesión inválida si está presente y retorna true si lo hizo
async function cerrarModalSesionInvalida() {
  const modal = document.querySelector('.ReactModal__Content');
  if (!modal) return false;
  if (!/session is invalid/i.test(modal.textContent || '')) return false;
  const acceptBtn = Array.from(modal.querySelectorAll('button')).find(b => /accept|aceptar/i.test(b.textContent || ''));
  if (acceptBtn) { clickElement(acceptBtn); await delay(600); }
  return true;
}

function status(extra = {}) {
  const needsLogin = pageNeedsLogin();
  return {
    ok: !needsLogin,
    needsLogin,
    url: window.location.href,
    message: needsLogin
      ? 'La página de agentes requiere iniciar sesión o no respondió con el módulo esperado. Iniciá sesión manualmente y volvé a intentar.'
      : 'Módulo de agentes disponible.',
    ...extra
  };
}

async function ensureUserSearchReady() {
  // Cierra el modal de sesión inválida antes de evaluar el estado
  await cerrarModalSesionInvalida();
  if (pageNeedsLogin()) return status();
  try {
    await waitFor(() => document.querySelector(SELECTORS.searchButton) || firstVisible(SELECTORS.playerAlias));
  } catch (_) {
    // Si agotó el timeout, re-chequea login (puede haber redirigido)
    await cerrarModalSesionInvalida();
    return status();
  }
  return status();
}

async function buscarUsuario(usuario, options = {}) {
  if (!usuario || String(usuario).trim().length < 3) {
    throw new Error('El usuario debe tener al menos 3 caracteres.');
  }

  const ready = await ensureUserSearchReady();
  if (ready.needsLogin) return ready;

  const searchInput = await waitFor(findSearchInput, options.timeout || DEFAULT_TIMEOUT);
  setReactInputValue(searchInput, String(usuario).trim());
  await delay();

  clickElement(await waitFor(() => firstVisible(SELECTORS.searchButton), options.timeout || DEFAULT_TIMEOUT));

  const wanted = String(usuario).trim();

  await waitFor(() => {
    const noData = firstVisible(SELECTORS.noResults);
    const player = firstVisible(SELECTORS.playerAlias);
    return noData || player;
  }, options.timeout || DEFAULT_TIMEOUT);

  // Re-chequea login por si el timeout ocultó una redirección
  await cerrarModalSesionInvalida();
  if (pageNeedsLogin()) return status();

  const noResults = firstVisible(SELECTORS.noResults);
  if (noResults) {
    return { ok: true, exists: false, user: wanted, message: normalizeText(noResults.textContent) };
  }

  const player = firstVisible(SELECTORS.playerAlias);
  const playerAlias = normalizeText(player ? player.textContent : '');

  // Match exacto: normaliza quitando acentos, espacios y comparando en minúsculas
  function normAlias(s) {
    return s.toLowerCase().replace(/[\s ]+/g, '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  const exactMatch = normAlias(playerAlias) === normAlias(wanted);

  if (!exactMatch) {
    return {
      ok: true,
      exists: false,
      user: playerAlias,
      message: `El alias encontrado "${playerAlias}" no coincide exactamente con "${wanted}".`
    };
  }

  // 1 intenta leer el saldo directo de la fila (columna Cantidad)
  let balance = player ? readBalanceFromPlayerRow(player) : null;

  // 2 si no hay nada, abre el modal de deposito, lee y lo cierra
  if (!balance || (!balance.raw && balance.value === 0)) {
    balance = await leerSaldoViaModal();
  }

  return { ok: true, exists: true, user: playerAlias, balance };
}

async function openMovementModal(iconName, options = {}) {
  const ready = await ensureUserSearchReady();
  if (ready.needsLogin) return ready;
  clickButtonByIcon(iconName);
  await delay(350);
  const amountInput = await waitFor(() => firstVisible(SELECTORS.amountInput), options.timeout || DEFAULT_TIMEOUT);
  return { ok: true, amountInput, balance: readVisibleBalance() };
}

function findActionButton(textPattern, root = document) {
  const buttons = visibleElements('button, [role="button"]', root);
  return buttons.find(btn => textPattern.test(btn.textContent || '')) || null;
}

async function cerrarModalActual() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  await delay(400);
  const cancelBtn = Array.from(visibleElements('button')).find(b => /cancelar|cancel|cerrar|close/i.test(b.textContent || ''));
  if (cancelBtn) { clickElement(cancelBtn); await delay(300); }
}

async function applyAmount(iconName, amount, actionName, options = {}) {
  const numericAmount = Number(String(amount).replace(',', '.'));
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('El monto debe ser un número mayor a cero.');
  }

  const opened = await openMovementModal(iconName, options);
  if (opened.needsLogin) return opened;

  // Para retiros: verificar saldo suficiente antes de confirmar
  if (actionName === 'retiro' && opened.balance && opened.balance.value > 0) {
    if (opened.balance.value < numericAmount) {
      await cerrarModalActual();
      return {
        ok: false,
        saldoInsuficiente: true,
        balance: opened.balance,
        message: `Saldo insuficiente: ${opened.balance.raw.trim()} disponible, se solicitaron $${numericAmount.toLocaleString('es-AR')}.`
      };
    }
  }

  setReactInputValue(opened.amountInput, String(amount));
  await delay();

  const applyButton = findActionButton(/aplicar/i) || firstVisible('button#btn_deposit, button.btn.btn-primary');
  clickElement(applyButton);

  // Espera a que el modal cierre y lee el saldo resultante
  await delay(800);
  const newBalance = readVisibleBalance();

  return {
    ok: true,
    action: actionName,
    amount: numericAmount,
    previousBalance: opened.balance,
    newBalance,
    message: `${actionName} enviado. Saldo anterior: ${opened.balance.raw.trim()}${newBalance.raw ? ' → ' + newBalance.raw.trim() : ''}.`
  };
}

function cargarSaldo(amount, options) {
  return applyAmount('circle-plus', amount, 'carga', options);
}

function retirarSaldo(amount, options) {
  return applyAmount('circle-minus', amount, 'retiro', options);
}

async function cambiarClave(password, options = {}) {
  if (!password || String(password).length < 4) {
    throw new Error('La contraseña debe tener al menos 4 caracteres.');
  }

  const ready = await ensureUserSearchReady();
  if (ready.needsLogin) return ready;

  clickButtonByIcon('key');
  await delay(350);

  const pass1 = await waitFor(() => firstVisible(SELECTORS.password), options.timeout || DEFAULT_TIMEOUT);
  const pass2 = await waitFor(() => firstVisible(SELECTORS.passwordRepeat), options.timeout || DEFAULT_TIMEOUT);
  setReactInputValue(pass1, password);
  setReactInputValue(pass2, password);
  await delay();

  const changeButton = findActionButton(/cambiar/i);
  clickElement(changeButton);

  return { ok: true, action: 'cambio_clave', message: 'Cambio de clave enviado. Confirmá el resultado en la página externa.' };
}

function irABusquedaUsuarios() {
  if (window.location.href !== USER_SEARCH_URL) window.location.assign(USER_SEARCH_URL);
  return { ok: true, url: USER_SEARCH_URL };
}

const api = {
  buscarUsuario,
  cargarSaldo,
  retirarSaldo,
  cambiarClave,
  irABusquedaUsuarios,
  estadoPagina: status
};

contextBridge.exposeInMainWorld('drexAutomation', api);

ipcRenderer.on('drex:automation:run', async (event, request = {}) => {
  const { requestId, method, args = [] } = request;
  try {
    if (!Object.prototype.hasOwnProperty.call(api, method)) {
      throw new Error(`Método no permitido: ${method}`);
    }
    const result = await api[method](...args);
    ipcRenderer.send('drex:automation:result', { requestId, ok: true, result });
  } catch (error) {
    ipcRenderer.send('drex:automation:result', { requestId, ok: false, error: error.message || String(error) });
  }
});