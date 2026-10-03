'use strict';
// Performance probe of the desktop app with real mouse input, run through Electron:
//   electron scripts/perf.js            (uses config.cfg; PERF_FOCUS=<topic id> PERF_UP=2 PERF_DOWN=3 to choose the view)
// Reports how long a rebuild takes (by phase) and how smooth idling, hovering, panning and zooming are:
// frames per second seen by the page plus the main-thread time Chromium spent on script, style, layout and the rest.
const { app } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (name, fallback) => (process.env[name] != null ? process.env[name] : fallback);

app.on('browser-window-created', (_e, win) => {
  win.setContentSize(1600, 950);
  const wc = win.webContents;
  wc.on('console-message', (_ev, level, message) => { if (level >= 2) console.log('[page]', message); });
  wc.once('did-finish-load', async () => {
    try {
      await run(win);
    } catch (e) {
      console.error('perf run failed:', e);
    }
    app.quit();
  });
});

async function run(win) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  for (let i = 0; i < 200; i++) {
    if (await js('!document.querySelector("#app").hidden')) break;
    await sleep(100);
  }
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Performance.enable');
  const metrics = async () => {
    const { metrics: list } = await wc.debugger.sendCommand('Performance.getMetrics');
    return Object.fromEntries(list.map((m) => [m.name, m.value]));
  };

  // Time the phases of Graph.rebuild and count frames.
  await js(`(() => {
    const P = XS.Graph.prototype;
    window.__phase = {};
    for (const name of ['computeVisible', 'layout', 'prepareEdges', 'syncNodes', 'paintBase', 'paintLinks', 'drawLabels', 'frame', 'rebuild', 'hover']) {
      const original = P[name];
      if (!original) continue;
      P[name] = function (...args) {
        const t = performance.now();
        const result = original.apply(this, args);
        window.__phase[name] = (window.__phase[name] || 0) + performance.now() - t;
        return result;
      };
    }
    if (${JSON.stringify(env("PERF_NODRAW", ""))} === "1") { P.paintBase = function () {}; P.paintLinks = function () {}; }
    window.__frames = [];
    const tick = (t) => { window.__frames.push(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`);

  const setSelect = (sel, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(String(value))}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  // PERF_FLAT=1 measures the plain (dagre) layout instead of the section lanes
  await js(`(() => { const box = document.querySelector('#kind-toggles input[data-kind="group"]'); if (box.checked === ${env('PERF_FLAT', '') === '1'}) box.click(); })()`);
  // PERF_ALL=1 / PERF_ALL=0 forces the 'all branches' switch on or off
  if (env('PERF_ALL', '') !== '') await js(`(() => { const box = document.querySelector('#kind-toggles input[data-kind="all"]'); if (box.checked !== ${env('PERF_ALL', '') === '1'}) box.click(); })()`);
  await setSelect('#sel-gen', 99);
  await setSelect('#sel-up', env('PERF_UP', 2));
  await js('window.__phase = {}');
  const focus = env('PERF_FOCUS', '');
  if (focus) {
    await setSelect('#sel-down', env('PERF_DOWN', 1));
    await js('window.__phase = {}');
    await js(`(async () => {
      const s = document.querySelector('#search');
      s.value = ${JSON.stringify(focus)}; s.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 300));
      window.__phase = {};
      s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    })()`);
  } else {
    await setSelect('#sel-down', env('PERF_DOWN', 3));
  }
  await sleep(1500);

  const scene = await js(`({
    topics: document.querySelectorAll('.node.topic').length, items: document.querySelectorAll('.node.item').length,
    nodesInDom: document.querySelectorAll('.node').length,
    nodesTotal: +document.querySelector('#viewport').dataset.nodes, edges: +document.querySelector('#viewport').dataset.edges,
    done: document.querySelectorAll('.node.p-done').length, running: document.querySelectorAll('.node.p-active, .node.p-paused').length,
    domElements: document.querySelectorAll('#viewport *').length,
    zoom: document.querySelector('#zoom-level').textContent,
    phases: Object.fromEntries(Object.entries(window.__phase).map(([k, v]) => [k, Math.round(v)])),
  })`);
  console.log('scene:', JSON.stringify(scene));

  /** Runs `action` and reports frame pacing and main-thread cost while it runs. */
  async function measure(label, action) {
    await js('window.__frames.length = 0; window.__phase = {}');
    const before = await metrics();
    const started = Date.now();
    await action();
    const elapsed = (Date.now() - started) / 1000;
    const after = await metrics();
    const frames = await js('window.__frames.slice()');
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
    const pick = (q) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))] : 0);
    const d = (name) => Math.round((after[name] - before[name]) * 1000);
    const hover = await js('Math.round(window.__phase.hover || 0)');
    console.log(
      `${label.padEnd(26)} fps ${String(Math.round(frames.length / elapsed)).padStart(3)}`,
      `| frame ms: median ${pick(0.5).toFixed(1)}, p95 ${pick(0.95).toFixed(1)}, worst ${pick(1).toFixed(1)}`,
      `| main thread per second: ${Math.round(d('TaskDuration') / elapsed)} ms`,
      `(script ${Math.round(d('ScriptDuration') / elapsed)}, style ${Math.round(d('RecalcStyleDuration') / elapsed)}, layout ${Math.round(d('LayoutDuration') / elapsed)})`,
      hover ? `| hover() ${hover} ms total` : '',
    );
  }

  const box = await js(`(() => { const r = document.querySelector('#viewport').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const cx = Math.round(box.x + box.w / 2), cy = Math.round(box.y + box.h / 2);
  const mouse = (type, x, y, extra = {}) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), ...extra });

  async function pan(seconds) {
    // drag from a spot of bare background so that no node is clicked
    const spot = await js(`(() => {
      const r = document.querySelector('#viewport').getBoundingClientRect();
      for (let y = r.top + 40; y < r.bottom - 40; y += 23) for (let x = r.left + 40; x < r.right - 40; x += 37) {
        const el = document.elementFromPoint(x, y);
        if (el && (el.id === 'viewport' || el.id === 'world' || /^canvas-/.test(el.id))) return { x, y };
      }
      return { x: r.left + 50, y: r.top + 50 };
    })()`);
    mouse('mouseDown', spot.x, spot.y, { button: 'left', clickCount: 1 });
    const end = Date.now() + seconds * 1000;
    let t = 0;
    while (Date.now() < end) {
      t += 0.12;
      mouse('mouseMove', spot.x + Math.sin(t) * 260, spot.y + Math.cos(t * 0.7) * 170, { button: 'left', modifiers: ['leftButtonDown'] });
      await sleep(8);
    }
    mouse('mouseUp', spot.x, spot.y, { button: 'left', clickCount: 1 });
  }

  async function hover(seconds) {
    const spots = await js(`[...document.querySelectorAll('.node')].map((n) => n.getBoundingClientRect())
      .filter((r) => r.left > ${box.x} && r.right < ${box.x + box.w} && r.top > ${box.y} && r.bottom < ${box.y + box.h})
      .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))`);
    const end = Date.now() + seconds * 1000;
    for (let i = 0; Date.now() < end; i++) {
      const p = spots.length ? spots[i % spots.length] : { x: cx, y: cy };
      mouse('mouseMove', p.x, p.y);
      await sleep(60);
    }
    mouse('mouseMove', box.x + 5, box.y + 5);
  }

  async function zoom(seconds, direction) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      mouse('mouseWheel', cx, cy, { deltaX: 0, deltaY: direction * 40, canScroll: true });
      await sleep(16);
    }
  }

  await measure('idle (100%)', () => sleep(2000));
  await measure('hover nodes (100%)', () => hover(2.5));
  await measure('pan (100%)', () => pan(2.5));
  await measure('zoom out', () => zoom(1.2, -1));
  await sleep(400);
  console.log('zoom now:', await js(`document.querySelector('#zoom-level').textContent`));
  await measure('idle (zoomed out)', () => sleep(2000));
  await measure('hover nodes (zoomed out)', () => hover(2.5));
  await measure('pan (zoomed out)', () => pan(2.5));
  await measure('zoom in', () => zoom(1.2, 1));
  await sleep(300);

  // a full rebuild, the way toggling a switch or expanding a node triggers it
  await js('window.__phase = {}');
  const t0 = Date.now();
  await js(`document.querySelector('#kind-toggles input[data-kind="item"]').click()`);
  await js(`document.querySelector('#kind-toggles input[data-kind="item"]').click()`);
  await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  console.log('two rebuilds:', Date.now() - t0, 'ms wall |', JSON.stringify(await js(`Object.fromEntries(Object.entries(window.__phase).map(([k, v]) => [k, Math.round(v)]))`)));
}

require('../src/main/main.js');
