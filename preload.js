const { contextBridge, ipcRenderer } = require('electron');

// Expose a tiny API to allow the renderer to request the host to restart.
// This is only used when running inside Electron; in browsers this API is
// unavailable and the UI will fall back to instructing the user to restart.
contextBridge.exposeInMainWorld('electronAPI', {
	restartApp: async () => {
 		try {
 			if (!ipcRenderer || !ipcRenderer.invoke) return { ok: false, error: 'ipc-unavailable' };
 			const res = await ipcRenderer.invoke('restart-app');
 			return res || { ok: false, error: 'no-response' };
 		} catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
 	},
  // Restart only the supervised server child process (does not relaunch the whole Electron app)
  restartServer: async () => {
    try {
      if (!ipcRenderer || !ipcRenderer.invoke) return { ok: false, error: 'ipc-unavailable' };
      const res = await ipcRenderer.invoke('restart-server');
      return res || { ok: false, error: 'no-response' };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }
 ,
  getServerLog: async () => {
    try {
      if (!ipcRenderer || !ipcRenderer.invoke) return { ok: false, error: 'ipc-unavailable' };
      const res = await ipcRenderer.invoke('get-server-log');
      return res || { ok: false, error: 'no-response' };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }
  ,
  getServerStatus: async () => {
    try {
      if (!ipcRenderer || !ipcRenderer.invoke) return { ok: false, error: 'ipc-unavailable' };
      const res = await ipcRenderer.invoke('get-server-status');
      return res || { ok: false, error: 'no-response' };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }
});
