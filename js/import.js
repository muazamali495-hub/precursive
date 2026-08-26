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

  /* ---------------- PDF ---------------- */

  /* Map a font's byte codes to text using its /ToUnicode CMap when present.
     Without one we fall back to Latin-1, which covers most simple PDFs. */
  function parseToUnicode(cmapText) {
    const map = new Map();
    const hex = h => parseInt(h, 16);
    const uni = h => {
      let s = '';
      for (let i = 0; i + 3 < h.length + 1; i += 4) {
        const cu = parseInt(h.substr(i, 4), 16);
        if (!isNaN(cu)) s += String.fromCharCode(cu);
      }
      return s;
    };
    for (const blk of cmapText.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
      for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(hex(m[1]), uni(m[2]));
    }
    for (const blk of cmapText.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = hex(m[1]), hi = hex(m[2]), base = hex(m[3]);
        for (let c = lo; c <= hi && c - lo < 65535; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      }
    }
    return map;
  }


  /* A compact Adobe Glyph List: enough to decode the names real producers emit. */
  const AGL = (function () {
    const m = new Map();
    const ascii = ('space exclam quotedbl numbersign dollar percent ampersand quotesingle ' +
      'parenleft parenright asterisk plus comma hyphen period slash zero one two three four ' +
      'five six seven eight nine colon semicolon less equal greater question at').split(' ');
    ascii.forEach((n, i) => m.set(n, String.fromCharCode(32 + i)));
    for (let c = 65; c <= 90; c++) m.set(String.fromCharCode(c), String.fromCharCode(c));
    for (let c = 97; c <= 122; c++) m.set(String.fromCharCode(c), String.fromCharCode(c));
    const tail = { bracketleft: 91, backslash: 92, bracketright: 93, asciicircum: 94,
      underscore: 95, grave: 96, braceleft: 123, bar: 124, braceright: 125, asciitilde: 126,
      quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201C, quotedblright: 0x201D,
      endash: 0x2013, emdash: 0x2014, bullet: 0x2022, ellipsis: 0x2026, fi: 0xFB01, fl: 0xFB02,
      sterling: 0xA3, euro: 0x20AC, degree: 0xB0, nbspace: 32, hyphenminus: 45 };
    Object.keys(tail).forEach(k => m.set(k, String.fromCharCode(tail[k])));
    return m;
  })();

  function glyphNameToChar(name) {
    if (!name) return '';
    if (AGL.has(name)) return AGL.get(name);
    let mm = /^uni([0-9A-Fa-f]{4})$/.exec(name);
    if (mm) return String.fromCharCode(parseInt(mm[1], 16));
    mm = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
    if (mm) return String.fromCodePoint(parseInt(mm[1], 16));
    // names like g23 / cid23 / index23 carry no meaning on their own
    return '';
  }

  /* Standard Macintosh glyph ordering. Subset fonts frequently use the glyph
     index as the character code; in that ordering 'space' is glyph 3, so text
     read as raw bytes comes out shifted by exactly 29. */
  const MAC_ORDER = ('.notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar ' +
    'percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash ' +
    'zero one two three four five six seven eight nine colon semicolon less equal greater ' +
    'question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash ' +
    'bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x ' +
    'y z braceleft bar braceright asciitilde').split(' ');

  function macOrderMap() {
    const m = new Map();
    MAC_ORDER.forEach((n, i) => { const c = glyphNameToChar(n); if (c) m.set(i, c); });
    return m;
  }

  /* Was this text decoded with the wrong encoding? Two reliable signals:
     correctly decoded text never contains raw control characters, and real
     prose is roughly a third vowels. A Caesar-shifted decode looks like
     letters, so a letter-ratio test alone never catches it. */
  /* How word-like is this text? Counts sequences that look like English words
     and common short words, so a re-read can be compared against the original
     rather than merely assumed to be an improvement. */
  const COMMON = new Set(("the of and to in is it for on as at by an be or are with that this " +
    "from was not have has had you your all can will each which their said if do how" ).split(" "));
  function englishScore(text) {
    const words = String(text || "").toLowerCase().match(/[a-z]{1,20}/g) || [];
    if (!words.length) return 0;
    let hits = 0, vowelly = 0;
    for (const w of words) {
      if (COMMON.has(w)) hits += 3;
      if (/[aeiou]/.test(w)) vowelly++;
    }
    return (hits + vowelly) / words.length;
  }

  function looksGarbled(text) {
    const s = String(text || "").slice(0, 4000);
    if (s.length < 12) return false;
    if (new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]").test(s)) return true;
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    if (letters < 20) return false;
    const vowels = (s.match(/[aeiouAEIOU]/g) || []).length;
    return vowels / letters < 0.12;
  }

  function decodePdfString(raw, map, twoByte) {
    let out = '';
    if (twoByte) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
        out += map && map.has(code) ? map.get(code) : String.fromCharCode(code);
      }
    } else {
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        out += map && map.has(code) ? map.get(code) : String.fromCharCode(code);
      }
    }
    return out;
  }

  // unescape a PDF literal string: \( \) \\ \n \t and \ddd octal
  function pdfLiteral(s) {
    return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (m, g) => {
      if (g === 'n') return '\n'; if (g === 'r') return '\r'; if (g === 't') return '\t';
      if (g === 'b' || g === 'f') return ' ';
      if (g === '(' || g === ')' || g === '\\') return g;
      return String.fromCharCode(parseInt(g, 8));
    });
  }

  async function pdfToHtml(bytes) {
    if (!global.PDFLib) throw new Error('PDF support is unavailable');
    const doc = await global.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const { PDFName, PDFRawStream, PDFDict, PDFArray } = global.PDFLib;
    const ctx = doc.context;
    const pagesOut = [];

    for (const page of doc.getPages()) {
      const node = page.node;

      /* Work out, per font, how its byte codes map to characters.
         Order of preference:
           1. /ToUnicode CMap            - authoritative when present
           2. /Encoding /Differences     - glyph names, resolved via the AGL
           3. standard Macintosh glyph order - for subset fonts whose codes are
              glyph indices (space lands on glyph 3, which is why such files
              come out uniformly shifted by 29 when read as raw bytes)
           4. Latin-1                    - ordinary simple fonts
         Also records whether each font uses 1- or 2-byte codes, which depends
         on the font type and NOT on whether a ToUnicode happens to exist. */
      const fontInfo = new Map();   // name -> { map, twoByte }
      try {
        let res = null;
        try { res = node.Resources && node.Resources(); } catch (e) {}
        if (!res) {
          // Resources are inheritable: walk up to the parent Pages node
          let up = node;
          for (let i = 0; i < 8 && up && !res; i++) {
            const parent = up.get && up.get(PDFName.of('Parent'));
            up = parent ? ctx.lookup(parent) : null;
            if (up && up.get) { const r = up.get(PDFName.of('Resources')); if (r) res = ctx.lookup(r); }
          }
        }
        const fonts = res && res.lookup ? res.lookup(PDFName.of('Font')) : null;
        if (fonts && fonts.entries) {
          for (const [key, ref] of fonts.entries()) {
            const name = key.asString().replace(/^\//, '');
            let map = null, twoByte = false;
            try {
              const f = ctx.lookup(ref);
              const sub = f && f.get && f.get(PDFName.of('Subtype'));
              const subName = sub && sub.asString ? sub.asString() : '';
              twoByte = /Type0/.test(subName);

              // 1. ToUnicode
              const tu = f && f.get && f.get(PDFName.of('ToUnicode'));
              if (tu) {
                const st = ctx.lookup(tu);
                if (st && st.getContents) {
                  let raw = st.getContents();
                  try {
                    const ds = new DecompressionStream('deflate');
                    raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
                  } catch (e) { /* often stored uncompressed */ }
                  const m = parseToUnicode(new TextDecoder('latin1').decode(raw));
                  if (m && m.size) map = m;
                }
              }

              // 2. /Encoding /Differences
              if (!map) {
                const encRef = f && f.get && f.get(PDFName.of('Encoding'));
                const enc = encRef ? ctx.lookup(encRef) : null;
                const diffRef = enc && enc.get && enc.get(PDFName.of('Differences'));
                const diffs = diffRef ? ctx.lookup(diffRef) : null;
                if (diffs && diffs.asArray) {
                  const m = new Map();
                  let code = 0;
                  for (const item of diffs.asArray()) {
                    const v = ctx.lookup(item);
                    if (v && typeof v.asNumber === 'function') { code = v.asNumber(); continue; }
                    const gname = v && v.asString ? v.asString().replace(/^\//, '') : null;
                    if (gname) { const ch = glyphNameToChar(gname); if (ch) m.set(code, ch); code++; }
                  }
                  if (m.size) map = m;
                }
              }
            } catch (e) {}
            fontInfo.set(name, { map: map, twoByte: twoByte });
          }
        }
      } catch (e) {}

      // concatenate + inflate the page content streams
      let content = '';
      try {
        let c = node.get(PDFName.of('Contents'));
        c = ctx.lookup(c);
        const parts = (c instanceof PDFArray) ? c.asArray().map(r => ctx.lookup(r)) : [c];
        for (const st of parts) {
          if (!st || !st.getContents) continue;
          let raw = st.getContents();
          try {
            const ds = new DecompressionStream('deflate');
            raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
          } catch (e) {}
          content += new TextDecoder('latin1').decode(raw) + '\n';
        }
      } catch (e) {}
      if (!content) continue;

      /* Walk the text operators, recording WHERE each piece of text lands.
         Real exporters position every line with its own Tm inside a single
         BT/ET block, so breaking lines on Td/T* alone merges the whole page
         into one string. Grouping by y position is what actually recovers
         the lines, and it also fixes reading order. */
      const items = [];                       // { x, y, text }
      let tm = [1,0,0,1,0,0], tlm = [1,0,0,1,0,0], leading = 0;
      let activeMap = null, twoByte = false, fontSize = 12, activeFont = null, activeName = null;
      const setTm = n => { tm = n.slice(); tlm = n.slice(); };
      const translate = (tx, ty) => {
        // tlm = [1 0 0 1 tx ty] x tlm
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
               tx * tlm[0] + ty * tlm[2] + tlm[4],
               tx * tlm[1] + ty * tlm[3] + tlm[5]];
        tm = tlm.slice();
      };
      const emit = txt => {
        if (!txt) return;
        items.push({ x: tm[4], y: tm[5], text: txt, size: Math.abs(tm[3] || 1) * fontSize,
                     font: activeName, mapped: !!activeMap });
      };

      const tokens = content.match(new RegExp("\\/[A-Za-z0-9#+\\-.]+|\\[[^\\]]*\\]|\\([^\\\\)]*(?:\\\\.[^\\\\)]*)*\\)|<[0-9A-Fa-f\\s]*>|-?[\\d.]+|[A-Za-z'\"*]+", 'g')) || [];
      let stack = [];
      for (const tk of tokens) {
        if (tk[0] === '/' || tk[0] === '[' || tk[0] === '(' || tk[0] === '<' || new RegExp("^-?[\\d.]+$").test(tk)) { stack.push(tk); continue; }
        switch (tk) {
          case 'BT': setTm([1,0,0,1,0,0]); stack = []; break;
          case 'Tf': {
            const nm = stack.filter(x => x[0] === '/').pop();
            const sz = parseFloat(stack[stack.length - 1]);
            if (!isNaN(sz)) fontSize = sz;
            if (nm) {
              const k = nm.slice(1);
              activeName = k;
              activeFont = fontInfo.get(k) || null;
              activeMap = activeFont ? activeFont.map : null;
              // byte width follows the font type, never the presence of a map
              twoByte = !!(activeFont && activeFont.twoByte);
            }
            stack = []; break;
          }
          case 'TL': { const v = parseFloat(stack[stack.length - 1]); if (!isNaN(v)) leading = v; stack = []; break; }
          case 'Tm': { const n = stack.slice(-6).map(Number); if (n.length === 6 && n.every(v => !isNaN(v))) setTm(n); stack = []; break; }
          case 'Td': { const n = stack.slice(-2).map(Number); if (n.length === 2) translate(n[0], n[1]); stack = []; break; }
          case 'TD': { const n = stack.slice(-2).map(Number); if (n.length === 2) { leading = -n[1]; translate(n[0], n[1]); } stack = []; break; }
          case 'T*': translate(0, -leading); stack = []; break;
          case 'Tj': case "'": case '"': {
            if (tk !== 'Tj') translate(0, -leading);
            const str = stack.filter(x => x[0] === '(' || x[0] === '<').pop();
            if (str) emit(str[0] === '(' ? decodePdfString(pdfLiteral(str.slice(1, -1)), activeMap, false)
                                        : decodePdfString(hexToRaw(str), activeMap, twoByte));
            stack = []; break;
          }
          case 'TJ': {
            const arr = stack.filter(x => x[0] === '[').pop() || '';
            let piece = '';
            for (const m of arr.matchAll(new RegExp("\\(([^\\\\)]*(?:\\\\.[^\\\\)]*)*)\\)|<([0-9A-Fa-f\\s]*)>|(-?[\\d.]+)", 'g'))) {
              if (m[1] !== undefined) piece += decodePdfString(pdfLiteral(m[1]), activeMap, false);
              else if (m[2] !== undefined) piece += decodePdfString(hexToRaw('<' + m[2] + '>'), activeMap, twoByte);
              else if (m[3] !== undefined) {
                // a large negative adjustment is how most producers write a space
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

      /* Repair per font, never per page. A file can mix fonts that decode
         correctly with a subset font whose codes are glyph indices; judging
         the page as a whole would re-map the good text too. */
      (function repairByFont() {
        const byFont = new Map();
        for (const it of items) {
          const k = it.font || '';
          if (!byFont.has(k)) byFont.set(k, []);
          byFont.get(k).push(it);
        }
        const mo = macOrderMap();
        byFont.forEach(function (group) {
          // a font that supplied a real encoding is trusted as-is
          if (group[0] && group[0].mapped) return;
          const before = group.map(g => g.text).join(' ');
          if (!looksGarbled(before)) return;
          const after = group.map(function (g) {
            return g.text.split('').map(function (ch) {
              const c = mo.get(ch.charCodeAt(0));
              return c === undefined ? ch : c;
            }).join('');
          });
          // only keep the re-read when it is genuinely better
          if (looksGarbled(after.join(' '))) return;
          if (englishScore(after.join(' ')) <= englishScore(before)) return;
          group.forEach(function (g, i) { g.text = after[i]; });
        });
      })();


      /* Group into lines by y (tolerance scaled to the text size), then order
         top-to-bottom and left-to-right, inserting a space where two pieces on
         the same line were positioned apart. */
      const tol = Math.max(2, Math.min(6, (items[0].size || 12) * 0.4));
      const rows = [];
      for (const it of items.slice().sort((p, q) => q.y - p.y || p.x - q.x)) {
        const row = rows.find(r => Math.abs(r.y - it.y) <= tol);
        if (row) { row.parts.push(it); row.y = (row.y + it.y) / 2; }
        else rows.push({ y: it.y, parts: [it] });
      }
      const lines = rows.map(r => {
        r.parts.sort((p, q) => p.x - q.x);
        let out = '';
        let prev = null;
        for (const p of r.parts) {
          if (prev && !/\s$/.test(out) && p.x - prev.x > 1) out += ' ';
          out += p.text;
          prev = p;
        }
        return out;
      }).filter(l => l.trim());
      if (lines.length) {
        // If a font gave us no encoding at all, raw bytes may really be glyph
        // indices. Retry through the standard Macintosh ordering and keep
        // whichever reading actually looks like words.
        pagesOut.push(lines);
      }
    }

    if (!pagesOut.length)
      throw new Error('No text found. If this PDF is a scan, the pages are images and hold no text to convert.');

    const html = [];
    pagesOut.forEach((lines, i) => {
      if (i) html.push('<hr class="pgbreak">');
      for (const l of lines) {
        const t = l.replace(/\s+/g, ' ').trim();
        html.push('<div>' + (t ? esc(t) : '<br>') + '</div>');
      }
    });
    return html.join('');
  }

  function hexToRaw(tok) {
    const h = tok.slice(1, -1).replace(/\s+/g, '');
    let s = '';
    for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.substr(i, 2).padEnd(2, '0'), 16));
    return s;
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
