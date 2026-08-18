/* app.js — UI wiring + PDF generation */
(function () {
  'use strict';

  const PAGE_SIZES = {
    a4:     { w: 595.28, h: 841.89, label: 'A4' },
    letter: { w: 612,    h: 792,    label: 'Letter' }
  };

  const $ = s => document.querySelector(s);
  const el = {
    input:    $('#input'),
    convert:  $('#convert'),
    preview:  $('#preview'),
    sheet:    $('#sheet'),
    size:     $('#size'),
    sizeVal:  $('#sizeVal'),
    pageSize: $('#pageSize'),
    rules:    $('#rules'),
    notice:   $('#notice'),
    noticeTxt:$('#noticeText'),
    details:  $('#noticeDetails'),
    stats:    $('#stats'),
    sample:   $('#sample'),
    clear:    $('#clear'),
    status:   $('#status'),
    year:     $('#year')
  };

  let FONT = null;
  let fontBytes = null;

  /* ---------- boot ---------- */
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function boot() {
    try {
      fontBytes = b64ToBytes(window.NT_FONT_B64);
      FONT = NTEngine.parseFont(fontBytes.buffer.slice(0));
    } catch (e) {
      setStatus('Could not load the font: ' + e.message, true);
      el.convert.disabled = true;
      return;
    }
    // register the font for the on-screen preview
    const face = new FontFace('NTPreCursive', fontBytes.buffer.slice(0));
    face.load().then(f => { document.fonts.add(f); render(); })
               .catch(() => render());

    el.input.addEventListener('input', render);
    el.size.addEventListener('input', render);
    el.pageSize.addEventListener('change', render);
    el.rules.addEventListener('change', render);
    el.convert.addEventListener('click', makePDF);
    el.sample.addEventListener('click', () => { el.input.value = SAMPLE; render(); el.input.focus(); });
    el.clear.addEventListener('click', () => { el.input.value = ''; render(); el.input.focus(); });
    el.year.textContent = new Date().getFullYear();
    render();
  }

  const SAMPLE = `The quick brown fox jumps over the lazy dog.

Every letter in this font has a lead-in and a lead-out stroke, but the letters never join. That is what "pre-cursive" means: the stage between printing and joined-up writing.

Numbers: 0 1 2 3 4 5 6 7 8 9
Money: £25.00 and €30 — a fair price.`;

  /* ---------- preview ---------- */
  function render() {
    const raw = el.input.value;
    const size = +el.size.value;
    el.sizeVal.textContent = size + 'pt';

    const { text, changes, lost } = NTEngine.fold(FONT, raw);

    // preview sheet uses the real font via @font-face
    el.sheet.style.fontSize = size + 'pt';
    el.sheet.style.lineHeight = ((FONT.ASC - FONT.DESC + FONT.GAP) / FONT.UPEM).toFixed(3);
    el.sheet.classList.toggle('ruled', el.rules.checked);
    el.sheet.style.setProperty('--line-h',
      (size * (FONT.ASC - FONT.DESC + FONT.GAP) / FONT.UPEM).toFixed(2) + 'pt');

    if (!raw.trim()) {
      el.sheet.innerHTML = '<span class="placeholder">Your handwriting will appear here…</span>';
    } else {
      el.sheet.textContent = text;
    }

    // coverage notice
    const nChanged = [...changes.values()].reduce((a, c) => a + c.count, 0);
    const nLost = [...lost.values()].reduce((a, c) => a + c, 0);
    if (!nChanged && !nLost) {
      el.notice.hidden = true;
    } else {
      el.notice.hidden = false;
      el.notice.classList.toggle('warn', nLost > 0);
      const bits = [];
      if (nChanged) bits.push(`${nChanged} character${nChanged > 1 ? 's' : ''} adjusted`);
      if (nLost) bits.push(`${nLost} not supported`);
      el.noticeTxt.textContent = bits.join(' · ');
      const rows = [];
      changes.forEach((v, k) => rows.push(
        `<span class="chip"><b>${esc(k)}</b> → ${esc(v.to === ' ' ? '␣' : v.to)} <i>×${v.count}</i></span>`));
      lost.forEach((n, k) => rows.push(
        `<span class="chip bad"><b>${esc(k)}</b> → ? <i>×${n}</i></span>`));
      el.details.innerHTML = rows.join('');
    }

    // page/line stats
    const ps = PAGE_SIZES[el.pageSize.value];
    const margin = 56;
    const lines = NTEngine.wrap(FONT, text, size, ps.w - margin * 2);
    const lineH = size * (FONT.ASC - FONT.DESC + FONT.GAP) / FONT.UPEM;
    const perPage = Math.max(1, Math.floor((ps.h - margin * 2) / lineH));
    const pages = Math.max(1, Math.ceil(lines.length / perPage));
    const chars = raw.length;
    el.stats.textContent = raw.trim()
      ? `${chars.toLocaleString()} characters · ${lines.length} lines · ${pages} page${pages > 1 ? 's' : ''} (${ps.label})`
      : `${ps.label} · ready`;
    el.convert.disabled = !raw.trim();
  }

  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function setStatus(msg, isErr) {
    el.status.textContent = msg || '';
    el.status.classList.toggle('err', !!isErr);
  }

  /* ---------- PDF ---------- */
  async function makePDF() {
    const raw = el.input.value;
    if (!raw.trim()) return;

    el.convert.classList.add('busy');
    el.convert.disabled = true;
    setStatus('Building your PDF…');

    try {
      // let the browser paint the busy state before the heavy work
      await new Promise(r => setTimeout(r, 20));

      const { PDFDocument, PDFOperator, PDFName, pushGraphicsState, popGraphicsState,
              beginText, endText, setFontAndSize, setTextMatrix,
              setFillingRgbColor, moveTo, lineTo, stroke, setStrokingRgbColor,
              setLineWidth } = PDFLib;

      // Resource key for the font on each page. Because we write raw operators
      // instead of page.drawText(), pdf-lib does NOT register the font in the
      // page's /Resources /Font dictionary for us — without this every viewer
      // falls back to a default face and the handwriting never appears.
      const FONT_KEY = 'F1';

      const doc = await PDFDocument.create();
      doc.registerFontkit(window.fontkit);
      const font = await doc.embedFont(fontBytes.buffer.slice(0), { subset: true });

      doc.setTitle('Pre-Cursive Handwriting');
      doc.setCreator('Pre-Cursive Converter');
      doc.setProducer('Pre-Cursive Converter');

      const size = +el.size.value;
      const ps = PAGE_SIZES[el.pageSize.value];
      const margin = 56;
      const colW = ps.w - margin * 2;
      const lineH = size * (FONT.ASC - FONT.DESC + FONT.GAP) / FONT.UPEM;
      const perPage = Math.max(1, Math.floor((ps.h - margin * 2) / lineH));

      const { text } = NTEngine.fold(FONT, raw);
      const lines = NTEngine.wrap(FONT, text, size, colW);
      const pages = NTEngine.paginate(lines, perPage);
      const showRules = el.rules.checked;

      const S = size / FONT.UPEM;

      for (const pgLines of pages) {
        const page = doc.addPage([ps.w, ps.h]);
        page.node.setFontDictionary(PDFName.of(FONT_KEY), font.ref);
        const top = ps.h - margin - FONT.ASC * S;

        pgLines.forEach((ln, i) => {
          const baseY = top - i * lineH;

          if (showRules) {
            const y = { asc: baseY + FONT.ASC * S, x: baseY + FONT.XH * S,
                        base: baseY, desc: baseY + FONT.DESC * S };
            page.pushOperators(
              pushGraphicsState(), setLineWidth(0.5), setStrokingRgbColor(0.80, 0.88, 0.94),
              moveTo(margin, y.asc),  lineTo(ps.w - margin, y.asc),  stroke(),
              moveTo(margin, y.desc), lineTo(ps.w - margin, y.desc), stroke(),
              setStrokingRgbColor(0.62, 0.78, 0.90),
              moveTo(margin, y.x),    lineTo(ps.w - margin, y.x),    stroke(),
              setStrokingRgbColor(0.50, 0.70, 0.87), setLineWidth(0.8),
              moveTo(margin, y.base), lineTo(ps.w - margin, y.base), stroke(),
              popGraphicsState()
            );
          }

          if (!ln) return;

          // Emit a TJ array carrying this font's own kern values. pdf-lib will
          // not do this for us: it reads GPOS only, and this font has none.
          const segs = NTEngine.kernRun(FONT, ln);
          const parts = [];
          for (const s of segs) {
            if (s.text) parts.push(font.encodeText(s.text).toString());
            if (s.kern) parts.push(String(Math.round(s.kern * 100) / 100));
          }
          page.pushOperators(
            pushGraphicsState(),
            setFillingRgbColor(0.106, 0.129, 0.161),
            beginText(),
            setFontAndSize(FONT_KEY, size),
            setTextMatrix(1, 0, 0, 1, margin, baseY),
            PDFOperator.of('TJ', ['[' + parts.join(' ') + ']']),
            endText(),
            popGraphicsState()
          );
        });
      }

      const bytes = await doc.save();
      download(bytes, filename());
      setStatus(`Done — ${pages.length} page${pages.length > 1 ? 's' : ''}, ${(bytes.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      console.error(e);
      setStatus('Something went wrong: ' + e.message, true);
    } finally {
      el.convert.classList.remove('busy');
      el.convert.disabled = false;
    }
  }

  function filename() {
    const first = (el.input.value.trim().split('\n')[0] || 'handwriting')
      .replace(/[^\w \-]/g, '').trim().slice(0, 40).replace(/\s+/g, '-').toLowerCase();
    return (first || 'handwriting') + '-precursive.pdf';
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
