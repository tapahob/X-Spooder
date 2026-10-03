'use strict';
// Smoke test of the web version, run through Electron's Chromium with no desktop API:
//   electron scripts/web-test.js [gameDir] [modId] [screenshot.png]
// The folder picker cannot be driven from a script, so the test copies the part of the game
// the page will read into the browser's private file system (OPFS), stores that directory
// handle where the page keeps "the folder used last time" and reloads - from there on it is
// the same code path as a visitor returning to the site.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { XS, openGame } = require('./page-env');

const [gameDir = 'C:/Games/X-Piratez HD', modId = 'piratez', shot = ''] = process.argv.slice(2);
const site = path.join(__dirname, '..', 'src', 'renderer');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The files of the game the page needs for one mod: rules, texts, options, saves, pictures. */
async function neededFiles() {
  const game = openGame(gameDir);
  const layout = await XS.loader.resolveLayout(game, modId);
  const data = await XS.loader.build(game, layout);
  const out = new Set();
  const add = async (rel) => { const r = await game.resolve(rel); if (r && !r.dir) out.add(r.parts.join('/')); };
  const addDir = async (rel, filter) => { for (const e of await game.ls(rel)) if (!e.dir && filter(e.name)) await add(`${rel}/${e.name}`); };

  for (const base of ['standard', `${layout.userDir}/mods`]) {
    for (const e of await game.ls(base)) if (e.dir) await add(`${base}/${e.name}/metadata.yml`);
  }
  for (const l of layout.layers) for (const f of l.rulesets) await add(f);
  for (const d of layout.langDirs) await addDir(d, (n) => /^(en-US|ru)\.yml$/i.test(n));
  await add(`${layout.userDir}/options.cfg`);
  await addDir(layout.saveDir, (n) => /\.a?sav$/i.test(n));
  for (const mod of await XS.loader.listMods(game)) {
    for (const f of (await XS.loader.resolveLayout(game, mod.id, { useSubmods: false })).layers.flatMap((l) => l.rulesets)) await add(f);
  }
  const dirs = Object.fromEntries(layout.layers.map((l) => [l.key, l.dir]));
  for (const t of Object.values(data.topics)) if (t.icon && t.icon.f) await add(`${dirs[t.icon.l]}/${t.icon.f}`);
  for (const f of ['UNITS/BIGOBS.PCK', 'UNITS/BIGOBS.TAB', 'GEODATA/PALETTES.DAT']) if (layout.ufoDir) await add(`${layout.ufoDir}/${f}`);
  return [...out];
}

// Runs in the page: copy the listed files into OPFS and remember the folder like the site does.
const SEED = `(async () => {
  const list = await (await fetch('/__game/list')).json();
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('game', { create: true });
  const dirs = new Map([['', root]]);
  const dirOf = async (parts) => {
    const key = parts.join('/');
    if (!dirs.has(key)) dirs.set(key, await (await dirOf(parts.slice(0, -1))).getDirectoryHandle(parts[parts.length - 1], { create: true }));
    return dirs.get(key);
  };
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < list.length) {
      const rel = list[next++];
      const parts = rel.split('/');
      const dir = await dirOf(parts.slice(0, -1));
      const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(await (await fetch('/__game/file?p=' + encodeURIComponent(rel))).blob());
      await w.close();
    }
  }));
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('x-spooder', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(root, 'gameDir');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    };
  });
  return list.length;
})()`;

const REPORT = `(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const imgs = [...document.querySelectorAll('img')];
  return {
    desktopApi: typeof window.api,
    mod: document.querySelector('#sel-mod')?.selectedOptions[0]?.textContent,
    topics: document.querySelector('#mod-info div')?.textContent,
    lang: document.querySelector('#sel-lang')?.selectedOptions[0]?.textContent,
    save: document.querySelector('.save-stats')?.textContent,
    roots: [...document.querySelectorAll('.node.focus')].map((n) => n.querySelector('.title').textContent + ' ' + [...n.classList].filter((c) => c.startsWith('p-'))),
    images: imgs.filter((i) => i.naturalWidth > 0).length + '/' + imgs.length,
    splash: document.querySelector('#splash').hidden ? '' : document.querySelector('#splash-text').textContent + ' | ' + document.querySelector('#splash-error').textContent,
  };
})()`;

app.whenReady().then(async () => {
  const files = await neededFiles();
  const allowed = new Set(files);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file;
    // The site itself may not make network requests (its CSP forbids them), so the test files are
    // copied into the browser from a separate blank page of the same origin.
    if (url.pathname === '/__seed.html') { res.setHeader('content-type', MIME['.html']); res.end('<!doctype html><title>seed</title>'); return; }
    if (url.pathname === '/__game/list') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(files)); return; }
    if (url.pathname === '/__game/file') {
      const rel = url.searchParams.get('p');
      if (!allowed.has(rel)) { res.statusCode = 404; res.end(); return; }
      file = path.join(gameDir, rel);
    } else {
      file = path.join(site, path.normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
      if (!file.startsWith(site)) { res.statusCode = 403; res.end(); return; }
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
      res.end(buf);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const win = new BrowserWindow({ width: 1600, height: 950, webPreferences: { partition: `webtest-${Date.now()}` } });
  const wc = win.webContents;
  wc.on('console-message', (_e, level, message) => { if (level >= 2) console.log('[page]', message); });
  try {
    await win.loadURL(`${origin}/index.html`);
    await sleep(800);
    console.log('first visit:', await wc.executeJavaScript(`document.querySelector('#splash-text').textContent + ' | ' + document.querySelector('#splash-hint').textContent + ' | button: ' + document.querySelector('#splash-choose').textContent`));
    await win.loadURL(`${origin}/__seed.html`);
    const started = Date.now();
    console.log('seeded files:', await wc.executeJavaScript(SEED, true), `in ${Date.now() - started} ms`);
    await win.loadURL(`${origin}/index.html`);
    for (let i = 0; i < 300; i++) {
      if (await wc.executeJavaScript('!document.querySelector("#app").hidden || !document.querySelector("#splash-error").hidden || !document.querySelector("#splash-choose").hidden')) break;
      await sleep(200);
    }
    console.log('returning visit:', JSON.stringify(await wc.executeJavaScript(REPORT, true), null, 1));
    if (shot) fs.writeFileSync(shot, (await wc.capturePage()).toPNG());
  } catch (e) {
    console.error('web test failed:', e);
  }
  server.close();
  app.quit();
});
