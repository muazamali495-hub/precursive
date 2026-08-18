/* layout.js — styled-run layout for NTPreCursive
 *
 * The v1 engine laid out plain lines of one size. Rich text needs a line to
 * mix sizes and styles, so everything here works on *runs*:
 *
 *   run  = { text, size, b, i, u, color }
 *   para = { align, list, level, runs }
 *
 * Because the font ships a single style, bold and italic are synthesised at
 * draw time (stroke width / sheared matrix). Metrics must account for that:
 * synthetic bold makes glyphs fractionally wider, so measurement adds the
 * stroke, otherwise bold text would overflow its line.
 */
(function (global) {
  'use strict';

  const BOLD_STROKE = 0.030;   // stroke width as a fraction of font size
  const ITALIC_SKEW = 0.2126;  // tan(12deg)

  const SUBSUP = 0.66;   // sub/superscript draw at this fraction of the size

  function runWidth(font, text, style) {
    const eff = (style.sub || style.sup) ? style.size * SUBSUP : style.size;
    const S = eff / font.UPEM;
    let w = 0, prev = -1;
    for (const ch of text) {
      const g = font.gid(ch.codePointAt(0));
      if (g === undefined) continue;
      if (prev >= 0) w += font.kern(prev, g);
      w += font.ADV[g];
      prev = g;
    }
    let out = w * S;
    // synthetic bold strokes outward, widening the run slightly
    if (style.b && text.length) out += style.size * BOLD_STROKE;
    return out;
  }

  /* Split a paragraph into styled tokens (words and whitespace). */
  function tokenize(para) {
    const toks = [];
    for (const run of para.runs) {
      if (!run.text) continue;
      for (const piece of run.text.split(/(\s+)/)) {
        if (piece === '') continue;
        toks.push({ text: piece, style: run, space: /^\s+$/.test(piece) });
      }
    }
    return toks;
  }

  const LIST_GAP = 0.9;   // bullet gutter, in ems of the paragraph size

  function bulletFor(para, index) {
    if (para.list === 'ul') return '•';
    if (para.list === 'ol') return index + '.';
    return null;
  }

  /* Lay one paragraph into lines that fit colW.
   * Returns [{ items:[{text,style,x,w}], width, ascent, descent, first }]
   */
  function layoutParagraph(font, para, colW, opts) {
    if (!para || !para.runs) para = { align: 'left', runs: [{ text: '', size: opts.baseSize }] };
    const indent = (para.level || 0) * (opts.indentPt || 24);
    const listMark = bulletFor(para, opts.listIndex || 1);
    const markStyle = para.runs[0] || { size: opts.baseSize, b: false, i: false };
    const markW = listMark ? runWidth(font, listMark, markStyle) + markStyle.size * LIST_GAP : 0;

    const avail0 = colW - indent - markW;      // first line (after bullet)
    const availN = colW - indent - markW;      // continuation lines align under text

    const toks = tokenize(para);
    const lines = [];
    let cur = [], curW = 0, first = true;

    const flush = () => {
      // drop trailing whitespace tokens
      while (cur.length && cur[cur.length - 1].space) { curW -= cur[cur.length - 1].w; cur.pop(); }
      lines.push({ items: cur, width: curW, first });
      cur = []; curW = 0; first = false;
    };

    for (let t = 0; t < toks.length; t++) {
      const tok = toks[t];
      let w = runWidth(font, tok.text, tok.style);
      const avail = first ? avail0 : availN;

      // a single word longer than the column must be split by character
      if (!tok.space && w > avail && !cur.length) {
        let rest = tok.text;
        while (runWidth(font, rest, tok.style) > avail && rest.length > 1) {
          let cut = 1;
          while (cut < rest.length &&
                 runWidth(font, rest.slice(0, cut + 1), tok.style) <= avail) cut++;
          const piece = rest.slice(0, cut);
          cur.push({ text: piece, style: tok.style, w: runWidth(font, piece, tok.style) });
          curW = runWidth(font, piece, tok.style);
          flush();
          rest = rest.slice(cut);
        }
        if (rest) { w = runWidth(font, rest, tok.style); cur.push({ text: rest, style: tok.style, w }); curW += w; }
        continue;
      }

      if (curW + w > avail && cur.length && !tok.space) { flush(); }
      if (tok.space && !cur.length) continue;      // no leading spaces on a line
      cur.push({ text: tok.text, style: tok.style, w });
      curW += w;
    }
    if (cur.length || !lines.length) flush();

    // vertical metrics per line, from the largest style present
    const asc = font.ASC / font.UPEM, desc = font.DESC / font.UPEM, gap = font.GAP / font.UPEM;
    for (const ln of lines) {
      let maxSize = opts.baseSize;
      for (const it of ln.items) maxSize = Math.max(maxSize, it.style.size);
      ln.ascent = asc * maxSize;
      ln.descent = -desc * maxSize;
      ln.height = (asc - desc + gap) * maxSize * (opts.lineSpacing || 1);
      ln.indent = indent;
      ln.markW = markW;
    }
    if (lines.length) { lines[0].listMark = listMark; lines[0].markStyle = markStyle; }
    return lines;
  }

  /* Assign x positions honouring alignment. Justify stretches inter-word gaps. */
  function positionLine(line, colW, align, isLastOfPara) {
    const startBase = line.indent + line.markW;
    const free = (colW - startBase) - line.width;
    let x = startBase, extra = 0;

    if (align === 'center') x = startBase + free / 2;
    else if (align === 'right') x = startBase + free;
    else if (align === 'justify' && !isLastOfPara) {
      const gaps = line.items.filter(i => /^\s+$/.test(i.text)).length;
      if (gaps > 0 && free > 0) extra = free / gaps;
    }
    for (const it of line.items) {
      it.x = x;
      x += it.w + (extra && /^\s+$/.test(it.text) ? extra : 0);
      if (extra && /^\s+$/.test(it.text)) it.w += extra;
    }
    return line;
  }

  /* A table cell or text box may itself contain a table, another box, an image
     or a page break. Those cannot be laid out recursively inside a cell, so
     flatten them to plain paragraphs: the text still prints instead of the
     whole export failing. */
  function flattenNested(blocks, baseSize) {
    const out = [];
    for (const b of blocks || []) {
      if (!b) continue;
      if (!b.type) { out.push(b); continue; }
      if (b.type === 'textbox') { out.push(...flattenNested(b.paras, baseSize)); continue; }
      if (b.type === 'table') {
        for (const row of b.rows || [])
          for (const cell of row || [])
            out.push(...flattenNested(cell && cell.paras, baseSize));
        continue;
      }
      // image, page break, rule and writing lines have no text to salvage
    }
    return out.length ? out : [{ align: 'left', runs: [{ text: '', size: baseSize }] }];
  }

  /* ---------- tables ----------
   * Columns split the text width equally. Each cell holds its own paragraphs,
   * laid out inside (cellWidth - 2*padding). A row is as tall as its tallest
   * cell, and rows are atomic when paginating — a row never splits across a
   * page boundary, which is what keeps a table readable.
   */
  function layoutTable(font, table, colW, opts) {
    const n = Math.max(1, table.cols);
    const pad = opts.cellPad != null ? opts.cellPad : 6;
    const cw = colW / n;
    const inner = Math.max(12, cw - pad * 2);
    const rows = [];

    for (const row of table.rows) {
      const cells = [];
      let tallest = 0;
      for (let c = 0; c < n; c++) {
        const src = row[c] || { paras: [] };
        const paras = flattenNested(src.paras, opts.baseSize);
        let lines = [], h = 0;
        for (const para of paras) {
          const ls = layoutParagraph(font, para, inner, opts);
          for (let i = 0; i < ls.length; i++) {
            positionLine(ls[i], inner, para.align || 'left', i === ls.length - 1);
            ls[i].dy = h + ls[i].ascent;
            h += ls[i].height;
          }
          lines = lines.concat(ls);
        }
        cells.push({ lines, x: c * cw, w: cw, header: !!src.header });
        if (h > tallest) tallest = h;
      }
      rows.push({ cells, height: tallest + pad * 2, pad, cw, cols: n });
    }
    return rows;
  }

  /* Flow a whole document into pages.
   * doc = [ para | {type:'table',...} | {type:'pagebreak'} ]
   * Returns [ [ item ] ] where item is {kind:'line'|'row', ..., y}
   * y is the distance DOWN from the top text edge.
   */
  function flow(font, doc, opts) {
    const colW = opts.pageW - opts.marginL - opts.marginR;
    const usableH = opts.pageH - opts.marginTop - opts.marginBottom;
    const pages = [];
    let page = [], y = 0, olCount = 0;

    const newPage = () => { pages.push(page); page = []; y = 0; };

    for (const block of doc) {
      if (block && block.type === 'pagebreak') {
        if (page.length) newPage();
        continue;
      }

      if (block && block.type === 'textbox') {
        const pad = 6;
        const w = Math.min(colW, block.w || colW);
        const inner = Math.max(20, w - pad * 2);
        const content = [];   // { type:'lines', lines } | { type:'image', src, x, dy, w, h }
        let ch = 0;
        for (const sub of (block.paras || [])) {
          if (sub && sub.type === 'image') {
            const natW = (sub.w || 200) * 0.75, natH = (sub.h || 150) * 0.75;
            const iw = Math.min(inner, natW), ih = natH * (iw / (natW || 1));
            content.push({ type: 'image', src: sub.src, x: 0, dy: ch, w: iw, h: ih });
            ch += ih + 4;
          } else {
            // paragraphs, and any nested table/box flattened to text
            const paras = sub && sub.type ? flattenNested([sub], opts.baseSize) : [sub];
            for (const para of paras) {
              const ls = layoutParagraph(font, para, inner, opts);
              for (let i = 0; i < ls.length; i++) {
                positionLine(ls[i], inner, (para && para.align) || 'left', i === ls.length - 1);
                ls[i].dy = ch + ls[i].ascent;
                ch += ls[i].height;
              }
              content.push({ type: 'lines', lines: ls });
            }
          }
        }
        // honour the dragged size, but never clip the content it holds
        const h = Math.max(block.h || 0, ch + pad * 2);
        if (y + h > usableH && page.length) newPage();
        page.push({ kind: 'textbox', x: 0, w: w, h: h, pad: pad, content: content, y: y });
        y += h + 6;
        continue;
      }
      if (block && block.type === 'image') {
        // scale to fit the column, converting CSS px to points
        const natW = (block.w || 400) * 0.75, natH = (block.h || 300) * 0.75;
        const w = Math.min(colW, natW), h = natH * (w / (natW || 1));
        if (y + h > usableH && page.length) newPage();
        page.push({ kind: 'image', src: block.src, x: 0, w: w, h: h, y: y });
        y += h + 6;
        continue;
      }
      if (block && (block.type === 'rule' || block.type === 'writinglines')) {
        const n = block.type === 'writinglines' ? 4 : 1;
        const gap = 26, h = n === 1 ? 14 : n * gap;
        if (y + h > usableH && page.length) newPage();
        page.push({ kind: 'rule', variant: block.type, y: y, h: h, gap: gap, count: n });
        y += h + 6;
        continue;
      }
      if (block && block.type === 'table') {
        const rows = layoutTable(font, block, colW, opts);
        for (const row of rows) {
          // a row taller than a whole page can only be placed as-is
          if (y + row.height > usableH && page.length) newPage();
          row.y = y;
          page.push({ kind: 'row', row: row, y: y });
          y += row.height;
        }
        y += (opts.paraSpacing || 0) + 4;
        olCount = 0;
        continue;
      }

      const para = block;
      if (para.list === 'ol') olCount++; else olCount = 0;
      const lines = layoutParagraph(font, para, colW, {
        baseSize: opts.baseSize, lineSpacing: opts.lineSpacing,
        indentPt: opts.indentPt, listIndex: olCount
      });
      lines.forEach((ln, idx) => {
        positionLine(ln, colW, para.align || 'left', idx === lines.length - 1);
        if (y + ln.height > usableH && page.length) newPage();
        ln.y = y + ln.ascent;
        y += ln.height;
        page.push({ kind: 'line', line: ln, y: ln.y });
      });
      y += (opts.paraSpacing || 0);
    }
    if (page.length || !pages.length) pages.push(page);
    return pages;
  }

  global.NTLayout = {
    runWidth, layoutParagraph, layoutTable, positionLine, flow, flattenNested, SUBSUP,
    BOLD_STROKE, ITALIC_SKEW
  };
})(window);
