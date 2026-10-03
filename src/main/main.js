'use strict';
// Desktop shell. All the work (parsing rulesets and saves, layout, drawing) happens in the page,
// which is the same code that is published as a web site; this process only keeps the settings
// file and hands the page read-only access to the game folder.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// --- settings ---------------------------------------------------------------

// config.cfg (YAML) sits in the program's own folder: the project root when run from source,
// next to the exe when packaged. It is created once the user has pointed at the game folder.
const configDir = () => (app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..', '..'));
const configFile = () => path.join(configDir(), 'config.cfg');
const CONFIG_KEYS = ['gameDir', 'mod', 'language', 'useSubmods'];

function readConfig() {
  let saved = null;
  try { saved = yaml.load(fs.readFileSync(configFile(), 'utf8')); } catch { /* no config yet */ }
  return saved && typeof saved === 'object' ? saved : {};
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  const text = '# X-Spooder settings. gameDir is the game folder (with the exe and "user" inside),\n'
    + '# mod is the id of the installed mod whose tree is shown (chosen automatically if absent).\n'
    + yaml.dump(next, { lineWidth: -1 });
  fs.writeFileSync(configFile(), text);
  return next;
}

// --- game folder access -----------------------------------------------------

// The page may read two folders: the configured one and the one just picked in the dialog
// (which becomes the configured one once the page has found a game in it).
let picked = null;

function rootDir(which) {
  const dir = which === 'picked' ? picked : readConfig().gameDir;
  if (!dir) throw new Error('no game folder');
  return path.resolve(String(dir));
}

/** Resolves a path inside one of the two roots; never anything outside them. */
function inside(which, rel) {
  const root = rootDir(which);
  const full = path.resolve(root, ...String(rel || '').split('/').filter(Boolean));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('outside the game folder');
  return full;
}

ipcMain.handle('fs:list', async (_e, which, rel) => {
  const entries = await fs.promises.readdir(inside(which, rel), { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
});

ipcMain.handle('fs:stat', async (_e, which, rel) => {
  const st = await fs.promises.stat(inside(which, rel));
  return { size: st.size, mtime: st.mtimeMs };
});

// bytes of a file; `length` > 0 reads only that many from the start
ipcMain.handle('fs:read', async (_e, which, rel, length) => {
  const file = inside(which, rel);
  if (!(length > 0)) return fs.promises.readFile(file);
  const handle = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
});

ipcMain.handle('config:get', () => readConfig());

ipcMain.handle('config:set', (_e, patch) => {
  const allowed = {};
  for (const k of CONFIG_KEYS) if (patch && k in patch) allowed[k] = patch[k];
  // the game folder can only become the one the user picked in the dialog
  if ('gameDir' in allowed && allowed.gameDir !== picked) delete allowed.gameDir;
  return writeConfig(allowed);
});

// Lets the user pick the game folder; returns its path (or null when cancelled).
ipcMain.handle('dialog:gameDir', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const current = readConfig().gameDir;
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose your X-COM game folder (the one with the game exe and the "user" folder)',
    defaultPath: current && fs.existsSync(current) ? current : undefined,
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  picked = res.filePaths[0];
  return picked;
});

// --- window -----------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: '#12141a',
    title: 'X-Spooder',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if (input.key === 'F5') win.webContents.reload();
  });
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
