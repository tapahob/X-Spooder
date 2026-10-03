'use strict';
// Builds both forms of the program:
//   dist/web/                  - the static web site (plain files, upload them to any web server);
//   dist/<name>-win32-x64/     - the Windows desktop app, packaged with @electron/packager.
// The Electron runtime zip is kept in .cache/ and fetched with curl when missing,
// because Node's own downloader is unreliable on some networks.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const electronVersion = require('electron/package.json').version;
const arch = 'x64';
const cacheDir = path.join(root, '.cache');
const zipName = `electron-v${electronVersion}-win32-${arch}.zip`;
const zipPath = path.join(cacheDir, zipName);
const releaseUrl = `https://github.com/electron/electron/releases/download/v${electronVersion}`;

function curl(url, dest) {
  execFileSync('curl.exe', ['-fSL', '--retry', '8', '--retry-all-errors', '--retry-delay', '3', '-C', '-', '-o', dest, url], { stdio: 'inherit' });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureElectronZip() {
  fs.mkdirSync(cacheDir, { recursive: true });
  const sums = path.join(cacheDir, `SHASUMS256-v${electronVersion}.txt`);
  if (!fs.existsSync(zipPath)) {
    console.log(`Downloading ${zipName}...`);
    curl(`${releaseUrl}/${zipName}`, zipPath);
  }
  if (!fs.existsSync(sums)) curl(`${releaseUrl}/SHASUMS256.txt`, sums);
  const line = fs.readFileSync(sums, 'utf8').split(/\r?\n/).find((l) => l.endsWith(zipName));
  if (!line || line.split(/\s+/)[0] !== sha256(zipPath)) {
    fs.rmSync(zipPath, { force: true });
    throw new Error(`Checksum mismatch for ${zipName} - deleted it, run the build again.`);
  }
}

/** The web version is the page itself: src/renderer copied as is. */
function buildWeb() {
  const out = path.join(root, 'dist', 'web');
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'src', 'renderer'), out, { recursive: true });
  const files = fs.readdirSync(out, { recursive: true }).filter((f) => fs.statSync(path.join(out, f)).isFile());
  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
  console.log(`Web site: ${out} (${files.length} files, ${Math.round(bytes / 1024)} KB)`);
}

async function main() {
  buildWeb();
  ensureElectronZip();
  const { packager } = await import('@electron/packager');
  // config.cfg lives next to the exe and the output folder is replaced - carry it over
  const name = pkg.productName || pkg.name;
  const appDir = path.join(root, 'dist', `${name}-win32-${arch}`);
  const oldConfig = path.join(appDir, 'config.cfg');
  const keptConfig = fs.existsSync(oldConfig) ? fs.readFileSync(oldConfig) : null;
  // A running copy locks its exe; replacing the folder under it would fail half-way.
  const exe = path.join(appDir, `${name}.exe`);
  if (fs.existsSync(exe)) {
    try {
      fs.closeSync(fs.openSync(exe, 'r+'));
    } catch {
      throw new Error(`${name} is running - close it and run the build again (the web site above is already built).`);
    }
  }
  const [out] = await packager({
    dir: root,
    out: path.join(root, 'dist'),
    name: pkg.productName || pkg.name,
    platform: 'win32',
    arch,
    electronVersion,
    electronZipDir: cacheDir,
    asar: true,
    overwrite: true,
    prune: true,
    ignore: [/^\/(dist|scripts|\.cache|\.claude|\.vscode)($|\/)/, /^\/(build\.bat|README\.md|\.gitignore|config\.cfg)$/],
    appCopyright: 'MIT',
    win32metadata: { CompanyName: 'X-Spooder', FileDescription: pkg.productName || pkg.name },
  });
  if (keptConfig) fs.writeFileSync(path.join(out, 'config.cfg'), keptConfig);
  console.log(`\nBuilt: ${path.join(out, `${pkg.productName || pkg.name}.exe`)}`);
}

main().catch((e) => {
  console.error(`\nBuild failed: ${e.message}`);
  process.exit(1);
});
