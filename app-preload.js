const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_AUTOMATION_METHODS = new Set([
  'estadoPagina',
  'irABusquedaUsuarios',
  'buscarUsuario',
  'cargarSaldo',
  'retirarSaldo',
  'cambiarClave',
  'crearUsuario',
  'obtenerSaldoAgente',
  'iniciarSesion',
  'finalizarOperacionAgentes'
]);

function createAutomationBridge(ipcRenderer) {
  const invoke = (method, ...args) => {
    if (!ALLOWED_AUTOMATION_METHODS.has(method)) {
      return Promise.reject(new Error(`Método no permitido: ${method}`));
    }
    return ipcRenderer.invoke('drex:automation', { method, args });
  };

  return {
    openAgentWindow: (url) => ipcRenderer.invoke('drex:open-agent-window', url),
    showAgentWindow: (url) => ipcRenderer.invoke('drex:show-agent-window', url),
    navigateAgent: (url) => ipcRenderer.invoke('drex:navigate', url),
    clearAgentData: () => ipcRenderer.invoke('drex:clear-data'),
    setProxy: (cfg) => ipcRenderer.invoke('proxy:set', cfg),
    clearProxy: () => ipcRenderer.invoke('proxy:clear'),
    boAutomation: (method, ...args) => invoke(method, ...args),
    drexAutomation: (method, ...args) => invoke(method, ...args),
    automation: (method, ...args) => invoke(method, ...args),
    verifyUser: (usuario) => ipcRenderer.invoke('drex:verify-user', { usuario })
  };
}

const bridge = createAutomationBridge(ipcRenderer);

contextBridge.exposeInMainWorld('ctrlElectron', {
  openAgentWindow: bridge.openAgentWindow,
  showAgentWindow: bridge.showAgentWindow,
  navigateAgent: bridge.navigateAgent,
  clearAgentData: bridge.clearAgentData,
  setProxy: bridge.setProxy,
  clearProxy: bridge.clearProxy,
  boAutomation: bridge.boAutomation,
  drexAutomation: bridge.drexAutomation,
  automation: bridge.automation,
  verifyUser: bridge.verifyUser
});

// Acceso a la ventana separada de Reg (visible, backoffice secundario)
const regApi = {
  exec:     (script) => ipcRenderer.invoke('chunior:exec', script),
  getUrl:   ()       => ipcRenderer.invoke('chunior:get-url'),
  navigate: (url)    => ipcRenderer.invoke('chunior:navigate', url),
  reload:   ()       => ipcRenderer.invoke('chunior:reload'),
  focus:    ()       => ipcRenderer.invoke('chunior:focus'),
};

contextBridge.exposeInMainWorld('reg', regApi);
contextBridge.exposeInMainWorld('chunior', regApi);
