'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, shell, nativeImage } = require('electron');

const settings = require('./settings');
const placement = require('./placement');
const { Poller } = require('./poller');
const { providers } = require('./providers');
const autostart = require('./autostart');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

let win = null;
let tray = null;
let poller = null;
let expanded = false;
let collapseTimer = null;

/**
 * Wayland gives applications no way to position a window at a screen edge, so
 * we ask Chromium for X11 (XWayland) unless the user insists otherwise. Set
 * SUP_OZONE=wayland to override — the tab will then land wherever the
 * compositor decides to put it.
 */
function configurePlatform() {
  if (process.platform !== 'linux') return;
  const ozone = process.env.SUP_OZONE || 'x11';
  app.commandLine.appendSwitch('ozone-platform', ozone);
  if (settings.load().transparent) {
    app.commandLine.appendSwitch('enable-transparent-visuals');
  }
}

function displayForConfig(config) {
  const displays = screen.getAllDisplays();
  if (config.display === 'cursor') {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  const index = Number(config.display);
  if (Number.isInteger(index) && displays[index]) return displays[index];
  return screen.getPrimaryDisplay();
}

function areaFor(config) {
  const display = displayForConfig(config);
  // A tab hugs the physical edge, so we use bounds rather than workArea and
  // deliberately sit over panels and docks.
  return config.useWorkArea ? display.workArea : display.bounds;
}

function applyBounds() {
  if (!win) return;
  const config = settings.load();
  const size = expanded ? placement.expandedSize(config) : placement.collapsedSize(config);
  const bounds = placement.boundsFor(config, areaFor(config), size);
  win.setBounds(bounds);
  if (process.env.SUP_DEV) {
    console.log(`[sup] ${expanded ? 'expanded' : 'collapsed'} on ${config.edge}: ${JSON.stringify(bounds)}`);
  }
}

function createWindow() {
  const config = settings.load();
  const size = placement.collapsedSize(config);
  const bounds = placement.boundsFor(config, areaFor(config), size);

  win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: config.transparent,
    backgroundColor: config.transparent ? '#00000000' : '#0b0b0f',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    type: process.platform === 'linux' ? config.windowType : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    applyBounds();
  });

  win.on('closed', () => {
    win = null;
  });
}

function sendConfig() {
  if (win && !win.isDestroyed()) win.webContents.send('sup:config', settings.load());
}

function setExpanded(next) {
  if (expanded === next || !win) return;
  expanded = next;
  applyBounds();
}

function createTray() {
  // Not every desktop exposes a status area (and some need an AppIndicator
  // extension). The tab is the product; the tray is a convenience.
  try {
    const icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('Sup');
    refreshTrayMenu();
    tray.on('click', () => poller.refreshNow());
  } catch (err) {
    console.warn(`Sup: no system tray available (${err.message}). Edit ${settings.FILE} to configure.`);
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const config = settings.load();

  const edgeItems = ['top', 'bottom', 'left', 'right'].map((edge) => ({
    label: edge[0].toUpperCase() + edge.slice(1),
    type: 'radio',
    checked: config.edge === edge,
    click: () => {
      settings.save({ edge });
      applyBounds();
      sendConfig();
      refreshTrayMenu();
    },
  }));

  const displayItems = [
    { label: 'Primary', type: 'radio', checked: config.display === 'primary', value: 'primary' },
    { label: 'Follow pointer', type: 'radio', checked: config.display === 'cursor', value: 'cursor' },
    ...screen.getAllDisplays().map((d, i) => ({
      label: `Display ${i + 1} (${d.size.width}×${d.size.height})`,
      type: 'radio',
      checked: String(config.display) === String(i),
      value: i,
    })),
  ].map((item) => ({
    label: item.label,
    type: item.type,
    checked: item.checked,
    click: () => {
      settings.save({ display: item.value });
      applyBounds();
      refreshTrayMenu();
    },
  }));

  const providerItems = providers.map((p) => ({
    label: p.label,
    type: 'checkbox',
    checked: config.enabled[p.id] !== false,
    click: (menuItem) => {
      settings.save({ enabled: { [p.id]: menuItem.checked } });
      poller.refreshNow();
      refreshTrayMenu();
    },
  }));

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Refresh now', click: () => poller.refreshNow() },
      { type: 'separator' },
      { label: 'Edge', submenu: edgeItems },
      { label: 'Screen', submenu: displayItems },
      { label: 'Providers', submenu: providerItems },
      {
        label: 'Transparent background',
        type: 'checkbox',
        checked: config.transparent !== false,
        click: (item) => {
          settings.save({ transparent: item.checked });
          relaunch();
        },
      },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: autostart.isEnabled(),
        click: (item) => autostart.setEnabled(item.checked),
      },
      { type: 'separator' },
      { label: 'Edit settings file…', click: () => shell.openPath(settings.FILE) },
      { label: 'Quit Sup', click: () => app.quit() },
    ])
  );
}

function relaunch() {
  app.relaunch();
  app.exit(0);
}

function wireIpc() {
  ipcMain.on('sup:ready', () => {
    sendConfig();
    if (win && !win.isDestroyed()) win.webContents.send('sup:update', poller.snapshot());
  });

  ipcMain.on('sup:expand', () => {
    clearTimeout(collapseTimer);
    setExpanded(true);
  });

  ipcMain.on('sup:collapse', () => {
    // A short grace period keeps the panel from flickering when the pointer
    // crosses the seam between the pill and the expanded body.
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => setExpanded(false), 180);
  });

  ipcMain.on('sup:refresh', () => poller.refreshNow());
  ipcMain.on('sup:open-settings', () => shell.openPath(settings.FILE));

  // The tray is not guaranteed to exist (plenty of desktops need an extension
  // for it), so the panel carries its own way out.
  ipcMain.on('sup:quit', () => app.quit());
}

function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  configurePlatform();
  app.on('second-instance', () => poller && poller.refreshNow());
  app.on('window-all-closed', () => {}); // tray-only app: never quit on close

  app.whenReady().then(() => {
    poller = new Poller();
    poller.on('update', (snapshot) => {
      if (win && !win.isDestroyed()) win.webContents.send('sup:update', snapshot);
      if (process.env.SUP_DEV) {
        for (const p of snapshot.providers) {
          const worst = p.windows.reduce((a, w) => (w.percent > (a ? a.percent : -1) ? w : a), null);
          console.log(
            `[sup] ${p.key.padEnd(14)} ${p.status.padEnd(16)} ` +
              `${worst ? `${Math.round(worst.percent)}% ${worst.label}` : p.detail || ''}`
          );
          for (const s of p.sessions || []) {
            console.log(`        ${s.state.padEnd(9)} ${(s.project || s.id).padEnd(18)} ${s.branch || ''}`);
          }
        }
      }
    });

    wireIpc();
    createWindow();
    createTray();
    poller.start();

    screen.on('display-metrics-changed', applyBounds);
    screen.on('display-added', applyBounds);
    screen.on('display-removed', applyBounds);
  });

  app.on('before-quit', () => poller && poller.stop());
}

main();
