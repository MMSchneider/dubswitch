# 🎛 DubSwitch — Per-Channel Routing & Overdub Tool for X32/M32

![DubSwitch Main UI](docs/images/dubswitch_main.png)

[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-active-brightgreen)
![Platform](https://img.shields.io/badge/platform-macOS%20|%20Windows%20|%20Linux-blue)
![Version](https://img.shields.io/badge/version-0.1.4--dev-orange)

DubSwitch transforms the way you record with your **Behringer X32 / Midas M32** by giving you **per-channel input control** and a flexible **A/B Toggle Matrix** — flip any channel between two user-defined sources: **Local**, **DAW (Card)**, **AES50-A**, **AES50-B**.

No more block routing gymnastics. No more scene juggling.  
Just fast overdubs, per-channel control, and total session clarity.

---

## 🚀 Key Features

- 🔄 **Per-Channel A/B Toggle Matrix** — choose any two sources per channel (Local, DAW, AES50-A, AES50-B).
- 🎨 **Customizable button colors** for each source type.
- ⚡ **Auto-detects your X32** on the network, with manual IP fallback.
- 🖊 **Reads channel names** from console and allows inline editing.
- 🛠 **OSC Command Panel** for raw commands and debugging.
- 🔧 **Routing Helper** — quickly set console input blocks to *UserIns* (required for operation).
- 🌐 **Server Port Config** — change local Node server port (default: 3000).
- 💾 **Session Presets** — save/recall toggle matrix states per project.

---

## 🖼 Screenshots

### Main Interface
![DubSwitch Main](docs/images/dubswitch_main.png)

### Settings: Colors
![Colors](docs/images/dubswitch_settings_color.png)

### Settings: IP Autodetect
![IP](docs/images/dubswitch_settings_ip.png)

### Settings: Matrix (A/B Sources)
![Matrix](docs/images/dubswitch_settings_matrix.png)

### Settings: OSC Panel
![OSC](docs/images/dubswitch_settings_osc.png)

### Settings: Routing Helper
![Routing](docs/images/dubswitch_settings_routing.png)

### Settings: Server Port
![Server](docs/images/dubswitch_settings_server.png)

---

## 🎯 Typical Workflow

1. **Track drums** on Local inputs (e.g., CH1–8).
2. **Flip channels to DAW** in DubSwitch to monitor playback.
3. **Record guitars/vocals** on remaining Local channels.
4. **Repeat**: flip finished channels to DAW, keep recording new layers.

---

## 🛠 Installation & Setup

1. **Clone the repository**
    ```sh
    git clone https://github.com/yourusername/dubswitch.git
    cd dubswitch
    ```
2. **Install dependencies**
    ```sh
    npm install
    ```
3. **Run the app**
    ```sh
    npm start
    ```
4. **Connect to your X32**
   - Make sure your console is set to use **User Inputs** for channels 1–32.
   - Launch DubSwitch, click **Autodetect**, or manually enter the X32 IP.
   - Use the **Matrix** tab to configure A/B sources per channel.

---

## 📘 Quick Reference

- **A/B Toggle** — click any channel to flip between two sources.
- **All A / All B** — one-click global switch for all channels.
- **Edit Channel Name** — click the pencil icon on any channel block.
- **Colors Tab** — customize button colors for better visual grouping.
- **OSC Tab** — send manual commands for testing or debugging.

---

## 🤝 Contributing

Pull requests and feature requests are welcome!  
Please open an issue first to discuss what you’d like to change.

---

## 📜 License

MIT — see [LICENSE](LICENSE) for details.

---

Made & built by **Mike Schneider** — [dubmajor.de](https://dubmajor.de)
