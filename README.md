<div align="center">

# 🎬 SANFLIX — Self-Hosted Personal Media Streaming Server & Netflix-Style Player

### *Your Library. Your Cinema.*

A lightweight, self-hosted streaming platform with a cinematic glassmorphism interface, built for your personal collection of movies, TV shows, and music.

[![Built by Santhosh](https://img.shields.io/badge/Developer-Santhosh%20A-red?style=for-the-badge&logo=github&link=https://a-santhosh-hub.github.io/in/)](https://a-santhosh-hub.github.io/in/)
[![Studio SanStudio](https://img.shields.io/badge/Studio-SanStudio-blue?style=for-the-badge&logo=codeforces&link=https://sanstudio-hub.github.io/in/)](https://sanstudio-hub.github.io/in/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.x-000000?style=for-the-badge&logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-HLS%20Transcoding-007808?style=for-the-badge&logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P%20Sharing-333333?style=for-the-badge&logo=webrtc&logoColor=white)](https://webrtc.org/)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

[Quick Start](#-quick-start) • [Why I Built This](#-why-i-built-this-story) • [Features](#-features) • [How to Share with Friends](#-sharing-with-friends-cloudflare-tunnel--lan) • [Architecture](#-project-architecture) • [SEO & GitHub Setup](#-how-to-publish-on-github-seo-guide) • [Portfolio Showcase](#-why-this-shines-in-a-portfolio) • [Legal & Disclaimer](#-legal-disclaimer--copyright)

---

</div>

## 💡 Why I Built This (Story & Vision)

> *"I am a huge movie lover. Over the years, I curated a large personal collection of movies, TV series, concert recordings, and tutorial videos on my hard drives. But when I wanted to watch them seamlessly across my devices or share a movie night with friends, I hit a wall."*
>
> — **Santhosh A** ([Portfolio](https://a-santhosh-hub.github.io/in/) | [SanStudio](https://sanstudio-hub.github.io/in/))

### The Problem with Existing Solutions
When searching GitHub and the web for a self-hosted media player:
1. **Most "Netflix Clones" on GitHub are fake**: They are purely static HTML/React frontend mockups that fetch movie trailers from TMDB API. They **cannot** stream real video files from your disk.
2. **Traditional Media Servers (Plex, Jellyfin, Emby) are heavy**: They require heavy background services, complicated Docker setups, high memory usage, and proprietary account sign-ins.
3. **No simple way to stream locally & securely tunnel to friends**: I wanted an app where you simply drop your video files into a folder, run **one command**, and instantly get a responsive, beautiful streaming interface on your laptop, phone, TV, or over Cloudflare Tunnels for friends.

### The Solution: SANFLIX
**SANFLIX** bridges the gap:
- **Zero Config**: Drop video files in `media/` and run `npm run dev`. Everything (Python venv, packages, secrets, scanner) runs automatically.
- **Cinematic Glass Interface**: A modern frosted-glass design (inspired by modern OS glass aesthetics and Netflix's intuitive UX).
- **Real Streaming Engine**: Uses **FFmpeg** and **HLS (HTTP Live Streaming)** for smooth, adaptive playback of 4K, 1080p, MKV, MP4, and multi-track audio.
- **Peer-to-Peer Hub & Sharing**: WebRTC direct device-to-device streaming and private share links so friends can stream without stressing server bandwidth.

---

## ⚡ Comparison: Why SANFLIX?

| Feature | Standard GitHub "Netflix Clones" | Heavy Media Servers (Plex/Jellyfin) | 🚀 SANFLIX |
| :--- | :---: | :---: | :---: |
| **Real Local Video Streaming** | ❌ (Static dummy UI) | ✅ | ✅ **Yes (MP4, MKV, WebM, HLS)** |
| **Setup Complexity** | Low | High (Docker, DB, config) | 🟢 **1 Command (`npm run dev`)** |
| **Resource Usage** | N/A | High (RAM/CPU heavy) | ⚡ **Ultra-lightweight (Python/Waitress)** |
| **Multi-Device / Mobile UI** | Often desktop-only | App required | 📱 **100% Responsive Glass Web App** |
| **Automatic Poster Fetching** | Needs API Keys | Needs API Keys | 🪄 **Keyless (Wikipedia/TVMaze) + TMDB option** |
| **P2P Device-to-Device Sharing** | ❌ | ❌ | 🌐 **Built-in WebRTC Shared Hub** |
| **YouTube Player Integration** | ❌ | ❌ | 📺 **Built-in Ad-free TV YouTube player** |
| **Multi-Track Audio Selection** | ❌ | ✅ | ✅ **Instant switch without transcoding** |

---

## 🌟 Features

### 🎬 1. Media Library & Streaming
- **Supported Video**: `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`
- **Supported Audio**: `.mp3`, `.m4a`, `.aac`, `.wav`, `.flac`, `.ogg`, `.opus`
- **HLS Adaptive Streaming**: Background segmentation for fast seeking and zero buffering on heavy 4K/high-bitrate movies.
- **Embedded Audio Track Selector**: Switch between dual-audio or multi-language tracks embedded in your MKV/MP4 files directly from the player.
- **Resume Playback**: Remembers your exact playback position across restarts.
- **Smart Next Episode**: Automatic 10-second countdown transition for TV shows.

### 🎨 2. Glassmorphism UI & Experience
- **Responsive Layout**: Seamless experience across Desktop, Tablet, iPhone/Android, and Smart TVs.
- **Floating Glass Navigation**: Translucent frosted-glass panels with system-preference aware contrast toggles ("Reduce Transparency" mode).
- **Touch Gestures**: Double-tap left/right to skip 10 seconds on mobile devices.
- **Keyboard Shortcuts**: Space to toggle play, arrow keys to seek and adjust volume, `F` for fullscreen, `M` to mute.

### 🔍 3. Automatic Artwork & Discovery
- **Keyless Auto-Posters**: Automatically extracts movie titles from filenames (e.g. `Inception.2010.1080p.mkv` ➔ `Inception`) and fetches high-res artwork from Wikipedia and TVMaze without requiring any API keys.
- **TMDB Integration (Optional)**: Drop a free TMDB API key in `tmdb_key.txt` to unlock landscape cinematic banners and backdrops.
- **Instant Search**: Search titles, filenames, series names, or audio tracks in real time.

### 🌐 4. Shared Hub & WebRTC P2P
- **Direct P2P Streaming**: Stream files directly between browser tabs or friends' devices using WebRTC without uploading the file to the server.
- **Private Share Links (Localgram)**: Generate expiring, revocable share links for specific movies so friends can watch without giving them full library access.

### 📺 5. Built-in YouTube Player
- Search and stream YouTube videos directly in the custom cinematic TV player without ads or third-party extensions (powered by `yt-dlp`).

### 🔒 6. Dual-Tier Security
- **Viewer Password**: Protects access when streaming over LAN, Wi-Fi, or public tunnels.
- **Admin Password**: Protects library uploads, file indexing, and administrative management.
- **Localhost Bypass**: Instant access from the host machine without tedious login prompts.

---
# 🎬 SANFLIX — Self-Hosted Personal Media Streaming Server & Netflix-Style Player

**SANFLIX** is an open-source, lightweight self-hosted media streaming server framework created by **A-Santhosh-Hub**. Designed with a cinematic glassmorphism UI, it features real HLS video streaming, multi-track audio selection, and WebRTC peer-to-peer sharing capabilities.


---
## 🚀 Quick Start

### Prerequisites
1. **Node.js 18+** — [Download Node.js](https://nodejs.org)
2. **Python 3.10+** — [Download Python](https://www.python.org/downloads/) *(On Windows, tick "Add python.exe to PATH")*
3. **FFmpeg & FFprobe** — Reads video metadata & converts HLS:
   - **Windows**: `winget install Gyan.FFmpeg`
   - **macOS**: `brew install ffmpeg`
   - **Linux**: `sudo apt install ffmpeg`

### Installation & Launch in 1 Step

```bash
# Clone the repository
git clone https://github.com/A-Santhosh-Hub/sanflix-netflix-clone.git
cd sanflix-netflix-clone

# Start the launcher
npm run dev
```

That's it! The launcher automatically:
1. Detects Python and creates a `.venv` virtual environment.
2. Installs dependencies (`Flask`, `Waitress`, `yt-dlp`).
3. Generates secure random credentials in `sanflix.env`.
4. Creates media directories (`media/movies`, `media/series`, `media/music`).
5. Opens your browser automatically at **`http://localhost:5000`**.

---

## 📂 Adding Your Media

Place your media files into the respective folders:

```text
sanflix/
└── media/
    ├── movies/
    │   ├── Inception (2010).mp4
    │   └── Interstellar.mkv
    ├── series/
    │   └── Breaking Bad/
    │       └── Season 1/
    │           ├── Breaking.Bad.S01E01.mkv
    │           └── Breaking.Bad.S01E02.mkv
    └── music/
        ├── Bohemian Rhapsody.flac
        └── Synthwave Mix.mp3
```

After adding files, run:
```bash
python scan_media.py
```
*(Or use the **Manage Library** button in the SANFLIX web UI to upload files directly from your browser).*

---

## 🌍 Sharing with Friends (Cloudflare Tunnel / LAN)

### Option 1: On Your Local Wi-Fi (LAN)
Run:
```bash
npm start
```
SANFLIX will bind to `0.0.0.0:5000`. Other computers, tablets, or phones on the same Wi-Fi can open:
`http://<YOUR-COMPUTER-LOCAL-IP>:5000` (e.g. `http://192.168.1.15:5000`) and sign in using the **Viewer Password** found in `sanflix.env`.

### Option 2: Share Anywhere via Free Cloudflare Tunnel
To share with friends outside your home without port-forwarding:
1. Download [Cloudflare `cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Run:
   ```bash
   cloudflared tunnel --url http://localhost:5000
   ```
3. Cloudflare gives you a secure HTTPS URL (e.g. `https://random-name.trycloudflare.com`).
4. Send the URL and your **Viewer Password** (from `sanflix.env`) to your friends. They can now watch your movie collection securely!

---

## 🛠 Project Architecture

```text
sanflix/
├── app.py                    # Flask application core, streaming endpoints & authentication
├── serve.py                  # Production WSGI entry point (Waitress)
├── scan_media.py             # Media scanner & metadata extraction (FFprobe)
├── convert_hls.py            # Standalone background HLS conversion
├── hls_manager.py            # HLS cache management & stream chunking
├── poster_fetcher.py         # Artwork scraper (Wikipedia, TVMaze, TMDB)
├── hubroom.py                # WebRTC signaling server for P2P watch rooms
├── localgram.py              # Single-file expiring share links
├── youtube_catalog.py        # YouTube search & catalog provider (yt-dlp)
├── youtube_stream.py         # YouTube video stream resolver
├── make_secrets.py           # Auto-generates random secure passwords
├── scripts/dev.cjs           # Cross-platform zero-dependency launcher
├── templates/                # HTML5 templates (Cinematic Player, Grid, Hub)
├── static/                   # Glassmorphism CSS & Vanilla JavaScript
└── tests/                    # Unit, regression, and E2E browser tests
```


## ⚖️ Legal Disclaimer & Copyright

- **No Media Bundled**: SANFLIX is an open-source software player engine. It **does not contain or distribute any copyrighted movies, audio, or video files**.
- **User Responsibility**: Users stream their own personally owned media collections.
- **Fair Use & Independence**: SANFLIX is an independent open-source project created by **Santhosh A** and **SanStudio**. It is **not** affiliated with, endorsed by, or associated with Netflix, Inc., Google LLC, or YouTube. "Netflix" is referenced solely for interface style description under fair descriptive use.
- **Safe to Host on GitHub**: Because this repository contains only original open-source source code and no pirated content, hosting this project on GitHub is 100% compliant with GitHub's Terms of Service and DMCA policies.

---

## 👨‍💻 Author & Studio

Designed and crafted with ❤️ by:

- **Santhosh A** — [Portfolio Website](https://a-santhosh-hub.github.io/in/) • [GitHub Profile](https://github.com/a-santhosh-hub)
- **SanStudio** — [Official Hub](https://sanstudio-hub.github.io/in/)

If you like this project, please consider giving it a ⭐ on GitHub!

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) — free for personal and educational use.
