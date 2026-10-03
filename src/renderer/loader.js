'use strict';
// Parses the OpenXcom (Extended) rulesets of a mod and builds a compact dataset describing
// the research graph, the items it needs and the sprites to show. Runs entirely in the page:
// every file comes through XS.GameFS, so nothing is ever sent to a server.
(function () {
  window.XS = window.XS || {};
  const yaml = window.jsyaml;
  const { join } = XS.path;

  // --- YAML ------------------------------------------------------------------

  // OXCE list/map operators (`!add`, `!remove`, `!info`) - keep the data, tag the op.
  function opType(tag, kind, op) {
    return new yaml.Type(tag, {
      kind,
      construct(data) {
        if (!op || data == null || typeof data !== 'object') return data;
        Object.defineProperty(data, '_op', { value: op, enumerable: false });
        return data;
      },
    });
  }
  const SCHEMA = yaml.DEFAULT_SCHEMA.extend([
    opType('!add', 'sequence', 'add'), opType('!add', 'mapping', 'add'),
    opType('!remove', 'sequence', 'remove'), opType('!remove', 'mapping', 'remove'),
    opType('!info', 'sequence'), opType('!info', 'mapping'), opType('!info', 'scalar'),
  ]);

  function parseYaml(text, name) {
    // raw control bytes are not valid YAML; \x01 is OpenXcom's "alternate colour" switch
    text = text.replace(/\x01/g, '{ALT}').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // json:true => duplicate keys override instead of throwing (rulesets do have them)
    return yaml.load(text, { schema: SCHEMA, json: true, filename: name }) || {};
  }

  async function readYaml(fs, file) {
    return parseYaml(await fs.text(file), file);
  }

  // --- locating the installation ----------------------------------------------

  async function readMetadata(fs, modDir) {
    try { return await readYaml(fs, join(modDir, 'metadata.yml')); } catch { return {}; }
  }

  /** A mod keeps its rulesets in Ruleset/; the bundled "standard" ones keep them in their root. */
  async function listRulFiles(fs, modDir) {
    const sub = join(modDir, 'Ruleset');
    const dir = (await fs.isDir(sub)) ? sub : modDir;
    return (await fs.ls(dir))
      .filter((e) => !e.dir && /\.rul$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((name) => join(dir, name));
  }

  /** The game's user folder: <game>/user in a portable install, else the game folder itself. */
  async function userDirOf(fs) {
    return (await fs.isDir('user')) ? 'user' : '';
  }

  /** Every mod found in the installation: the user's (<user>/mods) and the bundled ones (<game>/standard). */
  async function scanMods(fs) {
    const bases = [
      { dir: join(await userDirOf(fs), 'mods'), standard: false },
      { dir: 'standard', standard: true },
    ];
    const found = [];
    for (const base of bases) {
      const folders = (await fs.ls(base.dir)).filter((e) => e.dir);
      const mods = await Promise.all(folders.map(async ({ name: folder }) => {
        const dir = join(base.dir, folder);
        if (!(await fs.isFile(join(dir, 'metadata.yml')))) return null;
        const meta = await readMetadata(fs, dir);
        if (meta.id == null) return null;
        return {
          id: String(meta.id), dir, standard: base.standard,
          name: String(meta.name || folder), version: meta.version != null ? String(meta.version) : '',
          master: meta.master != null ? String(meta.master) : null, isMaster: !!meta.isMaster,
          // the original game's files it is built on (UFO or TFTD), as named in metadata.yml
          resources: Array.isArray(meta.loadResources) ? meta.loadResources.map(String) : [],
        };
      }));
      for (const m of mods) if (m && !found.some((x) => x.id === m.id)) found.push(m);
    }
    return found;
  }

  /**
   * The mods a research tree can be shown for: the installed master mods (total conversions and
   * the original games), the user's own first. Throws if the folder is not a game installation.
   */
  async function listMods(fs) {
    const all = await scanMods(fs);
    const needs = (m) => (m.resources.length ? m.resources : ((all.find((x) => x.id === m.master) || {}).resources || []));
    const masters = [];
    for (const m of all.filter((x) => x.isMaster)) {
      if (!(await listRulFiles(fs, m.dir)).length) continue;
      // e.g. Terror From the Deep without its TFTD folder: the game itself would refuse it too
      let present = true;
      for (const res of needs(m)) if (!(await fs.isDir(res))) present = false;
      if (present) masters.push(m);
    }
    if (!masters.length) {
      throw new Error(`No X-COM game found in this folder: it has no mods in user/mods or standard (${fs.label})`);
    }
    const userDir = await userDirOf(fs);
    return masters.map(({ id, name, version, standard }) => ({ id, name, version, standard, saveDir: join(userDir, id) }));
  }

  /**
   * Works out every directory that contributes data for one master mod:
   * the master it builds on, the mod itself and (optionally) its active submods.
   */
  async function resolveLayout(fs, modId, { useSubmods = true } = {}) {
    const all = await scanMods(fs);
    const mod = all.find((m) => m.id === modId && m.isMaster);
    if (!mod) throw new Error(`The mod "${modId}" is not installed in ${fs.label}`);
    const modDir = mod.dir;
    const meta = await readMetadata(fs, modDir);
    const userDir = await userDirOf(fs);
    const base = mod.master && mod.master !== '*' ? all.find((m) => m.id === mod.master) : null;

    // Submods: enabled in the game's options and made for this mod (or for any mod, master "*").
    const submods = [];
    const optionsFile = join(userDir, 'options.cfg');
    if (useSubmods && await fs.isFile(optionsFile)) {
      try {
        const active = ((await readYaml(fs, optionsFile)).mods || []).filter((m) => m && m.active).map((m) => String(m.id));
        for (const id of active) {
          const sub = all.find((m) => m.id === id);
          if (sub && !sub.isMaster && (sub.master === mod.id || sub.master === '*')) {
            submods.push({ dir: sub.dir, name: sub.name, id: sub.id });
          }
        }
      } catch (e) {
        // options.cfg is optional - ignore a broken one
      }
    }

    // Layers in load order; later layers override earlier ones.
    const layers = [];
    if (base) layers.push({ key: 'std', dir: base.dir });
    layers.push({ key: 'mod', dir: modDir });
    submods.forEach((s, i) => layers.push({ key: `sub${i}`, dir: s.dir, submod: s }));
    for (const l of layers) l.rulesets = await listRulFiles(fs, l.dir);

    const langDirs = [];
    for (const d of ['common/Language', 'common/Language/OXCE', ...layers.map((l) => join(l.dir, 'Language'))]) {
      if (await fs.isDir(d)) langDirs.push(d);
    }

    // Original UFO graphics (item sprites, ufopaedia art, inventory paperdolls, UFO pictures the
    // mod did not replace) - only for mods built on xcom1; TFTD's own formats and palettes are not read.
    let ufoDir = null;
    if (mod.id === 'xcom1' || mod.master === 'xcom1') {
      for (const c of ['UFO', join(userDir, 'UFO')]) {
        if (await fs.isDir(join(c, 'UNITS'))) { ufoDir = c; break; }
      }
    }
    // the game refers to its .SPK pictures by file name alone (UP022.SPK, MAN_2M0.SPK): note where each lives
    const vanillaSpk = {};
    let interwin = false;
    if (ufoDir) {
      for (const dir of ['GEOGRAPH', 'UFOGRAPH']) {
        for (const e of await fs.ls(join(ufoDir, dir))) {
          if (!e.dir && /\.spk$/i.test(e.name)) vanillaSpk[e.name.toUpperCase()] = { name: e.name, dir };
        }
      }
      interwin = await fs.isFile(join(ufoDir, 'GEODATA', 'INTERWIN.DAT'));
    }

    return {
      modDir, meta, master: base ? base.id : null, userDir, saveDir: join(userDir, mod.id),
      layers, langDirs, ufoDir, vanillaSpk, interwin, submods,
    };
  }

  /** The language selected in the game's own options (user/options.cfg), or null if unset. */
  async function gameLanguage(fs, layout) {
    try {
      const options = (await readYaml(fs, join(layout.userDir, 'options.cfg'))).options;
      const code = options && options.language;
      return code ? String(code) : null;
    } catch {
      return null;
    }
  }

  // --- ruleset merging --------------------------------------------------------

  const SECTIONS = {
    research: 'name',
    items: 'type',
    manufacture: 'name',
    ufopaedia: 'id',
    armors: 'type',
    facilities: 'type',
    crafts: 'type',
    craftWeapons: 'type',
    units: 'type',
    events: 'name',
    alienDeployments: 'type',
    ufos: 'type',
    alienMissions: 'type',
  };

  function mergeValue(oldVal, newVal) {
    const op = newVal && typeof newVal === 'object' ? newVal._op : null;
    if (!op) return newVal;
    if (Array.isArray(newVal)) {
      const base = Array.isArray(oldVal) ? oldVal : [];
      return op === 'add' ? base.concat(newVal) : base.filter((x) => !newVal.includes(x));
    }
    const base = oldVal && typeof oldVal === 'object' ? { ...oldVal } : {};
    if (op === 'add') return Object.assign(base, newVal);
    for (const k of Array.isArray(newVal) ? newVal : Object.keys(newVal)) delete base[k];
    return base;
  }

  function mergeSection(store, list, keyName) {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.delete != null) { store.delete(String(entry.delete)); continue; }
      let key = entry[keyName];
      let mustExist = false;
      if (key == null && entry.update != null) { key = entry.update; mustExist = true; }
      if (key == null && entry.override != null) { key = entry.override; mustExist = true; }
      if (key == null && entry.new != null) key = entry.new;
      if (key == null) continue;
      key = String(key);
      const existing = store.get(key);
      if (!existing) {
        if (mustExist) continue;
        const fresh = { [keyName]: key };
        for (const [k, v] of Object.entries(entry)) fresh[k] = mergeValue(undefined, v);
        fresh[keyName] = key;
        store.set(key, fresh);
      } else {
        for (const [k, v] of Object.entries(entry)) {
          if (k === 'update' || k === 'override' || k === 'new') continue;
          existing[k] = mergeValue(existing[k], v);
        }
      }
    }
  }

  // --- sprites ----------------------------------------------------------------

  function mergeExtraSprites(sprites, list, layerKey) {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const type = e.typeSingle || e.type;
      if (!type) continue;
      let set = sprites.get(type);
      if (!set) sprites.set(type, (set = new Map()));
      if (e.fileSingle) { set.set(0, { l: layerKey, f: e.fileSingle }); continue; }
      if (!e.files || typeof e.files !== 'object') continue;
      for (const [k, file] of Object.entries(e.files)) {
        const idx = Number(k);
        if (!Number.isFinite(idx) || typeof file !== 'string' || file.endsWith('/')) continue;
        if (e.subX && e.subY && e.width && e.height && !e.singleImage) {
          const cols = Math.floor(e.width / e.subX), rows = Math.floor(e.height / e.subY);
          for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            set.set(idx + r * cols + c, { l: layerKey, f: file, c: [c * e.subX, r * e.subY, e.subX, e.subY] });
          }
        } else {
          set.set(idx, { l: layerKey, f: file });
        }
      }
    }
  }

  // Vanilla sprite sets that XS.images can decode straight from the original game files.
  const VANILLA_PCK = { 'BIGOBS.PCK': { count: 57 }, 'BASEBITS.PCK': { count: 54 } };

  /**
   * Turns a sprite set + index into a reference XS.images can load later:
   * {l: layer key, f: file inside that mod, k?: key out palette index 0, c?: crop box}
   * or {pck, i} for a sprite of the original game. Whether the file really exists is only
   * found out when the picture is loaded.
   */
  function makeSpriteResolver(sprites, layout) {
    return function resolve(type, index = 0, { key = false } = {}) {
      if (type == null) return null;
      const set = sprites.get(type);
      const s = set && set.get(index);
      if (s) {
        const ref = { l: s.l, f: s.f };
        if (key) ref.k = 1;
        if (s.c) ref.c = s.c;
        return ref;
      }
      const v = VANILLA_PCK[type];
      if (v && layout.ufoDir && index >= 0 && index < v.count) return { pck: type, i: index };
      const spk = index === 0 && layout.vanillaSpk && layout.vanillaSpk[String(type).toUpperCase()];
      if (spk) return { spk: spk.name, dir: spk.dir };
      return null;
    };
  }

  // --- building the dataset ---------------------------------------------------

  const arr = (v) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

  async function build(fs, layout, onProgress = () => {}) {
    const stores = {};
    for (const s of Object.keys(SECTIONS)) stores[s] = new Map();
    const sprites = new Map();

    const files = layout.layers.flatMap((l) => l.rulesets.map((f) => ({ f, layer: l.key })));
    for (const [i, { f, layer }] of files.entries()) {
      onProgress({ stage: 'rules', file: f.split('/').pop(), done: i, total: files.length });
      let doc;
      try { doc = await readYaml(fs, f); } catch (e) {
        throw new Error(`Cannot parse ${f}: ${String(e.message).split('\n')[0]}`);
      }
      for (const [section, keyName] of Object.entries(SECTIONS)) mergeSection(stores[section], doc[section], keyName);
      mergeExtraSprites(sprites, doc.extraSprites, layer);
    }
    onProgress({ stage: 'graph', done: files.length, total: files.length });

    const sprite = makeSpriteResolver(sprites, layout);
    const { research, items, manufacture, ufopaedia, armors, facilities, units, events, alienDeployments, ufos, alienMissions } = stores;
    const keys = new Set();
    const want = (k) => { if (k != null && k !== '') keys.add(String(k)); return k; };

    const itemIcon = (id) => {
      const it = items.get(id);
      return it && it.bigSprite != null ? sprite('BIGOBS.PCK', Number(it.bigSprite), { key: true }) : null;
    };
    // Prisoners have no inventory picture of their own - borrow the corpse of their unit.
    const corpseIcon = (id) => {
      const u = units.get(id);
      const a = u && u.armor != null ? armors.get(String(u.armor)) : null;
      if (!a) return null;
      for (const c of [...arr(a.corpseBattle), ...arr(a.corpseGeo)]) {
        const s = itemIcon(c);
        if (s) return s;
      }
      return null;
    };
    // A UFO: its picture from the interception window (modSprite names that sprite).
    const ufoImage = (type) => {
      const ufo = ufos.get(type);
      if (ufo && ufo.modSprite) return sprite(String(ufo.modSprite), 0, { key: true });
      // the original game's UFOs are frames of GEODATA/INTERWIN.DAT
      if (ufo && ufo.sprite != null && layout.interwin) return { interwin: Number(ufo.sprite) };
      return null;
    };
    const armorImage = (id) => {
      const a = armors.get(id);
      if (!a) return null;
      // OXCE layered paperdolls: the figure is a stack of pictures named <prefix>__<layer>__<name>,
      // one list of names per look (M0, F0, ...); the first look stands for the armour.
      if (a.layersDefinition && typeof a.layersDefinition === 'object') {
        const looks = Object.values(a.layersDefinition).filter(Array.isArray);
        const specific = a.layersSpecificPrefix && typeof a.layersSpecificPrefix === 'object' ? a.layersSpecificPrefix : {};
        const layers = [];
        (looks[0] || []).forEach((name, i) => {
          if (!name) return;
          const prefix = specific[i] != null ? specific[i] : a.layersDefaultPrefix;
          const s = prefix != null ? sprite(`${prefix}__${i}__${name}`, 0, { key: true }) : null;
          if (s) layers.push(s);
        });
        if (layers.length) return { layers };
      }
      if (!a.spriteInv) return null;
      const base = String(a.spriteInv);
      for (const t of [base, `${base}.SPK`, `${base}M0.SPK`, `${base}F0.SPK`, `${base}M1.SPK`, `${base}F1.SPK`]) {
        const s = sprite(t, 0, { key: true });
        if (s) return s;
      }
      return null;
    };

    // Ufopaedia articles: resolve the picture and remember which research reveals them.
    const articles = {};
    const articlesByReq = new Map();
    for (const [id, a] of ufopaedia) {
      const type = Number(a.type_id) || 0;
      let img = null, kind = null;
      if (a.image_id) {
        img = sprite(String(a.image_id), 0);
        kind = 'bg';
        // Full-screen article art keeps its left part empty for the text - crop to the picture.
        const tw = Number(a.text_width) || 0;
        if (img && !img.c && tw > 0 && tw <= 260) img = { ...img, c: [tw, 0, 320 - tw, 200] };
      }
      if (!img && type === 6) {
        // a base facility: its tile from the base view (the top-left one, for big facilities)
        const f = facilities.get(id);
        const tile = f && (f.spriteFacility != null ? f.spriteFacility : f.spriteShape);
        img = tile != null ? sprite('BASEBITS.PCK', Number(tile), { key: true }) : null;
        kind = 'item';
      }
      if (!img && type === 9) {
        // a UFO: the picture of it from the interception window (modSprite names that sprite)
        img = ufoImage(id);
        kind = 'item';
      }
      if (!img && type === 5) {
        img = armorImage(id);
        kind = 'armor';
        // Inventory paperdolls are 320x200 screens with the figure on the left.
        if (img && !img.c) img = { ...img, c: [28, 28, 104, 128] };
      }
      if (!img) { img = itemIcon(a.weapon || id) || itemIcon(id); kind = 'item'; }
      if (!img) kind = null;
      const requires = arr(a.requires);
      const text = a.text != null ? String(a.text) : `${id}_UFOPEDIA`;
      articles[id] = {
        id, type, section: a.section || null, title: a.title || id, text, requires,
        img, kind, order: Number(a.listOrder) || 0,
      };
      want(id); want(a.title); want(text); want(a.section);
      for (const r of requires) {
        if (!articlesByReq.has(r)) articlesByReq.set(r, []);
        articlesByReq.get(r).push(id);
      }
    }

    // Manufacture: what a research topic lets you build and where items come from.
    const manuByReq = new Map();
    const manuByProduct = new Map();
    const manu = {};
    for (const [name, m] of manufacture) {
      const requires = arr(m.requires);
      const produced = m.producedItems && typeof m.producedItems === 'object' ? Object.keys(m.producedItems) : [name];
      manu[name] = {
        id: name, category: m.category || null, requires, produced,
        needs: m.requiredItems && typeof m.requiredItems === 'object' ? m.requiredItems : {},
        baseFunc: arr(m.requiresBaseFunc), time: Number(m.time) || 0, cost: Number(m.cost) || 0,
        img: itemIcon(produced[0]) || itemIcon(name),
      };
      for (const r of requires) {
        if (!manuByReq.has(r)) manuByReq.set(r, []);
        manuByReq.get(r).push(name);
      }
      for (const p of produced) {
        if (!manuByProduct.has(p)) manuByProduct.set(p, []);
        manuByProduct.get(p).push(name);
      }
    }

    // Which facilities provide a base service (requiresBaseFunc).
    const funcProviders = {};
    for (const [type, f] of facilities) {
      for (const fn of arr(f.provideBaseFunc)) (funcProviders[fn] = funcProviders[fn] || []).push(want(type));
    }

    // Other ways a topic can be handed to the player: events and finished missions.
    const sources = new Map();
    const addSource = (topic, kind, id) => {
      if (!sources.has(topic)) sources.set(topic, []);
      const list = sources.get(topic);
      if (!list.some((x) => x.kind === kind && x.id === id)) list.push({ kind, id: want(id) });
    };
    for (const [name, e] of events) for (const t of arr(e.researchList)) addSource(t, 'event', name);
    for (const [type, d] of alienDeployments) for (const t of arr(d.unlockedResearch)) addSource(t, 'mission', type);

    // Research topics.
    const topics = {};
    const usedItems = new Set();
    const usedManu = new Set();
    for (const [id, r] of research) {
      const free = arr(r.getOneFree);
      const freeProtected = {};
      if (r.getOneFreeProtected && typeof r.getOneFreeProtected === 'object') {
        for (const [gate, list] of Object.entries(r.getOneFreeProtected)) freeProtected[gate] = arr(list);
      }
      const lookup = r.lookup ? String(r.lookup) : null;
      const needItem = !!r.needItem;
      const articleId = articles[lookup || id] ? (lookup || id) : null;
      const revealed = (articlesByReq.get(id) || []).filter((a) => a !== articleId)
        .sort((a, b) => articles[a].order - articles[b].order);

      // Node thumbnail: the item itself, else the article picture, else what it reveals.
      let icon = itemIcon(id) || corpseIcon(id), iconKind = icon ? 'item' : null;
      if (!icon && articleId && articles[articleId].img) { icon = articles[articleId].img; iconKind = articles[articleId].kind; }
      if (!icon && lookup) { icon = itemIcon(lookup); iconKind = icon ? 'item' : null; }
      if (!icon) {
        const own = revealed.map((a) => articles[a]).filter((a) => a.img);
        const best = own.find((a) => a.requires.length === 1) || own[0];
        if (best) { icon = best.img; iconKind = best.kind; }
      }
      if (!icon && alienMissions.has(id)) {
        // research about an alien mission (its article is text only): show the craft that flies it
        const mission = alienMissions.get(id);
        const crafts = [...arr(mission.spawnUfo), ...(Array.isArray(mission.waves) ? mission.waves.map((w) => w && w.ufo).filter(Boolean).map(String) : [])];
        for (const type of crafts) {
          const craft = ufoImage(type);
          const article = articles[type] && articles[type].img ? articles[type] : null;
          if (craft) { icon = craft; iconKind = 'item'; break; }
          if (article) { icon = article.img; iconKind = article.kind; break; }
        }
      }

      const spawned = r.spawnedItem ? String(r.spawnedItem) : null;
      if (needItem) usedItems.add(id);
      if (spawned) usedItems.add(spawned);
      const builds = manuByReq.get(id) || [];
      builds.forEach((m) => usedManu.add(m));

      topics[id] = {
        id, cost: Number(r.cost) || 0, points: Number(r.points) || 0,
        needItem, destroyItem: !!r.destroyItem,
        deps: arr(r.dependencies), unlocks: arr(r.unlocks), free, freeProtected,
        disables: arr(r.disables), requires: arr(r.requires), baseFunc: arr(r.requiresBaseFunc),
        lookup, spawned, spawnedCount: Number(r.spawnedItemCount) || (spawned ? 1 : 0),
        article: articleId, revealed, builds, sources: sources.get(id) || [],
        section: articleId ? articles[articleId].section : null,
        icon, iconKind,
      };
      want(id); want(lookup);
    }

    // Drop references to topics that do not exist (deleted vanilla leftovers, typos).
    const exists = (t) => Object.prototype.hasOwnProperty.call(topics, t);
    let dangling = 0;
    for (const t of Object.values(topics)) {
      for (const f of ['deps', 'unlocks', 'free', 'disables', 'requires']) {
        const before = t[f].length;
        t[f] = [...new Set(t[f])].filter((x) => exists(x) && x !== t.id);
        dangling += before - t[f].length;
      }
      for (const gate of Object.keys(t.freeProtected)) {
        t.freeProtected[gate] = t.freeProtected[gate].filter(exists);
        if (!exists(gate) || !t.freeProtected[gate].length) delete t.freeProtected[gate];
      }
    }

    // Items that show up on the tree (needed for / produced by research).
    const itemOut = {};
    for (const id of usedItems) {
      const it = items.get(id);
      const makers = manuByProduct.get(id) || [];
      makers.forEach((m) => usedManu.add(m));
      itemOut[id] = {
        id, exists: !!it, icon: itemIcon(id) || corpseIcon(id),
        costBuy: it ? Number(it.costBuy) || 0 : 0, costSell: it ? Number(it.costSell) || 0 : 0,
        requiresBuy: it ? arr(it.requiresBuy).filter(exists) : [],
        requires: it ? arr(it.requires).filter(exists) : [],
        makers,
        liveAlien: !!(it && it.liveAlien),
      };
      want(id);
    }

    const manuOut = {};
    for (const name of usedManu) {
      const m = manu[name];
      manuOut[name] = m;
      want(name); want(m.category);
      m.produced.forEach(want);
      Object.keys(m.needs).forEach(want);
    }

    // Only keep articles that some topic can show.
    const articleOut = {};
    for (const t of Object.values(topics)) {
      if (t.article) articleOut[t.article] = articles[t.article];
      for (const a of t.revealed) articleOut[a] = articles[a];
    }

    return {
      meta: {
        id: layout.meta.id || null,
        name: layout.meta.name || layout.modDir.split('/').pop(),
        version: layout.meta.version || '',
        modDir: layout.modDir,
        submods: layout.submods.map((s) => s.name),
        hasMaster: !!layout.master,
        dangling,
      },
      topics, items: itemOut, manufacture: manuOut, articles: articleOut, funcProviders,
      stringKeys: [...keys],
    };
  }

  // --- localisation -----------------------------------------------------------

  async function availableLanguages(fs, layout) {
    const langs = new Set();
    for (const l of layout.layers) {
      if (l.key === 'std') continue;
      for (const e of await fs.ls(join(l.dir, 'Language'))) {
        if (!e.dir && /\.yml$/i.test(e.name)) langs.add(e.name.replace(/\.yml$/i, ''));
      }
    }
    return [...langs].sort();
  }

  function flatten(v) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.one || v.other || v.many || Object.values(v).find((x) => typeof x === 'string') || null;
    return v == null ? null : String(v);
  }

  /** Loads `lang` on top of en-US and returns only the keys the dataset uses. */
  async function loadStrings(fs, layout, lang, stringKeys) {
    const wanted = new Set(stringKeys);
    const out = {};
    let translated = 0;
    const passes = lang === 'en-US' ? ['en-US'] : ['en-US', lang];
    for (const code of passes) {
      for (const dir of layout.langDirs) {
        const file = join(dir, `${code}.yml`);
        if (!(await fs.isFile(file))) continue;
        let doc;
        try { doc = await readYaml(fs, file); } catch { continue; }
        const table = doc[code] || Object.values(doc)[0];
        if (!table || typeof table !== 'object') continue;
        for (const [k, v] of Object.entries(table)) {
          if (!wanted.has(k)) continue;
          const s = flatten(v);
          if (s == null) continue;
          if (code === lang && !(k in out && out[k].l === lang)) translated++;
          out[k] = { s, l: code };
        }
      }
    }
    const strings = {};
    for (const [k, v] of Object.entries(out)) strings[k] = v.s;
    return { strings, translated, total: Object.keys(strings).length };
  }

  XS.loader = { parseYaml, listMods, resolveLayout, gameLanguage, build, availableLanguages, loadStrings };
})();
