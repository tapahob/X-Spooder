'use strict';
// Turns the loader's sprite references into object URLs, reading the picture from the game
// folder on demand. OpenXcom treats palette index 0 as transparent no matter what the file
// says, so sprites get that patched in; sprites of the original game (.PCK) are decoded.
(function () {
  window.XS = window.XS || {};
  const { join } = XS.path;

  // --- PNG / GIF transparency -------------------------------------------------

  const CRC = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC[n] = c >>> 0;
  }
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
  const isPng = (b) => b.length > 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG';
  const isGif = (b) => b.length > 6 && ascii(b, 0, 3) === 'GIF';

  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /** Paletted PNG without tRNS: add one so index 0 becomes transparent. */
  function keyPng(b) {
    if (b.length < 33 || b[25] !== 3) return b; // not indexed colour
    let p = 8, afterPlte = -1;
    while (p + 12 <= b.length) {
      const len = u32(b, p);
      const type = ascii(b, p + 4, p + 8);
      if (type === 'tRNS') return b;
      if (type === 'PLTE') afterPlte = p + 12 + len;
      if (type === 'IDAT') break;
      p += 12 + len;
    }
    if (afterPlte < 0) return b;
    const body = new Uint8Array([0x74, 0x52, 0x4e, 0x53, 0]); // "tRNS" + alpha 0 for index 0
    const crc = crc32(body);
    const chunk = concat(new Uint8Array([0, 0, 0, 1]), body, new Uint8Array([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]));
    return concat(b.subarray(0, afterPlte), chunk, b.subarray(afterPlte));
  }

  /** GIF: make sure the first frame declares index 0 as transparent. */
  function keyGif(b) {
    if (b.length < 14) return b;
    const flags = b[10];
    let p = 13 + (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0);
    while (p < b.length) {
      if (b[p] === 0x21 && b[p + 1] === 0xf9) {
        if (b[p + 3] & 1) return b;
        const out = b.slice();
        out[p + 3] |= 1;
        out[p + 6] = 0;
        return out;
      }
      if (b[p] === 0x21) { // some other extension - skip its sub-blocks
        p += 2;
        while (p < b.length && b[p]) p += b[p] + 1;
        p++;
      } else if (b[p] === 0x2c) {
        const gce = new Uint8Array([0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00]);
        return concat(b.subarray(0, p), gce, b.subarray(p));
      } else {
        break;
      }
    }
    return b;
  }

  function mimeOf(file, b) {
    if (isPng(b)) return 'image/png';
    if (isGif(b)) return 'image/gif';
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    return { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
  }

  // --- the original game's sprites --------------------------------------------

  const PCK_SETS = {
    'BIGOBS.PCK': { dir: 'UNITS', w: 32, h: 48, palette: 4 },   // item pictures, battlescape colours
    'BASEBITS.PCK': { dir: 'GEOGRAPH', w: 32, h: 40, palette: 1 }, // base facility tiles, basescape colours
  };

  // PALETTES.DAT: 5 palettes of 256 RGB triplets (6 bit) + 6 padding bytes each.
  const PAL_GEOSCAPE = 0, PAL_UFOPAEDIA = 3, PAL_BATTLESCAPE = 4;

  /**
   * Decodes a 320x200 .SPK picture into RGBA pixels: ufopaedia art (GEOGRAPH, ufopaedia colours)
   * or an inventory paperdoll (UFOGRAPH, battlescape colours, colour 0 transparent).
   */
  function decodeSpk(spk, palette, paletteIndex, clear) {
    const w = 320, h = 200, off = paletteIndex * (768 + 6);
    const px = new Uint8Array(w * h);
    let o = 0, p = 0;
    const word = () => { const v = spk[p] | (spk[p + 1] << 8); p += 2; return v; };
    while (p + 1 < spk.length && o < px.length) {
      const flag = word();
      if (flag === 0xffff) o += word() * 2;          // skip (colour 0)
      else if (flag === 0xfffe) {                    // literal pixels
        const n = word() * 2;
        for (let i = 0; i < n && o < px.length; i++) px[o++] = spk[p++];
      } else if (flag === 0xfffd) break;             // end
    }
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < px.length; i++) {
      if (clear && !px[i]) continue;
      const c = px[i] * 3 + off;
      rgba[i * 4] = palette[c] * 4;
      rgba[i * 4 + 1] = palette[c + 1] * 4;
      rgba[i * 4 + 2] = palette[c + 2] * 4;
      rgba[i * 4 + 3] = 255;
    }
    return { rgba, w, h };
  }

  /**
   * GEODATA/INTERWIN.DAT is one raw 160x556 picture: the interception window (96 rows), its
   * minimised form (44 rows), then the original game's eight UFOs, 52 rows each with a range
   * ruler on top. Returns UFO `index` as RGBA, colour 0 transparent.
   */
  function decodeInterwin(dat, palette, index) {
    const w = 160, h = 52, top = 96 + 44 + index * h, off = PAL_GEOSCAPE * (768 + 6);
    if (index < 0 || (top + h) * w > dat.length) return null;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = dat[top * w + i];
      if (!v) continue;
      rgba[i * 4] = palette[off + v * 3] * 4;
      rgba[i * 4 + 1] = palette[off + v * 3 + 1] * 4;
      rgba[i * 4 + 2] = palette[off + v * 3 + 2] * 4;
      rgba[i * 4 + 3] = 255;
    }
    return { rgba, w, h };
  }

  /** Decodes one sprite of a vanilla .PCK set into RGBA pixels. */
  function decodePck(pck, tab, palette, paletteIndex, index, w, h) {
    if (index < 0 || (index + 1) * 2 > tab.length) return null;
    let p = tab[index * 2] | (tab[index * 2 + 1] << 8);
    const px = new Uint8Array(w * h);
    let o = pck[p++] * w; // leading blank rows
    while (p < pck.length) {
      const v = pck[p++];
      if (v === 0xff) break;
      if (v === 0xfe) o += pck[p++];
      else if (o < px.length) px[o++] = v;
    }
    const off = paletteIndex * (768 + 6);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < px.length; i++) {
      const c = px[i];
      if (!c) continue; // index 0 stays transparent
      rgba[i * 4] = palette[off + c * 3] * 4;
      rgba[i * 4 + 1] = palette[off + c * 3 + 1] * 4;
      rgba[i * 4 + 2] = palette[off + c * 3 + 2] * 4;
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  /** RGBA pixels as a PNG object URL. */
  async function toUrl(rgba, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? URL.createObjectURL(blob) : null;
  }

  // --- the store --------------------------------------------------------------

  class Images {
    constructor(fs, layout) {
      this.fs = fs;
      this.dirs = Object.fromEntries(layout.layers.map((l) => [l.key, l.dir]));
      this.order = layout.layers.map((l) => l.key).reverse();
      this.ufoDir = layout.ufoDir;
      this.urls = new Map();  // reference key -> Promise<object URL | null>
      this.pck = new Map();   // set name -> Promise<{pck, tab, palette}>
    }

    /** Object URL of the picture, or null if it cannot be found. Cached per reference. */
    url(ref) {
      const key = Images.key(ref);
      if (!this.urls.has(key)) {
        const load = ref.layers ? this.stack(ref) : ref.interwin != null ? this.interwin(ref)
          : ref.spk ? this.picture(ref) : ref.pck ? this.vanilla(ref) : this.modFile(ref);
        this.urls.set(key, load.catch(() => null));
      }
      return this.urls.get(key);
    }

    static key(ref) {
      if (ref.layers) return `layers|${ref.layers.map(Images.key).join('+')}`;
      if (ref.interwin != null) return `interwin|${ref.interwin}`;
      return ref.spk ? `spk|${ref.dir || ''}|${ref.spk}` : ref.pck ? `pck|${ref.pck}|${ref.i}` : `${ref.l}|${ref.f}|${ref.k ? 1 : 0}`;
    }

    /** A layered paperdoll: its pictures drawn over each other, bottom layer first. */
    async stack(ref) {
      const pictures = await Promise.all(ref.layers.map(async (layer) => {
        const url = await this.url(layer);
        if (!url) return null;
        const img = new Image();
        img.src = url;
        try { await img.decode(); return img; } catch { return null; }
      }));
      const present = pictures.filter(Boolean);
      if (!present.length) return null;
      const canvas = document.createElement('canvas');
      canvas.width = present[0].naturalWidth;
      canvas.height = present[0].naturalHeight;
      const ctx = canvas.getContext('2d');
      for (const img of present) ctx.drawImage(img, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return blob ? URL.createObjectURL(blob) : null;
    }

    async modFile(ref) {
      // OpenXcom overlays mod folders, so a file may physically live in another layer.
      for (const layer of [ref.l, ...this.order.filter((k) => k !== ref.l)]) {
        const f = await this.fs.file(join(this.dirs[layer], ref.f));
        if (!f) continue;
        let bytes = await f.bytes();
        const mime = mimeOf(ref.f, bytes);
        if (ref.k) bytes = mime === 'image/png' ? keyPng(bytes) : mime === 'image/gif' ? keyGif(bytes) : bytes;
        return URL.createObjectURL(new Blob([bytes], { type: mime }));
      }
      return null;
    }

    palette() {
      if (!this.paletteData) this.paletteData = this.fs.bytes(join(this.ufoDir, 'GEODATA', 'PALETTES.DAT'));
      return this.paletteData;
    }

    /** An original ufopaedia picture (GEOGRAPH/UPnnn.SPK). */
    async picture(ref) {
      if (!this.ufoDir) return null;
      const dir = ref.dir || 'GEOGRAPH';
      const [spk, palette] = await Promise.all([this.fs.bytes(join(this.ufoDir, dir, ref.spk)), this.palette()]);
      const paperdoll = dir.toUpperCase() === 'UFOGRAPH';
      const { rgba, w, h } = decodeSpk(spk, palette, paperdoll ? PAL_BATTLESCAPE : PAL_UFOPAEDIA, paperdoll);
      return toUrl(rgba, w, h);
    }

    /** An original UFO, as in the interception window. */
    async interwin(ref) {
      if (!this.ufoDir) return null;
      const [dat, palette] = await Promise.all([this.fs.bytes(join(this.ufoDir, 'GEODATA', 'INTERWIN.DAT')), this.palette()]);
      const frame = decodeInterwin(dat, palette, ref.interwin);
      return frame ? toUrl(frame.rgba, frame.w, frame.h) : null;
    }

    async vanilla(ref) {
      const set = PCK_SETS[ref.pck];
      if (!set || !this.ufoDir) return null;
      if (!this.pck.has(ref.pck)) {
        const base = join(this.ufoDir, set.dir, ref.pck.replace(/\.pck$/i, ''));
        this.pck.set(ref.pck, Promise.all([this.fs.bytes(`${base}.PCK`), this.fs.bytes(`${base}.TAB`), this.palette()]));
      }
      const [pck, tab, palette] = await this.pck.get(ref.pck);
      const rgba = decodePck(pck, tab, palette, set.palette, ref.i, set.w, set.h);
      return rgba ? toUrl(rgba, set.w, set.h) : null;
    }

    /** Frees every object URL (call when another mod or folder is loaded). */
    dispose() {
      for (const p of this.urls.values()) p.then((u) => { if (u) URL.revokeObjectURL(u); });
      this.urls.clear();
    }
  }

  XS.Images = Images;
  XS.images = null; // the store of the mod on screen, set by the app
})();
