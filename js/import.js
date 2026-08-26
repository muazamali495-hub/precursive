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

      // font code -> unicode maps for this page
      const maps = new Map();
      try {
        const res = node.Resources && node.Resources();
        const fonts = res && res.lookup ? res.lookup(PDFName.of('Font')) : null;
        if (fonts && fonts.entries) {
          for (const [key, ref] of fonts.entries()) {
            try {
              const f = ctx.lookup(ref);
              const tu = f && f.get && f.get(PDFName.of('ToUnicode'));
              if (!tu) continue;
              const st = ctx.lookup(tu);
              if (!st || !st.getContents) continue;
              let raw = st.getContents();
              try {
                const ds = new DecompressionStream('deflate');
                raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
              } catch (e) { /* may be uncompressed */ }
              maps.set(key.asString(), parseToUnicode(new TextDecoder('latin1').decode(raw)));
            } catch (e) {}
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

      // walk the text operators
      const lines = [];
      let cur = '', activeMap = null, twoByte = false;
      const tokens = content.match(/\/[A-Za-z0-9#+\-.]+|\[[^\]]*\]|\([^\\)]*(?:\\.[^\\)]*)*\)|<[0-9A-Fa-f\s]*>|-?[\d.]+|[A-Za-z'"*]+/g) || [];
      let stack = [];
      const push = t => { if (t) cur += t; };
      for (const tk of tokens) {
        if (tk[0] === '/' || tk[0] === '[' || tk[0] === '(' || tk[0] === '<' || /^-?[\d.]+$/.test(tk)) { stack.push(tk); continue; }
        if (tk === 'Tf') {
          const nm = stack.filter(x => x[0] === '/').pop();
          if (nm) { const k = nm.slice(1); activeMap = maps.get(k) || null; twoByte = !!activeMap; }
          stack = []; continue;
        }
        if (tk === 'Tj' || tk === "'" || tk === '"') {
          const s = stack.filter(x => x[0] === '(' || x[0] === '<').pop();
          if (s) push(s[0] === '(' ? decodePdfString(pdfLiteral(s.slice(1, -1)), activeMap, false)
                                   : decodePdfString(hexToRaw(s), activeMap, twoByte));
          if (tk !== 'Tj') { lines.push(cur); cur = ''; }
          stack = []; continue;
        }
        if (tk === 'TJ') {
          const arr = stack.filter(x => x[0] === '[').pop() || '';
          for (const m of arr.matchAll(/\(([^\\)]*(?:\\.[^\\)]*)*)\)|<([0-9A-Fa-f\s]*)>|(-?[\d.]+)/g)) {
            if (m[1] !== undefined) push(decodePdfString(pdfLiteral(m[1]), activeMap, false));
            else if (m[2] !== undefined) push(decodePdfString(hexToRaw('<' + m[2] + '>'), activeMap, twoByte));
            else if (m[3] !== undefined && parseFloat(m[3]) < -120) push(' ');  // wide gap = space
          }
          stack = []; continue;
        }
        if (tk === 'Td' || tk === 'TD' || tk === 'T*' || tk === 'ET') {
          if (cur.trim()) { lines.push(cur); cur = ''; }
          stack = []; continue;
        }
        stack = [];
      }
      if (cur.trim()) lines.push(cur);
      if (lines.length) pagesOut.push(lines);
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
