<div align="center">

# 🕯️ Lamplight Reader

**Read PDFs and the Bible aloud. Free, private, and entirely offline.**

A desktop app that turns any PDF, scanned page, or Scripture chapter into a calm, follow-along reading experience, with every word highlighted as it is spoken.

[![License: MIT](https://img.shields.io/badge/license-MIT-E3B23C.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-2C3440)
![Offline](https://img.shields.io/badge/works-100%25%20offline-2C3440)
![No account](https://img.shields.io/badge/account-not%20required-2C3440)

[Download](#-download) · [Features](#-features) · [Run from source](#-run-from-source) · [Tip jar](#-tip-jar) · [Contributing](#-contributing)

</div>

---

## Why Lamplight?

Reading long documents on a screen is tiring, and not everyone can or wants to read that way. Lamplight reads to you in your operating system's own voices and keeps your place with a highlighted word, so you can listen, follow along, or jump to any spot with a click.

It was built around three rules:

- **Private.** Your documents never leave your computer. There are no accounts, no uploads, no analytics, and no telemetry.
- **Offline.** Everything, including the full Bible in five languages, ships inside the app. After installing, you never need an internet connection.
- **Free.** There is no subscription and no paywall. An optional [tip jar](#-tip-jar) is the only way to support the project.

## ✨ Features

| | |
|---|---|
| 📄 **PDF reader** | Open PDFs of up to 500 pages and have them read aloud, with the current word highlighted. Click any word to start from there. |
| 📖 **Bible, built in** | Read and listen to all 66 books in **English, Spanish, French, German and Portuguese**, chosen by language, book and chapter. |
| 📷 **Document scanner** | Use your camera or upload photos, adjust the page corners, apply a clean-up filter, and turn the pages into a PDF that can be read aloud, using bundled OCR. |
| ✍️ **Fill & sign** | Place text and checkmarks on a PDF, add a typed or hand-drawn signature, and save a flattened copy. |
| 🎚️ **Playback controls** | Adjustable speed (0.5×–2.5×), voice selection, pause and resume, page skipping, and a table of contents for PDFs that have one. |
| 🌙 **Easy on the eyes** | A calm dark theme with a warm accent and a serif reading face, designed for long sessions. |

> **Voices:** Lamplight uses the text-to-speech voices already installed on your system. Most computers include several, and you can add more in your OS settings for additional languages.

## 📦 Download

Installers for Windows, macOS and Linux are published on the [**Releases**](../../releases/latest) page.

| Platform | File | How to install |
|---|---|---|
| Windows | `Lamplight Reader Setup.exe` or the portable `.exe` | Double-click. The portable build needs no installation. |
| macOS | `Lamplight Reader.dmg` | Open the disk image and drag the app into Applications. |
| Linux | `Lamplight Reader.AppImage` | Make it executable (`chmod +x`) and run it. |

> **First launch warnings.** The installers are not code-signed, so Windows SmartScreen or macOS Gatekeeper may warn you. On Windows choose *More info → Run anyway*. On macOS right-click the app and choose *Open*. If you would rather not trust a binary, [run it from source](#-run-from-source) instead.

## 🚀 Run from source

You only need [Node.js](https://nodejs.org/) 18 or newer, which includes `npm`.

```bash
git clone https://github.com/niamlestou/lamplight-reader.git
cd lamplight-reader
npm install
npm start
```

That's it. The first `npm install` downloads Electron (about 100 MB), after which the app works without a network connection.

### Build your own installer

```bash
npm run dist
```

Installers are written to the `dist/` folder for the platform you are building on. Pushing a tag such as `v1.0.0` also runs the [release workflow](.github/workflows/release.yml), which builds all three platforms and attaches them to a GitHub release.

## 🖱️ Using the app

1. **Open something.** Drop a PDF onto the window, choose **Upload PDF**, **Scan** a document, or open the **Bible**.
2. **Press play.** Use the controls at the bottom to start, pause, stop, change the speed, or pick a voice.
3. **Jump around.** Click or select any word to start reading from that spot, or use **Contents** to navigate a long document.
4. **Save your work.** Scanned documents and signed PDFs are saved to your regular downloads folder.

## 💛 Tip jar

Lamplight is free and always will be. If it helped you, you can leave a **one-time** tip from the **Tip jar** button in the app.

- One-time payment only: no subscription, no recurring charge, no account.
- You choose the amount, from $1 to $500.
- Checkout is hosted by [Stripe](https://stripe.com) in your web browser. Card details never pass through this app, and the repository contains no API keys or secrets. The tip button is a public Stripe Payment Link.
- It is the only feature that uses the internet, and nothing else in the app does.

## 🔒 Privacy

- Documents are processed locally and never uploaded.
- The app serves itself from a loopback-only server (`127.0.0.1`) and **blocks every other network request** at the window level, so even a bug could not send your data elsewhere.
- Camera access is requested only when you open the scanner, and no other permission is ever granted.
- There is no analytics, tracking, or crash reporting.

## 🗂️ Project structure

```
lamplight-reader/
├── main.js                 Electron shell: local server, window, network lockdown
├── package.json            Scripts and installer (electron-builder) configuration
├── app/                    The reader itself: static HTML, CSS and JavaScript
│   ├── index.html          Main reader window
│   ├── tip.html            Tip jar page
│   ├── css/                Stylesheets and self-hosted fonts
│   ├── js/
│   │   ├── lamplight-reader.js   PDF parsing, word highlighting, speech playback
│   │   ├── lamplight-scan.js     Camera capture, perspective correction, OCR
│   │   ├── lamplight-bible.js    Bible picker and chapter loader
│   │   └── lamplight-sign.js     Fill & sign
│   ├── bible/              Public-domain Bibles (en, es, fr, de, pt) as per-book JSON
│   └── vendor/             Bundled third-party libraries and fonts (see LICENSES.md)
├── scripts/build-bible.js  Rebuilds the Bible JSON from eBible.org USFM downloads
└── .github/workflows/      Release automation
```

## 📜 The Bible texts

All five translations are in the **public domain** and were converted from the USFM files published by [eBible.org](https://ebible.org):

| Language | Translation |
|---|---|
| English | World English Bible |
| Español | Reina-Valera 1909 |
| Français | Louis Segond 1910 |
| Deutsch | Lutherbibel 1912 |
| Português | Bíblia Portuguesa Mundial |

To regenerate them, download the USFM archives and run `node scripts/build-bible.js <folder>`; details are at the top of the script.

## 🤝 Contributing

Bug reports and pull requests are welcome. The reader is plain HTML and JavaScript with no build step, so a change to anything in `app/` shows up after restarting `npm start`. Please keep the app offline-only: changes that add network calls, analytics or accounts will not be accepted.

## 🙏 Acknowledgements

Lamplight stands on the shoulders of [pdf.js](https://github.com/mozilla/pdf.js), [pdf-lib](https://github.com/Hopding/pdf-lib), [Tesseract.js](https://github.com/naptha/tesseract.js), [Electron](https://www.electronjs.org), [IBM Plex Sans](https://github.com/IBM/plex), and [Source Serif 4](https://github.com/adobe-fonts/source-serif). Licenses for everything bundled are listed in [`app/vendor/LICENSES.md`](app/vendor/LICENSES.md).

## 📄 License

Released under the [MIT License](LICENSE) © 2026 Niam LeStourgeon. Bundled third-party code keeps its own licenses, and the Bible texts are in the public domain.
