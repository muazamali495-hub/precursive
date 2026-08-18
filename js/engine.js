/* engine.js — NTPreCursive text engine (browser)
 *
 * Parses the TrueType font directly so we can use the data pdf-lib cannot see:
 *   - the legacy `kern` table (this font has no GPOS, so pdf-lib applies NO
 *     kerning at all; we read the 303 pairs ourselves)
 *   - the real coverage of the font, including the 41 glyphs that share a
 *     single hollow-rectangle "tofu" outline and are therefore unusable
 *
 * Everything here is pure computation — no DOM, no network.
 */
(function (global) {
  'use strict';

  function parseFont(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const u8 = o => dv.getUint8(o);
    const u16 = o => dv.getUint16(o);
    const i16 = o => dv.getInt16(o);
    const u32 = o => dv.getUint32(o);
    const tagAt = o => String.fromCharCode(u8(o), u8(o + 1), u8(o + 2), u8(o + 3));

    const T = {};
    const numTables = u16(4);
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      T[tagAt(o)] = { off: u32(o + 8), len: u32(o + 12) };
    }
    if (!T.glyf || !T.loca || !T.cmap || !T.head) throw new Error('Not a TrueType outline font.');

    const UPEM = u16(T.head.off + 18);
    const indexToLoc = i16(T.head.off + 50);
    const NG = u16(T.maxp.off + 4);
    const ASC = i16(T.hhea.off + 4);
    const DESC = i16(T.hhea.off + 6);
    const GAP = i16(T.hhea.off + 8);
    const XH = T['OS/2'] ? i16(T['OS/2'].off + 86) : Math.round(UPEM * 0.5);
    const CAP = T['OS/2'] ? i16(T['OS/2'].off + 88) : Math.round(UPEM * 0.7);

    const loca = new Array(NG + 1);
    for (let i = 0; i <= NG; i++)
      loca[i] = indexToLoc ? u32(T.loca.off + i * 4) : u16(T.loca.off + i * 2) * 2;

    const nhm = u16(T.hhea.off + 34);
    const ADV = new Array(NG);
    for (let i = 0; i < nhm; i++) ADV[i] = u16(T.hmtx.off + i * 4);
    for (let i = nhm; i < NG; i++) ADV[i] = ADV[nhm - 1];

    // --- cmap: prefer Windows Unicode (3,1), fall back to (0,x) ---
    let sub = null, fallback = null;
    const cm = T.cmap.off;
    for (let i = 0, n = u16(cm + 2); i < n; i++) {
      const o = cm + 4 + i * 8, pid = u16(o), eid = u16(o + 2), off = cm + u32(o + 4);
      if (pid === 3 && eid === 1) sub = off;
      else if (pid === 0 && fallback === null) fallback = off;
    }
    sub = sub || fallback;
    const CMAP = new Map();
    if (sub !== null && u16(sub) === 4) {
      const segX2 = u16(sub + 6), seg = segX2 / 2;
      const endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
      for (let s = 0; s < seg; s++) {
        const end = u16(endO + s * 2), start = u16(startO + s * 2);
        const delta = i16(deltaO + s * 2), ro = u16(rangeO + s * 2);
        if (start === 0xFFFF) continue;
        for (let ch = start; ch <= end; ch++) {
          let g;
          if (!ro) g = (ch + delta) & 0xFFFF;
          else {
            const gi = rangeO + s * 2 + ro + (ch - start) * 2;
            if (gi + 1 >= arrayBuffer.byteLength) continue;
            g = u16(gi);
            if (g) g = (g + delta) & 0xFFFF;
          }
          if (g) CMAP.set(ch, g);
        }
      }
    }

    // --- kern (format 0) : the whole reason this parser exists ---
    const KERN = new Map();
    if (T.kern) {
      const st = T.kern.off + 4;
      const nPairs = u16(st + 6);
      for (let i = 0; i < nPairs; i++) {
        const o = st + 14 + i * 6;
        KERN.set((u16(o) << 16 | u16(o + 2)) >>> 0, i16(o + 4));
      }
    }

    // --- outlines (cached, lazily built) ---
    const pathCache = new Map();
    function outline(g) {
      if (pathCache.has(g)) return pathCache.get(g);
      const s = loca[g], e = loca[g + 1];
      let out = '';
      if (e > s) {
        const go = T.glyf.off + s, nc = i16(go);
        if (nc > 0) {
          const ep = [];
          for (let k = 0; k < nc; k++) ep.push(u16(go + 10 + k * 2));
          const np = ep[nc - 1] + 1, il = u16(go + 10 + nc * 2);
          let o = go + 12 + nc * 2 + il;
          const fl = [];
          while (fl.length < np) {
            const f = u8(o++); fl.push(f);
            if (f & 8) { let r = u8(o++); while (r-- > 0) fl.push(f); }
          }
          const xs = []; let x = 0;
          for (let i = 0; i < np; i++) {
            const f = fl[i];
            if (f & 2) { const d = u8(o++); x += (f & 16) ? d : -d; }
            else if (!(f & 16)) { x += i16(o); o += 2; }
            xs.push(x);
          }
          const ys = []; let y = 0;
          for (let i = 0; i < np; i++) {
            const f = fl[i];
            if (f & 4) { const d = u8(o++); y += (f & 32) ? d : -d; }
            else if (!(f & 32)) { y += i16(o); o += 2; }
            ys.push(y);
          }
          let start = 0;
          for (let ci = 0; ci < nc; ci++) {
            const end = ep[ci], pts = [];
            for (let i = start; i <= end; i++) pts.push({ x: xs[i], y: ys[i], on: !!(fl[i] & 1) });
            start = end + 1;
            if (!pts.length) continue;
            let si = pts.findIndex(p => p.on);
            if (si < 0) {
              pts.unshift({ x: (pts[0].x + pts[pts.length - 1].x) / 2, y: (pts[0].y + pts[pts.length - 1].y) / 2, on: true });
              si = 0;
            }
            const ord = pts.slice(si).concat(pts.slice(0, si));
            out += 'M' + ord[0].x + ' ' + ord[0].y;
            let i = 1;
            while (i <= ord.length) {
              const cp = ord[i % ord.length];
              if (cp.on) { out += 'L' + cp.x + ' ' + cp.y; i++; }
              else {
                const nx = ord[(i + 1) % ord.length];
                const eP = nx.on ? nx : { x: (cp.x + nx.x) / 2, y: (cp.y + nx.y) / 2 };
                out += 'Q' + cp.x + ' ' + cp.y + ' ' + eP.x + ' ' + eP.y;
                i += nx.on ? 2 : 1;
              }
              if (i > ord.length) break;
            }
            out += 'Z';
          }
        }
      }
      pathCache.set(g, out);
      return out;
    }

    // --- coverage: find the shared "tofu" outline and blank zero-width glyphs ---
    const bySig = new Map();
    for (let g = 0; g < NG; g++) {
      const d = outline(g);
      if (!d) continue;
      if (!bySig.has(d)) bySig.set(d, []);
      bySig.get(d).push(g);
    }
    let biggest = [];
    bySig.forEach(v => { if (v.length > biggest.length) biggest = v; });
    // only treat it as tofu if a suspicious number of glyphs share one shape
    const TOFU = new Set(biggest.length >= 5 ? biggest : []);
    const BLANK = new Set();
    for (let g = 0; g < NG; g++) if (!outline(g) && ADV[g] === 0) BLANK.add(g);

    return {
      UPEM, ASC, DESC, GAP, XH, CAP, NG, CMAP, KERN, ADV, outline, TOFU, BLANK,
      usable(cp) {
        const g = CMAP.get(cp);
        return g !== undefined && !TOFU.has(g) && !BLANK.has(g);
      },
      gid(cp) { return CMAP.get(cp); },
      kern(a, b) { return KERN.get((a << 16 | b) >>> 0) || 0; }
    };
  }

  /* ---------- character folding ----------
   * The font has no accented letters at all, and 41 codepoints render as a
   * tofu box. Rather than emit garbage we substitute, and report every change.
   */
  const MAP = {
    ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '',
    '‑': '-', '‒': '–', '―': '—',
    'Æ': 'AE', 'æ': 'ae', 'Ø': 'O', 'ø': 'o', 'Ð': 'D', 'ð': 'd',
    'Þ': 'Th', 'þ': 'th', 'ß': 'ss', 'Œ': 'OE', 'œ': 'oe',
    'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬀ': 'ff',
    'Ł': 'L', 'ł': 'l', 'Š': 'S', 'š': 's', 'Ž': 'Z', 'ž': 'z', 'Ÿ': 'Y',
    'ı': 'i', 'ƒ': 'f', 'µ': 'u', 'Đ': 'D', 'đ': 'd',
    '¡': '!', '¿': '?', '«': '"', '»': '"', '‹': '<', '›': '>',
    '¼': '1/4', '½': '1/2', '¾': '3/4', '¹': '1', '²': '2', '³': '3',
    '™': '(TM)', '®': '(R)', '¢': 'c', '¥': 'Y', '¤': '$', '‰': '%%', '⁄': '/',
    '×': 'x', '÷': '/', '·': '.', '¬': '-', 'ª': 'a', 'º': 'o',
    '´': "'", '¨': '"', 'ˆ': '^', 'ˇ': 'v', '˘': '-', '˙': '.', '˚': 'o',
    '˛': ',', '˝': '"', '¸': ',', '˜': '~',
    '`': "'",              // U+0060 is blank AND zero-width in this font
    '\t': '    ', ' ': '\n', ' ': '\n',
    '→': '->', '←': '<-', '↔': '<->',
    '≈': '~', '≤': '<=', '≥': '>=', '≠': '!=',
    '‟': '"', '″': '"', '′': "'"
  };
  // em/en dash, degree, smart quotes, bullet, ellipsis, dagger, £ and € all
  // exist in this font and are deliberately NOT listed above.

  function fold(font, text) {
    const changes = new Map();   // original char -> {to, count}
    const lost = new Map();      // char -> count
    let out = '';
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    for (const ch of text) {
      if (ch === '\n') { out += ch; continue; }
      const cp = ch.codePointAt(0);
      if (font.usable(cp) && MAP[ch] === undefined) { out += ch; continue; }
      if (MAP[ch] !== undefined) {
        const rep = MAP[ch];
        if (!changes.has(ch)) changes.set(ch, { to: rep, count: 0 });
        changes.get(ch).count++;
        out += rep;
        continue;
      }
      const d = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (d && d !== ch && [...d].every(c => font.usable(c.codePointAt(0)))) {
        if (!changes.has(ch)) changes.set(ch, { to: d, count: 0 });
        changes.get(ch).count++;
        out += d;
        continue;
      }
      lost.set(ch, (lost.get(ch) || 0) + 1);
      out += '?';
    }
    return { text: out, changes, lost };
  }

  /* ---------- layout ---------- */
  function measure(font, str, sizePt) {
    const S = sizePt / font.UPEM;
    let w = 0, prev = -1;
    for (const ch of str) {
      const g = font.gid(ch.codePointAt(0));
      if (g === undefined) continue;
      if (prev >= 0) w += font.kern(prev, g);
      w += font.ADV[g];
      prev = g;
    }
    return w * S;
  }

  function wrap(font, text, sizePt, colWidth) {
    const lines = [];
    for (const para of text.split('\n')) {
      if (!para.trim()) { lines.push(''); continue; }
      let cur = '';
      for (let word of para.split(/(\s+)/)) {
        if (!word) continue;
        // a token wider than the column must break by character
        while (measure(font, word, sizePt) > colWidth && word.length > 1) {
          let cut = 1;
          while (cut < word.length && measure(font, word.slice(0, cut + 1), sizePt) <= colWidth) cut++;
          if (cur.trim()) { lines.push(cur.replace(/\s+$/, '')); cur = ''; }
          lines.push(word.slice(0, cut));
          word = word.slice(cut);
        }
        const trial = cur + word;
        if (measure(font, trial, sizePt) > colWidth && cur.trim()) {
          lines.push(cur.replace(/\s+$/, ''));
          cur = word.replace(/^\s+/, '');
        } else cur = trial;
      }
      lines.push(cur.replace(/\s+$/, ''));
    }
    return lines;
  }

  /* Build a kerned run for one line: a list of {text, kern} segments where
   * `kern` is the adjustment (in 1/1000 em, PDF TJ convention) that follows.
   */
  function kernRun(font, str) {
    const segs = [];
    let buf = '', prev = -1;
    const scale = 1000 / font.UPEM;
    for (const ch of str) {
      const g = font.gid(ch.codePointAt(0));
      if (g === undefined) continue;
      if (prev >= 0) {
        const k = font.kern(prev, g);
        if (k) { segs.push({ text: buf, kern: -k * scale }); buf = ''; }
      }
      buf += ch;
      prev = g;
    }
    if (buf) segs.push({ text: buf, kern: 0 });
    return segs;
  }

  function paginate(lines, linesPerPage) {
    const pages = [];
    for (let i = 0; i < lines.length; i += linesPerPage) pages.push(lines.slice(i, i + linesPerPage));
    return pages.length ? pages : [['']];
  }

  global.NTEngine = { parseFont, fold, measure, wrap, kernRun, paginate, MAP };
})(window);
