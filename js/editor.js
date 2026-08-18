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
          const t = node.nodeValue.replace(/ /g, ' ');
          if (t) runs.push({
            text: t,
            size: inherited.size || baseSize,
            b: !!inherited.b, i: !!inherited.i, u: !!inherited.u,
            color: inherited.color || null
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
        const st = node.style;
        if (st) {
          if (st.fontWeight === 'bold' || +st.fontWeight >= 600) s.b = true;
          if (st.fontStyle === 'italic') s.i = true;
          if ((st.textDecorationLine || st.textDecoration || '').includes('underline')) s.u = true;
          if (st.color) s.color = st.color;
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
            last.i === r.i && last.u === r.u && last.color === r.color) last.text += r.text;
        else merged.push(r);
      }
      // a <br> splits into separate paragraphs
      let bucket = [];
      const emit = () => {
        doc.push({ align: alignOf(el), list: list || null, level: level || 0,
                   runs: bucket.length ? bucket : [{ text: '', size: baseSize }] });
        bucket = [];
      };
      for (const r of merged) { if (r.br) emit(); else bucket.push(r); }
      emit();
    }

    function descend(el, list, level) {
      for (const child of el.children) {
        const tag = child.tagName;
        if (tag === 'UL') descend(child, 'ul', (level || 0) + (list ? 1 : 0));
        else if (tag === 'OL') descend(child, 'ol', (level || 0) + (list ? 1 : 0));
        else if (tag === 'LI') pushPara(child, list, level);
        else if (BLOCK.test(tag)) pushPara(child, null, 0);
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
    return doc.map(p => p.runs.map(r => r.text).join('')).join('\n');
  }

  /* Apply character folding to every run, preserving styling. */
  function foldDocument(font, doc, foldFn) {
    const changes = new Map(), lost = new Map();
    const out = doc.map(p => ({
      align: p.align, list: p.list, level: p.level,
      runs: p.runs.map(r => {
        const res = foldFn(font, r.text);
        res.changes.forEach((v, k) => {
          if (!changes.has(k)) changes.set(k, { to: v.to, count: 0 });
          changes.get(k).count += v.count;
        });
        res.lost.forEach((n, k) => lost.set(k, (lost.get(k) || 0) + n));
        return Object.assign({}, r, { text: res.text });
      })
    }));
    return { doc: out, changes, lost };
  }

  global.NTEditor = { parseDocument, docText, foldDocument, rgbToArr, DEFAULT_SIZE };
})(window);
