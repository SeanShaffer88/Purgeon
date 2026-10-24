const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, arg) => ipcRenderer.invoke(channel, arg),
  onMenu: (fn) => {
    const listener = (_e, action) => fn(action);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
