'use strict';
// Runs the page's own modules (src/renderer) under Node, for the command-line helpers:
// the same loader, saves reader, model and layout code as in the app, fed from the disk.
const fs = require('fs');
const path = require('path');

global.window = global;
global.document = { documentElement: {}, createElement: () => ({}) };
global.jsyaml = require('js-yaml');
global.dagre = require('@dagrejs/dagre');
global.IntersectionObserver = class { observe() {} unobserve() {} };
global.Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} };

for (const name of ['i18n', 'gamefs', 'loader', 'saves', 'model', 'graph']) {
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', `${name}.js`), 'utf8'));
}

/** GameFS backend over a folder on disk. */
class NodeBackend {
  constructor(root) { this.root = root; }

  async list(parts) {
    const entries = await fs.promises.readdir(path.join(this.root, ...parts), { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
  }

  async file(parts) {
    const file = path.join(this.root, ...parts);
    const st = await fs.promises.stat(file);
    return {
      size: st.size,
      mtime: st.mtimeMs,
      bytes: async () => new Uint8Array(await fs.promises.readFile(file)),
      head: async (n) => new Uint8Array((await fs.promises.readFile(file)).subarray(0, n)),
    };
  }
}

const XS = global.XS;

/** Opens a game folder the way the app does. */
function openGame(dir) {
  return new XS.GameFS(new NodeBackend(path.resolve(dir)), path.resolve(dir));
}

module.exports = { XS, openGame };
