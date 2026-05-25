const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_AUTOMATION_METHODS = new Set([
  'estadoPagina',
  'irABusquedaUsuarios',
  'buscarUsuario',
  'cargarSaldo',
  'retirarSaldo',
  'cambiarClave',
  'crearUsuario',
  'obtenerSaldoAgente'
]);

contextBridge.exposeInMainWorld('ctrlElectron', {
  openAgentWindow: () => ipcRenderer.invoke('drex:open-agent-window'),
  showAgentWindow: () => ipcRenderer.invoke('drex:show-agent-window'),
  navigateAgent:   (url) => ipcRenderer.invoke('drex:navigate', url),
  drexAutomation: (method, ...args) => {
    if (!ALLOWED_AUTOMATION_METHODS.has(method)) {
      return Promise.reject(new Error(`Método no permitido: ${method}`));
    }
    return ipcRenderer.invoke('drex:automation', { method, args });
  },
  verifyUser: (usuario) => ipcRenderer.invoke('drex:verify-user', { usuario })
});

// Acceso a la ventana separada de Chunior (visible, backoffice secundario)
contextBridge.exposeInMainWorld('chunior', {
  exec:     (script) => ipcRenderer.invoke('chunior:exec', script),
  getUrl:   ()       => ipcRenderer.invoke('chunior:get-url'),
  navigate: (url)    => ipcRenderer.invoke('chunior:navigate', url),
  reload:   ()       => ipcRenderer.invoke('chunior:reload'),
  focus:    ()       => ipcRenderer.invoke('chunior:focus'),
});
