# Sistema de Cargas Automáticas — Prompt de Migración

## Qué hace este sistema

Automatiza acciones sobre el backoffice de agentes en `https://bo.casinodrex.com/agents/user_search` desde una app Electron. Desde tu propia UI podés:

1. **Buscar un usuario** por alias/nombre
2. **Cargarle saldo** (equivale a clickear el botón ➕ de la fila del usuario)
3. **Retirarle saldo** (botón ➖)
4. **Cambiarle la clave** (botón 🔑 / ícono `key`)

Todo ocurre en una ventana Electron separada que carga el backoffice real. Tu app nunca toca la red directamente — el preload inyectado en esa ventana hace la automatización DOM.

---

## Arquitectura en 3 capas

```
Tu UI (renderer de tu app)
    │  llama a window.ctrlElectron.drexAutomation(method, ...args)
    ▼
Main process (ipcMain)
    │  reenvía via win.webContents.send('drex:automation:run', ...)
    ▼
agent-preload.js (inyectado en la ventana del backoffice)
    │  manipula el DOM de bo.casinodrex.com
    └─ responde via ipcRenderer.send('drex:automation:result', ...)
```

---

## Archivos del sistema

### 1. `electron/agent-preload.js`
Se inyecta en la ventana del backoffice (`BrowserWindow` que carga la URL del casino). Contiene toda la lógica DOM.

### 2. `electron/app-preload.js`
Se inyecta en **tu ventana principal**. Expone `window.ctrlElectron.drexAutomation(method, args)` como puente seguro.

### 3. `electron/main-example.js`
Ejemplo completo del main process con los handlers IPC necesarios.

### 4. `electron/renderer-cargas-automaticas.js`
Ejemplo de cómo llamar al sistema desde el renderer de tu app. Incluye un panel HTML de prueba.

---

## Página objetivo

**URL:** `https://bo.casinodrex.com/agents/user_search`

### Elementos del DOM que el script manipula

#### Input de búsqueda
El script usa múltiples estrategias para encontrar el campo de búsqueda (la página puede variar):

| Prioridad | Selector | Descripción |
|-----------|----------|-------------|
| 1 | `input.validationField[type="text"]` | Campo con clase `validationField` (el más específico) |
| 2 | Input dentro de `.MuiInputBase-root` con `legend span` que diga "Introduzca un término" | Material UI |
| 3 | `input[id*="search"]`, `input[name*="search"]` | Genérico por nombre/id |
| 4 | `input[placeholder*="Buscar"]`, `input[placeholder*="Usuario"]` | Por placeholder |
| 5 | `input[type="search"]` | Tipo search |
| fallback | Primer `input[type="text"]` visible con `minLength >= 3` | Último recurso |

**Exclusiones:** Siempre se excluyen `input[name="amount"]` e `input[id="password"]`

#### Botón de búsqueda
```
#searchButton
```

#### Resultado: fila del jugador
```css
[data-agenttree-user-type="player"]
.agents-alias-text
```
El script verifica que el texto del elemento contenga (o sea contenido por) el usuario buscado.

#### Indicador de sin resultados
```css
.crmpam_no_data_found
```

#### Botones de acción en la fila del usuario
Los botones se localizan por el **ícono SVG** que contienen (`data-icon`):

| Acción | Ícono buscado | Selector SVG |
|--------|--------------|--------------|
| Cargar saldo | `circle-plus` | `svg[data-icon="circle-plus"]` |
| Retirar saldo | `circle-minus` | `svg[data-icon="circle-minus"]` |
| Cambiar clave | `key` | `svg[data-icon="key"]` |

El script hace: `icon.closest('button, [role="button"], a') || icon.parentElement` para llegar al elemento clickeable.

#### Modal de monto (cargar/retirar)
Aparece después de clickear el botón de acción:
```css
input[name="amount"]:not([disabled]):not([readonly])
```
Luego busca el botón de confirmación por texto:
- `findActionButton(/aplicar/i)` — botón que contenga "aplicar"
- fallback: `button#btn_deposit, button.btn.btn-primary`

#### Modal de cambio de clave
```css
/* Primer campo de contraseña */
input#password[name="password"]
input[name="password"][type="password"]

/* Campo de confirmación */
input[name="pasword2"][type="password"]   /* typo intencional en el backoffice */
input[name="password2"][type="password"]
```
Botón de confirmar: `findActionButton(/cambiar/i)`

#### Balance visible (lectura)
```css
input:disabled
input[readonly]
input[aria-disabled="true"]
```
Filtra el que contiene `ARS`, `$` o dígitos en su value.

---

## Métodos de la API

Todos retornan una Promise. Si `needsLogin: true` en el resultado, el usuario debe loguearse manualmente en la ventana del backoffice.

### `estadoPagina()`
Devuelve el estado actual de la ventana del backoffice.
```js
// Retorna:
{ ok: boolean, needsLogin: boolean, url: string, message: string }
```

### `irABusquedaUsuarios()`
Navega a la URL de búsqueda si no está ya ahí.
```js
{ ok: true, url: 'https://bo.casinodrex.com/agents/user_search' }
```

### `buscarUsuario(usuario, options?)`
Busca un usuario por alias. `usuario` debe tener ≥ 3 caracteres.
```js
// Éxito con resultado:
{ ok: true, exists: true, user: 'aaal67', balance: { raw: 'ARS 1.000', value: 1000 } }

// Sin resultados:
{ ok: true, exists: false, user: 'aaal67', message: 'No se encontraron resultados' }

// Requiere login:
{ ok: false, needsLogin: true, message: '...' }
```

### `cargarSaldo(amount, options?)`
Clickea el ícono `circle-plus`, completa el monto y confirma.
```js
// amount: número o string, ej: 1000 o "1000"
{ ok: true, action: 'carga', amount: 1000, previousBalance: {...}, message: '...' }
```

### `retirarSaldo(amount, options?)`
Clickea el ícono `circle-minus`, completa el monto y confirma.
```js
{ ok: true, action: 'retiro', amount: 500, previousBalance: {...}, message: '...' }
```

### `cambiarClave(password, options?)`
Clickea el ícono `key`, llena ambos campos de clave y confirma. `password` debe tener ≥ 4 caracteres.
```js
{ ok: true, action: 'cambio_clave', message: '...' }
```

---

## Código para el Main Process

```js
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const AGENT_USER_SEARCH_URL = 'https://bo.casinodrex.com/agents/user_search';
let agentWindow;
const pendingAutomation = new Map();

function createAgentWindow(url = AGENT_USER_SEARCH_URL) {
  agentWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Agentes - Cargas automatizadas',
    webPreferences: {
      preload: path.join(__dirname, 'electron/agent-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true        // IMPORTANTE: sandbox activo para seguridad
    }
  });
  agentWindow.loadURL(url);
  agentWindow.on('closed', () => {
    agentWindow = null;
    pendingAutomation.clear();
  });
  return agentWindow;
}

function getAgentWindow(url = AGENT_USER_SEARCH_URL) {
  if (agentWindow && !agentWindow.isDestroyed()) return agentWindow;
  return createAgentWindow(url);
}

function whenAgentReady(win) {
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise(resolve => win.webContents.once('did-finish-load', resolve));
}

function sendAutomation(method, ...args) {
  const win = getAgentWindow();
  return whenAgentReady(win).then(() => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      pendingAutomation.set(requestId, { resolve, reject });
      win.webContents.send('drex:automation:run', { requestId, method, args });
    });
  });
}

// Handlers IPC requeridos:
ipcMain.handle('drex:open-agent-window', (_event, url) => {
  const win = getAgentWindow(url);
  if (url && win.webContents.getURL() !== url) win.loadURL(url);
  win.show();
  win.focus();
  return { ok: true };
});

ipcMain.handle('drex:automation', async (_event, { method, args = [] } = {}) => {
  return sendAutomation(method, ...args);
});

ipcMain.on('drex:automation:result', (_event, response = {}) => {
  const pending = pendingAutomation.get(response.requestId);
  if (!pending) return;
  pendingAutomation.delete(response.requestId);
  if (response.ok) pending.resolve(response.result);
  else pending.reject(new Error(response.error || 'Error ejecutando automatización.'));
});
```

---

## Código para el Preload de tu ventana principal (app-preload.js)

```js
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_METHODS = new Set([
  'estadoPagina', 'irABusquedaUsuarios',
  'buscarUsuario', 'cargarSaldo', 'retirarSaldo', 'cambiarClave'
]);

contextBridge.exposeInMainWorld('ctrlElectron', {
  openAgentWindow: (url) => ipcRenderer.invoke('drex:open-agent-window', url),
  drexAutomation: (method, ...args) => {
    if (!ALLOWED_METHODS.has(method))
      return Promise.reject(new Error(`Método no permitido: ${method}`));
    return ipcRenderer.invoke('drex:automation', { method, args });
  }
});
```

---

## Uso desde tu UI (renderer)

```js
// Helper
async function callDrex(method, ...args) {
  return window.ctrlElectron.drexAutomation(method, ...args);
}

// Flujo completo: buscar + cargar
async function cargarSaldoAUsuario(usuario, monto) {
  // 1. Abrir/enfocar la ventana del backoffice
  await window.ctrlElectron.openAgentWindow();

  // 2. Verificar que esté lista (no requiera login)
  const estado = await callDrex('estadoPagina');
  if (estado.needsLogin) {
    alert('Iniciá sesión en la ventana del backoffice y volvé a intentar.');
    return;
  }

  // 3. Buscar usuario
  const busqueda = await callDrex('buscarUsuario', usuario);
  if (!busqueda.exists) {
    alert('Usuario no encontrado: ' + usuario);
    return;
  }

  // 4. Cargar saldo
  const resultado = await callDrex('cargarSaldo', monto);
  console.log(resultado.message);
  return resultado;
}

// Flujo: buscar + retirar
async function retirarSaldoDeUsuario(usuario, monto) {
  await window.ctrlElectron.openAgentWindow();
  const busqueda = await callDrex('buscarUsuario', usuario);
  if (!busqueda.exists) return;
  return callDrex('retirarSaldo', monto);
}

// Flujo: buscar + cambiar clave
async function cambiarClaveDeUsuario(usuario, nuevaClave) {
  await window.ctrlElectron.openAgentWindow();
  const busqueda = await callDrex('buscarUsuario', usuario);
  if (!busqueda.exists) return;
  return callDrex('cambiarClave', nuevaClave);
}
```

---

## HTML mínimo para el panel en tu UI

```html
<section id="cargasAutomaticasPanel">
  <label>Usuario</label>
  <input id="autoUsuario" type="text" minlength="3" placeholder="Ej: aaal67">

  <label>Monto</label>
  <input id="autoMonto" type="number" min="1" step="0.01" placeholder="Ej: 1000">

  <label>Nueva clave (solo para cambio de clave)</label>
  <input id="autoClave" type="password" placeholder="Min. 4 caracteres">

  <button onclick="cargarSaldoAUsuario(
    document.getElementById('autoUsuario').value,
    document.getElementById('autoMonto').value
  )">Cargar saldo</button>

  <button onclick="retirarSaldoDeUsuario(
    document.getElementById('autoUsuario').value,
    document.getElementById('autoMonto').value
  )">Retirar saldo</button>

  <button onclick="cambiarClaveDeUsuario(
    document.getElementById('autoUsuario').value,
    document.getElementById('autoClave').value
  )">Cambiar clave</button>
</section>
```

---

## Notas importantes para la migración

1. **`agent-preload.js` va en el BrowserWindow que abre el backoffice**, no en tu ventana principal. El `sandbox: true` es intencional para seguridad.

2. **Siempre llamar `openAgentWindow()` primero** — si la ventana no existe la crea, si ya existe la enfoca/navega.

3. **Verificar `estadoPagina()` antes de automatizar** — si el backoffice requiere login, el sistema no puede operar y devuelve `needsLogin: true`.

4. **El sistema detecta React** — `setReactInputValue` dispara eventos `input`/`change`/`blur` para que el framework los procese. No uses `input.value = x` directamente.

5. **Timeouts** — por defecto 12 segundos. Podés pasarle `{ timeout: 20000 }` como último argumento a cualquier método si la red es lenta.

6. **El typo en `pasword2`** (`input[name="pasword2"]`) es intencional — está en el backoffice del casino, no es error nuestro. El selector lo maneja con fallback.
