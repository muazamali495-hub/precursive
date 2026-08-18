/* app.js — UI wiring, rich text toolbar, and styled PDF generation */
(function () {
  'use strict';

  const WS_HEIGHT = 52;   // vertical band reserved for the worksheet header
  const PAGE_SIZES = {
    a4:     { w: 595.28, h: 841.89, label: 'A4' },
    letter: { w: 612,    h: 792,    label: 'Letter' }
  };
  const SAVE_KEY = 'precursive-doc-v2';

  const $ = s => document.querySelector(s);
  const el = {};
  ['editor','convert','sizeSel','pageSize','orientation','rules','tracing','worksheet',
   'spacing','spacingVal','margin','marginVal','notice','noticeText','noticeDetails',
   'stats','sample','clear','status','year','colorBtn','colorInput','wsName','wsFields',
   'sizeInput','sizeUp','sizeDown','hlBtn','hlInput','tableBtn','tableMenu','tableRows',
   'tableCols','tableHeader','tableInsert','pageBreakBtn']
   .forEach(id => el[id] = document.getElementById(id));

  let FONT = null, fontBytes = null, saveTimer = null;

  /* ---------- boot ---------- */
  function b64ToBytes(b64) {
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function boot() {
    try {
      fontBytes = b64ToBytes(window.NT_FONT_B64);
      FONT = NTEngine.parseFont(fontBytes.buffer.slice(0));
    } catch (e) {
      setStatus('Could not load the font: ' + e.message, true);
      el.convert.disabled = true; return;
    }
    new FontFace('NTPreCursive', fontBytes.buffer.slice(0)).load()
      .then(f => { document.fonts.add(f); refresh(); }).catch(refresh);

    try { document.execCommand('styleWithCSS', false, true); } catch (e) {}

    wireToolbar();
    restore();

    el.editor.addEventListener('input', () => { refresh(); scheduleSave(); });
    el.editor.addEventListener('keyup', syncToolbarState);
    el.editor.addEventListener('mouseup', syncToolbarState);
    // paste as plain text so foreign fonts and colours never leak in
    el.editor.addEventListener('paste', e => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    });

    ['change','input'].forEach(ev => {
      [el.pageSize, el.orientation, el.rules, el.tracing, el.worksheet, el.spacing, el.margin]
        .forEach(c => c && c.addEventListener(ev, () => { refresh(); scheduleSave(); }));
    });
    el.convert.addEventListener('click', makePDF);
    el.sample.addEventListener('click', loadSample);
    el.clear.addEventListener('click', () => {
      if (!el.editor.textContent.trim() || confirm('Clear the document?')) {
        el.editor.innerHTML = '<div><br></div>'; refresh(); scheduleSave(); el.editor.focus();
      }
    });
    el.year.textContent = new Date().getFullYear();
    refresh();
  }

  /* ---------- toolbar ---------- */
  function exec(cmd, val) {
    el.editor.focus();
    document.execCommand(cmd, false, val === undefined ? null : val);
    refresh(); scheduleSave(); syncToolbarState();
  }

  function wireToolbar() {
    document.querySelectorAll('[data-cmd]').forEach(b => {
      b.addEventListener('mousedown', e => e.preventDefault());   // keep selection
      b.addEventListener('click', () => exec(b.dataset.cmd, b.dataset.val));
    });
    /* Size: any value from 1 to 300. execCommand's fontSize only accepts the
       legacy 1-7 scale, so tag the selection with size 7 and immediately
       rewrite those <font> tags to a real pixel size. */
    const applySize = px => {
      px = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(+px || 0)));
      el.sizeInput.value = px;
      el.editor.focus();
      document.execCommand('fontSize', false, '7');
      el.editor.querySelectorAll('font[size="7"]').forEach(f => {
        const s = document.createElement('span');
        s.style.fontSize = px + 'px';
        while (f.firstChild) s.appendChild(f.firstChild);
        f.replaceWith(s);
      });
      refresh(); scheduleSave();
    };
    el.sizeInput.addEventListener('change', () => applySize(el.sizeInput.value));
    el.sizeInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); applySize(el.sizeInput.value); }
    });
    el.sizeDown.addEventListener('click', () => applySize(stepSize(-1)));
    el.sizeUp.addEventListener('click',   () => applySize(stepSize(+1)));

    el.colorBtn.addEventListener('click', () => el.colorInput.click());
    el.colorInput.addEventListener('input', () => {
      el.colorBtn.style.setProperty('--swatch', el.colorInput.value);
      exec('foreColor', el.colorInput.value);
    });
    el.hlBtn.addEventListener('click', () => el.hlInput.click());
    el.hlInput.addEventListener('input', () => {
      el.hlBtn.style.setProperty('--swatch', el.hlInput.value);
      exec('hiliteColor', el.hlInput.value);
    });

    el.tableBtn.addEventListener('click', () => el.tableMenu.hidden = !el.tableMenu.hidden);
    el.tableInsert.addEventListener('click', () => {
      insertTable(Math.max(1, Math.min(12, +el.tableRows.value || 2)),
                  Math.max(1, Math.min(8,  +el.tableCols.value || 2)),
                  el.tableHeader.checked);
      el.tableMenu.hidden = true;
    });
    document.addEventListener('click', e => {
      if (!el.tableMenu.hidden && !el.tableMenu.contains(e.target) && e.target !== el.tableBtn)
        el.tableMenu.hidden = true;
    });
    el.pageBreakBtn.addEventListener('click', () => {
      el.editor.focus();
      document.execCommand('insertHTML', false, '<hr class="pgbreak"><div><br></div>');
      refresh(); scheduleSave();
    });
  }

  const MIN_SIZE = 1, MAX_SIZE = 300;
  const SIZE_STEPS = [8,9,10,11,12,14,16,18,20,24,28,32,40,48,56,72,96,120,150,200,250,300];
  function stepSize(dir) {
    const cur = +el.sizeInput.value || NTEditor.DEFAULT_SIZE;
    if (dir < 0) { for (let i = SIZE_STEPS.length - 1; i >= 0; i--) if (SIZE_STEPS[i] < cur) return SIZE_STEPS[i]; return MIN_SIZE; }
    for (const s of SIZE_STEPS) if (s > cur) return s;
    return MAX_SIZE;
  }

  function insertTable(rows, cols, withHeader) {
    let html = '<table class="pc-table"><tbody>';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) {
        const th = withHeader && r === 0;
        html += th ? '<th><br></th>' : '<td><br></td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table><div><br></div>';
    el.editor.focus();
    document.execCommand('insertHTML', false, html);
    refresh(); scheduleSave();
  }

  function syncToolbarState() {
    [['bold','bold'],['italic','italic'],['underline','underline'],
     ['justifyLeft','justifyLeft'],['justifyCenter','justifyCenter'],
     ['justifyRight','justifyRight'],['justifyFull','justifyFull'],
     ['insertUnorderedList','insertUnorderedList'],['insertOrderedList','insertOrderedList']]
      .forEach(([cmd]) => {
        const btn = document.querySelector('[data-cmd="' + cmd + '"]');
        if (!btn) return;
        let on = false;
        try { on = document.queryCommandState(cmd); } catch (e) {}
        btn.classList.toggle('on', on);
      });
  }

  /* ---------- state ---------- */
  function opts() {
    const ps = PAGE_SIZES[el.pageSize.value];
    const land = el.orientation.value === 'landscape';
    const m = +el.margin.value;
    return {
      pageW: land ? ps.h : ps.w, pageH: land ? ps.w : ps.h,
      marginL: m, marginR: m, marginTop: m, marginBottom: m,
      baseSize: NTEditor.DEFAULT_SIZE,
      lineSpacing: +el.spacing.value,
      indentPt: 26, paraSpacing: 0,
      label: ps.label + (land ? ' landscape' : '')
    };
  }

  function currentDoc() {
    const doc = NTEditor.parseDocument(el.editor, NTEditor.DEFAULT_SIZE);
    return NTEditor.foldDocument(FONT, doc, NTEngine.fold);
  }

  function refresh() {
    const { doc, changes, lost } = currentDoc();
    const o = opts();

    // coverage notice
    const nCh = [...changes.values()].reduce((a, c) => a + c.count, 0);
    const nLost = [...lost.values()].reduce((a, c) => a + c, 0);
    if (!nCh && !nLost) el.notice.hidden = true;
    else {
      el.notice.hidden = false;
      el.notice.classList.toggle('warn', nLost > 0);
      const bits = [];
      if (nCh) bits.push(nCh + ' character' + (nCh > 1 ? 's' : '') + ' adjusted');
      if (nLost) bits.push(nLost + ' not supported');
      el.noticeText.textContent = bits.join(' · ');
      const rows = [];
      changes.forEach((v, k) => rows.push('<span class="chip"><b>' + esc(k) + '</b> → ' +
        esc(v.to === ' ' ? '␣' : v.to) + ' <i>×' + v.count + '</i></span>'));
      lost.forEach((n, k) => rows.push('<span class="chip bad"><b>' + esc(k) + '</b> → ? <i>×' + n + '</i></span>'));
      el.noticeDetails.innerHTML = rows.join('');
    }

    // stats
    const text = NTEditor.docText(doc);
    const words = (text.match(/\S+/g) || []).length;
    let pages = 1;
    try { pages = NTLayout.flow(FONT, doc, o).length; } catch (e) {}
    el.stats.textContent = words + ' word' + (words === 1 ? '' : 's') + ' · ' +
      text.replace(/\n/g, '').length + ' chars · ' + pages + ' page' + (pages > 1 ? 's' : '') +
      ' · ' + o.label;
    el.spacingVal.textContent = (+el.spacing.value).toFixed(1) + '×';
    el.marginVal.textContent = Math.round(+el.margin.value / 2.835) + 'mm';
    el.editor.classList.toggle('tracing', el.tracing.checked);
    el.editor.style.setProperty('--ls', el.spacing.value);
    el.wsFields.hidden = !el.worksheet.checked;
    el.convert.disabled = !text.trim();
  }

  const esc = s => s.replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  function setStatus(m, err) { el.status.textContent = m || ''; el.status.classList.toggle('err', !!err); }

  /* ---------- autosave ---------- */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify({
          html: el.editor.innerHTML,
          page: el.pageSize.value, orient: el.orientation.value,
          rules: el.rules.checked, tracing: el.tracing.checked,
          worksheet: el.worksheet.checked, spacing: el.spacing.value,
          margin: el.margin.value, wsName: el.wsName.value, at: Date.now()
        }));
        if (!/^Done/.test(el.status.textContent)) {
          setStatus('Saved');
          setTimeout(() => { if (el.status.textContent === 'Saved') setStatus(''); }, 1400);
        }
      } catch (e) {}
    }, 600);
  }

  function restore() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) {}
    if (!s) { el.editor.innerHTML = '<div><br></div>'; return; }
    el.editor.innerHTML = s.html || '<div><br></div>';
    if (s.page) el.pageSize.value = s.page;
    if (s.orient) el.orientation.value = s.orient;
    el.rules.checked = !!s.rules; el.tracing.checked = !!s.tracing;
    el.worksheet.checked = !!s.worksheet;
    if (s.spacing) el.spacing.value = s.spacing;
    if (s.margin) el.margin.value = s.margin;
    if (s.wsName) el.wsName.value = s.wsName;
  }

  function loadSample() {
    el.editor.innerHTML =
      '<div style="text-align:center"><span style="font-size:30px"><b>Handwriting Practice</b></span></div>' +
      '<div><br></div>' +
      '<div>The quick brown fox jumps over the lazy dog.</div>' +
      '<div>Pack my box with five dozen liquor jugs.</div>' +
      '<div><br></div>' +
      '<div><b>Letters to practise this week:</b></div>' +
      '<ul><li>a  c  d  g  q</li><li>b  h  k  l  t</li><li>m  n  r  u  y</li></ul>' +
      '<div><br></div>' +
      '<div><i>Remember to keep your letters sitting on the line.</i></div>';
    refresh(); scheduleSave();
  }

  /* ---------- PDF ---------- */
  async function makePDF() {
    const { doc } = currentDoc();
    if (!NTEditor.docText(doc).trim()) return;

    el.convert.classList.add('busy'); el.convert.disabled = true;
    setStatus('Building your PDF…');
    try {
      await new Promise(r => setTimeout(r, 20));
      const P = PDFLib;
      const TRM = P.TextRenderingMode;
      const pdf = await P.PDFDocument.create();
      pdf.registerFontkit(window.fontkit);
      const font = await pdf.embedFont(fontBytes.buffer.slice(0), { subset: true });
      pdf.setTitle('Pre-Cursive Handwriting');
      pdf.setCreator('Pre-Cursive Editor');

      const o = opts();
      const KEY = 'F1';
      const tracing = el.tracing.checked;
      const showRules = el.rules.checked;
      const worksheet = el.worksheet.checked;
      const wsTop = worksheet ? WS_HEIGHT : 0;
      const flowOpts = Object.assign({}, o, { marginTop: o.marginTop + wsTop });
      const pages = NTLayout.flow(FONT, doc, flowOpts);

      pages.forEach((lines, pi) => {
        const page = pdf.addPage([o.pageW, o.pageH]);
        page.node.setFontDictionary(P.PDFName.of(KEY), font.ref);
        const top = o.pageH - flowOpts.marginTop;

        if (worksheet) drawWorksheetHeader(P, page, font, KEY, o);

        for (const item of lines) {
          if (item.kind === 'row') {
            drawTableRow(P, page, font, KEY, o, item.row, top - item.y, tracing);
            continue;
          }
          const ln = item.line;
          const baseY = top - ln.y;

          if (showRules) drawRules(P, page, o, baseY, ln);

          if (ln.listMark) {
            drawRun(P, page, font, KEY, ln.listMark, ln.markStyle,
                    o.marginL + ln.indent, baseY, tracing);
          }
          drawLineItems(P, page, font, KEY, ln, o.marginL, baseY, tracing);
        }
        if (pages.length > 1) drawPageNumber(P, page, font, KEY, o, pi + 1, pages.length);
      });

      const bytes = await pdf.save();
      download(bytes, filename(doc));
      setStatus('Done — ' + pages.length + ' page' + (pages.length > 1 ? 's' : '') +
                ', ' + Math.round(bytes.length / 1024) + ' KB');
    } catch (e) {
      console.error(e);
      setStatus('Something went wrong: ' + e.message, true);
    } finally {
      el.convert.classList.remove('busy'); el.convert.disabled = false;
    }
  }

  /* Draw every item on one laid-out line, plus any underline/highlight. */
  function drawLineItems(P, page, font, KEY, ln, originX, baseY, tracing) {
    for (const it of ln.items) {
      if (!it.text.trim()) continue;
      const x = originX + it.x;
      if (it.style.hl) {
        const h = NTEditor.rgbToArr(it.style.hl);
        page.pushOperators(
          P.pushGraphicsState(), P.setFillingRgbColor(h[0], h[1], h[2]),
          P.moveTo(x - 1, baseY - it.style.size * 0.24),
          P.lineTo(x + it.w + 1, baseY - it.style.size * 0.24),
          P.lineTo(x + it.w + 1, baseY + it.style.size * 0.72),
          P.lineTo(x - 1, baseY + it.style.size * 0.72),
          P.closePath(), P.fill(), P.popGraphicsState());
      }
      drawRun(P, page, font, KEY, it.text, it.style, x, baseY, tracing);
      if (it.style.u) {
        const th = Math.max(0.5, it.style.size * 0.045);
        const uy = baseY - it.style.size * 0.10;
        const c = NTEditor.rgbToArr(it.style.color);
        page.pushOperators(
          P.pushGraphicsState(), P.setStrokingRgbColor(c[0], c[1], c[2]),
          P.setLineWidth(th), P.moveTo(x, uy), P.lineTo(x + it.w, uy),
          P.stroke(), P.popGraphicsState());
      }
    }
  }

  /* Draw one table row: cell borders, an optional header tint, then the
     cell text at its own offset inside the cell. */
  function drawTableRow(P, page, font, KEY, o, row, topY, tracing) {
    const x0 = o.marginL, pad = row.pad;
    const bottomY = topY - row.height;

    for (const cell of row.cells) {
      const cx = x0 + cell.x, cw = cell.w;
      if (cell.header) {
        page.pushOperators(
          P.pushGraphicsState(), P.setFillingRgbColor(0.93, 0.95, 0.97),
          P.moveTo(cx, bottomY), P.lineTo(cx + cw, bottomY),
          P.lineTo(cx + cw, topY), P.lineTo(cx, topY),
          P.closePath(), P.fill(), P.popGraphicsState());
      }
      page.pushOperators(
        P.pushGraphicsState(), P.setLineWidth(0.7), P.setStrokingRgbColor(0.55, 0.6, 0.66),
        P.moveTo(cx, bottomY), P.lineTo(cx + cw, bottomY),
        P.lineTo(cx + cw, topY), P.lineTo(cx, topY), P.closePath(),
        P.stroke(), P.popGraphicsState());

      for (const ln of cell.lines) {
        drawLineItems(P, page, font, KEY, ln, cx + pad, topY - pad - ln.dy, tracing);
        if (ln.listMark)
          drawRun(P, page, font, KEY, ln.listMark, ln.markStyle,
                  cx + pad + ln.indent, topY - pad - ln.dy, tracing);
      }
    }
  }

  /* Draw one styled run. Bold and italic are synthesised because the font
     ships a single style — see layout.js. */
  function drawRun(P, page, font, KEY, text, style, x, y, tracing) {
    const size = style.size || NTEditor.DEFAULT_SIZE;
    const c = NTEditor.rgbToArr(style.color);
    const ops = [P.pushGraphicsState()];

    if (tracing) {
      ops.push(P.setTextRenderingMode(P.TextRenderingMode.Outline),
               P.setLineWidth(Math.max(0.35, size * 0.022)),
               P.setStrokingRgbColor(c[0], c[1], c[2]));
    } else if (style.b) {
      ops.push(P.setTextRenderingMode(P.TextRenderingMode.FillAndOutline),
               P.setLineWidth(size * NTLayout.BOLD_STROKE),
               P.setStrokingRgbColor(c[0], c[1], c[2]),
               P.setFillingRgbColor(c[0], c[1], c[2]));
    } else {
      ops.push(P.setFillingRgbColor(c[0], c[1], c[2]));
    }

    ops.push(P.beginText(), P.setFontAndSize(KEY, size));
    ops.push(style.i
      ? P.PDFOperator.of('Tm', ['1 0 ' + NTLayout.ITALIC_SKEW + ' 1 ' + fmt(x) + ' ' + fmt(y)])
      : P.setTextMatrix(1, 0, 0, 1, x, y));

    const segs = NTEngine.kernRun(FONT, text);
    const parts = [];
    for (const s of segs) {
      if (s.text) parts.push(font.encodeText(s.text).toString());
      if (s.kern) parts.push(String(Math.round(s.kern * 100) / 100));
    }
    ops.push(P.PDFOperator.of('TJ', ['[' + parts.join(' ') + ']']),
             P.endText(), P.popGraphicsState());
    page.pushOperators(...ops);
  }
  const fmt = n => Math.round(n * 1000) / 1000;

  function drawRules(P, page, o, baseY, ln) {
    const S = (ln.items[0]?.style.size || o.baseSize) / FONT.UPEM;
    const x1 = o.marginL, x2 = o.pageW - o.marginR;
    const asc = baseY + FONT.ASC * S, xh = baseY + FONT.XH * S, de = baseY + FONT.DESC * S;
    page.pushOperators(
      P.pushGraphicsState(), P.setLineWidth(0.5), P.setStrokingRgbColor(0.80, 0.88, 0.94),
      P.moveTo(x1, asc), P.lineTo(x2, asc), P.stroke(),
      P.moveTo(x1, de),  P.lineTo(x2, de),  P.stroke(),
      P.setStrokingRgbColor(0.62, 0.78, 0.90),
      P.moveTo(x1, xh),  P.lineTo(x2, xh),  P.stroke(),
      P.setStrokingRgbColor(0.50, 0.70, 0.87), P.setLineWidth(0.8),
      P.moveTo(x1, baseY), P.lineTo(x2, baseY), P.stroke(),
      P.popGraphicsState());
  }

  /* Worksheet header: optional title, then "Name" and "Date" with rules to
     write on, and a divider separating the header from the body. */
  function drawWorksheetHeader(P, page, font, KEY, o) {
    const x1 = o.marginL, x2 = o.pageW - o.marginR;
    const top = o.pageH - o.marginTop;
    const title = (el.wsName.value || '').trim();
    const grey = 'rgb(96,106,118)';

    // The whole header sits inside the top margin band (WS_HEIGHT tall) so it
    // can never clip off the page when margins are reduced.
    if (title) {
      const ts = 15;
      const w = NTLayout.runWidth(FONT, title, { size: ts });
      drawRun(P, page, font, KEY, title, { size: ts, color: grey, b: true },
              (o.pageW - w) / 2, top - 12, false);
    }

    const ls = 11, y = top - 34;
    const nameW = NTLayout.runWidth(FONT, 'Name', { size: ls });
    const dateW = NTLayout.runWidth(FONT, 'Date', { size: ls });
    const mid = x1 + (x2 - x1) * 0.64;

    drawRun(P, page, font, KEY, 'Name', { size: ls, color: grey }, x1, y, false);
    drawRun(P, page, font, KEY, 'Date', { size: ls, color: grey }, mid, y, false);

    page.pushOperators(
      P.pushGraphicsState(), P.setLineWidth(0.6), P.setStrokingRgbColor(0.72, 0.77, 0.82),
      P.moveTo(x1 + nameW + 8, y - 2), P.lineTo(mid - 18, y - 2), P.stroke(),
      P.moveTo(mid + dateW + 8, y - 2), P.lineTo(x2, y - 2), P.stroke(),
      // divider under the whole header block
      P.setLineWidth(0.8), P.setStrokingRgbColor(0.62, 0.68, 0.74),
      P.moveTo(x1, y - 12), P.lineTo(x2, y - 12), P.stroke(),
      P.popGraphicsState());
  }

  function drawPageNumber(P, page, font, KEY, o, n, total) {
    const label = n + ' of ' + total;
    const w = NTLayout.runWidth(FONT, label, { size: 9 });
    drawRun(P, page, font, KEY, label, { size: 9, color: 'rgb(130,140,150)' },
            (o.pageW - w) / 2, o.marginBottom * 0.55, false);
  }

  function filename(doc) {
    const first = (NTEditor.docText(doc).trim().split('\n')[0] || 'document')
      .replace(/[^\w \-]/g, '').trim().slice(0, 40).replace(/\s+/g, '-').toLowerCase();
    return (first || 'document') + '-precursive.pdf';
  }

  function download(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
