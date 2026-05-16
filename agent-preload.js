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
  const cleaned = String(value || '').replace(/[^\d,.-]/g, '').replace(/,/g, '');
  const number = Number.parseFloat(cleaned);
  return Number.isFinite(number) ? number : 0;
}

function readVisibleBalance() {
  const candidates = visibleElements('input:disabled, input[readonly], input[aria-disabled="true"]');
  const balanceInput = candidates.find(input => /ARS|\$|\d/.test(input.value || ''));
  const raw = balanceInput ? balanceInput.value : '';
  return { raw, value: parseMoney(raw) };
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
  const hasSearch = document.querySelector(SELECTORS.searchButton) || document.querySelector(SELECTORS.playerAlias);
  if (hasSearch) return false;
  const password = document.querySelector('input[type="password"]');
  const loginButton = Array.from(document.querySelectorAll('button')).find(btn => /ingresar|login|iniciar|sign in/i.test(btn.textContent || ''));
  return Boolean(password || loginButton);
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
  if (pageNeedsLogin()) return status();
  await waitFor(() => document.querySelector(SELECTORS.searchButton) || document.querySelector(SELECTORS.playerAlias));
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

  const wanted = String(usuario).trim().toLowerCase();
  await waitFor(() => {
    const noData = firstVisible(SELECTORS.noResults);
    const player = firstVisible(SELECTORS.playerAlias);
    const playerText = normalizeText(player ? player.textContent : '').toLowerCase();
    return noData || (player && (!playerText || playerText.includes(wanted) || wanted.includes(playerText)));
  }, options.timeout || DEFAULT_TIMEOUT);

  const noResults = firstVisible(SELECTORS.noResults);
  if (noResults) {
    return { ok: true, exists: false, user: String(usuario).trim(), message: normalizeText(noResults.textContent) };
  }

  const player = firstVisible(SELECTORS.playerAlias);
  return {
    ok: true,
    exists: Boolean(player),
    user: normalizeText(player ? player.textContent : usuario),
    balance: readVisibleBalance()
  };
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

async function applyAmount(iconName, amount, actionName, options = {}) {
  const numericAmount = Number(String(amount).replace(',', '.'));
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('El monto debe ser un número mayor a cero.');
  }

  const opened = await openMovementModal(iconName, options);
  if (opened.needsLogin) return opened;

  setReactInputValue(opened.amountInput, String(amount));
  await delay();

  const applyButton = findActionButton(/aplicar/i) || firstVisible('button#btn_deposit, button.btn.btn-primary');
  clickElement(applyButton);

  return {
    ok: true,
    action: actionName,
    amount: numericAmount,
    previousBalance: opened.balance,
    message: `${actionName} enviado. Confirmá el resultado en la página externa.`
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