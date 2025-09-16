import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export interface AppSettings {
  x32: {
    host: string
    port: number
  }
  lastPreset: 'record' | 'playback' | null
  windowBounds?: {
    width: number
    height: number
    x: number
    y: number
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  x32: {
    host: '192.168.1.100',
    port: 10023
  },
  lastPreset: null
}

export class SettingsManager {
  private settingsPath: string

  constructor() {
    const userDataPath = app.getPath('userData')
    this.settingsPath = path.join(userDataPath, 'settings.json')
  }

  getSettings(): AppSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf8')
        const settings = JSON.parse(data)
        return { ...DEFAULT_SETTINGS, ...settings }
      }
    } catch (error) {
      console.error('Error reading settings:', error)
    }
    
    return DEFAULT_SETTINGS
  }

  saveSettings(settings: Partial<AppSettings>): void {
    try {
      const currentSettings = this.getSettings()
      const updatedSettings = { ...currentSettings, ...settings }
      
      // Ensure the directory exists
      const dir = path.dirname(this.settingsPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      fs.writeFileSync(this.settingsPath, JSON.stringify(updatedSettings, null, 2))
      console.log('Settings saved:', updatedSettings)
    } catch (error) {
      console.error('Error saving settings:', error)
    }
  }

  getSettingsPath(): string {
    return this.settingsPath
  }
}