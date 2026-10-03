'use strict';
// CLI sanity check of the ruleset loader: node scripts/inspect-data.js [gameDir] [modId] [lang] [topicId]
// Without a mod id it takes the one the app would open: the mod with the newest save.
const { XS, openGame } = require('./page-env');

(async () => {
  const game = openGame(process.argv[2] || 'C:/Games/X-Piratez HD');
  const lang = process.argv[4] || 'ru';

  let t = Date.now();
  const mods = await XS.loader.listMods(game);
  console.log('mods:', mods.map((m) => `${m.id} (${m.name} ${m.version})`).join(' | '));
  let modId = process.argv[3];
  if (!modId) {
    let newest = 0;
    modId = mods[0].id;
    for (const m of mods) {
      const time = await XS.saves.newest(game, m.saveDir);
      if (time > newest) { newest = time; modId = m.id; }
    }
    console.log('newest save is in:', modId);
  }

  const layout = await XS.loader.resolveLayout(game, modId);
  console.log('layers:', layout.layers.map((l) => `${l.key}(${l.rulesets.length})`).join(' '), '| ufo:', layout.ufoDir);
  console.log('submods:', layout.submods.map((s) => s.id).join(', '));
  const data = await XS.loader.build(game, layout);
  console.log(`build: ${Date.now() - t} ms`);
  t = Date.now();
  const { strings, translated, total } = await XS.loader.loadStrings(game, layout, lang, data.stringKeys);
  console.log(`strings(${lang}): ${Date.now() - t} ms, ${translated}/${total} translated of ${data.stringKeys.length} keys`);
  console.log('languages:', (await XS.loader.availableLanguages(game, layout)).join(' '), '| game language:', await XS.loader.gameLanguage(game, layout));

  const topics = Object.values(data.topics);
  const n = (f) => topics.filter(f).length;
  console.log({
    topics: topics.length,
    needItem: n((x) => x.needItem),
    withIcon: n((x) => x.icon),
    needItemWithItemIcon: n((x) => x.needItem && data.items[x.id] && data.items[x.id].icon),
    needItemMissingItem: n((x) => x.needItem && !data.items[x.id].exists),
    withArticle: n((x) => x.article),
    named: n((x) => strings[x.id]),
    zeroCost: n((x) => !x.cost),
    edges: topics.reduce((s, x) => s + x.deps.length + x.unlocks.length + x.free.length, 0),
    dangling: data.meta.dangling,
    items: Object.keys(data.items).length,
    manufacture: Object.keys(data.manufacture).length,
    articles: Object.keys(data.articles).length,
    jsonMB: +(JSON.stringify(data).length / 1e6).toFixed(2),
  });
  const kinds = {};
  for (const x of topics) kinds[x.iconKind] = (kinds[x.iconKind] || 0) + 1;
  console.log('icon kinds:', kinds, '| original-game sprites:', n((x) => x.icon && x.icon.pck));

  const saves = await XS.saves.list(game, layout.saveDir);
  console.log('saves:', saves.map((s) => s.file).join(', ') || 'none');
  if (saves.length) {
    const model = new XS.Model(data, strings);
    model.setProgress(await XS.saves.load(game, layout.saveDir, saves[0].file));
    const p = model.progress;
    console.log(`progress (${saves[0].file}): researched ${p.done.size}, available ${p.available.size}, in progress ${p.active.size}`);
  }

  const sample = process.argv[5] || Object.keys(data.topics)[0];
  console.log(JSON.stringify(data.topics[sample], null, 1));
  console.log(strings[sample], '\n', (strings[`${sample}_UFOPEDIA`] || '').slice(0, 300));
})().catch((e) => { console.error(e); process.exit(1); });
