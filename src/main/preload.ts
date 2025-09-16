import { contextBridge, ipcRenderer } from 'electron'

export interface DubSwitchAPI {
  // Settings
  getSettings: () => Promise<any>
  saveSettings: (settings: any) => Promise<boolean>
  
  // X32 Connection
  connectX32: (host: string, port: number) => Promise<{ success: boolean; error?: string }>
  disconnectX32: () => Promise<boolean>
  
  // Channel Control
  setChannelSource: (channel: number, source: 'local' | 'card') => Promise<{ success: boolean; error?: string }>
  getChannelSource: (channel: number) => Promise<{ success: boolean; source?: 'local' | 'card'; error?: string }>
  
  // Presets
  applyRecordPreset: () => Promise<{ success: boolean; error?: string }>
  applyPlaybackPreset: () => Promise<{ success: boolean; error?: string }>
}

const api: DubSwitchAPI = {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  connectX32: (host, port) => ipcRenderer.invoke('connect-x32', host, port),
  disconnectX32: () => ipcRenderer.invoke('disconnect-x32'),
  setChannelSource: (channel, source) => ipcRenderer.invoke('set-channel-source', channel, source),
  getChannelSource: (channel) => ipcRenderer.invoke('get-channel-source', channel),
  applyRecordPreset: () => ipcRenderer.invoke('apply-record-preset'),
  applyPlaybackPreset: () => ipcRenderer.invoke('apply-playback-preset'),
}

contextBridge.exposeInMainWorld('dubSwitch', api)

declare global {
  interface Window {
    dubSwitch: DubSwitchAPI
  }
}