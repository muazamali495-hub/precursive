/* import.js — turn an uploaded document into editor HTML.
 *
 * Supports .txt/.md (trivial), .docx (real formatting), and .pdf (best effort).
 *
 * No libraries are used. A .docx is a ZIP, and browsers can already inflate
 * raw deflate streams via DecompressionStream, so the archive is unpacked by
 * hand rather than pulling in a ZIP dependency. PDF text is recovered from the
 * page content streams with pdf-lib, which is already vendored here.
 */
(function (global) {
  'use strict';

  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  /* ---------------- ZIP (for .docx) ---------------- */

  async function inflateRaw(bytes) {
    if (!bytes.length) return new Uint8Array(0);
    const ds = new DecompressionStream('deflate-raw');
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }

  /* Read one named entry out of a ZIP. Walks the central directory rather
     than scanning, so it is not fooled by data that looks like a header. */
  async function zipRead(bytes, wanted) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // End of Central Directory: signature 0x06054b50, within the last 64KB
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .docx (no ZIP directory found)');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);

    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const cmtLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

      if (name === wanted) {
        // local header tells us the real offset of the data
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const data = bytes.subarray(start, start + compSize);
        return method === 0 ? data : await inflateRaw(data);
      }
      p += 46 + nameLen + extraLen + cmtLen;
    }
    throw new Error('Could not find ' + wanted + ' inside the file');
  }

  /* ---------------- DOCX ---------------- */

  const HALF_PT = v => Math.max(1, Math.min(300, Math.round(parseFloat(v) / 2)));

  function docxToHtml(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('The document XML could not be read');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const paras = doc.getElementsByTagNameNS(W, 'p');
    const out = [];
    let listOpen = null;

    for (const p of paras) {
      const pPr = p.getElementsByTagNameNS(W, 'pPr')[0];
      let align = '';
      let isList = false;
      if (pPr) {
        const j = pPr.getElementsByTagNameNS(W, 'jc')[0];
        const a = j && j.getAttributeNS(W, 'val');
        if (a === 'center' || a === 'right' || a === 'both') align = (a === 'both' ? 'justify' : a);
        isList = !!pPr.getElementsByTagNameNS(W, 'numPr')[0];
      }

      // build the runs
      let html = '';
      const runs = p.getElementsByTagNameNS(W, 'r');
      for (const r of runs) {
        const rPr = r.getElementsByTagNameNS(W, 'rPr')[0];
        let text = '';
        for (const child of r.childNodes) {
          if (child.namespaceURI !== W) continue;
          if (child.localName === 't') text += child.textContent;
          else if (child.localName === 'tab') text += '    ';
          else if (child.localName === 'br') text += '\n';
        }
        if (!text) continue;

        let open = '', close = '';
        if (rPr) {
          const has = n => {
            const e = rPr.getElementsByTagNameNS(W, n)[0];
            if (!e) return false;
            const v = e.getAttributeNS(W, 'val');
            return v !== '0' && v !== 'false' && v !== 'none';
          };
          if (has('b')) { open += '<b>'; close = '</b>' + close; }
          if (has('i')) { open += '<i>'; close = '</i>' + close; }
          if (has('u')) { open += '<u>'; close = '</u>' + close; }
          if (has('strike')) { open += '<s>'; close = '</s>' + close; }
          const style = [];
          const sz = rPr.getElementsByTagNameNS(W, 'sz')[0];
          if (sz && sz.getAttributeNS(W, 'val')) style.push('font-size:' + HALF_PT(sz.getAttributeNS(W, 'val')) + 'px');
          const col = rPr.getElementsByTagNameNS(W, 'color')[0];
          const cv = col && col.getAttributeNS(W, 'val');
          if (cv && /^[0-9a-f]{6}$/i.test(cv) && cv.toLowerCase() !== '000000') style.push('color:#' + cv);
          const hi = rPr.getElementsByTagNameNS(W, 'highlight')[0];
          const hv = hi && hi.getAttributeNS(W, 'val');
          if (hv && hv !== 'none') style.push('background-color:' + hv);
          if (style.length) { open += '<span style="' + style.join(';') + '">'; close = '</span>' + close; }
        }
        html += open + esc(text).replace(/\n/g, '<br>') + close;
      }

      if (isList) {
        if (!listOpen) { out.push('<ul>'); listOpen = 'ul'; }
        out.push('<li>' + (html || '<br>') + '</li>');
        continue;
      }
      if (listOpen) { out.push('</' + listOpen + '>'); listOpen = null; }
      out.push('<div' + (align ? ' style="text-align:' + align + '"' : '') + '>' + (html || '<br>') + '</div>');
    }
    if (listOpen) out.push('</' + listOpen + '>');
    return out.join('') || '<div><br></div>';
  }

  /* ---------------- PDF ----------------
   *
   * Text is decoded from the information the file actually carries, in the
   * order the PDF specification defines. Nothing is ever guessed and no
   * decoded text is rewritten afterwards: an earlier version tried to repair
   * suspicious output by remapping it, and that corrupted documents which had
   * decoded perfectly well. If a font genuinely carries no recoverable
   * encoding the file is reported as such rather than silently mangled.
   */

  /* --- character encodings ------------------------------------------- */

  function asciiRange(map) {
    for (let c = 32; c <= 126; c++) map.set(c, String.fromCharCode(c));
    return map;
  }

  // WinAnsi is Latin-1 plus a distinct 0x80-0x9F block
  const WIN_ANSI = (function () {
    const m = asciiRange(new Map());
    const high = { 128: 0x20AC, 130: 0x201A, 131: 0x0192, 132: 0x201E, 133: 0x2026,
      134: 0x2020, 135: 0x2021, 136: 0x02C6, 137: 0x2030, 138: 0x0160, 139: 0x2039,
      140: 0x0152, 142: 0x017D, 145: 0x2018, 146: 0x2019, 147: 0x201C, 148: 0x201D,
      149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x02DC, 153: 0x2122, 154: 0x0161,
      155: 0x203A, 156: 0x0153, 158: 0x017E, 159: 0x0178 };
    Object.keys(high).forEach(function (k) { m.set(+k, String.fromCharCode(high[k])); });
    for (let c = 160; c <= 255; c++) m.set(c, String.fromCharCode(c));
    return m;
  })();

  // StandardEncoding differs from ASCII only in a few punctuation slots
  const STANDARD = (function () {
    const m = asciiRange(new Map());
    m.set(39, String.fromCharCode(0x2019));   // quoteright
    m.set(96, String.fromCharCode(0x2018));   // quoteleft
    return m;
  })();

  const MAC_ROMAN = (function () {
    const m = asciiRange(new Map());
    const high = { 165: 0x2022, 208: 0x2013, 209: 0x2014, 210: 0x201C, 211: 0x201D,
      212: 0x2018, 213: 0x2019, 201: 0x2026, 202: 0x00A0 };
    Object.keys(high).forEach(function (k) { m.set(+k, String.fromCharCode(high[k])); });
    return m;
  })();

  function namedEncoding(name) {
    if (/WinAnsi/i.test(name)) return WIN_ANSI;
    if (/MacRoman/i.test(name)) return MAC_ROMAN;
    if (/Standard/i.test(name)) return STANDARD;
    return null;
  }

  /* --- glyph names ---------------------------------------------------- */

  const AGL = (function () {
    const m = new Map();
    const names = ('space exclam quotedbl numbersign dollar percent ampersand quotesingle ' +
      'parenleft parenright asterisk plus comma hyphen period slash zero one two three four ' +
      'five six seven eight nine colon semicolon less equal greater question at').split(' ');
    names.forEach(function (n, i) { m.set(n, String.fromCharCode(32 + i)); });
    for (let c = 65; c <= 90; c++) m.set(String.fromCharCode(c), String.fromCharCode(c));
    for (let c = 97; c <= 122; c++) m.set(String.fromCharCode(c), String.fromCharCode(c));
    const tail = { bracketleft: 91, backslash: 92, bracketright: 93, asciicircum: 94,
      underscore: 95, grave: 96, braceleft: 123, bar: 124, braceright: 125, asciitilde: 126,
      quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201C, quotedblright: 0x201D,
      quotesinglbase: 0x201A, quotedblbase: 0x201E, endash: 0x2013, emdash: 0x2014,
      bullet: 0x2022, ellipsis: 0x2026, dagger: 0x2020, daggerdbl: 0x2021, fi: 0xFB01,
      fl: 0xFB02, sterling: 0x00A3, euro: 0x20AC, degree: 0x00B0, trademark: 0x2122,
      copyright: 0x00A9, registered: 0x00AE, minus: 0x2212, multiply: 0x00D7, divide: 0x00F7 };
    Object.keys(tail).forEach(function (k) { m.set(k, String.fromCharCode(tail[k])); });
    return m;
  })();

  function glyphNameToChar(name) {
    if (!name) return '';
    if (AGL.has(name)) return AGL.get(name);
    let mm = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
    if (mm) return String.fromCodePoint(parseInt(mm[1], 16));
    mm = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
    if (mm) return String.fromCodePoint(parseInt(mm[1], 16));
    return '';
  }

  /* --- /ToUnicode CMap ------------------------------------------------ */

  function parseToUnicode(cmapText) {
    const map = new Map();
    const hex = function (h) { return parseInt(h, 16); };
    const uni = function (h) {
      let s = '';
      for (let i = 0; i + 4 <= h.length; i += 4) {
        const cu = parseInt(h.substr(i, 4), 16);
        if (!isNaN(cu)) s += String.fromCharCode(cu);
      }
      return s;
    };
    (cmapText.match(/beginbfchar([\s\S]*?)endbfchar/g) || []).forEach(function (blk) {
      const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let m;
      while ((m = re.exec(blk)) !== null) map.set(hex(m[1]), uni(m[2]));
    });
    (cmapText.match(/beginbfrange([\s\S]*?)endbfrange/g) || []).forEach(function (blk) {
      const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let m;
      while ((m = re.exec(blk)) !== null) {
        const lo = hex(m[1]), hi = hex(m[2]), base = hex(m[3]);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      }
    });
    return map;
  }

  /* --- embedded TrueType: glyph id -> unicode -------------------------
     Subset fonts frequently use the glyph index as the character code. The
     embedded font's own cmap answers that authoritatively, so no guessing is
     needed: invert unicode -> gid to get gid -> unicode. */

  function ttfGidToUnicode(buf) {
    try {
      if (!buf || buf.length < 12) return null;
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const tag = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
      if (tag !== 'true' && tag !== '\u0000\u0001\u0000\u0000' && dv.getUint32(0) !== 0x00010000) {
        if (tag !== 'ttcf') return null;
      }
      const numTables = dv.getUint16(4);
      let cmapOff = 0;
      for (let i = 0; i < numTables; i++) {
        const o = 12 + i * 16;
        if (o + 16 > buf.length) break;
        const t = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
        if (t === 'cmap') { cmapOff = dv.getUint32(o + 8); break; }
      }
      if (!cmapOff || cmapOff + 4 > buf.length) return null;

      const n = dv.getUint16(cmapOff + 2);
      let best = 0, bestScore = -1;
      for (let i = 0; i < n; i++) {
        const rec = cmapOff + 4 + i * 8;
        if (rec + 8 > buf.length) break;
        const pid = dv.getUint16(rec), eid = dv.getUint16(rec + 2);
        const off = cmapOff + dv.getUint32(rec + 4);
        // prefer a real Unicode subtable; a (3,0) symbolic one is last resort
        let score = -1;
        if (pid === 3 && eid === 10) score = 5;
        else if (pid === 3 && eid === 1) score = 4;
        else if (pid === 0) score = 3;
        else if (pid === 3 && eid === 0) score = 1;
        else if (pid === 1 && eid === 0) score = 0;
        if (score > bestScore) { bestScore = score; best = off; }
      }
      if (!best || best + 4 > buf.length) return null;

      const rev = new Map();
      const put = function (uni, gid) {
        if (!gid) return;
        if (bestScore === 1 && uni >= 0xF000 && uni <= 0xF0FF) uni -= 0xF000;  // symbolic
        if (!rev.has(gid)) rev.set(gid, String.fromCodePoint(uni));
      };
      const fmt = dv.getUint16(best);

      if (fmt === 0) {
        for (let c = 0; c < 256; c++) put(c, buf[best + 6 + c]);
      } else if (fmt === 4) {
        const segX2 = dv.getUint16(best + 6), seg = segX2 / 2;
        const endO = best + 14, startO = endO + segX2 + 2;
        const deltaO = startO + segX2, rangeO = deltaO + segX2;
        for (let s = 0; s < seg; s++) {
          const end = dv.getUint16(endO + s * 2), start = dv.getUint16(startO + s * 2);
          const delta = dv.getInt16(deltaO + s * 2), ro = dv.getUint16(rangeO + s * 2);
          if (start === 0xFFFF) continue;
          for (let c = start; c <= end && c !== 0x10000; c++) {
            let g;
            if (!ro) g = (c + delta) & 0xFFFF;
            else {
              const gi = rangeO + s * 2 + ro + (c - start) * 2;
              if (gi + 1 >= buf.length) continue;
              g = dv.getUint16(gi);
              if (g) g = (g + delta) & 0xFFFF;
            }
            put(c, g);
          }
        }
      } else if (fmt === 6) {
        const first = dv.getUint16(best + 6), cnt = dv.getUint16(best + 8);
        for (let i = 0; i < cnt; i++) put(first + i, dv.getUint16(best + 10 + i * 2));
      } else if (fmt === 12) {
        const groups = dv.getUint32(best + 12);
        for (let g = 0; g < groups && g < 100000; g++) {
          const o = best + 16 + g * 12;
          if (o + 12 > buf.length) break;
          const sc = dv.getUint32(o), ec = dv.getUint32(o + 4), sg = dv.getUint32(o + 8);
          for (let c = sc; c <= ec && c - sc < 65536; c++) put(c, sg + (c - sc));
        }
      } else return null;

      return rev.size ? rev : null;
    } catch (e) { return null; }
  }

  /* --- stream helpers -------------------------------------------------- */

  async function inflateMaybe(bytes) {
    if (!bytes || !bytes.length) return bytes;
    for (const fmt of ['deflate', 'deflate-raw']) {
      try {
        const ds = new DecompressionStream(fmt);
        const out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
        if (out.byteLength) return new Uint8Array(out);
      } catch (e) { /* try the next form */ }
    }
    return bytes;
  }

  async function streamBytes(ctx, ref) {
    try {
      const st = ctx.lookup(ref);
      if (!st || !st.getContents) return null;
      return await inflateMaybe(st.getContents());
    } catch (e) { return null; }
  }

  /* --- per-font decoder ------------------------------------------------ */

  async function buildFontDecoder(ctx, PDFName, fontRef) {
    const info = { twoByte: false, decode: null };
    let toUni = null, diffs = null, baseEnc = null, gidRev = null, symbolic = false;
    let type0 = false;

    try {
      const font = ctx.lookup(fontRef);
      if (!font || !font.get) return null;
      const sub = font.get(PDFName.of('Subtype'));
      const subName = sub && sub.asString ? sub.asString() : '';
      type0 = /Type0/.test(subName);

      // 1. ToUnicode is authoritative when present
      const tu = font.get(PDFName.of('ToUnicode'));
      if (tu) {
        const raw = await streamBytes(ctx, tu);
        if (raw) {
          const m = parseToUnicode(new TextDecoder('latin1').decode(raw));
          if (m && m.size) toUni = m;
        }
      }

      // the descriptor lives on the descendant font for Type0
      let holder = font;
      if (type0) {
        const dfRef = font.get(PDFName.of('DescendantFonts'));
        const df = dfRef ? ctx.lookup(dfRef) : null;
        const first = df && df.asArray ? ctx.lookup(df.asArray()[0]) : null;
        if (first) holder = first;
        info.twoByte = true;                       // Identity-H and friends
        const encRef = font.get(PDFName.of('Encoding'));
        const enc = encRef && encRef.asString ? encRef.asString() : '';
        if (/Identity-H|Identity-V/.test(enc)) info.twoByte = true;
      }

      // 2. /Encoding: a named base and/or a Differences array
      if (!type0) {
        const encRef = font.get(PDFName.of('Encoding'));
        if (encRef) {
          const enc = ctx.lookup(encRef);
          if (enc && enc.asString) baseEnc = namedEncoding(enc.asString());
          else if (enc && enc.get) {
            const be = enc.get(PDFName.of('BaseEncoding'));
            if (be && be.asString) baseEnc = namedEncoding(be.asString());
            const dRef = enc.get(PDFName.of('Differences'));
            const arr = dRef ? ctx.lookup(dRef) : null;
            if (arr && arr.asArray) {
              const m = new Map();
              let code = 0;
              arr.asArray().forEach(function (item) {
                const v = ctx.lookup(item);
                if (v && typeof v.asNumber === 'function') { code = v.asNumber(); return; }
                const gname = v && v.asString ? v.asString().replace(/^\//, '') : null;
                if (gname) { const ch = glyphNameToChar(gname); if (ch) m.set(code, ch); code++; }
              });
              if (m.size) diffs = m;
            }
          }
        }
      }

      // 3. symbolic flag decides whether a standard encoding may be assumed
      const fdRef = holder.get && holder.get(PDFName.of('FontDescriptor'));
      const fd = fdRef ? ctx.lookup(fdRef) : null;
      if (fd && fd.get) {
        const fl = fd.get(PDFName.of('Flags'));
        const flags = fl && typeof fl.asNumber === 'function' ? fl.asNumber() : 0;
        symbolic = !!(flags & 4) && !(flags & 32);
        // 4. the embedded font program answers glyph-index codes exactly
        for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
          const ffRef = fd.get(PDFName.of(key));
          if (!ffRef) continue;
          const raw = await streamBytes(ctx, ffRef);
          if (raw) { gidRev = ttfGidToUnicode(raw); if (gidRev) break; }
        }
      }
    } catch (e) { /* fall through with whatever was resolved */ }

    const preferGid = type0 || symbolic || (!baseEnc && !diffs);

    info.decode = function (code) {
      if (toUni && toUni.has(code)) return toUni.get(code);
      if (diffs && diffs.has(code)) return diffs.get(code);
      if (!preferGid && baseEnc && baseEnc.has(code)) return baseEnc.get(code);
      if (gidRev && gidRev.has(code)) return gidRev.get(code);
      if (baseEnc && baseEnc.has(code)) return baseEnc.get(code);
      if (!type0 && STANDARD.has(code)) return STANDARD.get(code);
      return String.fromCharCode(code);
    };
    return info;
  }

  /* --- string literals -------------------------------------------------- */

  function pdfLiteral(s) {
    return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, function (m, g) {
      if (g === 'n') return '\n';
      if (g === 'r') return '\r';
      if (g === 't') return '\t';
      if (g === 'b' || g === 'f') return ' ';
      if (g === '(' || g === ')' || g === '\\') return g;
      return String.fromCharCode(parseInt(g, 8));
    });
  }

  function hexToRaw(tok) {
    const h = tok.slice(1, -1).replace(/\s+/g, '');
    let s = '';
    for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.substr(i, 2).padEnd(2, '0'), 16));
    return s;
  }

  function codesOf(raw, twoByte) {
    const out = [];
    if (twoByte) {
      for (let i = 0; i + 1 < raw.length; i += 2) out.push((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
    } else {
      for (let i = 0; i < raw.length; i++) out.push(raw.charCodeAt(i));
    }
    return out;
  }

  const CONTROLish = /[\u0000-\u0008\u000E-\u001F]/g;

  /* --- main ------------------------------------------------------------- */

  async function pdfToHtml(bytes) {
    if (!global.PDFLib) throw new Error('PDF support is unavailable');
    const doc = await global.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const PDFName = global.PDFLib.PDFName, PDFArray = global.PDFLib.PDFArray;
    const ctx = doc.context;
    const pagesOut = [];

    for (const page of doc.getPages()) {
      const node = page.node;

      // resources may be inherited from an ancestor Pages node
      let res = null;
      try { res = node.Resources && node.Resources(); } catch (e) {}
      if (!res) {
        let up = node;
        for (let i = 0; i < 8 && up && !res; i++) {
          const p = up.get && up.get(PDFName.of('Parent'));
          up = p ? ctx.lookup(p) : null;
          if (up && up.get) { const r = up.get(PDFName.of('Resources')); if (r) res = ctx.lookup(r); }
        }
      }

      const decoders = new Map();
      try {
        const fonts = res && res.lookup ? res.lookup(PDFName.of('Font')) : null;
        if (fonts && fonts.entries) {
          for (const [key, ref] of fonts.entries()) {
            const name = key.asString().replace(/^\//, '');
            const dec = await buildFontDecoder(ctx, PDFName, ref);
            if (dec) decoders.set(name, dec);
          }
        }
      } catch (e) {}

      // content streams
      let content = '';
      try {
        let c = ctx.lookup(node.get(PDFName.of('Contents')));
        const parts = (c instanceof PDFArray) ? c.asArray().map(function (r) { return ctx.lookup(r); }) : [c];
        for (const st of parts) {
          if (!st || !st.getContents) continue;
          const raw = await inflateMaybe(st.getContents());
          content += new TextDecoder('latin1').decode(raw) + '\n';
        }
      } catch (e) {}
      if (!content) continue;

      const items = [];
      let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], leading = 0, fontSize = 12;
      let dec = null;
      const setTm = function (n) { tm = n.slice(); tlm = n.slice(); };
      const translate = function (tx, ty) {
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
               tx * tlm[0] + ty * tlm[2] + tlm[4],
               tx * tlm[1] + ty * tlm[3] + tlm[5]];
        tm = tlm.slice();
      };
      const emit = function (txt) {
        if (!txt) return;
        items.push({ x: tm[4], y: tm[5], text: txt, size: Math.abs(tm[3] || 1) * fontSize });
      };
      const readStr = function (tok) {
        const raw = tok[0] === '(' ? pdfLiteral(tok.slice(1, -1)) : hexToRaw(tok);
        const twoByte = dec ? dec.twoByte : false;
        const codes = codesOf(raw, twoByte);
        let out = '';
        for (const c of codes) out += dec ? dec.decode(c) : String.fromCharCode(c);
        return out;
      };

      const tokenRe = new RegExp(
        "\\/[A-Za-z0-9#+\\-.]+|\\[[^\\]]*\\]|\\([^\\\\)]*(?:\\\\.[^\\\\)]*)*\\)|" +
        "<[0-9A-Fa-f\\s]*>|-?[\\d.]+|[A-Za-z'\"*]+", 'g');
      const numRe = /^-?[\d.]+$/;
      const tokens = content.match(tokenRe) || [];
      let stack = [];

      for (const tk of tokens) {
        if (tk[0] === '/' || tk[0] === '[' || tk[0] === '(' || tk[0] === '<' || numRe.test(tk)) {
          stack.push(tk); continue;
        }
        switch (tk) {
          case 'BT': setTm([1, 0, 0, 1, 0, 0]); stack = []; break;
          case 'Tf': {
            const nm = stack.filter(function (x) { return x[0] === '/'; }).pop();
            const sz = parseFloat(stack[stack.length - 1]);
            if (!isNaN(sz)) fontSize = sz;
            if (nm) dec = decoders.get(nm.slice(1)) || null;
            stack = []; break;
          }
          case 'TL': { const v = parseFloat(stack[stack.length - 1]); if (!isNaN(v)) leading = v; stack = []; break; }
          case 'Tm': { const n = stack.slice(-6).map(Number);
            if (n.length === 6 && n.every(function (v) { return !isNaN(v); })) setTm(n);
            stack = []; break; }
          case 'Td': { const n = stack.slice(-2).map(Number); if (n.length === 2) translate(n[0], n[1]); stack = []; break; }
          case 'TD': { const n = stack.slice(-2).map(Number); if (n.length === 2) { leading = -n[1]; translate(n[0], n[1]); } stack = []; break; }
          case 'T*': translate(0, -leading); stack = []; break;
          case 'Tj': case "'": case '"': {
            if (tk !== 'Tj') translate(0, -leading);
            const s = stack.filter(function (x) { return x[0] === '(' || x[0] === '<'; }).pop();
            if (s) emit(readStr(s));
            stack = []; break;
          }
          case 'TJ': {
            const arr = stack.filter(function (x) { return x[0] === '['; }).pop() || '';
            const inner = new RegExp("\\(([^\\\\)]*(?:\\\\.[^\\\\)]*)*)\\)|<([0-9A-Fa-f\\s]*)>|(-?[\\d.]+)", 'g');
            let piece = '', m;
            while ((m = inner.exec(arr)) !== null) {
              if (m[1] !== undefined) piece += readStr('(' + m[1] + ')');
              else if (m[2] !== undefined) piece += readStr('<' + m[2] + '>');
              else if (m[3] !== undefined) {
                const adj = parseFloat(m[3]);
                if (adj <= -100 && piece && !/\s$/.test(piece)) piece += ' ';
              }
            }
            emit(piece);
            stack = []; break;
          }
          default: stack = [];
        }
      }
      if (!items.length) continue;

      // group into lines by vertical position, then order the page naturally
      const tol = Math.max(2, Math.min(6, (items[0].size || 12) * 0.4));
      const rows = [];
      items.slice().sort(function (p, q) { return q.y - p.y || p.x - q.x; }).forEach(function (it) {
        const row = rows.find(function (r) { return Math.abs(r.y - it.y) <= tol; });
        if (row) { row.parts.push(it); row.y = (row.y + it.y) / 2; }
        else rows.push({ y: it.y, parts: [it] });
      });
      const lines = rows.map(function (r) {
        r.parts.sort(function (p, q) { return p.x - q.x; });
        let out = '', prev = null;
        r.parts.forEach(function (p) {
          if (prev && !/\s$/.test(out) && p.x - prev.x > 1) out += ' ';
          out += p.text;
          prev = p;
        });
        return out;
      }).filter(function (l) { return l.trim(); });
      if (lines.length) pagesOut.push(lines);
    }

    if (!pagesOut.length)
      throw new Error('No text found. If this PDF is a scan, the pages are images and hold no text to convert.');

    // Be honest when a file's fonts carry no recoverable encoding, rather than
    // emitting nonsense that looks like text.
    const all = pagesOut.map(function (p) { return p.join(' '); }).join(' ');
    const ctrl = (all.match(CONTROLish) || []).length;
    if (all.length > 40 && ctrl / all.length > 0.15)
      throw new Error('This PDF stores its text without any recoverable character information, ' +
        'so it cannot be converted. Try the original Word file, or copy the text and paste it in.');

    const html = [];
    pagesOut.forEach(function (lines, i) {
      if (i) html.push('<hr class="pgbreak">');
      lines.forEach(function (l) {
        const t = l.replace(CONTROLish, '').replace(/\s+/g, ' ').trim();
        html.push('<div>' + (t ? esc(t) : '<br>') + '</div>');
      });
    });
    return html.join('');
  }

  /* ---------------- plain text ---------------- */

  function textToHtml(txt) {
    return txt.replace(/\r\n?/g, '\n').split('\n')
      .map(l => '<div>' + (l.trim() ? esc(l) : '<br>') + '</div>').join('') || '<div><br></div>';
  }

  /* ---------------- entry point ---------------- */

  async function fileToHtml(file) {
    const name = (file.name || '').toLowerCase();
    const buf = new Uint8Array(await file.arrayBuffer());

    if (name.endsWith('.docx')) {
      const xml = new TextDecoder().decode(await zipRead(buf, 'word/document.xml'));
      return { html: docxToHtml(xml), kind: 'Word document' };
    }
    if (name.endsWith('.pdf') || (buf[0] === 0x25 && buf[1] === 0x50)) {
      return { html: await pdfToHtml(buf), kind: 'PDF' };
    }
    if (name.endsWith('.doc'))
      throw new Error('Old .doc files are not supported. Save it as .docx in Word first.');

    // treat anything else as text, but refuse obvious binaries
    let ctrl = 0;
    const probe = buf.subarray(0, 4096);
    for (const b of probe) if (b === 0 || (b < 9) || (b > 13 && b < 32)) ctrl++;
    if (probe.length && ctrl / probe.length > 0.02)
      throw new Error('That file is not text. Try a .docx, .pdf or .txt file.');

    let txt = new TextDecoder().decode(buf);
    if (txt.includes('�')) txt = new TextDecoder('windows-1252').decode(buf);
    return { html: textToHtml(txt), kind: 'text file' };
  }

  global.NTImport = { fileToHtml, docxToHtml, textToHtml, zipRead };
})(window);
