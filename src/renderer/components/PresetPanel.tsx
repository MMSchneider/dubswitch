import React from 'react'
import { PresetType } from '../../shared/types'

interface PresetPanelProps {
  currentPreset: PresetType | null
  onApplyPreset: (preset: PresetType) => void
  onUndo: () => void
  canUndo: boolean
  isConnected: boolean
  isLoading: boolean
}

const PresetPanel: React.FC<PresetPanelProps> = ({
  currentPreset,
  onApplyPreset,
  onUndo,
  canUndo,
  isConnected,
  isLoading
}) => {
  return (
    <div className="preset-panel panel">
      <h3>Presets</h3>
      
      <div className="preset-buttons">
        <button
          className={`preset-btn record-btn ${currentPreset === 'record' ? 'active' : ''}`}
          onClick={() => onApplyPreset('record')}
          disabled={!isConnected || isLoading}
          title="Record Mode: CH1-24 Local, CH25-32 Card"
        >
          <div className="preset-name">Record</div>
          <div className="preset-description">1-24 Local, 25-32 Card</div>
        </button>
        
        <button
          className={`preset-btn playback-btn ${currentPreset === 'playback' ? 'active' : ''}`}
          onClick={() => onApplyPreset('playback')}
          disabled={!isConnected || isLoading}
          title="Playback Mode: All channels Card"
        >
          <div className="preset-name">Playback</div>
          <div className="preset-description">1-32 Card</div>
        </button>
      </div>
      
      <div className="preset-actions">
        <button
          className="undo-btn"
          onClick={onUndo}
          disabled={!canUndo || !isConnected || isLoading}
          title="Undo last preset application"
        >
          Undo Changes
        </button>
      </div>
    </div>
  )
}

export default PresetPanel