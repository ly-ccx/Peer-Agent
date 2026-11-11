const { contextBridge, ipcRenderer } = require('electron');
let sequence = 0;
contextBridge.exposeInMainWorld('ri00', {
  async query(payload) {
    const clientSequence = ++sequence;
    const start = performance.timeOrigin + performance.now();
    const value = await ipcRenderer.invoke('project-agent:list-obligation-grants', payload);
    return { clientSequence, start, end: performance.timeOrigin + performance.now(),
      ok: value?.ok === true, grants: value?.grants?.length,
      responseBytes: new TextEncoder().encode(JSON.stringify(value)).length };
  },
});
