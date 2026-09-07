'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { configHome } = require('./lib/paths');

const DESKTOP_FILE = path.join(configHome(), 'autostart', 'supbar.desktop');

/**
 * Linux desktops read ~/.config/autostart/*.desktop; everywhere else Electron's
 * own login-item API is the right thing.
 */
function isEnabled() {
  if (process.platform === 'linux') return fs.existsSync(DESKTOP_FILE);
  return app.getLoginItemSettings().openAtLogin;
}

function setEnabled(enabled) {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    return;
  }
  if (!enabled) {
    fs.rmSync(DESKTOP_FILE, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(DESKTOP_FILE), { recursive: true });
  fs.writeFileSync(DESKTOP_FILE, desktopEntry());
}

function desktopEntry() {
  // When installed from the .deb this is /usr/bin/sup; when running from
  // a checkout it is the electron binary plus the project path.
  const exec = app.isPackaged ? process.execPath : `${process.execPath} ${app.getAppPath()}`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Sup',
    'Comment=AI coding assistant usage limits on your screen edge',
    `Exec=${exec}`,
    'Icon=sup',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

module.exports = { isEnabled, setEnabled, DESKTOP_FILE };
