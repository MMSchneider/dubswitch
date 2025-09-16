import React from 'react'
import { ChannelState } from '../../shared/types'

interface ChannelGridProps {
  channels: ChannelState[]
  onChannelToggle: (channel: number, source: 'local' | 'card') => void
  isConnected: boolean
  disabled?: boolean
}

const ChannelGrid: React.FC<ChannelGridProps> = ({ 
  channels, 
  onChannelToggle, 
  isConnected, 
  disabled = false 
}) => {
  return (
    <div className="channel-grid">
      <div className="grid-header">
        <h2>Channel Routing (CH1-32)</h2>
      </div>
      
      <div className="channels">
        {channels.map(channel => (
          <div 
            key={channel.channel} 
            className={`channel-item ${!isConnected ? 'disabled' : ''} ${!channel.isOnline ? 'offline' : ''}`}
          >
            <div className="channel-number">
              CH{channel.channel.toString().padStart(2, '0')}
            </div>
            
            <div className="toggle-container">
              <button
                className={`toggle-btn ${channel.source === 'local' ? 'active' : ''}`}
                onClick={() => onChannelToggle(channel.channel, 'local')}
                disabled={disabled || !isConnected}
                title="Route to Local Input (Preamp)"
              >
                Local
              </button>
              
              <div className="toggle-separator">↔</div>
              
              <button
                className={`toggle-btn ${channel.source === 'card' ? 'active' : ''}`}
                onClick={() => onChannelToggle(channel.channel, 'card')}
                disabled={disabled || !isConnected}
                title="Route to Card Input (USB)"
              >
                Card
              </button>
            </div>
            
            <div className={`status-indicator ${channel.isOnline ? 'online' : 'offline'}`}>
              {channel.isOnline ? '●' : '○'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default ChannelGrid