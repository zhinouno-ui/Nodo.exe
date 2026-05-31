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
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const set = v => nativeSetter ? nativeSetter.call(input, v) : (input.value = v);
  input.click();
  input.focus();
  set('');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
  set(String(value));
  input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: String(value), inputType: 'insertText' }));
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

// Inyecta valor + verifica que React lo aceptó. Si no, reintenta hasta `tries` veces.
// Devuelve true si el valor quedó seteado, false si no.
async function setReactInputAndVerify(input, value, tries = 4) {
  const target = String(value);
  for (let i = 0; i < tries; i++) {
    setReactInputValue(input, target);
    await delay(120); // ventana de verificación
    if (String(input.value || '') === target) return true;
  }
  return false;
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
  let s = String(value || '').replace(/[\u00a0\u202f\s]/g, '').replace(/[^\d,.]/g, '');
  if (!s) return 0;
  const lastDot   = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot > lastComma)        s = s.replace(/,/g, '');
  else if (lastComma > lastDot)   s = s.replace(/\./g, '').replace(',', '.');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function findActiveModal() {
  const sels = '.ReactModal__Content, .MuiDialog-root, .MuiModal-root, [role="dialog"]';
  return firstVisible(sels);
}

// Saldo del USUARIO — busca inputs disabled con "ARS" en toda la página
// El saldo del agente es un SPAN (.hideUserBalance), nunca un input → sin conflicto
function readUserBalance() {
  const inputs = Array.from(document.querySelectorAll(
    'input.Mui-disabled, input[disabled], input[readonly]'
  )).filter(isVisible);
  const bal = inputs.find(el => /ARS/.test(el.value || ''));
  if (bal) return { raw: bal.value, value: parseMoney(bal.value) };
  return null;
}

// Saldo del AGENTE (operador) — span.hideUserBalance siempre visible en el backoffice
function readAgentBalance() {
  const span = firstVisible('span.hideUserBalance');
  if (span) {
    const raw = span.textContent || span.innerText || '';
    return { raw: raw.trim(), value: parseMoney(raw) };
  }
  // Fallback: input deshabilitado fuera de modales
  const modal = findActiveModal();
  const candidates = visibleElements('input:disabled, input[readonly], input[aria-disabled="true"]');
  const outside = modal ? candidates.filter(el => !modal.contains(el)) : candidates;
  const bal = outside.find(el => /ARS|\$/.test(el.value || ''));
  if (bal) return { raw: bal.value, value: parseMoney(bal.value) };
  return { raw: '', value: 0 };
}

// Mantengo readVisibleBalance como alias para compatibilidad — devuelve user balance
function readVisibleBalance() {
  return readUserBalance() || { raw: '', value: 0 };
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

// Lee el saldo del jugador asumiendo que el modal de depósito YA está abierto.
// No abre ni cierra nada. Si no encuentra nada devuelve {raw:'', value:0}.
function _leerSaldoJugadorEnModalAbierto() {
  // ── Estrategia 1: buscar por label "Balance Jugador" / "Jugador" ──────────
  const allLabels = Array.from(document.querySelectorAll(
    'label, .MuiInputLabel-root, .MuiFormLabel-root, legend, [class*="InputLabel"], [class*="label"], p, span'
  )).filter(isVisible);

  for (const label of allLabels) {
    const text = (label.textContent || label.innerText || '').trim();
    if (!/jugador/i.test(text)) continue;
    const container = label.closest(
      '.MuiFormControl-root, .MuiTextField-root, .MuiOutlinedInput-root, fieldset, .form-group, .MuiInputBase-root'
    ) || label.parentElement;
    if (!container) continue;
    const inp = container.querySelector('input[disabled], input.Mui-disabled, input[readonly]');
    if (inp && isVisible(inp) && /ARS/.test(inp.value || '')) {
      return { raw: inp.value, value: parseMoney(inp.value) };
    }
    const formControl = label.closest('.MuiFormControl-root') || label.parentElement?.closest('.MuiFormControl-root');
    if (formControl) {
      const inp2 = formControl.querySelector('input[disabled], input.Mui-disabled, input[readonly]');
      if (inp2 && isVisible(inp2) && /ARS/.test(inp2.value || '')) {
        return { raw: inp2.value, value: parseMoney(inp2.value) };
      }
    }
  }

  // ── Estrategia 2: ARS inputs → el de menor valor es el jugador ───────────
  const arsInputs = Array.from(document.querySelectorAll(
    'input[disabled], input.Mui-disabled, input[readonly]'
  ))
    .filter(isVisible)
    .filter(el => /ARS/.test(el.value || ''));

  if (arsInputs.length >= 2) {
    const sorted = arsInputs.slice().sort((a, b) => parseMoney(a.value) - parseMoney(b.value));
    return { raw: sorted[0].value, value: parseMoney(sorted[0].value) };
  }
  if (arsInputs.length === 1) {
    return { raw: arsInputs[0].value, value: parseMoney(arsInputs[0].value) };
  }
  return { raw: '', value: 0 };
}

// Lee los DOS balances del jugador en el modal abierto (depósito o retiro).
// El modal de Casinodrex tiene dos inputs disabled lado a lado:
//   - Input 0 (DOM order): saldo PREVIO / actual del jugador
//   - Input 1 (DOM order): saldo POSTERIOR (preview cuando hay monto tipeado, o
//                          actual después de Aplicar)
// Si hay un tercer input ARS (balance agente) lo descartamos por ser el más alto.
// Devuelve { pre, post }, cada uno con { raw, value } o null si no se encontró.
function _leerBalancesEnModalDeposito() {
  const inputs = Array.from(document.querySelectorAll(
    'input[disabled], input.Mui-disabled, input[readonly]'
  ))
    .filter(isVisible)
    .filter(el => /ARS/.test(el.value || ''));

  if (inputs.length === 0) return { pre: null, post: null };

  // Si hay 3+ inputs ARS, el de mayor valor es el balance del AGENTE → lo descartamos
  let candidates = inputs;
  if (inputs.length >= 3) {
    const sorted = [...inputs].sort((a, b) => parseMoney(b.value) - parseMoney(a.value));
    const agente = sorted[0];
    candidates = inputs.filter(el => el !== agente);
  }

  // Ordenar por posición en el DOM (input 0 = pre, input 1 = post)
  candidates.sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });

  return {
    pre:  candidates[0] ? { raw: candidates[0].value, value: parseMoney(candidates[0].value) } : null,
    post: candidates[1] ? { raw: candidates[1].value, value: parseMoney(candidates[1].value) } : null
  };
}

// Abre el modal de depósito (circle-plus) y devuelve el saldo PRE del jugador.
// NO cierra el modal — el caller decide qué hacer.
async function abrirModalDepositoYLeerSaldo() {
  clickButtonByIcon('circle-plus');
  await delay(800);
  const balances = _leerBalancesEnModalDeposito();
  return balances.pre || _leerSaldoJugadorEnModalAbierto();
}

// Versión completa: abre, lee, cierra. Mantiene el comportamiento histórico.
async function leerSaldoViaModal() {
  try {
    return await abrirModalDepositoYLeerSaldo();
  } catch (_) {
    return { raw: '', value: 0 };
  } finally {
    await cerrarModalActual();
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

// Detecta el modal de sesión inválida en cualquiera de sus variantes:
//  - .ReactModal__Content (versión vieja, texto "session is invalid")
//  - .ReactModalContent  (versión nueva, texto "Invalid session", botón "Cerrar")
//  - .card-alert         (fallback por si encapsula el modal)
function detectarModalSesionInvalida() {
  const selectores = ['.ReactModal__Content', '.ReactModalContent', '.card-alert', '[role="dialog"]'];
  for (const sel of selectores) {
    const el = document.querySelector(sel);
    if (el && /invalid session|session is invalid/i.test(el.textContent || '')) return el;
  }
  return null;
}

function pageNeedsLogin() {
  // Modal de sesión inválida (aparece cuando la sesión expira abruptamente)
  if (detectarModalSesionInvalida()) return true;

  // Pantalla de login — h4 con clase loginTitle o texto "login agente"
  const allH4 = Array.from(document.querySelectorAll('h4'));
  const loginH4 = allH4.find(h => /login agente/i.test(h.textContent || ''));
  if (loginH4) return true;

  // URL apunta a una ruta de login
  if (/login|signin|sign-in/i.test(window.location.href)) return true;

  // /new_user: la página tiene un input[type=password] (clave del nuevo jugador),
  // pero NO es la pantalla de login. La reconocemos como página interna válida.
  if (/\/new_user/i.test(window.location.href)) {
    const tieneFormulario = document.querySelector('input[name="alias"]')
                         || document.querySelector('input[name="password"][type="password"]')
                         || /nuevo\s+jugador/i.test(document.body.textContent || '');
    if (tieneFormulario) return false;
  }

  // Botón "ENTRAR" visible sin botón de búsqueda = pantalla de login
  const hasSearch = document.querySelector(SELECTORS.searchButton) || firstVisible(SELECTORS.playerAlias);
  if (hasSearch) return false;

  const entrarBtn = Array.from(document.querySelectorAll('button')).find(btn => /entrar|ingresar|login|iniciar|sign in/i.test(btn.textContent || ''));
  const password  = document.querySelector('input[type="password"]');
  return Boolean(entrarBtn || password);
}

// Maneja el modal de sesión inválida. Estrategia:
//   1) Si el modal tiene un botón "Accept" / "Cerrar" / "OK" visible → lo clickea
//      (el modal mismo redirige al login del casino, mejor que recargar a mano)
//   2) Si no hay botón → fallback: navega a USER_SEARCH_URL para forzar el login screen
// Espera hasta que el modal desaparezca y que aparezca el form de login.
async function cerrarModalSesionInvalida() {
  const modal = detectarModalSesionInvalida();
  if (!modal) return false;

  // Buscar el botón dentro del modal: "Accept", "Cerrar", "OK" o el .btn-primary visible
  const buttons = Array.from(modal.querySelectorAll('button, [role="button"], input[type="submit"], a.btn'));
  const accept = buttons.find(b => {
    if (!isVisible(b)) return false;
    const t = ((b.textContent || b.value || '') + '').trim().toLowerCase();
    return /accept|aceptar|cerrar|close|ok/.test(t);
  }) || buttons.find(isVisible);

  if (accept) {
    try { clickElement(accept); } catch (_) {}
  } else {
    // Sin botón: fallback al reload diferido
    setTimeout(() => { try { window.location.assign(USER_SEARCH_URL); } catch (_) {} }, 200);
  }

  // Esperar a que el modal desaparezca (hasta 6 segundos)
  const tFin = Date.now() + 6000;
  while (Date.now() < tFin) {
    await delay(180);
    if (!detectarModalSesionInvalida()) break;
  }
  // Y esperar a que aparezca el form de login o se cargue alguna página interna
  const tFin2 = Date.now() + 6000;
  while (Date.now() < tFin2) {
    await delay(180);
    if (document.querySelector('input[type="password"]')) break;
    if (document.querySelector(SELECTORS.searchButton)) break;
  }
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

// ⛔ FLUJO BLINDADO — NO MODIFICAR (parte del core de carga/retiro estable).
// La espera del resultado-que-coincide y la lectura de saldo pre/post están
// calibradas. Tag git: estable-flujo-carga.
async function buscarUsuario(usuario, options = {}) {
  if (!usuario || String(usuario).trim().length < 3) {
    throw new Error('El usuario debe tener al menos 3 caracteres.');
  }

  const ready = await ensureUserSearchReady();
  if (ready.needsLogin) return ready;

  const searchInput = await waitFor(findSearchInput, options.timeout || DEFAULT_TIMEOUT);
  const wantedClean = String(usuario).trim();
  // Inyecta con verificación: si React no aceptó el valor a los 120ms, reintenta.
  const seteado = await setReactInputAndVerify(searchInput, wantedClean, 4);
  if (!seteado) {
    return { ok: false, exists: false, user: wantedClean, message: 'El campo de búsqueda no aceptó el alias después de varios intentos.' };
  }

  const wanted = String(usuario).trim();
  function normAlias(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(new RegExp('[\u0300-\u036f]','g'), '').replace(/\s+/g, '');
  }
  const wantedNorm = normAlias(wanted);

  // Click buscar y esperar el resultado QUE COINCIDE con lo buscado.
  // Ignoramos resultados viejos (de una busqueda anterior) que tardan en limpiarse.
  clickElement(await waitFor(() => firstVisible(SELECTORS.searchButton), options.timeout || DEFAULT_TIMEOUT));
  await delay(350);

  const TIMEOUT = options.timeout || DEFAULT_TIMEOUT;
  const inicioBusqueda = now();
  let matchedAlias = null;
  let huboNoResults = false;

  while (now() - inicioBusqueda < TIMEOUT) {
    await cerrarModalSesionInvalida();
    if (pageNeedsLogin()) return status();
    const players = visibleElements(SELECTORS.playerAlias);
    const match = players.find(el => normAlias(normalizeText(el.textContent)) === wantedNorm);
    if (match) { matchedAlias = normalizeText(match.textContent); break; }
    if (firstVisible(SELECTORS.noResults)) {
      const m2 = visibleElements(SELECTORS.playerAlias).find(el => normAlias(normalizeText(el.textContent)) === wantedNorm);
      if (m2) { matchedAlias = normalizeText(m2.textContent); break; }
      huboNoResults = true; break;
    }
    await delay(180);
  }

  if (!matchedAlias) {
    return { ok: true, exists: false, user: wanted, message: huboNoResults ? ('Sin resultados para ' + wanted) : 'No aparecio el usuario buscado.' };
  }
  const playerAlias = matchedAlias;

  // Modos de lectura de balance:
  //   - options.skipBalance      → no leer (no abre modal)
  //   - options.keepDepositModalOpen → abrir modal, leer, DEJAR ABIERTO
  //     (el caller va a llamar cargarSaldo con modalAlreadyOpen y reusar el modal)
  //   - default                  → abrir, leer, cerrar
  let balance = null;
  let modalLeftOpen = false;
  if (options.skipBalance) {
    // nada
  } else if (options.keepDepositModalOpen) {
    balance = await abrirModalDepositoYLeerSaldo();
    modalLeftOpen = true;
  } else {
    balance = await leerSaldoViaModal();
  }

  return { ok: true, exists: true, user: playerAlias, balance, modalLeftOpen };
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

// ⛔ FLUJO BLINDADO — NO MODIFICAR (core de carga/retiro estable).
// Abre el modal UNA vez, lee saldo pre (input 0) y post (input 1). Tag: estable-flujo-carga.
async function applyAmount(iconName, amount, actionName, options = {}) {
  const numericAmount = Number(String(amount).replace(',', '.'));
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('El monto debe ser un número mayor a cero.');
  }

  const opened = await openMovementModal(iconName, options);
  if (opened.needsLogin) return opened;

  // Espera a que el modal termine de renderizar (React necesita tiempo)
  await delay(500);

  // El modal tiene DOS inputs disabled del jugador: pre y post.
  // Leemos ambos por orden DOM. El primero es el saldo actual (PRE).
  const balancesAntes = _leerBalancesEnModalDeposito();
  const balance = balancesAntes.pre || _leerSaldoJugadorEnModalAbierto() || opened.balance || { raw:'', value:0 };

  // Para retiros: verifica saldo suficiente (sólo si hay un balance válido conocido)
  if (actionName === 'retiro' && balance && balance.value > 0) {
    if (balance.value < numericAmount) {
      await cerrarModalActual();
      return {
        ok: false,
        saldoInsuficiente: true,
        balance,
        message: `Saldo insuficiente: ${balance.raw.trim()} disponible, se solicitaron $${numericAmount.toLocaleString('es-AR')}.`
      };
    }
  }

  // Re-busca el input de monto (por si React reescribió el DOM al abrir el modal)
  const amountInput = firstVisible(SELECTORS.amountInput) || opened.amountInput;
  if (!amountInput) throw new Error('No se encontró el campo de monto.');
  setReactInputValue(amountInput, String(amount));
  await delay(400);

  // Busca el botón Aplicar — id específico primero, luego texto, luego clase
  const applyButton =
    firstVisible('button#btn_deposit') ||
    findActionButton(/^\s*aplicar\s*$/i) ||
    firstVisible('button.btn.btn-primary');
  if (!applyButton) throw new Error('No se encontró el botón "Aplicar".');
  if (applyButton.disabled) throw new Error('El botón "Aplicar" está deshabilitado (¿monto inválido?).');
  clickElement(applyButton);

  // El segundo input del modal (DOM order #1) muestra el saldo POSTERIOR.
  // Antes de Aplicar es un preview (pre + monto). Después de Aplicar el casino
  // lo actualiza al saldo real. Esperamos un poco y leemos.
  await delay(1500);
  const balancesDespues = _leerBalancesEnModalDeposito();
  let newBalance;
  if (balancesDespues.post && balancesDespues.post.raw) {
    newBalance = balancesDespues.post;
  } else if (balancesDespues.pre && balancesDespues.pre.raw && Math.abs(balancesDespues.pre.value - balance.value) > 0.01) {
    // Fallback: si el modal cerró y solo queda un input que cambió → ese es el post
    newBalance = balancesDespues.pre;
  } else {
    newBalance = { raw: balance.raw, value: balance.value, unchanged: true };
  }

  return {
    ok: true,
    action: actionName,
    amount: numericAmount,
    previousBalance: balance,
    newBalance,
    message: `${actionName} enviado. Saldo anterior: ${balance.raw?.trim() || '—'}${newBalance?.raw ? ' → ' + newBalance.raw.trim() : ''}.`
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

// Crear usuario en el backoffice (URL: /agents/new_user)
async function crearUsuario(alias, password, options = {}) {
  if (!alias || String(alias).trim().length < 3) {
    throw new Error('El alias debe tener al menos 3 caracteres.');
  }
  if (!password || String(password).length < 6) {
    throw new Error('La contraseña debe tener al menos 6 caracteres.');
  }
  if (!/^[a-zA-Z0-9]+$/.test(String(password))) {
    throw new Error('La contraseña sólo puede tener letras y números.');
  }

  await cerrarModalSesionInvalida();
  if (pageNeedsLogin()) return status();

  await delay(800);

  const aliasInput = await waitFor(() => firstVisible('input[name="alias"]'), options.timeout || DEFAULT_TIMEOUT);
  aliasInput.click(); await delay(150);
  const aliasOk = await setReactInputAndVerify(aliasInput, String(alias).trim(), 5);
  if (!aliasOk) throw new Error('No se pudo completar el campo alias (React no tomó el valor después de 5 intentos).');

  const passInput = await waitFor(() => firstVisible('input[name="password"][type="password"]'), options.timeout || DEFAULT_TIMEOUT);
  passInput.click(); await delay(150);
  const passOk = await setReactInputAndVerify(passInput, String(password), 5);
  if (!passOk) throw new Error('No se pudo completar el campo clave (React no tomó el valor después de 5 intentos).');

  const registrarBtn = findActionButton(/registrar/i);
  if (!registrarBtn) throw new Error('No se encontró el botón "Registrar".');
  await delay(200);
  clickElement(registrarBtn);

  // Tras clickear "Registrar" hay DOS caminos posibles:
  //   a) Aparece el error "ErrorDuplicated alias" → el alias ya existe
  //   b) Aparece un modal de CONFIRMACIÓN con los datos + botón "Guardar"
  // El texto "registrado correctamente" recién aparece DESPUÉS de Guardar, así que
  // NO podemos esperarlo acá. Esperamos: error duplicado O el botón Guardar.
  const TIMEOUT = options.timeout || DEFAULT_TIMEOUT;
  const buscarGuardar = function(){
    const btns = Array.from(document.querySelectorAll('button.btn.btn-primary, button')).filter(isVisible);
    return btns.find(b => /^guardar$/i.test((b.textContent || '').trim())) || null;
  };
  const esDuplicado = function(){
    return /ErrorDuplicated|duplicated alias|already exists|alias ya existe/i.test(document.body.textContent || '');
  };

  await waitFor(() => esDuplicado() || buscarGuardar(), TIMEOUT);

  // Dar un instante para que el modal (error o confirmación) termine de renderizar
  await delay(300);

  if (esDuplicado())
    return { ok: false, alias, error: 'duplicado', message: 'El alias ya existe.' };

  // Camino b): modal de confirmación → clickear "Guardar"
  const guardarBtn = buscarGuardar() || findActionButton(/^guardar$/i);
  if (guardarBtn) {
    clickElement(guardarBtn);
    await delay(900); // esperar la pantalla final de confirmación
  } else {
    console.warn('[crearUsuario] botón Guardar no encontrado tras Registrar');
  }

  return { ok: true, alias, password, message: 'Usuario creado correctamente.' };
}

// Devuelve el saldo del AGENTE (operador) sin tocar nada del usuario
async function obtenerSaldoAgente(options = {}) {
  await cerrarModalSesionInvalida();
  if (pageNeedsLogin()) return { ok: false, needsLogin: true };
  await waitFor(() => readAgentBalance().raw, options.timeout || 6000).catch(()=>{});
  return { ok: true, balance: readAgentBalance() };
}

// Inicia sesión en el backoffice de agentes inyectando usuario y clave.
// Si ya hay sesión activa devuelve {ok:true} inmediatamente.
// Si aparece el modal de "session is invalid" → clickea Accept, espera el redirect
// al login, y sigue con la inyección de credenciales en la misma pasada.
async function iniciarSesion(usuario, clave) {
  // Modal de sesión inválida → cerrarlo (clickeando Accept) y esperar el form de login
  if (detectarModalSesionInvalida()) {
    await cerrarModalSesionInvalida();
    // Después del cierre puede tardar un instante en renderizar el form
    const t0 = now();
    while (now() - t0 < 5000) {
      await delay(200);
      if (document.querySelector('input[type="password"]')) break;
    }
  }

  // Ya logueado → nada que hacer
  if (!pageNeedsLogin()) {
    return { ok: true, message: 'Sesión ya activa.' };
  }

  // Buscar el formulario de login (con reintentos por si la página está montando)
  let userInput = null, passInput = null, entrarBtn = null;
  const tBusca = now();
  while (now() - tBusca < 6000) {
    userInput = document.querySelector('input[type="text"], input[name="username"], input[name="user"], input[autocomplete="username"]');
    passInput = document.querySelector('input[type="password"]');
    entrarBtn = Array.from(document.querySelectorAll('button')).find(btn =>
      /entrar|ingresar|login|iniciar|sign.?in/i.test(btn.textContent || '')
    );
    if (userInput && passInput && entrarBtn) break;
    await delay(250);
  }

  if (!userInput || !passInput || !entrarBtn) {
    return { ok: false, message: 'No se encontró el formulario de login en el backoffice.' };
  }

  // Inyectar credenciales con disparo de eventos React
  setReactInputValue(userInput, usuario);
  await delay(200);
  setReactInputValue(passInput, clave);
  await delay(300);
  clickElement(entrarBtn);

  // Esperar hasta 15s a que desaparezca la pantalla de login
  const inicio = now();
  while (now() - inicio < 15000) {
    await delay(500);
    if (!pageNeedsLogin()) return { ok: true, message: 'Sesión iniciada.' };
  }

  return { ok: false, message: 'No se pudo iniciar sesión. Verificá usuario y contraseña.' };
}

const api = {
  buscarUsuario,
  cargarSaldo,
  retirarSaldo,
  cambiarClave,
  crearUsuario,
  obtenerSaldoAgente,
  irABusquedaUsuarios,
  iniciarSesion,
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
// Canal separado para verificación de login (verifyWindow)
ipcRenderer.on('drex:verify:run', async (event, request = {}) => {
  const { requestId, method, args = [] } = request;
  try {
    if (!Object.prototype.hasOwnProperty.call(api, method)) {
      throw new Error('Método no permitido: ' + method);
    }
    const result = await api[method](...args);
    ipcRenderer.send('drex:verify:result', { requestId, ok: true, result });
  } catch (error) {
    ipcRenderer.send('drex:verify:result', { requestId, ok: false, error: error.message || String(error) });
  }
});