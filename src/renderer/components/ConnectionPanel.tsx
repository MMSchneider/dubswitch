import React, { useState } from 'react'

interface ConnectionPanelProps {
  isConnected: boolean
  settings: { host: string; port: number }
  onConnect: (host: string, port: number) => void
  onDisconnect: () => void
  isLoading: boolean
}

const ConnectionPanel: React.FC<ConnectionPanelProps> = ({
  isConnected,
  settings,
  onConnect,
  onDisconnect,
  isLoading
}) => {
  const [host, setHost] = useState(settings.host)
  const [port, setPort] = useState(settings.port.toString())

  const handleConnect = () => {
    const portNum = parseInt(port, 10)
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      alert('Please enter a valid port number (1-65535)')
      return
    }
    onConnect(host, portNum)
  }

  return (
    <div className="connection-panel panel">
      <h3>X32 Connection</h3>
      
      <div className="connection-form">
        <div className="form-group">
          <label htmlFor="host">IP Address:</label>
          <input
            id="host"
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            disabled={isConnected || isLoading}
            placeholder="192.168.1.100"
          />
        </div>
        
        <div className="form-group">
          <label htmlFor="port">Port:</label>
          <input
            id="port"
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={isConnected || isLoading}
            placeholder="10023"
            min="1"
            max="65535"
          />
        </div>
        
        <div className="form-actions">
          {!isConnected ? (
            <button
              className="connect-btn"
              onClick={handleConnect}
              disabled={isLoading || !host.trim()}
            >
              {isLoading ? 'Connecting...' : 'Connect'}
            </button>
          ) : (
            <button
              className="disconnect-btn"
              onClick={onDisconnect}
              disabled={isLoading}
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ConnectionPanel