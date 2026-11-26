'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, shell, nativeImage, powerMonitor } = require('electron');

const settings = require('./settings');
const placement = require('./placement');
const { Poller } = require('./poller');
const { providers } = require('./providers');
const autostart = require('./autostart');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

/**
 * A packaged Windows app has no console to print to, so when diagnostics are
 * asked for, mirror them into a file next to the settings.
 */
function startDebugLog() {
  if (!process.env.SUP_DEV) return;
  try {
    const file = path.join(settings.appConfigDir(), 'sup.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `Sup ${app.getVersion()} on ${process.platform} ${process.arch}\n`);
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        original(...args);
        try {
          fs.appendFileSync(file, `${args.join(' ')}\n`);
        } catch {
          /* the log is a convenience, never a reason to fail */
        }
      };
    }
    console.log(`[sup] diagnostics written to ${file}`);
  } catch {
    /* no diagnostics available; carry on */
  }
}

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

/**
 * While the tab is being dragged it follows the pointer without touching the
 * settings file; the placement is only saved when it is dropped.
 */
let dragPlacement = null;

function currentConfig() {
  const config = settings.load();
  return dragPlacement ? { ...config, ...dragPlacement } : config;
}

function placementAt(point) {
  const displays = screen.getAllDisplays();
  const display = screen.getDisplayNearestPoint(point);
  const index = Math.max(0, displays.findIndex((d) => d.id === display.id));
  const area = settings.load().useWorkArea ? display.workArea : display.bounds;
  return { ...placement.snapToEdge(point, area), display: index };
}

function applyBounds() {
  if (!win) return;
  const config = currentConfig();
  const size = expanded || FIXED_SIZE ? placement.expandedSize(config) : placement.collapsedSize(config);
  const bounds = placement.boundsFor(config, areaFor(config), size);
  win.setBounds(bounds);
  if (process.env.SUP_DEV) {
    console.log(`[sup] ${expanded ? 'expanded' : 'collapsed'} on ${config.edge}: ${JSON.stringify(bounds)}`);
  }
}

/**
 * Show the tab, once, from whichever signal arrives first.
 *
 * `ready-to-show` is not dependable for a frameless transparent window —
 * notably on Windows, where it can simply never fire, leaving the app running
 * with a tray icon and nothing on screen. So take the first of three chances
 * and make the call idempotent.
 */
function showWindow(reason) {
  if (!win || win.isDestroyed() || win.isVisible()) return;
  win.showInactive();
  applyBounds();
  if (process.env.SUP_DEV) {
    console.log(`[sup] shown via ${reason}: ${JSON.stringify(win.getBounds())} visible=${win.isVisible()}`);
  }
}

function createWindow() {
  const config = settings.load();
  const size = FIXED_SIZE ? placement.expandedSize(config) : placement.collapsedSize(config);
  const bounds = placement.boundsFor(config, areaFor(config), size);

  const options = {
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
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  // An unfocusable window keeps X11 window managers from stealing focus when
  // the pointer crosses it, but on Windows it can stop the window appearing at
  // all — and there is nothing there to steal focus in the first place.
  if (process.platform !== 'win32') options.focusable = false;
  if (process.platform === 'linux') options.type = config.windowType;

  const created = new BrowserWindow(options);
  win = created;
  pointerThrough = null;
  passPointerThrough(true);
  watchPointer();

  win.setAlwaysOnTop(true, config.alwaysOnTopLevel || 'screen-saver');
  // macOS and Linux only; on Windows older Electron builds threw here.
  if (process.platform !== 'win32') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => showWindow('ready-to-show'));
  win.webContents.once('did-finish-load', () => showWindow('did-finish-load'));
  const fallback = setTimeout(() => showWindow('fallback timer'), 3000);

  win.webContents.on('did-fail-load', (_e, code, description) => {
    console.error(`Sup: the tab failed to load (${code} ${description}).`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    // A window already replaced (or shut down on purpose) is not news.
    if (win !== created || details.reason === 'clean-exit') return;
    console.error(`Sup: the tab's renderer went away (${details.reason}); rebuilding it.`);
    scheduleRebuild();
  });

  win.on('closed', () => {
    clearTimeout(fallback);
    // A replacement window may already have been created by then.
    if (win === created) win = null;
  });
}

/**
 * Transparency is fixed when a window is created, so changing it means a new
 * window — but not a new process. Relaunching cannot be relied on: for the
 * portable Windows build `process.execPath` is a temporary extraction that no
 * longer exists by the time it is re-run, so the app just exits and never
 * comes back.
 */
function recreateWindow() {
  const old = win;
  win = null;
  expanded = false;
  if (old && !old.isDestroyed()) old.destroy();
  createWindow();
}

/**
 * The tab must never be silently gone. Sleep, closing the lid onto an
 * external display (clamshell) or a display change can take Chromium's GPU
 * process down, and with it the page: the window stays on screen, fully
 * transparent, with nothing drawn in it, and nothing ever redraws it. So when
 * the renderer or GPU process dies, after waking, and whenever a periodic
 * check finds the page dead, build a fresh window.
 */
let rebuildTimer = null;

function scheduleRebuild(delayMs = 1500) {
  clearTimeout(rebuildTimer);
  // Give Chromium a moment to bring its GPU process back first.
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    recreateWindow();
  }, delayMs);
}

function pageIsDead() {
  if (!win || win.isDestroyed()) return true;
  const wc = win.webContents;
  try {
    return wc.isDestroyed() || wc.isCrashed() || !wc.mainFrame || wc.mainFrame.isDestroyed();
  } catch {
    // Touching a disposed frame throws: that is an answer too.
    return true;
  }
}

function watchHealth() {
  app.on('child-process-gone', (_e, details) => {
    if (details.type !== 'GPU') return;
    console.error(`Sup: the GPU process went away (${details.reason}); rebuilding the tab.`);
    scheduleRebuild();
  });

  // Rebuilding on wake is cheap and catches what no event reports.
  powerMonitor.on('resume', () => scheduleRebuild(3000));
  powerMonitor.on('unlock-screen', () => {
    if (pageIsDead()) scheduleRebuild();
  });

  const timer = setInterval(() => {
    if (!rebuildTimer && pageIsDead()) {
      console.error('Sup: found the tab dead; rebuilding it.');
      scheduleRebuild(0);
    }
  }, 30000);
  if (timer.unref) timer.unref();
}

function sendConfig() {
  if (win && !win.isDestroyed()) win.webContents.send('sup:config', currentConfig());
}

/**
 * On macOS and Windows the window never changes size. Resizing a transparent
 * window there is not atomic: the new size lands a few frames before the new
 * position, so every hover in or out flashed the tab (or a long strip of the
 * panel) at the wrong spot. Instead the window stays panel-sized and, while
 * collapsed, lets the pointer through to whatever is underneath.
 *
 * A window that lets the pointer through gets no hover events on macOS (even
 * with `forward`), so the main process watches the pointer itself and stops
 * letting it through while it is over the tab; the page then sees an ordinary
 * hover. Linux keeps the resizing window, where the flash was never seen.
 */
const FIXED_SIZE = process.platform !== 'linux';
const POINTER_POLL_MS = 100;

let pointerThrough = null;
let pointerTimer = null;

function passPointerThrough(through) {
  if (!FIXED_SIZE || !win || win.isDestroyed() || pointerThrough === through) return;
  pointerThrough = through;
  win.setIgnoreMouseEvents(through, { forward: true });
}

function watchPointer() {
  if (!FIXED_SIZE || pointerTimer) return;
  pointerTimer = setInterval(() => {
    if (!win || win.isDestroyed() || expanded || dragPlacement) return;
    const config = currentConfig();
    const tab = placement.tabRect(config.edge, win.getBounds(), placement.collapsedSize(config));
    passPointerThrough(!placement.contains(tab, screen.getCursorScreenPoint()));
  }, POINTER_POLL_MS);
  if (pointerTimer.unref) pointerTimer.unref();
}

function setExpanded(next) {
  if (expanded === next || !win) return;
  expanded = next;
  if (FIXED_SIZE) passPointerThrough(!next);
  else applyBounds();
}

function createTray() {
  // Not every desktop exposes a status area (and some need an AppIndicator
  // extension). The tab is the product; the tray is a convenience.
  try {
    let icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
    // The menu bar draws images at their point size; 32px would be oversized.
    if (process.platform === 'darwin' && !icon.isEmpty()) icon = icon.resize({ height: 18 });
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
      {
        label: 'Show tab (reset position)',
        click: () => {
          // A tab dragged onto a display that has since been unplugged would
          // otherwise stay lost, so this really does reset where it sits.
          settings.save({ display: 'primary', offset: 0 });
          if (!win || win.isDestroyed()) createWindow();
          else {
            sendConfig();
            win.showInactive();
            applyBounds();
          }
        },
      },
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
          recreateWindow();
          refreshTrayMenu();
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

  ipcMain.on('sup:drag-start', () => {
    clearTimeout(collapseTimer);
    dragPlacement = {};
    setExpanded(false);
    // The drag's own pointer events must keep arriving until it is dropped.
    passPointerThrough(false);
  });

  ipcMain.on('sup:drag-move', (_e, point) => {
    if (!dragPlacement || !point) return;
    const next = placementAt(point);
    const edgeChanged = next.edge !== currentConfig().edge;
    dragPlacement = next;
    applyBounds();
    // The tab rotates when it moves to an edge with the other orientation.
    if (edgeChanged) sendConfig();
  });

  ipcMain.on('sup:drag-end', (_e, point) => {
    if (!dragPlacement) return;
    const dropped = point ? placementAt(point) : dragPlacement;
    dragPlacement = null;
    passPointerThrough(!expanded);
    if (dropped.edge) settings.save(dropped);
    applyBounds();
    sendConfig();
    refreshTrayMenu();
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
  app.whenReady().then(startDebugLog);
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
    watchHealth();
    poller.start();

    screen.on('display-metrics-changed', applyBounds);
    screen.on('display-added', applyBounds);
    screen.on('display-removed', applyBounds);
  });

  app.on('before-quit', () => poller && poller.stop());
}

main();
