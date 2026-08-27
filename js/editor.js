/* editor.js — rich text surface + DOM -> document model
 *
 * A contenteditable div is the editing surface. Formatting uses
 * document.execCommand: deprecated, but universally supported and the only
 * option that needs no build step or framework. The messy HTML it produces
 * is fine because we never trust it — parseDocument() walks the DOM and
 * derives a clean model of paragraphs and styled runs.
 */
(function (global) {
  'use strict';

  const DEFAULT_SIZE = 18;

  /* ---------- DOM -> model ---------- */

  const BLOCK = /^(DIV|P|LI|H1|H2|H3|H4|BLOCKQUOTE|PRE)$/;

  function styleOf(node, inherited) {
    const s = Object.assign({}, inherited);
    while (node && node.nodeType === 1 && !BLOCK.test(node.tagName)) {
      const tag = node.tagName;
      if (tag === 'B' || tag === 'STRONG') s.b = true;
      if (tag === 'I' || tag === 'EM') s.i = true;
      if (tag === 'U') s.u = true;
      const cs = node.style;
      if (cs) {
        if (cs.fontWeight === 'bold' || +cs.fontWeight >= 600) s.b = true;
        if (cs.fontStyle === 'italic') s.i = true;
        if (cs.textDecorationLine === 'underline' || cs.textDecoration.includes('underline')) s.u = true;
        if (cs.color) s.color = cs.color;
        if (cs.fontSize && cs.fontSize.endsWith('px')) s.size = parseFloat(cs.fontSize);
      }
      if (node.dataset && node.dataset.size) s.size = parseFloat(node.dataset.size);
      node = node.parentNode;
    }
    return s;
  }

  function rgbToArr(c) {
    if (!c) return [0.106, 0.129, 0.161];
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
    const h = /^#([0-9a-f]{6})$/i.exec(c.trim());
    if (h) { const n = parseInt(h[1], 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
    return [0.106, 0.129, 0.161];
  }

  /* execCommand leaves 'transparent' or a zero-alpha rgba behind when a
     highlight is cleared; those must not become a painted rectangle. */
  function isTransparent(c) {
    if (!c) return true;
    const s = String(c).trim().toLowerCase();
    if (s === 'transparent' || s === 'initial' || s === 'inherit') return true;
    const m = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(s);
    return !!m && parseFloat(m[1]) === 0;
  }

  function imageBlockFrom(node) {
    if (!node) return null;
    const img = node.tagName === 'IMG' ? node : node.querySelector && node.querySelector('img');
    if (!img) return null;
    const wrap = (img.closest && img.closest('.img-wrap')) || null;
    const m = wrap || img;
    // The size the picture was given wins over the size it happens to be
    // drawn at: a narrow screen scales it down to fit, and that must not
    // shrink it on the printed page as well.
    const styleW = parseFloat((wrap && wrap.style.width) || img.style.width || '');
    const styleH = parseFloat((wrap && wrap.style.height) || img.style.height || '');
    const w = (styleW || m.offsetWidth || img.naturalWidth || 300);
    const h = (styleH || m.offsetHeight || img.naturalHeight || 200);
    return { type: 'image', src: img.getAttribute('src'), w: w, h: h };
  }

  function alignOf(el) {
    const a = (el.style && el.style.textAlign) || el.getAttribute?.('align') || '';
    return ['center', 'right', 'justify'].includes(a) ? a : 'left';
  }

  /* Walk the editor and produce [{align, list, level, runs:[{text,size,b,i,u,color}]}] */
  function parseDocument(root, baseSize) {
    const doc = [];
    baseSize = baseSize || DEFAULT_SIZE;

    function pushPara(el, list, level) {
      const runs = [];
      const walk = (node, inherited) => {
        if (node.nodeType === 3) {
          const t = node.nodeValue.replace(/​/g, '').replace(/ /g, ' ');
          if (t) runs.push({
            text: t,
            size: inherited.size || baseSize,
            b: !!inherited.b, i: !!inherited.i, u: !!inherited.u,
            color: inherited.color || null,
            hl: inherited.hl || null,
            strike: !!inherited.strike, sub: !!inherited.sub, sup: !!inherited.sup
          });
          return;
        }
        if (node.nodeType !== 1) return;
        if (node.tagName === 'BR') { runs.push({ text: '', br: true }); return; }
        const s = Object.assign({}, inherited);
        const tag = node.tagName;
        if (tag === 'B' || tag === 'STRONG') s.b = true;
        if (tag === 'I' || tag === 'EM') s.i = true;
        if (tag === 'U') s.u = true;
        if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s.strike = true;
        if (tag === 'SUB') s.sub = true;
        if (tag === 'SUP') s.sup = true;
        const st = node.style;
        if (st) {
          if (st.fontWeight === 'bold' || +st.fontWeight >= 600) s.b = true;
          if (st.fontStyle === 'italic') s.i = true;
          if ((st.textDecorationLine || st.textDecoration || '').includes('underline')) s.u = true;
          if (st.color) s.color = st.color;
          if (st.backgroundColor && !isTransparent(st.backgroundColor)) s.hl = st.backgroundColor;
          if ((st.textDecorationLine || st.textDecoration || '').includes('line-through')) s.strike = true;
          const va = (st.verticalAlign || '').toLowerCase();
          if (va === 'sub') s.sub = true;
          else if (va === 'super') s.sup = true;
          if (st.fontSize && st.fontSize.endsWith('px')) s.size = parseFloat(st.fontSize);
        }
        if (tag === 'H1') s.size = baseSize * 1.9, s.b = true;
        if (tag === 'H2') s.size = baseSize * 1.5, s.b = true;
        if (tag === 'H3') s.size = baseSize * 1.25, s.b = true;
        for (const c of node.childNodes) walk(c, s);
      };
      walk(el, {});
      // merge adjacent runs with identical styling
      const merged = [];
      for (const r of runs) {
        if (r.br) { merged.push(r); continue; }
        const last = merged[merged.length - 1];
        if (last && !last.br && last.size === r.size && last.b === r.b &&
            last.i === r.i && last.u === r.u && last.color === r.color &&
            last.hl === r.hl && last.strike === r.strike &&
            last.sub === r.sub && last.sup === r.sup) last.text += r.text;
        else merged.push(r);
      }
      // a <br> splits into separate paragraphs
      let bucket = [], emitted = 0;
      const emit = () => {
        emitted++;
        const ml = parseFloat((el.style && el.style.marginLeft) || 0) || 0;
        const extra = ml > 8 ? Math.round(ml / 40) : 0;
        doc.push({ align: alignOf(el), list: list || null, level: (level || 0) + extra,
                   dropcap: !!(el.classList && el.classList.contains('dropcap')),
                   wordart: !!(el.classList && el.classList.contains('wordart')),
                   shade: (el.style && el.style.backgroundColor && !isTransparent(el.style.backgroundColor))
                          ? el.style.backgroundColor : null,
                   runs: bucket.length ? bucket : [{ text: '', size: baseSize }] });
        bucket = [];
      };
      /* Pictures wherever they sit in this block. execCommand wraps what it
         inserts inside whatever the caret was in, so a photo is regularly a
         level or two down from where it looks like it should be. */
      const pics = el.querySelectorAll ? [].slice.call(el.querySelectorAll('img')) : [];

      for (const r of merged) { if (r.br) emit(); else bucket.push(r); }
      // a block that holds only a picture should not also print a blank line,
      // and a trailing break should not add one either
      if (bucket.length || (!emitted && !pics.length)) emit();

      pics.forEach(function (p) {
        const ib = imageBlockFrom((p.closest && p.closest('.img-wrap')) || p);
        if (ib) doc.push(ib);
      });
    }

    /* A <table> becomes one block; each cell carries its own paragraph list,
       parsed by recursing with a fresh sub-document. */
    function pushTable(tableEl) {
      const trs = [...tableEl.querySelectorAll('tr')];
      if (!trs.length) return;
      let cols = 0;
      for (const tr of trs) cols = Math.max(cols, tr.children.length);
      const rows = trs.map(tr => {
        const cells = [];
        for (let c = 0; c < cols; c++) {
          const td = tr.children[c];
          if (!td) { cells.push({ paras: [], header: false }); continue; }
          const sub = parseDocument(td, baseSize);
          cells.push({ paras: sub, header: td.tagName === 'TH' });
        }
        return cells;
      });
      doc.push({ type: 'table', cols, rows });
    }

    function descend(el, list, level) {
      for (const child of el.children) {
        const tag = child.tagName;
        if (tag === 'TABLE') pushTable(child);
        else if (tag === 'HR') {
          const k = child.className || '';
          if (k.includes('writinglines')) doc.push({ type: 'writinglines' });
          else if (k.includes('rule')) doc.push({ type: 'rule' });
          else doc.push({ type: 'pagebreak' });
        }
        else if (tag === 'BLOCKQUOTE') descend(child, list, (level || 0) + 1);
        else if (tag === 'UL') descend(child, 'ul', (level || 0) + (list ? 1 : 0));
        else if (tag === 'OL') descend(child, 'ol', (level || 0) + (list ? 1 : 0));
        else if (tag === 'LI') pushPara(child, list, level);
        else if (tag === 'IMG' || (child.classList && child.classList.contains('img-wrap'))) {
          const ib = imageBlockFrom(child); if (ib) doc.push(ib);
        }
        else if (BLOCK.test(tag) && child.classList && child.classList.contains('textbox')) {
          const px = v => (parseFloat(v) || 0) * 0.75;      // CSS px -> points
          doc.push({ type: 'textbox',
                     w: px(child.style.width) || 0, h: px(child.style.height) || 0,
                     paras: parseDocument(child, baseSize) });
        }
        else if (BLOCK.test(tag)) {
          // execCommand wraps inserted things inside the current block
          if (child.querySelector(':scope > table, :scope > .textbox, :scope > hr')) descend(child, list, level);
          else pushPara(child, null, level || 0);
        }
      }
      // loose text directly inside the editor (before the first block)
      const loose = [...el.childNodes].filter(n =>
        n.nodeType === 3 ? n.nodeValue.trim() : (n.nodeType === 1 && !BLOCK.test(n.tagName) && n.tagName !== 'UL' && n.tagName !== 'OL'));
      if (loose.length && el === root && !el.querySelector(':scope > div, :scope > p, :scope > ul, :scope > ol, :scope > h1, :scope > h2, :scope > h3')) {
        pushPara(el, null, 0);
      }
    }

    descend(root, null, 0);
    if (!doc.length) doc.push({ align: 'left', list: null, level: 0, runs: [{ text: '', size: baseSize }] });
    return doc;
  }

  /* Flatten a model back to plain text (for folding, counts, autosave preview) */
  function docText(doc) {
    return doc.map(b => {
      if (b.type === 'textbox') return b.paras.map(p => docText([p])).join('\n');
      if (b.type && b.type !== 'table') return '';
      if (b.type === 'table')
        return b.rows.map(r => r.map(c => docText(c.paras)).join('\t')).join('\n');
      return b.runs.map(r => r.text).join('');
    }).join('\n');
  }

  /* Apply character folding to every run, preserving styling. Recurses into
     table cells so nothing in a table escapes the coverage check. */
  function foldDocument(font, doc, foldFn) {
    const changes = new Map(), lost = new Map();

    const collect = res => {
      res.changes.forEach((v, k) => {
        if (!changes.has(k)) changes.set(k, { to: v.to, count: 0 });
        changes.get(k).count += v.count;
      });
      res.lost.forEach((n, k) => lost.set(k, (lost.get(k) || 0) + n));
    };
    const foldRuns = runs => runs.map(r => {
      const res = foldFn(font, r.text);
      collect(res);
      return Object.assign({}, r, { text: res.text });
    });
    const foldBlocks = blocks => blocks.map(b => {
      if (b.type === 'textbox')
        return { type:'textbox', w:b.w, h:b.h, paras: foldBlocks(b.paras) };
      if (b.type && b.type !== 'table') return b;
      if (b.type === 'table') return {
        type: 'table', cols: b.cols,
        rows: b.rows.map(row => row.map(c => ({ header: c.header, paras: foldBlocks(c.paras) })))
      };
      return { align: b.align, list: b.list, level: b.level, shade: b.shade,
               dropcap: b.dropcap, wordart: b.wordart, runs: foldRuns(b.runs) };
    });

    return { doc: foldBlocks(doc), changes, lost };
  }

  global.NTEditor = { parseDocument, docText, foldDocument, rgbToArr, DEFAULT_SIZE };
})(window);
