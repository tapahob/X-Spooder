'use strict';
// Times the tree layout on real neighbourhoods: node scripts/bench-layout.js [gameDir] [modId] [flat]
// Uses the page's model and layout code (rendering is not touched).
const { XS, openGame } = require('./page-env');

(async () => {
  const game = openGame(process.argv[2] || 'C:/Games/X-Piratez HD');
  const layout = await XS.loader.resolveLayout(game, process.argv[3] || 'piratez');
  const data = await XS.loader.build(game, layout);
  const { strings } = await XS.loader.loadStrings(game, layout, 'ru', data.stringKeys);
  const model = new XS.Model(data, strings);
  const G = XS.Graph.prototype;

  const hubs = model.ids
    .map((id) => [id, model.inc[id].length + model.out[id].length])
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);
  const cases = [
    [model.startTopics(), 0, 1], [model.startTopics(), 0, 2],
    ...hubs.map((id) => [id, 2, 1]), [hubs[0], 99, 1], [hubs[1], 2, 3],
  ];
  for (const [focus, up, down] of cases) {
    const foci = [].concat(focus);
    const self = Object.assign(Object.create(G), {
      model, foci, up, down, maxGen: 99, kinds: new Set(['dep', 'unlock', 'free', 'disable']),
      showItems: true, expansions: [], groupSections: process.argv[4] !== 'flat',
    });
    const v = self.computeVisible();
    const t = Date.now();
    const size = self.layout(v.nodes, v.edges);
    console.log(
      (foci.length > 1 ? `<${foci.length} roots>` : foci[0]).padEnd(34), `up=${up} down=${down}`,
      `nodes=${v.nodes.length} edges=${v.edges.length} trunc=${v.truncated}`, `${Date.now() - t} ms`,
      `${Math.round(size.w)}x${Math.round(size.h)}`, 'lanes:', self.clusters.length,
    );
  }
})().catch((e) => { console.error(e); process.exit(1); });
