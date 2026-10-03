'use strict';
// Reads OpenXcom saved games (two YAML documents: a short header, then the game state)
// and extracts what matters for the tree: finished and running research, and what each
// base has in stock and built - enough to work out what can be researched right now.
(function () {
  window.XS = window.XS || {};
  const { join } = XS.path;
  const SAVE_RE = /\.a?sav$/i;

  // OpenXcom writes raw control bytes (colour codes inside names and mod versions),
  // which YAML forbids - drop them before parsing.
  const clean = (text) => text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  async function readHeader(fs, file) {
    const text = clean(await fs.headText(file, 8192));
    const end = text.search(/^---\s*$/m);
    return window.jsyaml.load(end >= 0 ? text.slice(0, end) : text, { json: true }) || {};
  }

  /** The save files of a folder with their modification times, newest first (headers not read). */
  async function files(fs, dir) {
    const out = [];
    for (const e of await fs.ls(dir)) {
      if (e.dir || !SAVE_RE.test(e.name)) continue;
      const f = await fs.file(join(dir, e.name));
      if (f) out.push({ file: e.name, mtime: f.mtime });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** Saves in `dir`, newest first. */
  async function list(fs, dir) {
    return Promise.all((await files(fs, dir)).map(async ({ file, mtime }) => {
      let head = {};
      try { head = await readHeader(fs, join(dir, file)); } catch { /* unreadable header - still list the file */ }
      return {
        file,
        name: head.name != null ? String(head.name) : file,
        mtime,
        time: head.time && typeof head.time === 'object' ? head.time : null,
        battle: head.mission != null,
        auto: /\.asav$/i.test(file),
      };
    }));
  }

  /** When the newest save in `dir` was written; 0 if there are none. */
  async function newest(fs, dir) {
    const list = await files(fs, dir);
    return list.length ? list[0].mtime : 0;
  }

  async function load(fs, dir, name) {
    if (!SAVE_RE.test(name) || /[\\/]/.test(name)) throw new Error(`Not a save file: ${name}`);
    const f = await fs.file(join(dir, name));
    if (!f) throw new Error(`File not found: ${name}`);
    const docs = window.jsyaml.loadAll(clean(XS.GameFS.decode(await f.bytes())), null, { json: true });
    const head = docs[0] || {};
    const game = docs[1] || {};

    const research = [];
    const bases = [];
    for (const b of Array.isArray(game.bases) ? game.bases : []) {
      if (!b || typeof b !== 'object') continue;
      const baseName = b.name != null ? String(b.name) : '';
      for (const r of Array.isArray(b.research) ? b.research : []) {
        if (!r || r.project == null) continue;
        research.push({
          id: String(r.project), base: baseName,
          assigned: Number(r.assigned) || 0, spent: Number(r.spent) || 0, cost: Number(r.cost) || 0,
        });
      }
      const items = {};
      if (b.items && typeof b.items === 'object') {
        for (const [k, v] of Object.entries(b.items)) if (Number(v) > 0) items[k] = Number(v);
      }
      // facilities still under construction carry a buildTime and provide nothing yet
      const facilities = (Array.isArray(b.facilities) ? b.facilities : [])
        .filter((x) => x && x.type != null && !(Number(x.buildTime) > 0))
        .map((x) => String(x.type));
      bases.push({ name: baseName, items, facilities: [...new Set(facilities)] });
    }

    return {
      file: name,
      name: head.name != null ? String(head.name) : name,
      time: head.time && typeof head.time === 'object' ? head.time : null,
      mtime: f.mtime,
      discovered: (Array.isArray(game.discovered) ? game.discovered : []).map(String),
      research,
      bases,
    };
  }

  XS.saves = { list, load, newest };
})();
