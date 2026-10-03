'use strict';
// Read-only access to the game folder, the same for every way of getting at it:
//   - a directory handle from the browser's folder picker (File System Access API),
//   - the file list of an <input type="file" webkitdirectory> (browsers without the picker),
//   - the desktop app's main process (Electron IPC).
// Paths are '/'-separated, relative to the game folder and case-insensitive, the way
// OpenXcom itself treats them (rulesets routinely get the case of file names wrong).
(function () {
  window.XS = window.XS || {};

  const split = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const join = (...parts) => parts.flatMap(split).join('/');

  // --- backends: list(realParts) -> [{name, dir}], file(realParts) -> {size, mtime, bytes(), head(n)} ---

  /** FileSystemDirectoryHandle (showDirectoryPicker, or any other source of handles). */
  class HandleBackend {
    constructor(root) {
      this.root = root;
      this.dirs = new Map([['', Promise.resolve(root)]]);
    }

    dir(parts) {
      const key = parts.join('/');
      if (!this.dirs.has(key)) {
        const parent = this.dir(parts.slice(0, -1));
        this.dirs.set(key, parent.then((h) => h.getDirectoryHandle(parts[parts.length - 1])));
      }
      return this.dirs.get(key);
    }

    async list(parts) {
      const out = [];
      for await (const entry of (await this.dir(parts)).values()) {
        out.push({ name: entry.name, dir: entry.kind === 'directory' });
      }
      return out;
    }

    async file(parts) {
      const dir = await this.dir(parts.slice(0, -1));
      const f = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
      return {
        size: f.size,
        mtime: f.lastModified,
        bytes: async () => new Uint8Array(await f.arrayBuffer()),
        head: async (n) => new Uint8Array(await f.slice(0, n).arrayBuffer()),
      };
    }
  }

  /** The File objects of a folder chosen through <input webkitdirectory>. */
  class FileListBackend {
    /** @param {Array<{path: string, file: Blob & {lastModified?: number}}>} entries path inside the chosen folder */
    constructor(entries) {
      this.tree = new Map([['', new Map()]]);
      for (const { path, file } of entries) {
        const parts = split(path);
        for (let i = 0; i < parts.length; i++) {
          const key = parts.slice(0, i).join('/');
          if (!this.tree.has(key)) this.tree.set(key, new Map());
          const last = i === parts.length - 1;
          if (!this.tree.get(key).has(parts[i])) this.tree.get(key).set(parts[i], last ? file : null);
        }
      }
    }

    /** Builds the backend from an input's FileList (drops the chosen folder's own name from the paths). */
    static fromInput(files) {
      return new FileListBackend([...files].map((file) => ({
        path: split(file.webkitRelativePath || file.name).slice(1).join('/') || file.name,
        file,
      })));
    }

    async list(parts) {
      const dir = this.tree.get(parts.join('/'));
      if (!dir) throw new Error('not a directory');
      return [...dir.entries()].map(([name, file]) => ({ name, dir: file === null }));
    }

    async file(parts) {
      const dir = this.tree.get(parts.slice(0, -1).join('/'));
      const f = dir && dir.get(parts[parts.length - 1]);
      if (!f) throw new Error('not a file');
      return {
        size: f.size,
        mtime: f.lastModified || 0,
        bytes: async () => new Uint8Array(await f.arrayBuffer()),
        head: async (n) => new Uint8Array(await f.slice(0, n).arrayBuffer()),
      };
    }
  }

  /** The desktop app: the main process reads the folder named in config.cfg. */
  class IpcBackend {
    constructor(api) { this.api = api; }

    list(parts) { return this.api.fsList(parts.join('/')); }

    async file(parts) {
      const rel = parts.join('/');
      const st = await this.api.fsStat(rel);
      return {
        size: st.size,
        mtime: st.mtime,
        bytes: () => this.api.fsRead(rel, 0),
        head: (n) => this.api.fsRead(rel, n),
      };
    }
  }

  // --- the facade -------------------------------------------------------------

  class GameFS {
    /** @param label what to call this folder in the interface (its path or name) */
    constructor(backend, label) {
      this.backend = backend;
      this.label = label;
      this.listings = new Map(); // lower-cased dir path -> Promise<Map<lower name, {name, dir}> | null>
    }

    /** Directory listing keyed by lower-cased name, or null if `realParts` is not a directory. */
    entries(realParts) {
      const key = realParts.join('/').toLowerCase();
      if (!this.listings.has(key)) {
        this.listings.set(key, this.backend.list(realParts)
          .then((list) => new Map(list.map((e) => [e.name.toLowerCase(), e])))
          .catch(() => null));
      }
      return this.listings.get(key);
    }

    /** Finds the entry whatever the case of the path: {parts: real names, dir} or null. */
    async resolve(p) {
      const real = [];
      let dir = true;
      for (const seg of split(p)) {
        const listing = dir ? await this.entries(real) : null;
        const entry = listing && listing.get(seg.toLowerCase());
        if (!entry) return null;
        real.push(entry.name);
        dir = entry.dir;
      }
      return { parts: real, dir };
    }

    /** Drops the cached listing of a directory so that new files in it are seen. */
    forget(p) { this.listings.delete(split(p).join('/').toLowerCase()); }

    async isDir(p) { const r = await this.resolve(p); return !!r && r.dir; }
    async isFile(p) { const r = await this.resolve(p); return !!r && !r.dir; }

    /** [{name, dir}] of a directory; empty when it does not exist. */
    async ls(p) {
      const r = await this.resolve(p);
      if (!r || !r.dir) return [];
      const listing = await this.entries(r.parts);
      return listing ? [...listing.values()] : [];
    }

    /** {size, mtime, bytes(), head(n)} or null when there is no such file. */
    async file(p) {
      const r = await this.resolve(p);
      if (!r || r.dir) return null;
      try { return await this.backend.file(r.parts); } catch { return null; }
    }

    async bytes(p) {
      const f = await this.file(p);
      if (!f) throw new Error(`File not found: ${p}`);
      return f.bytes();
    }

    async text(p) { return GameFS.decode(await this.bytes(p)); }

    /** The first `n` bytes of a file as text (enough for a save's header). */
    async headText(p, n) {
      const f = await this.file(p);
      if (!f) throw new Error(`File not found: ${p}`);
      return GameFS.decode(await f.head(n));
    }

    static decode(bytes) {
      const text = new TextDecoder('utf-8').decode(bytes);
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    }
  }

  XS.GameFS = GameFS;
  XS.fsBackends = { HandleBackend, FileListBackend, IpcBackend };
  XS.path = { split, join };
})();
