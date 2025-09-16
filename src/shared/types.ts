export interface ChannelState {
  channel: number
  source: 'local' | 'card'
  isOnline?: boolean
}

export interface AppState {
  channels: ChannelState[]
  isConnected: boolean
  connectionStatus: string
  currentPreset: 'record' | 'playback' | null
  settings: {
    x32: {
      host: string
      port: number
    }
    lastPreset: 'record' | 'playback' | null
  }
  undoState: ChannelState[] | null
  error: string | null
}

export type PresetType = 'record' | 'playback'