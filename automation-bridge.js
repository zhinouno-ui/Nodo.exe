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
    boAutomation: (method, ...args) => invoke(method, ...args),
    drexAutomation: (method, ...args) => invoke(method, ...args),
    automation: (method, ...args) => invoke(method, ...args),
    verifyUser: (usuario) => ipcRenderer.invoke('drex:verify-user', { usuario }),
    openAgentWindow: (url) => ipcRenderer.invoke('drex:open-agent-window', url),
    showAgentWindow: (url) => ipcRenderer.invoke('drex:show-agent-window', url),
    navigateAgent: (url) => ipcRenderer.invoke('drex:navigate', url),
    clearAgentData: () => ipcRenderer.invoke('drex:clear-data'),
    setProxy: (cfg) => ipcRenderer.invoke('proxy:set', cfg),
    clearProxy: () => ipcRenderer.invoke('proxy:clear')
  };
}

module.exports = { createAutomationBridge, ALLOWED_AUTOMATION_METHODS };
