import React from 'react'

interface StatusBarProps {
  connectionStatus: string
  error: string | null
  onClearError: () => void
}

const StatusBar: React.FC<StatusBarProps> = ({ 
  connectionStatus, 
  error, 
  onClearError 
}) => {
  return (
    <div className="status-bar">
      <div className="status-left">
        <span className="connection-status">{connectionStatus}</span>
      </div>
      
      <div className="status-right">
        {error && (
          <div className="error-container">
            <span className="error-message">Error: {error}</span>
            <button 
              className="clear-error-btn" 
              onClick={onClearError}
              title="Clear error"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default StatusBar