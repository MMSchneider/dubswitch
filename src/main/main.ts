import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { X32Client } from './x32-client'
import { SettingsManager } from './settings-manager'

class DubSwitchApp {
  private mainWindow: BrowserWindow | null = null
  private x32Client: X32Client | null = null
  private settingsManager: SettingsManager

  constructor() {
    this.settingsManager = new SettingsManager()
  }

  async createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    })

    const isDev = process.env.NODE_ENV === 'development'

    if (isDev) {
      this.mainWindow.loadURL('http://localhost:3000')
      this.mainWindow.webContents.openDevTools()
    } else {
      this.mainWindow.loadFile(path.join(__dirname, '../dist-react/index.html'))
    }

    this.mainWindow.on('closed', () => {
      this.mainWindow = null
    })
  }

  setupIPC() {
    // Settings IPC
    ipcMain.handle('get-settings', async () => {
      return this.settingsManager.getSettings()
    })

    ipcMain.handle('save-settings', async (_, settings) => {
      this.settingsManager.saveSettings(settings)
      return true
    })

    // X32 Connection IPC
    ipcMain.handle('connect-x32', async (_, host: string, port: number) => {
      try {
        this.x32Client = new X32Client(host, port)
        await this.x32Client.connect()
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    })

    ipcMain.handle('disconnect-x32', async () => {
      if (this.x32Client) {
        this.x32Client.disconnect()
        this.x32Client = null
      }
      return true
    })

    // Channel control IPC
    ipcMain.handle('set-channel-source', async (_, channel: number, source: 'local' | 'card') => {
      if (!this.x32Client) {
        return { success: false, error: 'Not connected to X32' }
      }
      try {
        await this.x32Client.setChannelSource(channel, source)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    })

    ipcMain.handle('get-channel-source', async (_, channel: number) => {
      if (!this.x32Client) {
        return { success: false, error: 'Not connected to X32' }
      }
      try {
        const source = await this.x32Client.getChannelSource(channel)
        return { success: true, source }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    })

    // Preset IPC
    ipcMain.handle('apply-record-preset', async () => {
      if (!this.x32Client) {
        return { success: false, error: 'Not connected to X32' }
      }
      try {
        await this.x32Client.applyRecordPreset()
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    })

    ipcMain.handle('apply-playback-preset', async () => {
      if (!this.x32Client) {
        return { success: false, error: 'Not connected to X32' }
      }
      try {
        await this.x32Client.applyPlaybackPreset()
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    })
  }

  init() {
    app.whenReady().then(() => {
      this.createWindow()
      this.setupIPC()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          this.createWindow()
        }
      })
    })

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit()
      }
    })

    app.on('will-quit', () => {
      if (this.x32Client) {
        this.x32Client.disconnect()
      }
    })
  }
}

const dubSwitchApp = new DubSwitchApp()
dubSwitchApp.init()