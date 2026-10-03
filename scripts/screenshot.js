'use strict';
// Dev helper: starts the app, optionally runs a snippet in the page, saves a screenshot and quits.
//   electron scripts/screenshot.js out.png ["js to run in the renderer"] [width] [height]
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const [out = 'screenshot.png', script = '', width = '1600', height = '950'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.setContentSize(Number(width), Number(height));
  const wc = win.webContents;
  wc.on('console-message', (_ev, level, message, line, source) => {
    console.log(`[renderer:${level}] ${message} (${path.basename(String(source))}:${line})`);
  });
  wc.once('did-finish-load', async () => {
    try {
      for (let i = 0; i < 100; i++) {
        if (await wc.executeJavaScript('!document.querySelector("#app").hidden || !document.querySelector("#splash-error").hidden')) break;
        await sleep(100);
      }
      await sleep(600);
      if (script) console.log('script ->', JSON.stringify(await wc.executeJavaScript(script, true)));
      await sleep(900);
      const img = await wc.capturePage();
      fs.writeFileSync(out, img.toPNG());
      console.log('saved', out, img.getSize());
    } catch (e) {
      console.error('screenshot failed:', e);
    }
    app.quit();
  });
});

require('../src/main/main.js');
