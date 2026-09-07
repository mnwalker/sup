'use strict';

/**
 * Renders the tab with sample data and writes PNGs, so you can see what a
 * change looks like without installing every provider:
 *
 *   npx electron scripts/screenshot.js
 *   xvfb-run -a npx electron scripts/screenshot.js   # headless
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const OUT = path.join(__dirname, '..', 'docs', 'preview');

const CONFIG = { edge: 'right', warnAt: 75, dangerAt: 90, collapsedWidth: 190 };

const SNAPSHOT = {
  generatedAt: new Date().toISOString(),
  providers: [
    {
      id: 'claude',
      key: 'claude',
      label: 'Claude Code',
      account: null,
      status: 'ok',
      plan: 'max',
      detail: null,
      windows: [
        { key: 'five_hour', label: 'Session (5h)', percent: 62, resetsAt: iso(2.3), detail: null },
        { key: 'seven_day', label: 'Weekly (all models)', percent: 41, resetsAt: iso(74), detail: null },
        { key: 'seven_day_opus', label: 'Weekly Opus', percent: 12, resetsAt: iso(74), detail: null },
      ],
      session: { state: 'working', since: new Date().toISOString(), project: 'checkout-api' },
    },
    {
      id: 'codex',
      key: 'codex',
      label: 'Codex',
      account: null,
      status: 'ok',
      plan: null,
      detail: null,
      windows: [
        { key: 'primary', label: 'Session (5h)', percent: 88, resetsAt: iso(0.7), detail: null },
        { key: 'secondary', label: 'Weekly', percent: 34, resetsAt: iso(96), detail: null },
      ],
      session: { state: 'waiting', since: new Date().toISOString(), project: 'infra' },
    },
    {
      id: 'cursor',
      key: 'cursor',
      label: 'Cursor',
      account: 'me@example.com',
      status: 'ok',
      plan: 'pro',
      detail: null,
      windows: [{ key: 'included', label: 'Included usage', percent: 96, resetsAt: iso(240), detail: '$19.20 of $20.00' }],
      session: { state: 'idle', since: null, project: null },
    },
    {
      id: 'antigravity',
      key: 'antigravity',
      label: 'Antigravity',
      account: null,
      status: 'not-installed',
      plan: null,
      detail: 'Antigravity does not appear to be installed.',
      windows: [],
      session: { state: 'unknown', since: null, project: null },
    },
  ],
};

function iso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString();
}

async function shoot(win, name, width, height, expanded) {
  win.setBounds({ x: 0, y: 0, width, height });
  await win.webContents.executeJavaScript(
    `document.body.dataset.state = ${JSON.stringify(expanded ? 'expanded' : 'collapsed')};`
  );
  // Let the resize settle and the open/close transition finish before capturing.
  await new Promise((r) => setTimeout(r, 900));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
  console.log(`wrote ${path.join(OUT, `${name}.png`)}`);
}

app.commandLine.appendSwitch('ozone-platform', 'x11');
// Headless CI (and root shells) have no usable sandbox or GPU.
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 400,
    height: 360,
    show: false,
    frame: false,
    // A flat "desktop" behind the tab, since a transparent capture would be
    // invisible in a PNG viewer.
    backgroundColor: '#242833',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ipcMain.on('sup:ready', () => {
    win.webContents.send('sup:config', CONFIG);
    win.webContents.send('sup:update', SNAPSHOT);
  });
  ipcMain.on('sup:expand', () => {});
  ipcMain.on('sup:collapse', () => {});
  ipcMain.on('sup:refresh', () => {});

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));

  await shoot(win, 'collapsed', 90, 260, false);
  await shoot(win, 'expanded', 450, 460, true);

  app.quit();
});
