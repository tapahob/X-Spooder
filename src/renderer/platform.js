'use strict';
// What differs between the desktop app and the web page: where the settings live and how
// the game folder is reached. Everything else (parsing, layout, drawing) is shared.
//   desktop - settings in config.cfg next to the program, files read by the main process;
//   web     - settings in localStorage, the folder picked by the visitor and read in place
//             by the browser (nothing is uploaded), its handle remembered in IndexedDB.
(function () {
  window.XS = window.XS || {};
  const { GameFS } = XS;
  const { HandleBackend, FileListBackend, IpcBackend } = XS.fsBackends;
  const DEFAULTS = { mod: null, language: 'auto', useSubmods: true };

  // --- desktop (Electron) -------------------------------------------------------

  function desktop(api) {
    // The main process reads either the configured folder or the one just picked.
    const backend = (root) => new IpcBackend({
      fsList: (rel) => api.fsList(root, rel),
      fsStat: (rel) => api.fsStat(root, rel),
      fsRead: (rel, n) => api.fsRead(root, rel, n),
    });
    return {
      desktop: true,
      getConfig: async () => ({ ...DEFAULTS, ...(await api.getConfig()) }),
      setConfig: (patch) => api.setConfig(patch),
      async openGame() {
        const { gameDir } = await api.getConfig();
        if (!gameDir) return null;
        return { fs: new GameFS(backend('config'), gameDir) };
      },
      async pickGame() {
        const dir = await api.chooseGameDir();
        return dir ? new GameFS(backend('picked'), dir) : null;
      },
      // the picked folder turned out to be a game: make it the configured one
      accept: (fs) => api.setConfig({ gameDir: fs.label }),
    };
  }

  // --- web ------------------------------------------------------------------------

  // A tiny key-value store for the folder handle (handles cannot go into localStorage).
  function idb(mode, run) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('x-spooder', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', mode);
        const req = run(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  function web() {
    const hasPicker = typeof window.showDirectoryPicker === 'function';
    const readConfig = () => {
      try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('xs.config') || '{}') }; } catch { return { ...DEFAULTS }; }
    };
    const fromHandle = (handle) => {
      const fs = new GameFS(new HandleBackend(handle), handle.name);
      fs.handle = handle;
      return fs;
    };

    /** Folder chooser for browsers without showDirectoryPicker: an <input webkitdirectory>. */
    function pickWithInput() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.addEventListener('change', () => {
          if (!input.files.length) { resolve(null); return; }
          const name = (input.files[0].webkitRelativePath || '').split('/')[0] || 'game';
          resolve(new GameFS(FileListBackend.fromInput(input.files), name));
        });
        input.addEventListener('cancel', () => resolve(null));
        input.click();
      });
    }

    return {
      desktop: false,
      getConfig: async () => readConfig(),
      async setConfig(patch) {
        const next = { ...readConfig(), ...patch };
        try { localStorage.setItem('xs.config', JSON.stringify(next)); } catch { /* private mode */ }
        return next;
      },
      /**
       * The folder used last time, if the browser still lets us read it. When it wants the
       * visitor to confirm again, returns {resume, label}: call resume() from a click.
       */
      async openGame() {
        if (!hasPicker) return null;
        let handle = null;
        try { handle = await idb('readonly', (kv) => kv.get('gameDir')); } catch { /* no storage */ }
        if (!handle) return null;
        if (await handle.queryPermission({ mode: 'read' }) === 'granted') return { fs: fromHandle(handle) };
        return {
          label: handle.name,
          resume: async () => (await handle.requestPermission({ mode: 'read' }) === 'granted' ? fromHandle(handle) : null),
        };
      },
      async pickGame() {
        if (!hasPicker) return pickWithInput();
        try {
          return fromHandle(await window.showDirectoryPicker({ id: 'x-spooder-game', mode: 'read' }));
        } catch (e) {
          if (e && e.name === 'AbortError') return null;
          throw e;
        }
      },
      async accept(fs) {
        if (!fs.handle) return;
        try { await idb('readwrite', (kv) => kv.put(fs.handle, 'gameDir')); } catch { /* not remembered, that's all */ }
      },
    };
  }

  XS.platform = window.api ? desktop(window.api) : web();
})();
