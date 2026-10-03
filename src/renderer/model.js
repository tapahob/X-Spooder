'use strict';
// In-memory model of the research graph: edges in both directions, names, search.
(function () {
  window.XS = window.XS || {};

  // Edge kinds. `dep`, `unlock` and `free` are the ways to reach a topic and are followed
  // when walking the tree; `disable` is only drawn between topics already on screen.
  const KINDS = ['dep', 'unlock', 'free', 'disable'];
  const WALK_KINDS = ['dep', 'unlock', 'free'];

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');

  class Model {
    constructor(data, strings) {
      this.data = data;
      this.topics = data.topics;
      this.items = data.items;
      this.ids = Object.keys(this.topics);
      this.inc = {};  // id -> [{from, kind, gate?}]
      this.out = {};  // id -> [{to, kind, gate?}]
      for (const id of this.ids) { this.inc[id] = []; this.out[id] = []; }

      const seen = new Set();
      const edge = (from, to, kind, gate) => {
        const k = `${from}>${to}>${kind}`;
        if (from === to || seen.has(k) || !this.topics[from] || !this.topics[to]) return;
        seen.add(k);
        this.out[from].push({ to, kind, gate });
        this.inc[to].push({ from, kind, gate });
      };
      for (const t of Object.values(this.topics)) {
        for (const d of t.deps) edge(d, t.id, 'dep');
        for (const d of t.requires) edge(d, t.id, 'dep');
        for (const u of t.unlocks) edge(t.id, u, 'unlock');
        for (const f of t.free) edge(t.id, f, 'free');
        for (const [gate, list] of Object.entries(t.freeProtected)) for (const f of list) edge(t.id, f, 'free', gate);
        for (const x of t.disables) edge(t.id, x, 'disable');
      }
      this.setStrings(strings);
    }

    setStrings(strings) {
      this.strings = strings;
      const collator = new Intl.Collator(XS.i18n.locale(), { numeric: true, sensitivity: 'base' });
      this.search = this.ids.map((id) => {
        const name = this.name(id);
        return { id, name, n: norm(name), i: id.toLowerCase(), section: this.topics[id].section };
      }).sort((a, b) => collator.compare(a.name, b.name));
    }

    str(key) {
      return key != null && this.strings[key] != null ? this.strings[key] : null;
    }

    /** Localised name, falling back to a readable form of the raw id. */
    name(id) {
      const s = this.str(id);
      if (s != null && s.trim()) return Model.plain(s);
      return String(id).replace(/^STR_/, '').replace(/_/g, ' ');
    }

    /** One-line text: OpenXcom formatting codes removed. */
    static plain(s) {
      return String(s).replace(/\{(NEWLINE|SMALLLINE)\}/g, ' ').replace(/\{ALT\}|[\x01-\x08]/g, '').replace(/\s+/g, ' ').trim();
    }

    /** Multi-line text as safe HTML ({NEWLINE}, {ALT} highlighting). */
    static rich(s) {
      let alt = false;
      return esc(String(s).replace(/\r/g, ''))
        .replace(/\{NEWLINE\}|\{SMALLLINE\}|\n/g, '<br>')
        .replace(/\{ALT\}|\x01/g, () => ((alt = !alt) ? '<span class="alt">' : '</span>'))
        .replace(/[\x02-\x08]/g, '') + (alt ? '</span>' : '');
    }

    /** How a topic is obtained, for badges and wording. */
    status(id) {
      const t = this.topics[id];
      const item = this.items[id];
      if (t.needItem && !(item && item.exists)) return 'locked';
      if (!t.cost) return 'auto';
      return 'normal';
    }

    hasItem(id) {
      const t = this.topics[id];
      return !!(t && t.needItem && this.items[id] && this.items[id].exists);
    }

    /** Nothing has to be known or owned to research it: no dependencies, no `requires`, no item. */
    isStart(id) {
      const t = this.topics[id];
      return !t.needItem && !t.deps.length && !t.requires.length;
    }

    /**
     * The roots of the tree: every topic without requirements that is actually researched
     * (zero-cost topics are not projects - the game hands them out by itself).
     */
    startTopics() {
      return this.ids.filter((id) => this.topics[id].cost > 0 && this.isStart(id))
        .sort((a, b) => this.topics[a].cost - this.topics[b].cost || this.out[b].length - this.out[a].length);
    }

    /**
     * The other ways into the tree: topics that need no research and that nothing leads to, but
     * that are not free projects either - they wait for an item or a prisoner, or the game hands
     * them out (events, missions). Most mods hang the bulk of their research on these.
     * What can be worked on with the loaded save comes first, then the biggest branches.
     */
    entryTopics() {
      const free = new Set(this.startTopics());
      const rank = (id) => {
        const state = this.state(id);
        if (state === 'avail' || state === 'active' || state === 'paused') return 0;
        if (state === 'done') return 1;
        return this.hasItem(id) ? 2 : 3;
      };
      return this.ids
        .filter((id) => {
          const t = this.topics[id];
          return !free.has(id) && !t.deps.length && !t.requires.length && !this.inc[id].some((e) => e.kind !== 'disable');
        })
        .map((id) => [id, rank(id)])
        .sort((a, b) => a[1] - b[1] || this.out[b[0]].length - this.out[a[0]].length || this.name(a[0]).localeCompare(this.name(b[0])))
        .map(([id]) => id);
    }

    /** Which share of all topics can be reached from the free starting projects alone. */
    startCoverage() {
      if (this.coverage == null) {
        const seen = new Set(this.startTopics());
        const queue = [...seen];
        while (queue.length) {
          for (const e of this.out[queue.pop()]) {
            if (e.kind !== 'disable' && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
          }
        }
        this.coverage = this.ids.length ? seen.size / this.ids.length : 1;
      }
      return this.coverage;
    }

    // --- progress from a saved game ---------------------------------------------

    /**
     * Applies a save: which topics are finished, which are being researched, and which
     * could be started right now. Pass null to clear.
     */
    setProgress(save) {
      this.progress = null;
      if (!save) return;
      const done = new Set(save.discovered.filter((id) => this.topics[id]));
      const active = new Map();
      for (const r of save.research) if (this.topics[r.id] && !active.has(r.id)) active.set(r.id, r);

      const disabled = new Set();
      for (const id of done) for (const x of this.topics[id].disables) disabled.add(x);

      // what each base can do: stock and the services its finished facilities provide
      const provides = {};
      for (const [fn, types] of Object.entries(this.data.funcProviders)) {
        for (const type of types) (provides[type] = provides[type] || []).push(fn);
      }
      const bases = save.bases.map((b) => ({
        items: b.items,
        funcs: new Set(b.facilities.flatMap((type) => provides[type] || [])),
      }));

      const available = new Set();
      for (const id of this.ids) {
        if (done.has(id) || active.has(id) || disabled.has(id)) continue;
        if (this.dependenciesMet(id, done) && this.baseCanResearch(id, bases)) available.add(id);
      }
      this.progress = { save, done, active, available, disabled, bases };
    }

    /** OXCE rule: every `requires`, and then either all dependencies or one direct unlock. */
    dependenciesMet(id, done) {
      const t = this.topics[id];
      if (!t.cost || this.status(id) === 'locked') return false; // never offered as a project
      if (!t.requires.every((r) => done.has(r))) return false;
      if (this.inc[id].some((e) => e.kind === 'unlock' && done.has(e.from))) return true;
      return t.deps.every((d) => done.has(d));
    }

    baseCanResearch(id, bases) {
      const t = this.topics[id];
      return bases.some((b) => (!t.needItem || b.items[id] > 0) && t.baseFunc.every((f) => b.funcs.has(f)));
    }

    /**
     * How many research steps each unfinished topic is away from what can be worked on now:
     * 0 for the available and running projects, 1 for what they lead to, and so on, following
     * the given link kinds. Topics that cannot be reached from there are absent.
     */
    generations(kinds) {
      const p = this.progress;
      if (!p) return null;
      const key = [...kinds].sort().join();
      if (p.gens && p.gens.key === key) return p.gens.map;
      const map = new Map();
      let frontier = [...p.available, ...p.active.keys()];
      for (const id of frontier) map.set(id, 0);
      for (let depth = 1; frontier.length; depth++) {
        const next = [];
        for (const id of frontier) {
          for (const e of this.children(id, kinds)) {
            if (map.has(e.to) || p.done.has(e.to)) continue;
            map.set(e.to, depth);
            next.push(e.to);
          }
        }
        frontier = next;
      }
      p.gens = { key, map };
      return map;
    }

    /** What still stands between the player and this topic (only meaningful with a save). */
    blockers(id) {
      const p = this.progress;
      const t = this.topics[id];
      if (!p || !t.cost || this.status(id) === 'locked') return null;
      const missing = this.dependenciesMet(id, p.done) ? [] : [...new Set([...t.requires, ...t.deps])].filter((d) => !p.done.has(d));
      const provides = (b) => t.baseFunc.filter((f) => !b.funcs.has(f));
      const bases = p.bases;
      return {
        disabled: p.disabled.has(id),
        deps: missing,
        item: t.needItem && !bases.some((b) => b.items[id] > 0),
        funcs: bases.length ? bases.map(provides).sort((a, b) => a.length - b.length)[0] : t.baseFunc,
      };
    }

    /** 'done' | 'disabled' | 'active' (scientists assigned) | 'paused' (started, nobody on it) | 'avail' | null */
    state(id) {
      const p = this.progress;
      if (!p) return null;
      if (p.active.has(id)) return p.active.get(id).assigned > 0 ? 'active' : 'paused';
      if (p.done.has(id)) return 'done';
      if (p.disabled.has(id)) return 'disabled'; // closed off by something already researched
      if (p.available.has(id)) return 'avail';
      return null;
    }

    /** The researched topics that closed this one off (`disables`). */
    disabledBy(id) {
      const p = this.progress;
      return p ? this.inc[id].filter((e) => e.kind === 'disable' && p.done.has(e.from)).map((e) => e.from) : [];
    }

    parents(id, kinds) { return this.inc[id].filter((e) => kinds.has(e.kind)); }
    children(id, kinds) { return this.out[id].filter((e) => kinds.has(e.kind)); }

    find(query, section, limit, state) {
      const q = norm(query.trim());
      let list = this.search;
      if (section) list = list.filter((e) => (section === '-' ? !e.section : e.section === section));
      if (state) {
        list = list.filter((e) => {
          const s = this.state(e.id);
          return state === 'active' ? s === 'active' || s === 'paused' : state === 'todo' ? s !== 'done' : s === state;
        });
      }
      if (!q) return { total: list.length, rows: list.slice(0, limit) };
      const words = q.split(/\s+/);
      const starts = [], rest = [];
      for (const e of list) {
        const inName = words.every((w) => e.n.includes(w));
        if (!inName && !e.i.includes(q.replace(/\s+/g, '_'))) continue;
        (inName && e.n.startsWith(words[0]) ? starts : rest).push(e);
      }
      const all = starts.concat(rest);
      return { total: all.length, rows: all.slice(0, limit) };
    }

    /** A stable colour (hue in degrees) per ufopaedia section. */
    sectionHue(section) {
      if (!this.hues) {
        this.hues = new Map(this.sections().map((s, i) => [s.id, Math.round((i * 137.508 + 28) % 360)]));
      }
      return this.hues.get(section) || 0;
    }

    sections() {
      const count = new Map();
      for (const t of Object.values(this.topics)) count.set(t.section || '-', (count.get(t.section || '-') || 0) + 1);
      return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n }));
    }

    /** A reasonable topic to open on first launch: a well-connected researchable one. */
    defaultFocus() {
      let best = this.ids[0], score = -1;
      for (const id of this.ids) {
        const t = this.topics[id];
        if (!t.cost || !t.icon) continue;
        const s = Math.min(this.inc[id].length, 6) * Math.min(this.out[id].length, 12);
        if (s > score) { score = s; best = id; }
      }
      return best;
    }
  }

  XS.Model = Model;
  XS.KINDS = KINDS;
  XS.WALK_KINDS = WALK_KINDS;
  XS.esc = esc;
})();
