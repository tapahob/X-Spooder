'use strict';
// The tree view: picks the neighbourhood of the focused topic, lays it out (prerequisites on
// the left, consequences on the right) and draws it.
//
// Drawing is split by what is cheap for the browser:
//   - section lanes and the faint links are painted once on a canvas somewhat larger than the
//     viewport, which is then just moved along while the camera pans; the highlighted links
//     (of the selected card, of the hovered card) get canvases of the same kind;
//   - lane names are a third, tiny canvas repainted every frame;
//   - topic cards are DOM elements, but only those near the viewport exist at any moment,
//     so the page never carries more than a screenful of them.
// Nothing here is a huge composited layer, which is what made big trees slow before.
(function () {
  const { t } = XS.i18n;

  // Topics drawn at once before the walk is cut short. The lane layout and the drawing cope with
  // a whole mod (X-Piratez: 4700 topics, 25000 links); dagre, used when grouping is off, needs
  // seconds beyond a couple of hundred nodes.
  const MAX_NODES = { lanes: 6000, flow: 220 };
  const TOPIC = { w: 236, h: 60 };
  const ITEM = { w: 190, h: 48 };
  const MAX_STACKED = 12;        // up to this many roots are stacked in a column of their own
  const UNLIMITED = 99;          // "no limit" value of the generations selector
  const ZOOM_MIN = 0.12, ZOOM_MAX = 2.5;
  const FAR = 0.42;              // below this zoom the cards are too small to read: draw them plainer
  const CULL_MARGIN = 260;       // px around the viewport in which cards are kept in the page
  const LAYER_MARGIN = 420;      // px around the viewport that a cached canvas also covers

  const RANK_GAP = 110;          // horizontal space between columns
  const MARGIN = 80;             // empty space around the whole drawing

  // How each kind of link is stroked on the canvas (colours come from the stylesheet).
  const EDGE_STYLE = {
    dep: { width: 1.5, dash: [] },
    unlock: { width: 1.5, dash: [7, 4] },
    free: { width: 2, dash: [2, 4], cap: 'round' },
    disable: { width: 1.5, dash: [10, 3, 2, 3] },
    item: { width: 2, dash: [] },
  };
  const EDGE_KINDS = Object.keys(EDGE_STYLE);
  const MAX_DASHED = 80;         // highlighted links beyond this many are stroked solid
  const DIM = 0.1;               // opacity of links that belong to neither the hovered nor the selected card

  const ICONS = {
    flask: '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M4.5 1h3M5 1v3.2L1.9 9.6c-.4.7.1 1.4.9 1.4h6.4c.8 0 1.3-.7.9-1.4L7 4.2V1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    lock: '<svg viewBox="0 0 12 12" width="11" height="11"><rect x="2.2" y="5.4" width="7.6" height="5.4" rx="1" fill="currentColor"/><path d="M4 5.4V3.8a2 2 0 0 1 4 0v1.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    bolt: '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M7 .8 2.5 6.8h3L4.8 11.2l4.7-6.3h-3z" fill="currentColor"/></svg>',
    star: '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 .9 7.5 4.3l3.7.3-2.8 2.4.9 3.6L6 8.7 2.7 10.6l.9-3.6L.8 4.6l3.7-.3z" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M2 6.4 4.8 9.2 10 3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    user: '<svg viewBox="0 0 12 12" width="11" height="11"><circle cx="6" cy="3.6" r="2.3" fill="currentColor"/><path d="M1.6 11c.3-2.6 2-4 4.4-4s4.1 1.4 4.4 4z" fill="currentColor"/></svg>',
    box: '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 1.2 10.6 3.5v5L6 10.8 1.4 8.5v-5zM1.6 3.6 6 5.8l4.4-2.2M6 5.8v4.8" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  };

  // Pictures are read from the game folder only when they come near the screen.
  const lazy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      lazy.unobserve(entry.target);
      entry.target.xsLoad();
    }
  }, { rootMargin: '400px' });

  /** <img> for a sprite reference produced by the loader ({l, f, k?, c?} or {pck, i}). */
  // Paperdolls stand somewhere on a screen-sized transparent picture: the box of their visible
  // pixels, per picture, so that the figure (and all of it) fills the frame.
  const figureBoxes = new Map();
  function figureBox(img) {
    if (figureBoxes.has(img.src)) return figureBoxes.get(img.src);
    const w = img.naturalWidth, h = img.naturalHeight;
    let box = null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] < 16) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (x1 >= 0) {
        const pad = 4;
        x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
        x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
        box = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
      }
    } catch { /* unreadable picture: shown whole */ }
    figureBoxes.set(img.src, box);
    return box;
  }
  const viewBox = (c) => `xywh(${c[0]}px ${c[1]}px ${c[2]}px ${c[3]}px)`;

  /**
   * Picture for a sprite reference produced by the loader ({l, f, k?, c?}, {pck, i}, {spk}, ...).
   * `full`: show the whole picture (the details panel) - ufopaedia art is otherwise cut down to
   * its illustrated part for the small thumbnails.
   */
  function sprite(ref, kind, { full = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `thumb k-${kind || 'none'}`;
    if (!ref) { wrap.classList.add('empty'); return wrap; }
    const img = document.createElement('img');
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    if (kind === 'armor') {
      // the figure, whole, wherever it stands on its picture
      img.addEventListener('load', () => { const box = figureBox(img); if (box) img.style.objectViewBox = viewBox(box); });
    } else if (ref.c && !(full && kind === 'bg')) {
      img.style.objectViewBox = viewBox(ref.c); // a cell of a sprite sheet, or the art beside the text
    }
    const fail = () => { img.remove(); wrap.classList.add('empty'); };
    img.addEventListener('error', fail, { once: true });
    const images = XS.images;
    img.xsLoad = () => images.url(ref).then((url) => { if (url) img.src = url; else fail(); });
    wrap.appendChild(img);
    lazy.observe(img);
    return wrap;
  }

  // --- link geometry: {d: SVG path data, tip: [x, y, angle] of the arrow head} --------------

  /** Open uniform B-spline through dagre's control points (same as d3.curveBasis). */
  function basisLink(p) {
    const n = p.length;
    const tip = [p[n - 1].x, p[n - 1].y, Math.atan2(p[n - 1].y - p[n - 2].y, p[n - 1].x - p[n - 2].x)];
    if (n < 3) return { d: 'M' + p.map((q) => `${q.x},${q.y}`).join('L'), tip };
    let x0 = p[0].x, y0 = p[0].y, x1 = p[1].x, y1 = p[1].y;
    let d = `M${x0},${y0}L${(5 * x0 + x1) / 6},${(5 * y0 + y1) / 6}`;
    for (let i = 2; i < n; i++) {
      const { x, y } = p[i];
      d += `C${(2 * x0 + x1) / 3},${(2 * y0 + y1) / 3} ${(x0 + 2 * x1) / 3},${(y0 + 2 * y1) / 3} ${(x0 + 4 * x1 + x) / 6},${(y0 + 4 * y1 + y) / 6}`;
      x0 = x1; y0 = y1; x1 = x; y1 = y;
    }
    return { d: d + `C${(2 * x0 + x1) / 3},${(2 * y0 + y1) / 3} ${(x0 + 2 * x1) / 3},${(y0 + 2 * y1) / 3} ${x1},${y1}`, tip };
  }

  /** A curve from the right side of `a` to the left side of `b` (or around, if `b` is not to the right). */
  function cardLink(a, b) {
    if (b.x - b.w / 2 >= a.x + a.w / 2) {
      const x1 = a.x + a.w / 2, x2 = b.x - b.w / 2, bend = Math.max(40, (x2 - x1) * 0.5);
      return { d: `M${x1},${a.y}C${x1 + bend},${a.y} ${x2 - bend},${b.y} ${x2},${b.y}`, tip: [x2, b.y, 0] };
    }
    const x1 = a.x - a.w / 2, x2 = b.x + b.w / 2, sag = (a.h + b.h) / 2;
    return {
      d: `M${x1},${a.y}C${x1 - 70},${a.y + sag} ${x2 + 70},${b.y + sag} ${x2},${b.y}`,
      tip: [x2, b.y, Math.atan2(-sag, -70)],
    };
  }

  /** An arc from the bottom of `a` to the bottom of `b`, for links that are not part of the layout. */
  function arcLink(a, b) {
    const ax = a.x, ay = a.y + a.h / 2, bx = b.x, by = b.y + b.h / 2;
    const sag = 36 + Math.min(120, Math.abs(bx - ax) * 0.15);
    return { d: `M${ax},${ay}C${ax},${ay + sag} ${bx},${by + sag} ${bx},${by}`, tip: [bx, by, -Math.PI / 2] };
  }

  const laneTint = (c, alpha) => (c.hue == null ? `hsl(226 9% 58% / ${alpha})` : `hsl(${c.hue} 55% 55% / ${alpha})`);

  /** Adds an arrow head pointing along `angle` with its point at (x, y) to a Path2D. */
  function addTip(path, [x, y, angle], size) {
    const c = Math.cos(angle), s = Math.sin(angle), half = size * 0.42;
    const bx = x - c * size, by = y - s * size;
    path.moveTo(x, y);
    path.lineTo(bx - s * half, by + c * half);
    path.lineTo(bx + s * half, by - c * half);
    path.closePath();
  }

  /**
   * A canvas whose content is expensive to paint (hundreds of long curves). It is painted for
   * one camera position, somewhat larger than the viewport, and then merely moved by CSS while
   * the camera pans. It is painted again when the camera leaves that margin, when a zoom
   * gesture has settled (meanwhile the old picture is stretched), and once things are idle.
   */
  class CachedLayer {
    /**
     * @param paint (ctx, k) => void, drawing in world coordinates
     * @param maxScale cap on device pixels per CSS pixel (faint content does not need more)
     */
    constructor(canvas, paint, wake, maxScale) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.paint = paint;
      this.wake = wake;         // asks the owner for another frame
      this.maxScale = maxScale;
      this.scale = 1;
      this.drawn = null;        // the camera the picture was painted for
      this.timer = 0;
      this.zoomingSince = 0;
    }

    resize(vw, vh, dpr) {
      this.vw = vw;
      this.vh = vh;
      this.scale = Math.min(dpr, this.maxScale);
      const w = vw + LAYER_MARGIN * 2, h = vh + LAYER_MARGIN * 2;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.canvas.width = Math.max(1, Math.round(w * this.scale));
      this.canvas.height = Math.max(1, Math.round(h * this.scale));
      this.drawn = null;
    }

    /** The content changed: paint afresh on the next frame. */
    invalidate() { this.drawn = null; }

    /** Brings the picture in line with the camera, repainting only when it has to. */
    place(view) {
      const d = this.drawn;
      if (!d) { this.repaint(view); return; }
      const M = LAYER_MARGIN, f = view.k / d.k;
      const tx = view.x - f * (d.x + M) + M, ty = view.y - f * (d.y + M) + M; // where the old picture belongs now
      if (f === 1) {
        const covers = Math.abs(tx) <= M && Math.abs(ty) <= M;
        if (!covers) { this.repaint(view); return; }
        this.canvas.style.transform = `translate(${tx}px, ${ty}px)`;
        if (tx || ty) this.repaintSoon(260);
        return;
      }
      const now = performance.now();
      if (!this.zoomingSince) this.zoomingSince = now;
      if (now - this.zoomingSince > 320) { this.repaint(view); return; } // a long zoom: refresh on the way
      this.canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${f})`;
      this.repaintSoon(110);
    }

    repaintSoon(ms) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.drawn = null; this.wake(); }, ms);
    }

    repaint(view) {
      clearTimeout(this.timer);
      this.zoomingSince = 0;
      const { x, y, k } = view;
      const ctx = this.ctx, s = this.scale;
      this.drawn = { x, y, k };
      this.canvas.style.transform = 'translate(0px, 0px)';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(s * k, 0, 0, s * k, s * (x + LAYER_MARGIN), s * (y + LAYER_MARGIN));
      this.paint(ctx, k);
    }
  }

  class Graph {
    constructor(model, els, handlers) {
      this.model = model;
      this.viewport = els.viewport;
      this.world = els.world;     // transformed container of the cards
      this.nodesEl = els.nodes;
      const wake = () => this.requestFrame();
      // lanes and every link, faint: the heavy one (1.5 device pixels per pixel are plenty for it)
      this.base = new CachedLayer(els.base, (ctx, k) => this.paintBase(ctx, k), wake, 1.5);
      // the links of the selected card and of the hovered one, at full strength. A hub has hundreds
      // of them, so each set has a canvas of its own: moving the mouse repaints only the second.
      this.pinned = new CachedLayer(els.pinned, (ctx, k) => this.paintLinks(ctx, k, this.links.get(this.selected)), wake, 2);
      this.hot = new CachedLayer(els.hot, (ctx, k) => this.paintLinks(ctx, k, this.links.get(this.hovered)), wake, 2);
      this.labels = els.labels;   // lane names, repainted every frame (a dozen words)
      this.labelCtx = this.labels.getContext('2d');
      this.handlers = handlers;

      this.foci = [];         // topics the view grows from: one, or the roots of the tree
      this.focus = null;      // the single focused topic, if there is exactly one
      this.up = 2;
      this.down = 1;
      this.kinds = new Set(['dep', 'unlock', 'free', 'disable']);
      this.showItems = true;
      this.maxGen = UNLIMITED;   // how many generations past the available research to show
      this.groupSections = true; // one horizontal lane per ufopaedia section
      this.clusters = [];        // lanes of the last layout: [{section, left, top, w, h}]
      this.expansions = [];   // [{id, dir}] in the order the user opened them
      this.selected = null;   // node key: "t:<topic>" or "i:<item>"
      this.hovered = null;
      this.lit = new Set();   // keys of the hovered card and its neighbours

      this.view = { x: 0, y: 0, k: 1 };
      this.nodes = new Map(); // key -> {key, type, id, x, y, w, h, el?, mounted?}
      this.edges = [];        // [{from, to, kind, d, tip, path}]
      this.links = new Map(); // key -> the edges touching that node
      this.batches = {};      // kind -> {lines: Path2D, tips: Path2D} of all its edges, for the dim pass
      this.size = { w: 0, h: 0 };
      this.truncated = false;

      this.vw = 0;
      this.vh = 0;
      this.framePending = false;
      this.colors = null;
      new ResizeObserver(() => this.resize()).observe(this.viewport);
      this.resize();

      this.bindPanZoom();
      this.bindNodes();
    }

    // --- what to show ---------------------------------------------------------

    computeVisible() {
      const m = this.model;
      const walk = new Set(XS.WALK_KINDS.filter((k) => this.kinds.has(k)));
      const limit = this.groupSections ? MAX_NODES.lanes : MAX_NODES.flow;
      // With very many roots, half of the room is kept for what they lead to.
      const start = this.foci.slice(0, Math.max(1, limit >> 1));
      const vis = new Set(start);
      let truncated = start.length < this.foci.length;

      // Generation limit: beyond the researched topics, show only what is at most `maxGen`
      // steps past the research that is available or running in the loaded save.
      const gens = this.maxGen < UNLIMITED ? m.generations(walk) : null;
      const foci = new Set(this.foci);
      const allowed = (id) => {
        if (!gens || foci.has(id) || m.progress.done.has(id)) return true;
        const g = gens.get(id);
        return g != null && g <= this.maxGen;
      };

      const bfs = (dir, depth) => {
        let frontier = [...start];
        for (let d = 0; d < depth && frontier.length; d++) {
          const next = [];
          for (const id of frontier) {
            const list = dir < 0 ? m.parents(id, walk) : m.children(id, walk);
            for (const e of list) {
              const other = dir < 0 ? e.from : e.to;
              if (vis.has(other) || !allowed(other)) continue;
              if (vis.size >= limit) { truncated = true; return; }
              vis.add(other);
              next.push(other);
            }
          }
          frontier = next;
        }
      };
      bfs(-1, this.up);
      bfs(1, this.down);

      for (const { id, dir } of this.expansions) {
        if (!vis.has(id)) continue;
        const list = dir < 0 ? m.parents(id, walk) : m.children(id, walk);
        for (const e of list) {
          const other = dir < 0 ? e.from : e.to;
          if (allowed(other)) vis.add(other);
        }
      }

      const edges = [];
      for (const id of vis) {
        for (const e of m.out[id]) {
          if (this.kinds.has(e.kind) && vis.has(e.to)) edges.push({ from: `t:${id}`, to: `t:${e.to}`, kind: e.kind });
        }
      }

      const nodes = [];
      for (const id of vis) {
        nodes.push({
          key: `t:${id}`, type: 'topic', id, ...TOPIC,
          hiddenUp: m.parents(id, walk).filter((e) => !vis.has(e.from) && allowed(e.from)).length,
          hiddenDown: m.children(id, walk).filter((e) => !vis.has(e.to) && allowed(e.to)).length,
        });
        if (this.showItems && m.hasItem(id)) {
          nodes.push({ key: `i:${id}`, type: 'item', id, ...ITEM });
          edges.push({ from: `i:${id}`, to: `t:${id}`, kind: 'item' });
        }
      }
      return { nodes, edges, truncated, topicCount: vis.size };
    }

    // --- layout ---------------------------------------------------------------

    /** Positions the nodes and shapes the links; returns the size of the drawing. */
    layout(nodes, edges) {
      // Several foci are the roots of the tree: they get a column of their own.
      // (A long list of entry points is not stacked: those are just the first column of their lanes.)
      const roots = this.stacksRoots() ? new Set(this.foci.map((id) => `t:${id}`)) : null;
      this.clusters = [];
      const size = this.groupSections ? this.laneLayout(nodes, edges, roots) : this.flowLayout(nodes, edges, roots);
      const byKey = new Map(nodes.map((n) => [n.key, n]));
      for (const e of edges) {
        // 'disable' links take no part in the layout: they are arcs drawn over it
        if (!e.d) Object.assign(e, arcLink(byKey.get(e.from), byKey.get(e.to)));
      }
      return size;
    }

    /**
     * Plain layered layout with routed links (dagre). Thorough but slow on big, dense
     * neighbourhoods; used when grouping by section is switched off.
     */
    flowLayout(nodes, edges, roots) {
      const g = new dagre.graphlib.Graph({ multigraph: true });
      g.setGraph({
        rankdir: 'LR', nodesep: 12, edgesep: 6, ranksep: RANK_GAP, marginx: MARGIN, marginy: MARGIN,
        // network-simplex gives the tidiest ranks but is too slow for big neighbourhoods
        ranker: nodes.length > 140 ? 'tight-tree' : 'network-simplex',
      });
      g.setDefaultEdgeLabel(() => ({}));
      for (const n of nodes) g.setNode(n.key, { width: n.w, height: n.h });
      const links = edges.filter((e) => e.kind !== 'disable');
      for (const e of links) {
        const weight = e.kind === 'item' ? 6 : e.kind === 'dep' ? 2 : 1;
        // roots sit one rank further away, so the item nodes of their children do not share their column
        g.setEdge(e.from, e.to, { weight, minlen: roots && roots.has(e.from) ? 2 : 1 }, e.kind);
      }
      dagre.layout(g);
      for (const n of nodes) { const p = g.node(n.key); n.x = p.x; n.y = p.y; }
      for (const e of links) Object.assign(e, basisLink(g.edge(e.from, e.to, e.kind).points));
      if (roots) this.stackRoots(nodes, links, roots);
      const info = g.graph();
      return { w: info.width || 0, h: info.height || 0 };
    }

    /**
     * dagre puts every root at the middle of its own children, which scatters them over the
     * whole height. Stack them together instead and fan their links out as plain curves.
     */
    stackRoots(nodes, links, roots) {
      const byKey = new Map(nodes.map((n) => [n.key, n]));
      const list = nodes.filter((n) => roots.has(n.key)).sort((a, b) => a.y - b.y);
      const gap = 22;
      const middle = list.reduce((s, n) => s + n.y, 0) / list.length;
      const span = (list.length - 1) * (TOPIC.h + gap);
      // Pull the stack close to its children unless an item node sits in the way.
      let x = Math.min(...list.map((n) => n.x));
      const kids = links.filter((e) => roots.has(e.from)).map((e) => byKey.get(e.to).x);
      const near = Math.min(...kids) - TOPIC.w - 330;
      const band = span / 2 + TOPIC.h;
      const blocked = nodes.some((n) => !roots.has(n.key) && n.x < near + TOPIC.w && Math.abs(n.y - middle) < band);
      if (kids.length && near > x && !blocked) x = near;
      let y = middle - span / 2;
      for (const n of list) { n.x = x; n.y = y; y += TOPIC.h + gap; }
      for (const e of links) {
        if (roots.has(e.from)) Object.assign(e, cardLink(byKey.get(e.from), byKey.get(e.to)));
      }
    }

    /**
     * Groups the nodes by ufopaedia section. Columns run from prerequisites to consequences;
     * vertically every section gets a horizontal lane of its own, tall enough for its fullest
     * column. An item node shares its topic's id and so sits in the same lane. Roots stay
     * outside the lanes, stacked on the left.
     *
     * Done by hand rather than with dagre: the lanes dictate the vertical placement anyway, and
     * a direct ranking plus a few ordering sweeps take milliseconds where dagre needs a second.
     */
    laneLayout(nodes, edges, roots) {
      const m = this.model;
      const GAP = 12, HEAD = 36, FOOT = 16, BETWEEN = 16, SIDE = 26;
      const isRoot = (n) => !!roots && roots.has(n.key);
      const byKey = new Map(nodes.map((n) => [n.key, n]));
      const links = edges.filter((e) => e.kind !== 'disable');

      this.assignRanks(nodes, links, roots);
      const step = TOPIC.w + RANK_GAP;
      for (const n of nodes) n.x = MARGIN + TOPIC.w / 2 + n.rank * step;

      // The lanes keep one fixed order (biggest sections first, "no article" last),
      // so that a section is found in the same place in every view.
      const position = new Map(m.sections().map((s, i) => [s.id, s.id === '-' ? Infinity : i]));
      const lanes = new Map();
      let left = Infinity, right = -Infinity;
      nodes.forEach((n, seq) => {
        n.seq = seq;
        if (isRoot(n)) return;
        const section = m.topics[n.id].section || '-';
        let lane = lanes.get(section);
        if (!lane) lanes.set(section, (lane = { section, cols: new Map() }));
        if (!lane.cols.has(n.rank)) lane.cols.set(n.rank, []);
        lane.cols.get(n.rank).push(n);
        left = Math.min(left, n.x - n.w / 2);
        right = Math.max(right, n.x + n.w / 2);
      });
      const order = [...lanes.values()].sort((a, b) => position.get(a.section) - position.get(b.section));

      // stacks every lane's columns and returns the total height
      const place = () => {
        this.clusters = [];
        let y = MARGIN;
        for (const lane of order) {
          let inner = 0;
          for (const list of lane.cols.values()) {
            list.height = list.reduce((s, n) => s + n.h, 0) + GAP * (list.length - 1);
            inner = Math.max(inner, list.height);
          }
          for (const list of lane.cols.values()) {
            let top = y + HEAD + (inner - list.height) / 2;
            for (const n of list) { n.y = top + n.h / 2; top += n.h + GAP; }
          }
          const h = HEAD + inner + FOOT;
          const none = lane.section === '-';
          this.clusters.push({
            section: lane.section, left: left - SIDE, top: y, w: right - left + SIDE * 2, h,
            hue: none ? null : m.sectionHue(lane.section),
            label: (none ? t('noSection') : m.name(lane.section)).toUpperCase(),
          });
          y += h + BETWEEN;
        }
        return Math.max(y - BETWEEN, MARGIN) + MARGIN;
      };

      // Inside a column of a lane the nodes start in the order the walk found them, then a few
      // sweeps move each one towards the average height of what it is linked to (fewer crossings).
      const around = new Map(nodes.map((n) => [n.key, []]));
      for (const e of links) {
        around.get(e.from).push(byKey.get(e.to));
        around.get(e.to).push(byKey.get(e.from));
      }
      let height = place();
      for (let sweep = 0; sweep < 4; sweep++) {
        for (const n of nodes) {
          let sum = 0, count = 0;
          for (const other of around.get(n.key)) if (other.y != null) { sum += other.y; count++; }
          n.pull = count ? sum / count : n.y;
        }
        for (const lane of order) for (const list of lane.cols.values()) list.sort((a, b) => a.pull - b.pull || a.seq - b.seq);
        height = place();
      }

      if (roots) {
        const list = nodes.filter(isRoot).sort((a, b) => (a.pull ?? 0) - (b.pull ?? 0) || a.seq - b.seq);
        const gap = 22;
        if (left === Infinity) { left = MARGIN + SIDE + 300 + TOPIC.w; right = left; }
        const x = Math.max(Math.min(...list.map((n) => n.x)), left - SIDE - 300 - TOPIC.w / 2);
        let y = height / 2 - ((list.length - 1) * (TOPIC.h + gap)) / 2;
        for (const n of list) { n.x = x; n.y = y; y += TOPIC.h + gap; }
        height = Math.max(height, y + MARGIN);
      }

      for (const e of links) Object.assign(e, cardLink(byKey.get(e.from), byKey.get(e.to)));
      return { w: Math.max(right, 0) + SIDE + MARGIN, h: height };
    }

    /**
     * Gives every node a column (`rank`): after everything it depends on, and otherwise as
     * close to its neighbours as the links allow.
     */
    assignRanks(nodes, links, roots) {
      const index = new Map(nodes.map((n, i) => [n.key, i]));
      const count = nodes.length;
      const out = Array.from({ length: count }, () => []);
      const inc = Array.from({ length: count }, () => []);
      for (const e of links) {
        const link = {
          a: index.get(e.from), b: index.get(e.to), back: false,
          // roots sit one column further away, leaving the next one to their children's item nodes
          len: roots && roots.has(e.from) ? 2 : 1,
          weight: e.kind === 'item' ? 6 : e.kind === 'dep' ? 2 : 1,
        };
        out[link.a].push(link);
        inc[link.b].push(link);
      }

      // Depth-first walk: yields a topological order and marks the links that close a cycle.
      const state = new Uint8Array(count); // 0 new, 1 on the stack, 2 finished
      const order = [];
      for (let start = 0; start < count; start++) {
        if (state[start]) continue;
        state[start] = 1;
        const stack = [[start, 0]];
        while (stack.length) {
          const top = stack[stack.length - 1];
          const list = out[top[0]];
          if (top[1] < list.length) {
            const link = list[top[1]++];
            if (state[link.b] === 1) link.back = true;
            else if (state[link.b] === 0) { state[link.b] = 1; stack.push([link.b, 0]); }
          } else {
            state[top[0]] = 2;
            order.push(top[0]);
            stack.pop();
          }
        }
      }
      order.reverse(); // sources first

      // longest path from the sources...
      const rank = new Int32Array(count);
      for (const v of order) {
        for (const link of out[v]) if (!link.back) rank[link.b] = Math.max(rank[link.b], rank[v] + link.len);
      }

      // ...then let each node slide, within what its links allow, to the weighted median of
      // where its neighbours would like it. A few passes shorten the links considerably.
      const fixed = nodes.map((n) => !!roots && roots.has(n.key));
      const settle = (v) => {
        if (fixed[v]) return;
        let lo = -Infinity, hi = Infinity, total = 0;
        const wishes = [];
        for (const link of inc[v]) {
          if (link.back) continue;
          const r = rank[link.a] + link.len;
          lo = Math.max(lo, r);
          wishes.push([r, link.weight]);
          total += link.weight;
        }
        for (const link of out[v]) {
          if (link.back) continue;
          const r = rank[link.b] - link.len;
          hi = Math.min(hi, r);
          wishes.push([r, link.weight]);
          total += link.weight;
        }
        if (!wishes.length || lo > hi) return;
        wishes.sort((p, q) => p[0] - q[0]);
        let target = wishes[wishes.length - 1][0];
        let half = total / 2;
        for (const [r, weight] of wishes) {
          half -= weight;
          if (half <= 0) { target = r; break; }
        }
        rank[v] = Math.min(hi, Math.max(lo, target));
      };
      for (let pass = 0; pass < 3; pass++) {
        for (let i = count - 1; i >= 0; i--) settle(order[i]);
        for (const v of order) settle(v);
      }

      let min = Infinity;
      for (let i = 0; i < count; i++) min = Math.min(min, rank[i]);
      nodes.forEach((n, i) => { n.rank = rank[i] - min; });
    }

    // --- rendering ------------------------------------------------------------

    /** Rebuilds the view. `anchor` (node key) keeps that node where it is on screen. */
    rebuild(anchor) {
      if (!this.foci.length) return;
      const before = anchor && this.nodes.get(anchor);
      const beforePos = before ? this.toScreen(before.x, before.y) : null;

      const { nodes, edges, truncated, topicCount } = this.computeVisible();
      this.size = this.layout(nodes, edges);
      this.truncated = truncated;

      this.nodes = new Map(nodes.map((n) => [n.key, n]));
      this.edges = edges;
      this.prepareEdges();
      for (const layer of [this.base, this.pinned, this.hot]) layer.invalidate(); // new content
      this.nodesEl.replaceChildren(); // the cards are made again as they come into view
      this.hovered = null;
      this.lit = new Set();
      this.world.classList.remove('hovering');
      this.viewport.dataset.nodes = nodes.length;
      this.viewport.dataset.edges = edges.length;

      const after = anchor && this.nodes.get(anchor);
      if (beforePos && after) {
        this.view.x = beforePos.x - after.x * this.view.k;
        this.view.y = beforePos.y - after.y * this.view.k;
        this.applyView();
      } else {
        this.centerOnFoci();
      }
      this.frame();
      this.handlers.onRebuild({ truncated, topicCount });
    }

    /**
     * Canvas paths of the links. All links of a kind become one path for the dim pass (parsed in
     * one go); a link gets a path of its own only when it is first highlighted.
     */
    prepareEdges() {
      this.links = new Map();
      this.batches = {};
      const data = {};
      for (const e of this.edges) {
        let batch = this.batches[e.kind];
        if (!batch) {
          batch = this.batches[e.kind] = { lines: null, tips: new Path2D() };
          data[e.kind] = [];
        }
        data[e.kind].push(e.d);
        addTip(batch.tips, e.tip, 9);
        for (const key of [e.from, e.to]) {
          if (!this.links.has(key)) this.links.set(key, []);
          this.links.get(key).push(e);
        }
      }
      for (const kind of Object.keys(data)) this.batches[kind].lines = new Path2D(data[kind].join(''));
    }

    /** One step of drawing: moves the camera, keeps only the nearby cards in the page, brings the canvases along. */
    frame() {
      this.framePending = false;
      const { x, y, k } = this.view;
      this.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
      const far = k < FAR;
      if (far !== this.far) {
        this.far = far;
        this.viewport.classList.toggle('far', far);
      }
      this.syncNodes();
      this.base.place(this.view);
      this.pinned.place(this.view);
      this.hot.place(this.view);
      this.drawLabels();
    }

    requestFrame() {
      if (this.framePending) return;
      this.framePending = true;
      requestAnimationFrame(() => this.frame());
    }

    resize() {
      const r = this.viewport.getBoundingClientRect();
      this.vw = r.width;
      this.vh = r.height;
      this.dpr = window.devicePixelRatio || 1;
      this.labels.width = Math.max(1, Math.round(r.width * this.dpr));
      this.labels.height = Math.max(1, Math.round(r.height * this.dpr));
      for (const layer of [this.base, this.pinned, this.hot]) layer.resize(r.width, r.height, this.dpr);
      this.requestFrame();
    }

    /** Puts the cards near the viewport into the page and takes the others out. */
    syncNodes() {
      const { x, y, k } = this.view;
      const x0 = (-x - CULL_MARGIN) / k, x1 = (this.vw - x + CULL_MARGIN) / k;
      const y0 = (-y - CULL_MARGIN) / k, y1 = (this.vh - y + CULL_MARGIN) / k;
      for (const n of this.nodes.values()) {
        const near = n.x + n.w / 2 > x0 && n.x - n.w / 2 < x1 && n.y + n.h / 2 > y0 && n.y - n.h / 2 < y1;
        if (near && !n.mounted) {
          if (!n.el) n.el = this.makeNode(n);
          this.nodesEl.appendChild(n.el);
          n.mounted = true;
        } else if (!near && n.mounted) {
          n.el.remove();
          n.mounted = false;
        }
      }
    }

    /** Base layer: the section lanes and every link, faint. */
    paintBase(ctx, k) {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1 / k;
      for (const c of this.clusters) {
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(c.left, c.top, c.w, c.h, 12);
        else ctx.rect(c.left, c.top, c.w, c.h); // older browsers
        ctx.fillStyle = laneTint(c, 0.07);
        ctx.fill();
        ctx.strokeStyle = laneTint(c, 0.45);
        ctx.stroke();
        ctx.fillStyle = laneTint(c, 0.5);
        ctx.fillRect(c.left, c.top + 12, 4, c.h - 24);
      }

      // All links of a kind are one path: a single stroke, plain and thin. Their dash patterns
      // are left to the highlighted copies - at this opacity they are not seen, only paid for.
      const colors = this.edgeColors();
      ctx.globalAlpha = DIM;
      for (const kind of EDGE_KINDS) {
        const batch = this.batches[kind];
        if (!batch) continue;
        ctx.strokeStyle = colors[kind];
        ctx.fillStyle = colors[kind];
        ctx.lineWidth = Math.max(EDGE_STYLE[kind].width, 1 / k); // never thinner than a screen pixel
        ctx.stroke(batch.lines);
        ctx.fill(batch.tips);
      }
      ctx.globalAlpha = 1;
    }

    /** The links of one card at full strength (the selected card's, or the hovered one's). */
    paintLinks(ctx, k, list) {
      if (!list) return;
      const colors = this.edgeColors();
      // dashing hundreds of long curves is slow; with that many, colour alone has to tell the kinds apart
      const dashed = list.length <= MAX_DASHED;
      for (const e of list) {
        const style = EDGE_STYLE[e.kind];
        ctx.strokeStyle = colors[e.kind];
        ctx.fillStyle = colors[e.kind];
        ctx.lineCap = (dashed && style.cap) || 'butt';
        ctx.lineWidth = Math.max(2.4, 1.5 / k);
        ctx.setLineDash(dashed ? style.dash : []);
        if (!e.path) {
          e.path = new Path2D(e.d);
          e.head = new Path2D();
          addTip(e.head, e.tip, 10);
        }
        ctx.stroke(e.path);
        ctx.fill(e.head);
      }
      ctx.setLineDash([]);
    }

    /**
     * Lane names, drawn in screen space every frame: always readable, and they stay in view
     * while any part of their lane is on screen.
     */
    drawLabels() {
      const ctx = this.labelCtx, dpr = this.dpr;
      const { x, y, k } = this.view;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.labels.width, this.labels.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const size = Math.max(11, Math.min(15, 15 * k));
      ctx.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.letterSpacing = '1px';
      for (const c of this.clusters) {
        const sx = c.left * k + x, sy = c.top * k + y, sw = c.w * k, sh = c.h * k;
        if (sy > this.vh || sy + sh < 0 || sx > this.vw || sx + sw < 0) continue;
        const width = ctx.measureText(c.label).width;
        const lx = Math.min(Math.max(sx + 16 * k, 10), sx + sw - width - 10);
        const ly = Math.min(Math.max(sy + 9 * k, 6), sy + sh - size - 4);
        ctx.fillStyle = c.hue == null ? 'hsl(226 12% 76%)' : `hsl(${c.hue} 65% 78%)`;
        ctx.fillText(c.label, lx, ly);
      }
    }

    edgeColors() {
      if (!this.colors) {
        const css = getComputedStyle(document.documentElement);
        this.colors = Object.fromEntries(EDGE_KINDS.map((kind) => [kind, css.getPropertyValue(`--${kind}`).trim() || '#99a']));
      }
      return this.colors;
    }

    makeNode(n) {
      const m = this.model;
      const el = document.createElement('div');
      el.dataset.key = n.key;
      el.style.left = `${n.x - n.w / 2}px`;
      el.style.top = `${n.y - n.h / 2}px`;
      el.style.width = `${n.w}px`;
      el.style.height = `${n.h}px`;

      const body = document.createElement('div');
      body.className = 'body';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = m.name(n.id);
      const meta = document.createElement('div');
      meta.className = 'meta';
      body.append(title, meta);

      if (n.type === 'topic') {
        const topic = m.topics[n.id];
        const status = m.status(n.id);
        el.className = `node topic st-${status}`;
        if (this.foci.length <= MAX_STACKED && this.foci.includes(n.id)) el.classList.add('focus');
        el.title = `${m.name(n.id)}\n${n.id}`;
        el.appendChild(sprite(topic.icon, topic.iconKind));
        const state = m.state(n.id);
        if (state) el.classList.add(`p-${state}`);
        if (state === 'active' || state === 'paused') {
          // being researched: progress instead of the plain cost, plus a bar along the bottom
          const run = m.progress.active.get(n.id);
          meta.innerHTML = `${ICONS.flask}<span>${run.spent}/${run.cost}</span>`
            + (run.assigned ? `${ICONS.user}<span>${run.assigned}</span>` : '');
          const bar = document.createElement('div');
          bar.className = 'bar';
          const fill = document.createElement('i');
          fill.style.width = `${run.cost ? Math.min(100, Math.round((run.spent / run.cost) * 100)) : 0}%`;
          bar.appendChild(fill);
          el.appendChild(bar);
        } else if (status === 'locked') meta.innerHTML = ICONS.lock;
        else if (status === 'auto') meta.innerHTML = `${ICONS.bolt}<span>${XS.esc(t('auto'))}</span>`;
        else meta.innerHTML = `${ICONS.flask}<span>${topic.cost}</span>`;
        if (state === 'done') meta.insertAdjacentHTML('afterbegin', ICONS.check);
        if (topic.points) {
          // score awarded for finishing the research
          const pts = document.createElement('span');
          pts.className = 'points';
          pts.title = t('points');
          pts.innerHTML = `${ICONS.star}<span>${topic.points}</span>`;
          meta.appendChild(pts);
        }
        if (topic.baseFunc.length) {
          const f = document.createElement('span');
          f.className = 'func';
          f.textContent = topic.baseFunc.join(' · ');
          meta.appendChild(f);
        }
        el.appendChild(body);
        if (n.hiddenUp) el.appendChild(this.expander(n.hiddenUp, 'up'));
        if (n.hiddenDown) el.appendChild(this.expander(n.hiddenDown, 'down'));
      } else {
        const item = m.items[n.id];
        el.className = 'node item';
        el.title = `${t('item')}: ${m.name(n.id)}\n${n.id}`;
        el.appendChild(sprite(item.icon, 'item'));
        meta.innerHTML = `${ICONS.box}<span>${XS.esc(item.liveAlien ? t('prisoner') : t('item'))}</span>`;
        el.appendChild(body);
      }
      if (n.key === this.selected) el.classList.add('selected');
      if (this.lit.has(n.key)) el.classList.add('hl');
      return el;
    }

    expander(count, dir) {
      const b = document.createElement('button');
      b.className = `exp exp-${dir}`;
      b.dataset.exp = dir;
      b.textContent = `+${count}`;
      return b;
    }

    // --- selection and hover --------------------------------------------------

    setClass(key, name, on) {
      const n = this.nodes.get(key);
      if (n && n.el) n.el.classList.toggle(name, on);
    }

    select(key) {
      if (this.selected) this.setClass(this.selected, 'selected', false);
      this.selected = key;
      if (key) this.setClass(key, 'selected', true);
      this.pinned.invalidate();
      this.requestFrame();
    }

    hover(key) {
      if (key === this.hovered) return;
      this.hovered = key;
      const lit = new Set();
      if (key) {
        lit.add(key);
        for (const e of this.links.get(key) || []) { lit.add(e.from); lit.add(e.to); }
      }
      // only the cards whose state changes are touched
      for (const old of this.lit) if (!lit.has(old)) this.setClass(old, 'hl', false);
      for (const now of lit) if (!this.lit.has(now)) this.setClass(now, 'hl', true);
      this.lit = lit;
      this.world.classList.toggle('hovering', !!key);
      this.hot.invalidate();
      this.requestFrame();
    }

    bindNodes() {
      const keyOf = (ev) => {
        const el = ev.target.closest('.node');
        return el ? el.dataset.key : null;
      };
      this.nodesEl.addEventListener('click', (ev) => {
        if (this.dragged) return;
        const key = keyOf(ev);
        if (!key) return;
        const exp = ev.target.closest('.exp');
        if (exp) {
          this.expansions.push({ id: key.slice(2), dir: exp.dataset.exp === 'up' ? -1 : 1 });
          this.rebuild(key);
          return;
        }
        this.select(key);
        this.handlers.onSelect(key);
      });
      this.nodesEl.addEventListener('dblclick', (ev) => {
        const key = keyOf(ev);
        if (!key || ev.target.closest('.exp')) return;
        this.handlers.onOpen(key.slice(2));
      });
      this.nodesEl.addEventListener('mouseover', (ev) => this.hover(keyOf(ev)));
      this.nodesEl.addEventListener('mouseleave', () => this.hover(null));
    }

    // --- camera ---------------------------------------------------------------

    toScreen(x, y) {
      return { x: x * this.view.k + this.view.x, y: y * this.view.k + this.view.y };
    }

    /** The camera moved: everything that follows it is brought up to date on the next frame. */
    applyView() {
      this.handlers.onZoom(this.view.k);
      this.requestFrame();
    }

    centerOn(key) {
      const n = this.nodes.get(key);
      if (!n) return;
      this.view.x = this.vw / 2 - n.x * this.view.k;
      this.view.y = this.vh / 2 - n.y * this.view.k;
      this.applyView();
    }

    /** A handful of foci are the roots of the tree, stacked in a column of their own. */
    stacksRoots() { return this.foci.length > 1 && this.foci.length <= MAX_STACKED; }

    /** One focus goes to the middle; several (the roots) go to the left edge, zoomed out to fit. */
    centerOnFoci() {
      const ns = this.foci.map((id) => this.nodes.get(`t:${id}`)).filter(Boolean);
      if (ns.length < 2) { if (ns.length) this.centerOn(ns[0].key); return; }
      if (!this.stacksRoots()) {
        // a long first column: start at its first card, at a readable size
        const k = Math.min(this.view.k, 1);
        this.view.k = k;
        this.view.x = (60 + ns[0].w / 2 - ns[0].x) * k;
        this.view.y = this.vh / 2 - ns[0].y * k;
        this.applyView();
        return;
      }
      const top = Math.min(...ns.map((n) => n.y - n.h / 2)), bottom = Math.max(...ns.map((n) => n.y + n.h / 2));
      const x = ns.reduce((s, n) => s + n.x, 0) / ns.length;
      const k = Math.max(0.3, Math.min(this.view.k, 1, (this.vh - 120) / (bottom - top)));
      this.view.k = k;
      this.view.x = (36 + ns[0].w / 2 - x) * k;
      this.view.y = this.vh / 2 - ((top + bottom) / 2) * k;
      this.applyView();
    }

    fit() {
      if (!this.size.w || !this.size.h) return;
      const k = Math.max(ZOOM_MIN, Math.min(1, (this.vw - 24) / this.size.w, (this.vh - 24) / this.size.h));
      this.view.k = k;
      this.view.x = (this.vw - this.size.w * k) / 2;
      this.view.y = (this.vh - this.size.h * k) / 2;
      this.applyView();
    }

    zoomBy(factor, cx, cy) {
      if (cx == null) { cx = this.vw / 2; cy = this.vh / 2; }
      const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.view.k * factor));
      const f = k / this.view.k;
      this.view.x = cx - (cx - this.view.x) * f;
      this.view.y = cy - (cy - this.view.y) * f;
      this.view.k = k;
      this.applyView();
    }

    bindPanZoom() {
      const vp = this.viewport;
      let drag = null;
      vp.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 && ev.button !== 1) return;
        if (ev.target.closest('button, #legend, #zoom, #notice')) return;
        drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y };
        this.dragged = false;
      });
      vp.addEventListener('pointermove', (ev) => {
        if (!drag || ev.pointerId !== drag.id) return;
        const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
        if (!this.dragged && Math.hypot(dx, dy) < 4) return;
        if (!this.dragged) { this.dragged = true; vp.setPointerCapture(drag.id); vp.classList.add('panning'); }
        this.view.x = drag.vx + dx;
        this.view.y = drag.vy + dy;
        this.applyView();
      });
      const end = (ev) => {
        if (!drag || ev.pointerId !== drag.id) return;
        drag = null;
        vp.classList.remove('panning');
        // let the click that follows a drag be ignored, then re-arm
        setTimeout(() => { this.dragged = false; }, 0);
      };
      vp.addEventListener('pointerup', end);
      vp.addEventListener('pointercancel', end);
      vp.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const r = vp.getBoundingClientRect();
        const delta = ev.deltaMode === 1 ? ev.deltaY * 32 : ev.deltaY;
        this.zoomBy(Math.exp(-delta * 0.0014), ev.clientX - r.left, ev.clientY - r.top);
      }, { passive: false });
    }

    // --- state changes from the outside --------------------------------------

    /** @param {string|string[]} ids one topic to centre on, or several roots to grow the tree from */
    setFocus(ids) {
      this.foci = Array.isArray(ids) ? ids : [ids];
      this.focus = this.foci.length === 1 ? this.foci[0] : null;
      this.expansions = [];
      this.selected = this.focus ? `t:${this.focus}` : null;
      this.rebuild(null);
    }

    /** Key of the node that should stay put when the view is rebuilt in place. */
    anchor() { return `t:${this.foci[0]}`; }

    update(patch) {
      Object.assign(this, patch);
      this.rebuild(this.anchor());
    }
  }

  XS.Graph = Graph;
  XS.sprite = sprite;
  XS.ICONS = ICONS;
})();
