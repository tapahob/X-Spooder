# X-Spooder

Realtime X-Com (UFO Defense and mods) companion app showing the current state of your research tree.

Research tree viewer for OpenXcom Extended mods – built for
[X-Piratez](https://openxcom.org/forum/index.php/topic,3626.0.html), works with the other installed total
conversions too. It reads the rulesets, texts and saved games of your own game folder and shows the tree with
sprites, localized names and descriptions, the items a topic needs, and your progress.

All the work happens in the page. The same code runs in two forms:

- **Web site** – a handful of static files. The visitor picks their game folder and the browser reads it in
  place; nothing is uploaded, and the server only ever serves those static files.
- **Windows app** – the same page in an Electron window, which remembers the game folder in `config.cfg`.

## Publishing the web site

```
build.bat
```

puts the site into `dist\web\` (about 300 KB). Upload that folder to any web server – nginx, Apache, Caddy, a
static bucket; there is no backend, no database and nothing to run. Serve it over **HTTPS** (or `localhost`):
browsers only allow folder access on secure origins.

A minimal nginx block:

```nginx
server {
    listen 443 ssl;
    server_name spooder.example.com;
    root /var/www/x-spooder;          # the contents of dist/web
    index index.html;
    gzip on;
    gzip_types text/css application/javascript;
    location / { try_files $uri =404; expires 1h; }
}
```

What visitors get:

- Chrome, Edge, Opera: "Choose game folder" opens the system folder picker; the browser remembers the folder and
  on the next visit offers to continue with it (one click to confirm access).
- Firefox, Safari: the folder is chosen through a file-input dialog; the browser lists every file in it first
  (a few seconds for a full game install) and it has to be chosen again on each visit. Re-reading the newest
  save needs the folder to be chosen again there.
- Settings (mod, language, switches) are kept in the browser's local storage.

## Running the desktop app from source

```
npm install
npm start
```

On the first start the app asks for the game folder (for example `C:\Games\X-Piratez HD`). A folder that does
not hold the game is refused. The answer is saved to `config.cfg` in the program's own folder – the project root
when run with `npm start`, next to the exe for the built app (`build.bat` carries that file over to the new
build). The app asks again whenever `config.cfg` is missing or its `gameDir` no longer points at the game.
The folder button in the top-right corner switches to another installation. Nothing is written to the game folder.

```yaml
# config.cfg
gameDir: C:\Games\X-Piratez HD
mod: piratez        # only after choosing a mod by hand; id from the mod's metadata.yml
language: auto      # or a language code such as ru, en-US
useSubmods: true
```

If `npm install` fails while downloading the Electron binary, install with `npm install --ignore-scripts`,
download `electron-v<version>-win32-x64.zip` from the Electron releases page, unpack it into
`node_modules/electron/dist` and create `node_modules/electron/path.txt` containing `electron.exe`.

`build.bat` also builds the desktop app: `dist\X-Spooder-win32-x64\X-Spooder.exe`; the whole folder is the
application and can be copied anywhere. The Electron runtime zip is downloaded once into `.cache\` (with curl,
checksum-verified) and reused by later builds.

## Mods and language

The selector at the bottom of the left panel lists the master mods installed in the game folder: the ones in
`user\mods` (X-Piratez, X-Com Files, …) and the bundled `standard\xcom1` / `xcom2`. A mod whose original game is
missing from the folder (its `loadResources` in `metadata.yml`, e.g. `TFTD` for Terror From the Deep without a
`TFTD` folder) is not listed – the game could not run it either. Until one is chosen by hand,
the mod with the most recently written saved game is opened; if nothing has been saved yet, the first in the list.
Saves are read from `user\<mod id>`.

Texts are shown in the language selected in the game itself (`language` in `user\options.cfg`), with `en-US` filling
any gaps; the language selector overrides that, and its first entry goes back to following the game.

## Using the tree

- The app opens on the start of the tree. Its roots are worked out from the rules of whichever mod is open:
  every research project with no requirements at all – no dependencies, no `requires`, no item needed.
  (Zero-cost topics are left out: they are not projects, the game hands them out by itself.) The roots are
  stacked on the left, with what they lead to fanning out to the right. The house button or `Alt+Home`
  returns there.
- **All branches** adds the other entry points: topics that need no research and that nothing leads to, but that
  wait for an item, a prisoner or an event. Most mods hang the bulk of their research on these (from its three free
  projects the original UFO reaches 8 of 137 topics, X-Com Files 26 of 3526); X-Piratez funnels most of it through
  its four starting projects. So the switch is on by default for a mod whose free projects lead to less than half
  of its research, and off otherwise; flipping it is remembered per mod. Entry points that can be worked on with the
  loaded save come first, then the biggest branches.
- After focusing a topic, its prerequisites are on the left and what it leads to is on the right.
- Click a node for its description, double-click to move the focus there, `+N` badges reveal hidden neighbours.
- Drag to pan, wheel to zoom, `Ctrl+F` to search, `Alt+←/→` (or mouse back/forward) for history.
- Each node shows the research cost (flask) and the score it awards (star).
- With **Sections** switched on, nodes are grouped into one horizontal lane per ufopaedia section; columns still
  run from prerequisites to consequences. A whole mod fits (up to 6000 topics; X-Piratez with all branches and
  unlimited depth is 5900 nodes and 25000 links). Switch it off for the plain layered layout with routed edges
  (dagre); that one is slow on big trees, so it stops at 220 topics.
- Edge types: **requires** (all of them are needed), **unlocks** (any one is enough), **bonus** (`getOneFree`),
  **disables**, and **item** (the topic has `needItem` and the item exists).

## Progress from a saved game

The newest save (`.sav` or `.asav`) of the mod – for X-Piratez, `user\piratez` in the game folder – is read on start.
The selector at the bottom of the left panel picks another save or turns the overlay off, and the button next to it
re-reads the newest one. The save is never modified.

- **Green, slowly flowing** – researched (the save's `discovered` list).
- **Yellow** – can be started right now: not researched, costs research time, every `requires` is known, either all
  dependencies are known or one known topic unlocks it, the needed item is in a base's stores, and that base has
  the required facilities built.
- **Blue moving stripes with a progress bar** – on a base's research list; the stripes stand still when no
  scientists are assigned.
- **Red** – closed off for good: a researched topic `disables` it (the details name which one).

**Generations** in the toolbar limits how far past your current research the tree goes: generation 0 is what is
available or running now, 1 is what those lead to, and so on (shortest path over the enabled link types).
Researched topics and the focused one are always shown; the default is unlimited.

The state filter under the search box lists, for example, everything available now. Items in transfer or aboard a
craft are not counted.

## How the tree is drawn

Big trees (hundreds of topics, thousands of links) stay smooth because nothing large is ever handed to the
browser to paint:

- **Topic cards** are DOM elements, but only those near the viewport exist; the rest are created when they come
  into view. Zoomed far out, the cards drop their text and animation.
- **Links and section lanes** are painted on canvases a little larger than the viewport, once per camera
  position; panning just moves the finished picture, and it is repainted when the camera leaves the margin or a
  zoom has settled. All faint links of one kind are a single stroke.
- **Highlighted links** (of the selected card, of the hovered card) have canvases of their own, so moving the
  mouse repaints only a handful of curves.
- **The lane layout** is computed directly (ranking plus a few ordering sweeps) in a few milliseconds.

`npm run perf` measures all of this on a real game folder with real mouse input: rebuild time by phase, and
frames per second while idling, hovering, panning and zooming (`PERF_FOCUS=<topic id>`, `PERF_UP`, `PERF_DOWN`
pick the view, `PERF_FLAT=1` the dagre layout).

## What is read

| Source | Used for |
| --- | --- |
| the mod's master (its `master` in `metadata.yml`, usually `standard/xcom1`) | the rules the mod builds on |
| `<mod>/Ruleset/*.rul` | `research`, `items`, `manufacture`, `ufopaedia`, `armors`, `units`, `facilities`, `ufos`, `events`, `alienDeployments`, `extraSprites` |

Where a topic's picture comes from, in order: the item it needs (`bigSprite`, or the corpse of a prisoner's unit),
its ufopaedia article – the article art (`image_id`), a base facility's tile, a UFO's interception picture
(`modSprite`), an armour's inventory paperdoll (a single picture, or an OXCE layered one assembled from its
`<prefix>__<layer>__<name>` pictures for the first look) – then the picture of an article it reveals, and for
research about an alien mission (whose article is text only) the interception picture of a UFO flying that mission.
Topics with only a text article, and the game's internal flag topics, have none. The HD graphics pack is used by
the game engine itself and is not part of the rules, so the pictures are the mod's own.
| submods active in `user/options.cfg` whose `master` is the mod or `*` | same sections, layered on top (can be switched off) |
| `Language/<lang>.yml` of all the above plus `common/Language` | names and texts, with `en-US` as fallback; the game's own language by default |
| `UFO/UNITS/BIGOBS.PCK`, `UFO/GEOGRAPH/BASEBITS.PCK`, `UFO/GEOGRAPH/*.SPK`, `UFO/UFOGRAPH/*.SPK`, `UFO/GEODATA/INTERWIN.DAT` | for a mod built on `xcom1`: the item pictures, base facility tiles, ufopaedia art, armour paperdolls and UFO pictures it keeps from the original game (TFTD's own picture formats are not read) |

## Layout

- `src/renderer/` – the whole program; this folder *is* the web site.
  - `gamefs.js` – read-only, case-insensitive access to the game folder over three backends: a directory handle
    (folder picker), a file-input file list, and the desktop app's IPC.
  - `platform.js` – what differs between desktop and web: settings storage and how the folder is obtained.
  - `loader.js` – ruleset parsing and merging, builds the dataset; `saves.js` – saved game parsing;
    `images.js` – sprites as object URLs (palette index 0 transparency, original-game `.PCK` decoding).
  - `model.js` (graph, search, progress), `graph.js` (layout, drawing, pan/zoom), `details.js`, `app.js`, `i18n.js`.
  - `vendor/` – dagre and js-yaml, copied from `node_modules`.
- `src/main/main.js`, `preload.js` – desktop shell only: window, `config.cfg`, and read access to the game folder.
- `scripts/` – `build.js` (used by `build.bat`), `page-env.js` (runs the page's modules under Node),
  `inspect-data.js` (loader stats), `bench-layout.js` (layout timings), `screenshot.js` (desktop app screenshot,
  run via Electron), `web-test.js` (smoke test of the web version, run via Electron: `npm run web-test`),
  `perf.js` (rendering performance probe, run via Electron: `npm run perf`).
