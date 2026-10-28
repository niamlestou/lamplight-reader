// Lamp Light Reader desktop shell: serves ./app from a loopback-only HTTP server and
// shows it in a window. Nothing is uploaded. Outbound: the tip jar link, and (only if the user opts in) one-time downloads of the Kokoro voice model from huggingface.co.
const { app, BrowserWindow, session, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'app');
const TIP_URL = 'https://buy.stripe.com/';
const PREFERRED_PORT = 47813; // fixed so saved preferences (localStorage) survive restarts
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.gz': 'application/gzip', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(ROOT, requested === '/' ? 'index.html' : requested);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
  });
});

function listen() {
  return new Promise(resolve => {
    server.once('error', () => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); // preferred port busy
    server.listen(PREFERRED_PORT, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function createWindow() {
  const port = await listen(), origin = `http://127.0.0.1:${port}`;
  // Block every request that is not to the local server (or inline data/blob URLs).
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(http:\/\/127\.0\.0\.1|data:|blob:|devtools:|https:\/\/([a-z0-9-]+\.)*(huggingface\.co|hf\.co)\/)/.test(details.url) }));
  // Only the document scanner needs a permission: the camera.
  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => callback(permission === 'media'));

  const win = new BrowserWindow({ width: 1180, height: 820, minWidth: 420, minHeight: 560, backgroundColor: '#1B2027', title: 'Lamp Light Reader', autoHideMenuBar: true });
  win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith(TIP_URL)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin)) { event.preventDefault(); if (url.startsWith(TIP_URL)) shell.openExternal(url); } });
  win.loadURL(origin);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { server.close(); app.quit(); });
