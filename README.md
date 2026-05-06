# SpotifyShowLyric

Lyrics panel for the Windows Spotify desktop app.

<img width="2168" height="1388" alt="{826C9F47-36D0-46A1-925F-6426CE7A45CD}" src="https://github.com/user-attachments/assets/fbcae457-cdbc-4ff5-9969-1ae13404a71e" />


   
This project does **not** require Spicetify. Instead, a local Node.js server injects code directly into Spotify through Chrome DevTools Protocol and renders a right-side lyrics panel for the currently playing track.

## What It Does

- Injects a custom lyrics panel into the native Spotify desktop client
- Detects the current song directly from Spotify UI / Media Session
- Looks up lyrics through multiple sources
- Caches successful matches in a local CSV file
- Can run in the background with `pm2`

## Current Lyrics Source Order

1. `LRCLIB`
2. `lyrics.ovh`
3. `Genius` browser scraping through `puppeteer`

If a song is found once, it is stored in `lyrics-cache.csv`, so the next request is instant.

## Tech Stack

- `express`
- `cors`
- `ws`
- `puppeteer`
- Spotify desktop app with remote debugging enabled

## Project Files

- `server.js` - local API, lyrics providers, cache and Spotify injector
- `lyrics.js` - injected UI panel shown inside Spotify
- `lyrics-cache.csv` - generated cache for successful lyrics matches

## Requirements

- Windows
- Spotify desktop app
- Node.js

## Installation

### 1. Clone or download the project

Put the project anywhere you want, for example:

### 2. Install Node.js

If Node.js is not installed yet:

```powershell
winget install -e --id OpenJS.NodeJS
```

Restart the terminal after installation if needed.

### 3. Install project dependencies

Open a terminal in the project folder and run:

```powershell
npm install
```

This installs everything required by the current version of the project:

- `express`
- `cors`
- `ws`
- `puppeteer`

### 4. Enable Spotify remote debugging

Spotify must be started with a DevTools port so the server can inject script

Find (or create) your Spotify shortcut and edit its **Target** field by appending:

```text
--remote-debugging-port=9222
```

Example:

```text
"C:\Users\<YourUser>\AppData\Roaming\Spotify\Spotify.exe" --remote-debugging-port=9222
```

Then:

1. Fully close Spotify
2. Kill it from the tray if it is still running in background
3. Start it again using that modified shortcut (you can bind it to the taskbar - it will be working now)

### 5. Start the local server (optional)

 Now we will set up pm2. You can read about it [here](https://pm2.keymetrics.io/docs/usage/quick-start/)
 Execute all this commands: 
   ```
   npm install pm2 -g
   npm install pm2-windows-startup -g
   pm2-startup install
   pm2 start server.js --name lyrics-server
   pm2 save
   ```
 Run ```pm2 list```
   
   It should look like this:

<img width="724" height="97" alt="{D3A85054-E047-48C8-9AFD-AC6F9C2D52C2}" src="https://github.com/user-attachments/assets/0ec1b110-f011-4277-8832-3d2979b90f74" />

After that, Windows should restore your saved PM2 processes on startup.
Now you can reopen your Spotify app and see how extension is working!

## How It Works

1. `server.js` monitors Spotify DevTools on port `9222`
2. Once Spotify is available, the server injects `lyrics.js`
3. `lyrics.js` reads the current track from Spotify
4. The injected script requests lyrics from the local server
5. The server checks:
   - cache
   - `LRCLIB`
   - `lyrics.ovh`
   - `Genius` scraping
6. The result is rendered inside the right-side lyrics panel

## Ports

Current defaults:

- local lyrics server: `3217`
- Spotify remote debugging: `9222`

If you change the local server port, update it in both:

- `server.js`
- `lyrics.js`

### Genius fallback is slower

That is expected.

- `LRCLIB` and `lyrics.ovh` are fast API requests
- `Genius` fallback uses browser automation through `puppeteer`
- this can take noticeably longer than API hits

## Disclaimer

This project is a personal desktop customization tool for Spotify on Windows. It relies on Spotify UI structure and remote debugging behavior, so future Spotify updates may break some selectors or injection behavior.
