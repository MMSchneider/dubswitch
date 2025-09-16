import React, { useState, useEffect, useCallback } from 'react'
import { AppState, ChannelState, PresetType } from '../shared/types'
import ChannelGrid from './components/ChannelGrid'
import ConnectionPanel from './components/ConnectionPanel'
import PresetPanel from './components/PresetPanel'
import StatusBar from './components/StatusBar'
import './App.css'

const INITIAL_CHANNELS: ChannelState[] = Array.from({ length: 32 }, (_, i) => ({
  channel: i + 1,
  source: 'local' as const,
  isOnline: false
}))

function App() {
  const [appState, setAppState] = useState<AppState>({
    channels: INITIAL_CHANNELS,
    isConnected: false,
    connectionStatus: 'Disconnected',
    currentPreset: null,
    settings: {
      x32: { host: '192.168.1.100', port: 10023 },
      lastPreset: null
    },
    undoState: null,
    error: null
  })

  const [isLoading, setIsLoading] = useState(false)

  // Load settings on startup
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await window.dubSwitch.getSettings()
        setAppState(prev => ({ ...prev, settings }))
      } catch (error) {
        console.error('Failed to load settings:', error)
        setError('Failed to load settings')
      }
    }
    loadSettings()
  }, [])

  const setError = useCallback((error: string | null) => {
    setAppState(prev => ({ ...prev, error }))
  }, [])

  const saveSettings = useCallback(async (newSettings: Partial<typeof appState.settings>) => {
    try {
      const updatedSettings = { ...appState.settings, ...newSettings }
      await window.dubSwitch.saveSettings(updatedSettings)
      setAppState(prev => ({ ...prev, settings: updatedSettings }))
    } catch (error) {
      console.error('Failed to save settings:', error)
      setError('Failed to save settings')
    }
  }, [appState.settings])

  const connectToX32 = useCallback(async (host: string, port: number) => {
    setIsLoading(true)
    setError(null)
    
    try {
      const result = await window.dubSwitch.connectX32(host, port)
      if (result.success) {
        setAppState(prev => ({
          ...prev,
          isConnected: true,
          connectionStatus: `Connected to ${host}:${port}`
        }))
        
        // Save connection settings
        await saveSettings({ x32: { host, port } })
        
        // Load current channel states
        await refreshChannelStates()
      } else {
        setError(result.error || 'Connection failed')
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Connection failed')
    } finally {
      setIsLoading(false)
    }
  }, [saveSettings])

  const disconnect = useCallback(async () => {
    try {
      await window.dubSwitch.disconnectX32()
      setAppState(prev => ({
        ...prev,
        isConnected: false,
        connectionStatus: 'Disconnected',
        channels: INITIAL_CHANNELS
      }))
    } catch (error) {
      setError('Failed to disconnect')
    }
  }, [])

  const refreshChannelStates = useCallback(async () => {
    if (!appState.isConnected) return

    try {
      const channelPromises = Array.from({ length: 32 }, async (_, i) => {
        const channel = i + 1
        const result = await window.dubSwitch.getChannelSource(channel)
        return {
          channel,
          source: result.success ? result.source! : 'local' as const,
          isOnline: result.success
        }
      })

      const channels = await Promise.all(channelPromises)
      setAppState(prev => ({ ...prev, channels }))
    } catch (error) {
      setError('Failed to refresh channel states')
    }
  }, [appState.isConnected])

  const setChannelSource = useCallback(async (channel: number, source: 'local' | 'card') => {
    if (!appState.isConnected) {
      setError('Not connected to X32')
      return
    }

    try {
      const result = await window.dubSwitch.setChannelSource(channel, source)
      if (result.success) {
        setAppState(prev => ({
          ...prev,
          channels: prev.channels.map(ch =>
            ch.channel === channel ? { ...ch, source } : ch
          )
        }))
      } else {
        setError(result.error || 'Failed to set channel source')
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to set channel source')
    }
  }, [appState.isConnected])

  const applyPreset = useCallback(async (preset: PresetType) => {
    if (!appState.isConnected) {
      setError('Not connected to X32')
      return
    }

    setIsLoading(true)
    setError(null)

    // Save current state for undo
    setAppState(prev => ({ ...prev, undoState: [...prev.channels] }))

    try {
      const result = preset === 'record' 
        ? await window.dubSwitch.applyRecordPreset()
        : await window.dubSwitch.applyPlaybackPreset()

      if (result.success) {
        setAppState(prev => ({ ...prev, currentPreset: preset }))
        await saveSettings({ lastPreset: preset })
        await refreshChannelStates()
      } else {
        setError(result.error || 'Failed to apply preset')
        // Restore state on error
        setAppState(prev => ({ ...prev, undoState: null }))
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to apply preset')
      setAppState(prev => ({ ...prev, undoState: null }))
    } finally {
      setIsLoading(false)
    }
  }, [appState.isConnected, saveSettings, refreshChannelStates])

  const undoChanges = useCallback(async () => {
    if (!appState.undoState || !appState.isConnected) return

    setIsLoading(true)
    try {
      const promises = appState.undoState.map(channel =>
        window.dubSwitch.setChannelSource(channel.channel, channel.source)
      )
      
      await Promise.all(promises)
      
      setAppState(prev => ({
        ...prev,
        channels: prev.undoState!,
        undoState: null,
        currentPreset: null
      }))
    } catch (error) {
      setError('Failed to undo changes')
    } finally {
      setIsLoading(false)
    }
  }, [appState.undoState, appState.isConnected])

  return (
    <div className="app">
      <header className="app-header">
        <h1>DubSwitch</h1>
        <p>Behringer X32 Card ↔ Local Channel Switching</p>
      </header>

      <main className="app-main">
        <div className="control-panel">
          <ConnectionPanel
            isConnected={appState.isConnected}
            settings={appState.settings.x32}
            onConnect={connectToX32}
            onDisconnect={disconnect}
            isLoading={isLoading}
          />
          
          <PresetPanel
            currentPreset={appState.currentPreset}
            onApplyPreset={applyPreset}
            onUndo={undoChanges}
            canUndo={appState.undoState !== null}
            isConnected={appState.isConnected}
            isLoading={isLoading}
          />
        </div>

        <ChannelGrid
          channels={appState.channels}
          onChannelToggle={setChannelSource}
          isConnected={appState.isConnected}
          disabled={isLoading}
        />
      </main>

      <StatusBar
        connectionStatus={appState.connectionStatus}
        error={appState.error}
        onClearError={() => setError(null)}
      />
    </div>
  )
}

export default App