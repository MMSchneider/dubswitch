# DubSwitch

Overdub-friendly routing & Card↔Local switching for Behringer X32

## Overview

DubSwitch is an Electron-based desktop application that provides intuitive control over Behringer X32 input routing for overdub recording workflows. Switch between local preamp inputs and USB card inputs across all 32 channels with preset configurations optimized for recording and playback scenarios.

## Features

- **32-Channel Grid Interface**: Visual control over all X32 input channels (CH1-32)
- **Local ↔ Card Toggle**: Switch each channel between local preamp and USB card input
- **Smart Presets**:
  - **Record Mode**: Channels 1-24 → Local, Channels 25-32 → Card
  - **Playback Mode**: All channels (1-32) → Card
- **Real-time OSC Communication**: Direct UDP control of X32 via OSC protocol
- **Apply/Undo Functionality**: Safely test configurations with instant rollback
- **Persistent Settings**: Automatically saves X32 IP/port and last preset
- **Connection Status**: Visual feedback for X32 connectivity and errors
- **Cross-Platform**: Works on Windows, macOS, and Linux

## Installation

### Download Pre-built Binaries

Download the latest release for your platform:
- **Windows**: `dubswitch-win32-x64.zip`
- **macOS**: `dubswitch-darwin-x64.zip` or `dubswitch-darwin-arm64.zip`
- **Linux**: `dubswitch-linux-x64.zip`

### Build from Source

#### Prerequisites

- Node.js 18+ and npm
- Git

#### Steps

1. Clone the repository:
   ```bash
   git clone https://github.com/MMSchneider/dubswitch.git
   cd dubswitch
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the application:
   ```bash
   npm run build
   ```

4. Package for your platform:
   ```bash
   # For current platform
   npm run package
   
   # For specific platforms
   npm run package:win    # Windows
   npm run package:mac    # macOS
   npm run package:linux  # Linux
   ```

## Development

### Available Scripts

- `npm run dev` - Start development mode (React + Electron)
- `npm run dev:react` - Start React development server only
- `npm run dev:electron` - Start Electron in development mode
- `npm run build` - Build for production
- `npm run package` - Build and package for distribution

### Development Setup

1. Start the React development server:
   ```bash
   npm run dev:react
   ```

2. In another terminal, start Electron:
   ```bash
   npm run dev:electron
   ```

Or use the combined development command:
```bash
npm run dev
```

## Usage

### Initial Setup

1. **Start DubSwitch** and ensure your Behringer X32 is connected to the same network
2. **Configure Connection**:
   - Enter your X32's IP address (e.g., `192.168.1.100`)
   - Port is typically `10023` (X32 default OSC port)
   - Click "Connect"

### Channel Control

- **Individual Channels**: Click "Local" or "Card" buttons for each channel
- **Bulk Operations**: Use presets for common configurations

### Presets

#### Record Preset
- Channels 1-24: Local (for live instruments/mics)
- Channels 25-32: Card (for playback tracks)
- Ideal for overdub recording sessions

#### Playback Preset  
- All channels 1-32: Card
- Perfect for full playback of recorded sessions

### Safety Features

- **Undo**: Revert to previous channel configuration
- **Visual Feedback**: See connection status and channel states
- **Error Handling**: Clear error messages for troubleshooting

## X32 Configuration

### Network Setup

1. Connect X32 to your network via Ethernet
2. Set X32 to a static IP or note its DHCP assignment
3. Ensure X32 OSC is enabled (typically enabled by default)

### Recommended X32 Settings

- **Routing**: Set up USB routing to match your DAW input configuration
- **Gain Staging**: Adjust preamp gains for local inputs as needed
- **Card Inputs**: Configure USB return routing in X32-Edit if required

## Technical Details

### OSC Implementation

DubSwitch communicates with the X32 using OSC (Open Sound Control) over UDP:
- **Default Port**: 10023 (X32 OSC receive port)
- **Channel Routing Command**: `/ch/XX/config/source`
- **Local Input Value**: `0` (local preamp)
- **Card Input Value**: `17-48` (USB inputs 1-32)

### File Locations

Settings are stored in:
- **Windows**: `%APPDATA%/dubswitch/settings.json`
- **macOS**: `~/Library/Application Support/dubswitch/settings.json`  
- **Linux**: `~/.config/dubswitch/settings.json`

## Troubleshooting

### Connection Issues

1. **Cannot connect to X32**:
   - Verify X32 IP address and network connectivity
   - Check that X32 OSC is enabled
   - Ensure port 10023 is not blocked by firewall

2. **Commands not working**:
   - Confirm X32 firmware is up to date
   - Check X32's routing configuration
   - Verify USB audio driver installation

### Performance

- **Slow response**: Check network latency to X32
- **Missing updates**: Restart connection if channel states appear stale

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Acknowledgments

- Built with Electron, React, and TypeScript
- Uses `node-osc` for X32 communication
- Inspired by the needs of home studio overdub workflows
