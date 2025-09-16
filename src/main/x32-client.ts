import * as osc from 'node-osc'

export class X32Client {
  private client: osc.Client | null = null
  private server: osc.Server | null = null
  private host: string
  private port: number
  private currentState: Map<number, 'local' | 'card'> = new Map()

  constructor(host: string, port: number = 10023) {
    this.host = host
    this.port = port
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.client = new osc.Client(this.host, this.port)
        this.server = new osc.Server(10024, '0.0.0.0', () => {
          console.log('OSC Server is listening on port 10024')
          resolve()
        })

        this.server.on('message', (msg: any) => {
          console.log('Received OSC message:', msg)
        })

        // Send initial connection message
        this.client.send('/xremote', () => {
          console.log('Connected to X32 at', this.host)
        })

        // Initialize current state
        this.initializeChannelStates()

      } catch (error) {
        reject(error)
      }
    })
  }

  disconnect(): void {
    if (this.client) {
      this.client.close()
      this.client = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  private async initializeChannelStates(): Promise<void> {
    // Initialize all channels to local by default
    for (let i = 1; i <= 32; i++) {
      this.currentState.set(i, 'local')
    }
  }

  async setChannelSource(channel: number, source: 'local' | 'card'): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected to X32')
    }

    if (channel < 1 || channel > 32) {
      throw new Error('Channel must be between 1 and 32')
    }

    return new Promise((resolve, reject) => {
      try {
        // For X32, we control the source selection through input routing
        // Local = input from local preamp (channel)
        // Card = input from USB/Card input
        const inputPath = `/ch/${channel.toString().padStart(2, '0')}/config/source`
        const sourceValue = source === 'local' ? 0 : 17 + (channel - 1) // USB inputs start at 17

        this.client!.send(inputPath, sourceValue, (err: any) => {
          if (err) {
            reject(err)
          } else {
            this.currentState.set(channel, source)
            console.log(`Set channel ${channel} to ${source} (value: ${sourceValue})`)
            resolve()
          }
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  async getChannelSource(channel: number): Promise<'local' | 'card'> {
    if (channel < 1 || channel > 32) {
      throw new Error('Channel must be between 1 and 32')
    }

    // Return cached state for now
    // In a real implementation, you might want to query the X32
    return this.currentState.get(channel) || 'local'
  }

  async applyRecordPreset(): Promise<void> {
    console.log('Applying Record Preset: Channels 1-24 Local, 25-32 Card')
    
    const promises: Promise<void>[] = []
    
    // Channels 1-24: Local
    for (let i = 1; i <= 24; i++) {
      promises.push(this.setChannelSource(i, 'local'))
    }
    
    // Channels 25-32: Card
    for (let i = 25; i <= 32; i++) {
      promises.push(this.setChannelSource(i, 'card'))
    }
    
    await Promise.all(promises)
  }

  async applyPlaybackPreset(): Promise<void> {
    console.log('Applying Playback Preset: All channels (1-32) Card')
    
    const promises: Promise<void>[] = []
    
    // All channels: Card
    for (let i = 1; i <= 32; i++) {
      promises.push(this.setChannelSource(i, 'card'))
    }
    
    await Promise.all(promises)
  }

  getCurrentState(): Map<number, 'local' | 'card'> {
    return new Map(this.currentState)
  }
}