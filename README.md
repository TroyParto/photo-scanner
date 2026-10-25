# Photo Scanner — Desktop App

Automatically detects, crops, straightens and saves individual photos from scanned JPEG/PNG files. No manual adjustments needed — background colour and edges are detected automatically.

---

## Requirements

- **Node.js** (v18 or newer) — https://nodejs.org  
  Download the LTS version and install it.

---

## Quick Start (run without building)

```bash
# 1. Open a terminal inside the photo-scanner-app folder
cd photo-scanner-app

# 2. Install dependencies (first time only — needs internet)
npm install

# 3. Launch the app
npm start
```

---

## Build a standalone installer

After `npm install`, build for your platform:

| Platform | Command | Output |
|----------|---------|--------|
| Windows  | `npm run build-win` | `dist/Photo Scanner Setup.exe` |
| macOS    | `npm run build-mac` | `dist/Photo Scanner.dmg` |
| Linux    | `npm run build-linux` | `dist/Photo Scanner.AppImage` |

---

## How it works

1. Drop one or more scanned image files into the sidebar
2. The app auto-detects the scanner background colour from the image corners
3. Each individual photo is found, split apart if multiple are on one scan, and edge-trimmed precisely
4. Rotation is auto-detected and corrected — fine-tune with the sliders if needed
5. Click **Save all to folder…** to pick a destination once and save everything silently

## Tips

- **Gap sensitivity** slider — lower it if photos are still merging together
- Rotation sliders only appear for photos where a tilt was detected
- Individual **Save** buttons on each thumbnail save a single photo

---

## Troubleshooting

**npm: command not found** → Install Node.js from https://nodejs.org  
**Build fails on macOS** → Run `xcode-select --install` first  
**Photos clumping** → Lower the Gap sensitivity slider and hit Re-detect all
