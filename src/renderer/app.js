'use strict';
// Glue: loads the data, wires the toolbar, the search list, the tree and the details panel.
(function () {
  const { t, en } = XS.i18n;
  const $ = (sel) => document.querySelector(sel);
  const RESULT_LIMIT = 250;
  const DEPTHS = [0, 1, 2, 3, 4, 6, 99];
  const GENERATIONS = [0, 1, 2, 3, 4, 5, 99]; // 99 = unlimited
  const TOGGLES = ['dep', 'unlock', 'free', 'disable', 'item'];
  const SWITCHES = [...TOGGLES, 'group', 'all']; // toolbar switches: edge kinds, section grouping, all entry points
  const STATES = ['done', 'avail', 'active', 'disabled'];
  const START = '@start'; // pseudo-location: the tree grown from the starting research projects

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`xs.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(`xs.${key}`, JSON.stringify(value)); } catch { /* ignore */ } },
  };

  const platform = XS.platform;
  const { loader } = XS;

  let fs = null;        // XS.GameFS: the game folder in use
  let layout = null;    // which folders make up the mod on screen
  let stringKeys = [];  // the text keys that mod needs
  let config = {};      // {mod, language, useSubmods}
  let mods = [];        // master mods installed in the game folder: [{id, name, version, saveDir}]
  let modId = null;     // the mod on screen
  let allRoots = false; // the start view also grows from the entry points that wait for an item or an event
  let model, graph, details, languages;
  let lang;        // language in effect
  let langSetting; // what the user chose: a language code, or 'auto' = same as the game
  let autoLang;    // the language 'auto' resolves to (from the game's options.cfg)
  let current = null; // topic id or START
  let saves = [];     // saved games of the mod, newest first
  let saveError = null;
  const history = { back: [], fwd: [] };

  // --- startup ----------------------------------------------------------------

  let splashAction = null;
  function showSplash({ text, hint = '', error = '', button = '', busy = false, onClick = null }) {
    $('#splash').hidden = false;
    document.querySelector('.spinner').hidden = !busy;
    $('#splash-text').textContent = text;
    $('#splash-hint').textContent = hint;
    $('#splash-hint').hidden = !hint;
    $('#splash-error').textContent = error;
    $('#splash-error').hidden = !error;
    $('#splash-choose').textContent = button;
    $('#splash-choose').hidden = !button;
    splashAction = onClick;
  }
  $('#splash-choose').addEventListener('click', () => { if (splashAction) splashAction(); });

  /** A path inside the game folder as the user knows it. */
  const where = (rel) => {
    const sep = fs.label.includes(String.fromCharCode(92)) ? String.fromCharCode(92) : '/';
    return [fs.label, ...rel.split('/')].join(sep);
  };

  const firstLine = (e) => String(e && e.message ? e.message : e).split(/\r?\n/)[0];

  /** Reopens the folder used last time, or asks for one. */
  async function boot() {
    showSplash({ text: t('loading'), busy: true });
    config = await platform.getConfig();
    let opened = null;
    try { opened = await platform.openGame(); } catch { /* treated as "no folder yet" */ }
    if (opened && opened.fs) { loadGame(opened.fs); return; }
    if (opened && opened.resume) {
      // the browser remembers the folder but wants the visitor to allow reading it again
      showSplash({
        text: en('resumeGame', opened.label), hint: en('askGameDirHintWeb'), button: en('resumeButton'),
        onClick: async () => {
          const again = await opened.resume().catch(() => null);
          if (again) loadGame(again); else askGameDir();
        },
      });
      return;
    }
    askGameDir();
    if (platform.desktop) chooseDir(); // nothing configured yet - open the folder dialog straight away
  }

  function askGameDir(error) {
    $('#app').hidden = true;
    showSplash({
      text: en('askGameDir'), hint: en(platform.desktop ? 'askGameDirHint' : 'askGameDirHintWeb'),
      error, button: en('chooseDir'), onClick: chooseDir,
    });
  }

  /** Lets the user pick the game folder; a folder without the game is refused and nothing changes. */
  async function chooseDir() {
    let picked = null;
    try { picked = await platform.pickGame(); } catch (e) { refuse(firstLine(e)); return; }
    if (!picked) return;
    try { await loader.listMods(picked); } catch (e) { refuse(firstLine(e)); return; }
    await platform.accept(picked);
    loadGame(picked);
  }

  function refuse(message) {
    if ($('#app').hidden) askGameDir(message);
    else window.alert(message);
  }

  /** Opens a game folder: lists its mods and shows the configured one, or the most recently played. */
  async function loadGame(nextFs) {
    showSplash({ text: t('loading'), busy: true });
    let list;
    try { list = await loader.listMods(nextFs); } catch (e) { askGameDir(firstLine(e)); return; }
    fs = nextFs;
    mods = list;
    const wanted = mods.some((m) => m.id === config.mod) ? config.mod : await defaultMod();
    try {
      await loadMod(wanted);
    } catch (e) {
      $('#app').hidden = true;
      showSplash({ text: t('loadError'), error: `${firstLine(e)}\n\n${t('modDir')}: ${fs.label}`, button: t('chooseDir'), onClick: chooseDir });
    }
  }

  /** The mod with the newest saved game; the first installed one when nothing has been saved yet. */
  async function defaultMod() {
    let best = mods[0], bestTime = 0;
    for (const m of mods) {
      const time = await XS.saves.newest(fs, m.saveDir);
      if (time > bestTime) { best = m; bestTime = time; }
    }
    return best.id;
  }

  /**
   * Picks the language to show: the explicit setting, or the one from the game's options.cfg
   * (falling back to the browser's language when the game is set to "auto" too).
   */
  async function resolveLanguage(setting, forLayout, available) {
    const match = (code) => {
      if (!code) return null;
      const want = String(code).toLowerCase();
      return available.find((l) => l.toLowerCase() === want)
        || available.find((l) => l.toLowerCase().split('-')[0] === want.split('-')[0])
        || null;
    };
    const fallback = available.includes('en-US') ? 'en-US' : available[0];
    const auto = match(await loader.gameLanguage(fs, forLayout)) || match(navigator.language) || fallback;
    return { lang: (setting !== 'auto' && match(setting)) || auto, auto };
  }

  /** Parses one mod of the open game folder and puts it on screen. Throws without touching the screen. */
  let loadTicket = 0;
  async function loadMod(id) {
    const ticket = ++loadTicket;
    const started = performance.now();
    const nextLayout = await loader.resolveLayout(fs, id, { useSubmods: config.useSubmods });
    const dataset = await loader.build(fs, nextLayout, (p) => {
      if (p.stage === 'rules') $('#splash-text').textContent = `${t('loading')} ${p.done + 1}/${p.total}`;
    });
    if (!Object.keys(dataset.topics).length) throw new Error(t('modEmpty', dataset.meta.name));
    const available = await loader.availableLanguages(fs, nextLayout);
    const picked = await resolveLanguage(config.language, nextLayout, available);
    const texts = await loader.loadStrings(fs, nextLayout, picked.lang, dataset.stringKeys);

    if (ticket !== loadTicket) return; // a newer request has taken over

    // everything parsed - switch over
    layout = nextLayout;
    modId = id;
    stringKeys = dataset.stringKeys;
    languages = available;
    lang = picked.lang;
    autoLang = picked.auto;
    langSetting = config.language;
    if (XS.images) XS.images.dispose();
    XS.images = new XS.Images(fs, layout);
    XS.i18n.setLanguage(lang);
    model = new XS.Model(dataset, texts.strings);
    model.stats = { ms: Math.round(performance.now() - started), translated: texts.translated, total: texts.total };
    const progress = await readSaves(null);
    if (ticket !== loadTicket) return;
    model.setProgress(store.get('nosave', false) ? null : progress);
    // Unless the user chose otherwise for this mod: when the free starting projects lead to less
    // than half of the research, the tree also starts from the item- and event-driven entry points.
    const choice = store.get(`all.${modId}`, null);
    allRoots = choice != null ? !!choice : model.startCoverage() < 0.5;

    $('#app').hidden = false;
    $('#splash').hidden = true;
    setupOnce();
    renderChrome();
    renderSaveInfo();
    ensureGraph();
    graph.model = model;
    details.model = model;
    syncToolbar();
    history.back.length = 0;
    history.fwd.length = 0;
    current = null;
    open(START, { record: false });
    renderResults();
  }

  /** Switches the mod (or re-reads it) while the app is up; on failure the old one stays. */
  async function switchMod(id) {
    showSplash({ text: t('loading'), busy: true });
    try {
      await loadMod(id);
    } catch (e) {
      $('#splash').hidden = true;
      renderChrome(); // puts the selectors back to what is actually shown
      syncToolbar();
      window.alert(firstLine(e));
    }
  }

  /** Lists the mod's saves and reads one of them (null = the newest); returns its progress or null. */
  async function readSaves(file) {
    fs.forget(layout.saveDir); // saves appear and change while the game is played
    saves = await XS.saves.list(fs, layout.saveDir);
    saveError = null;
    const pick = file || (saves[0] && saves[0].file);
    if (!pick) return null;
    try {
      return await XS.saves.load(fs, layout.saveDir, pick);
    } catch (e) {
      saveError = firstLine(e);
      return null;
    }
  }

  function ensureGraph() {
    if (graph) return;
    graph = new XS.Graph(model, {
      viewport: $('#viewport'), world: $('#world'), nodes: $('#nodes'), base: $('#canvas-base'), pinned: $('#canvas-pinned'), hot: $('#canvas-hot'), labels: $('#canvas-labels'),
    }, {
      onSelect: (key) => details.show(key),
      onOpen: (id) => open(id),
      onRebuild: ({ truncated, topicCount }) => {
        const n = $('#notice');
        n.hidden = !truncated;
        n.textContent = truncated ? t('truncated', topicCount) : '';
      },
      onZoom: (k) => { $('#zoom-level').textContent = `${Math.round(k * 100)}%`; },
    });
    graph.up = store.get('up', 2);
    graph.down = store.get('down', 1);
    graph.maxGen = store.get('gens', 99);
    const off = new Set(store.get('off', []));
    graph.kinds = new Set(XS.KINDS.filter((k) => !off.has(k)));
    graph.showItems = !off.has('item');
    graph.groupSections = !off.has('group');
    details = new XS.Details(model, $('#details'), { onOpen: (id) => open(id) });
  }

  // --- navigation -------------------------------------------------------------

  function open(loc, { record = true } = {}) {
    const roots = loc === START ? [...model.startTopics(), ...(allRoots ? model.entryTopics() : [])] : null;
    if (roots && !roots.length) loc = model.defaultFocus();
    else if (!roots && !model.topics[loc]) return;
    if (record && current && current !== loc) {
      history.back.push(current);
      history.fwd.length = 0;
    }
    current = loc;
    if (loc === START) {
      graph.setFocus(roots);
      details.show(null);
    } else {
      graph.setFocus(loc);
      details.show(`t:${loc}`);
    }
    syncHistory();
    markActiveResult();
  }

  function go(dir) {
    const from = dir < 0 ? history.back : history.fwd;
    const to = dir < 0 ? history.fwd : history.back;
    if (!from.length) return;
    to.push(current);
    open(from.pop(), { record: false });
  }

  function syncHistory() {
    $('#btn-back').disabled = !history.back.length;
    $('#btn-fwd').disabled = !history.fwd.length;
    $('#btn-home').classList.toggle('on', current === START);
  }

  // --- toolbar ----------------------------------------------------------------

  function renderChrome() {
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    $('#btn-back').title = t('back');
    $('#btn-fwd').title = t('forward');
    $('#btn-home').title = t('home');
    $('#btn-settings').title = `${t('settings')}\n${fs.label}`;
    $('#search').placeholder = t('search');

    for (const sel of [$('#sel-up'), $('#sel-down')]) {
      sel.replaceChildren(...DEPTHS.map((d) => new Option(d === 99 ? t('depthAll') : String(d), String(d))));
    }

    $('#sel-gen').replaceChildren(...GENERATIONS.map((g) => new Option(g === 99 ? t('gensAll') : String(g), String(g))));
    $('#gen-limit').title = t('gensHint');

    $('#sel-lang').replaceChildren(
      new Option(`${t('langAuto')}: ${XS.i18n.langName(autoLang)}`, 'auto'),
      ...languages.map((code) => new Option(XS.i18n.langName(code), code)),
    );
    $('#sel-lang').value = langSetting === 'auto' || !languages.includes(langSetting) ? 'auto' : langSetting;
    $('#sel-lang').title = t('language');

    const toggles = $('#kind-toggles');
    toggles.replaceChildren(...SWITCHES.map((kind) => {
      const label = document.createElement('label');
      label.className = `toggle k-${kind}`;
      label.title = t(`legend_${kind}`);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.kind = kind;
      const swatch = document.createElement('i');
      const text = document.createElement('span');
      text.textContent = t(`kind_${kind}`);
      label.append(box, swatch, text);
      return label;
    }));

    $('#legend').replaceChildren(...TOGGLES.map((kind) => {
      const row = document.createElement('div');
      row.className = `k-${kind}`;
      row.innerHTML = '<svg width="34" height="8"><path d="M0,4H34" class="edge"/></svg>';
      row.querySelector('path').classList.add(`k-${kind}`);
      const text = document.createElement('span');
      text.textContent = `${t(`kind_${kind}`)} — ${t(`legend_${kind}`)}`;
      row.appendChild(text);
      return row;
    }), ...STATES.map((state) => {
      const row = document.createElement('div');
      row.className = 'state';
      const swatch = document.createElement('i');
      swatch.className = `swatch p-${state}`;
      const text = document.createElement('span');
      text.textContent = t(`state_${state}`);
      row.append(swatch, text);
      return row;
    }), Object.assign(document.createElement('div'), { className: 'hint', textContent: t('hintNav') }));

    const stateSel = $('#sel-state');
    const keep = stateSel.value;
    stateSel.replaceChildren(
      new Option(t('stateAll'), ''),
      ...[...STATES, 'todo'].map((s) => new Option(t(`state_${s}`), s)),
    );
    stateSel.value = keep;

    const sections = model.sections();
    $('#sel-section').replaceChildren(
      new Option(t('allSections'), ''),
      ...sections.map((s) => new Option(`${s.id === '-' ? t('noSection') : model.name(s.id)} (${s.n})`, s.id)),
    );

    const meta = model.data.meta;
    const info = $('#mod-info');
    info.replaceChildren();
    // the mod is chosen from the ones installed in the game folder
    const title = document.createElement('select');
    title.id = 'sel-mod';
    title.className = 'mod-name';
    title.title = t('modSelect');
    title.replaceChildren(...mods.map((m) => new Option(`${m.name} ${m.version}`.trim(), m.id)));
    title.value = modId;
    const sub = document.createElement('div');
    const pct = model.stats.total ? Math.round((model.stats.translated / model.stats.total) * 100) : 100;
    sub.textContent = `${t('topicsCount', model.ids.length)} · ${t('translatedCount', pct)}`;
    const dir = document.createElement('div');
    dir.className = 'path';
    dir.textContent = where(meta.modDir);
    dir.title = dir.textContent;
    info.append(title, sub, dir);
    const sm = document.createElement('label');
    sm.className = 'submods';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'chk-submods';
    box.checked = !!config.useSubmods;
    sm.append(box, document.createTextNode(` ${t('submods')}${meta.submods.length ? ` (${meta.submods.length})` : ''}`));
    sm.title = meta.submods.join('\n');
    info.appendChild(sm);
  }

  // --- saved game ---------------------------------------------------------------

  function saveLabel(s) {
    const pad = (n) => String(n).padStart(2, '0');
    const date = s.time ? ` · ${pad(s.time.day)}.${pad(s.time.month)}.${s.time.year}` : '';
    return `${s.name}${date}${s.battle ? ` · ${t('saveBattle')}` : ''}`;
  }

  function renderSaveInfo() {
    const box = $('#save-info');
    box.replaceChildren();
    const p = model.progress;
    $('#sel-state').hidden = !p;
    $('#gen-limit').hidden = !p; // generations are counted from the save's available research
    $('#legend').classList.toggle('has-progress', !!p);

    const head = document.createElement('div');
    head.className = 'save-head';
    const sel = document.createElement('select');
    sel.id = 'sel-save';
    sel.title = t('save');
    sel.append(...saves.map((s) => new Option(saveLabel(s), s.file)), new Option(t('saveNone'), ''));
    sel.value = p ? p.save.file : '';
    const refresh = document.createElement('button');
    refresh.id = 'btn-save-refresh';
    refresh.className = 'icon-btn';
    refresh.title = t('saveRefresh');
    refresh.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    head.append(sel, refresh);
    box.appendChild(head);

    const line = document.createElement('div');
    line.className = 'save-stats';
    if (p) {
      line.textContent = t('saveStats', p.done.size, p.available.size, p.active.size);
    } else if (!saves.length) {
      line.textContent = t('saveMissing');
    } else if (saveError) {
      line.textContent = `${t('saveError')}: ${saveError}`;
    }
    if (line.textContent) box.appendChild(line);

    // when the file was written and where it lives - a stale save from another install is easy to miss
    if (p) {
      const place = document.createElement('div');
      place.className = 'path';
      const written = new Date(p.save.mtime).toLocaleString(XS.i18n.locale(), { dateStyle: 'short', timeStyle: 'short' });
      place.textContent = `${written} · ${where(layout.saveDir)}`;
      place.title = `${p.save.file}\n${place.textContent}`;
      box.appendChild(place);
    }
  }

  /** Loads a save (null = the newest one, '' = none) and repaints everything that shows progress. */
  async function useSave(file) {
    store.set('nosave', file === '');
    if (file === '') {
      model.setProgress(null);
    } else {
      model.setProgress(await readSaves(file));
    }
    if (!model.progress) $('#sel-state').value = '';
    renderSaveInfo();
    renderResults();
    graph.rebuild(graph.anchor());
    details.refresh();
  }

  function syncToolbar() {
    $('#sel-up').value = String(graph.up);
    $('#sel-down').value = String(graph.down);
    $('#sel-gen').value = String(graph.maxGen);
    for (const box of document.querySelectorAll('#kind-toggles input')) {
      const kind = box.dataset.kind;
      box.checked = kind === 'item' ? graph.showItems : kind === 'group' ? graph.groupSections : kind === 'all' ? allRoots : graph.kinds.has(kind);
    }
  }

  // --- search list ------------------------------------------------------------

  function renderResults() {
    const { rows, total } = model.find($('#search').value, $('#sel-section').value, RESULT_LIMIT, $('#sel-state').value);
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const topic = model.topics[r.id];
      const row = document.createElement('button');
      row.className = `result st-${model.status(r.id)}`;
      const state = model.state(r.id);
      if (state) row.classList.add(`p-${state}`);
      row.dataset.id = r.id;
      row.title = r.id;
      row.appendChild(XS.sprite(topic.icon, topic.iconKind));
      const name = document.createElement('span');
      name.textContent = r.name;
      row.appendChild(name);
      frag.appendChild(row);
    }
    $('#results').replaceChildren(frag);
    $('#results').scrollTop = 0;
    $('#results-info').textContent = total ? (total > rows.length ? t('shown', rows.length, total) : String(total)) : t('nothingFound');
    markActiveResult();
  }

  function markActiveResult() {
    for (const el of document.querySelectorAll('#results .result')) {
      el.classList.toggle('active', !!graph && el.dataset.id === graph.focus);
    }
  }

  // --- one-time event wiring --------------------------------------------------

  let wired = false;
  function setupOnce() {
    if (wired) return;
    wired = true;

    $('#btn-back').addEventListener('click', () => go(-1));
    $('#btn-fwd').addEventListener('click', () => go(1));
    $('#btn-home').addEventListener('click', () => open(START));
    $('#btn-fit').addEventListener('click', () => graph.fit());
    $('#btn-zoom-in').addEventListener('click', () => graph.zoomBy(1.25));
    $('#btn-zoom-out').addEventListener('click', () => graph.zoomBy(0.8));
    $('#zoom-level').addEventListener('click', () => { graph.view.k = 1; graph.centerOnFoci(); });

    $('#sel-up').addEventListener('change', (e) => { store.set('up', +e.target.value); graph.update({ up: +e.target.value }); });
    $('#sel-down').addEventListener('change', (e) => { store.set('down', +e.target.value); graph.update({ down: +e.target.value }); });

    $('#sel-gen').addEventListener('change', (e) => { store.set('gens', +e.target.value); graph.update({ maxGen: +e.target.value }); });

    $('#kind-toggles').addEventListener('change', (e) => {
      const kind = e.target.dataset.kind;
      if (!kind) return;
      if (kind === 'all') {
        // how the tree starts is remembered per mod: some mods need it, in others it only adds noise
        allRoots = e.target.checked;
        store.set(`all.${modId}`, allRoots);
        open(START);
        return;
      }
      if (kind === 'item') graph.showItems = e.target.checked;
      else if (kind === 'group') graph.groupSections = e.target.checked;
      else if (e.target.checked) graph.kinds.add(kind);
      else graph.kinds.delete(kind);
      const off = [...TOGGLES, 'group'].filter((k) => (k === 'item' ? !graph.showItems : k === 'group' ? !graph.groupSections : !graph.kinds.has(k)));
      store.set('off', off);
      graph.rebuild(graph.anchor());
    });

    let timer = 0;
    $('#search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(renderResults, 90); });
    $('#search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = document.querySelector('#results .result');
        if (first) open(first.dataset.id);
      } else if (e.key === 'Escape') {
        e.target.value = '';
        renderResults();
      }
    });
    $('#sel-section').addEventListener('change', renderResults);
    $('#sel-state').addEventListener('change', renderResults);
    $('#save-info').addEventListener('change', (e) => { if (e.target.id === 'sel-save') useSave(e.target.value); });
    $('#save-info').addEventListener('click', (e) => { if (e.target.closest('#btn-save-refresh')) useSave(null); });
    $('#results').addEventListener('click', (e) => {
      const row = e.target.closest('.result');
      if (row) open(row.dataset.id);
    });

    $('#sel-lang').addEventListener('change', async (e) => {
      const next = e.target.value;
      config.language = next;
      await platform.setConfig({ language: next });
      const picked = await resolveLanguage(next, layout, languages);
      const res = await loader.loadStrings(fs, layout, picked.lang, stringKeys);
      langSetting = next;
      lang = picked.lang;
      autoLang = picked.auto;
      XS.i18n.setLanguage(lang);
      model.stats = { ...model.stats, translated: res.translated, total: res.total };
      model.setStrings(res.strings);
      renderChrome();
      renderSaveInfo();
      syncToolbar();
      renderResults();
      graph.rebuild(graph.anchor());
      details.refresh();
    });

    $('#btn-settings').addEventListener('click', chooseDir);
    $('#mod-info').addEventListener('change', async (e) => {
      if (e.target.id === 'sel-mod') { chooseMod(e.target.value); return; }
      if (e.target.id !== 'chk-submods') return;
      config.useSubmods = e.target.checked;
      showSplash({ text: t('loading'), busy: true });
      await platform.setConfig({ useSubmods: config.useSubmods });
      switchMod(modId);
    });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement.tagName !== 'INPUT')) {
        e.preventDefault();
        $('#search').focus();
        $('#search').select();
      } else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.altKey && e.key === 'Home') { e.preventDefault(); open(START); }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) go(-1);
      if (e.button === 4) go(1);
    });
  }

  /** The user picked another mod in the selector: remember the choice and show it. */
  async function chooseMod(id) {
    config.mod = id;
    showSplash({ text: t('loading'), busy: true });
    await platform.setConfig({ mod: id });
    switchMod(id);
  }

  boot();
})();
