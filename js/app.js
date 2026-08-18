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
  ['editor','convert','pageSize','orientation','rules','tracing','worksheet',
   'spacing','spacingVal','margin','marginVal','notice','noticeText','noticeDetails',
   'stats','sample','clear','status','year','colorBtn','colorInput','wsName',
   'sizeInput','sizeUp','sizeDown','hlBtn','hlInput','tableBtn','tableMenu','tableRows',
   'tableCols','tableHeader','tableInsert','pageBreakBtn','shadeBtn','shadeInput',
   'caseBtn','caseMenu','spacingBtn','spacingMenu','marksBtn','fmtPainter',
   'blankPageBtn','coverBtn','pictureBtn','pictureInput','shapeBtn','shapeMenu',
   'linkBtn','unlinkBtn','headerBtn','footerBtn','pageNumBtn','textBoxBtn',
   'wordArtBtn','dropCapBtn','dateBtn','symbolBtn','symbolMenu','symbolGrid',
   'headerMenu','headerText','headerAlign','headerSize','headerRule',
   'footerMenu','footerText','footerAlign','footerSize']
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

    el.shadeBtn.addEventListener('click', () => el.shadeInput.click());
    el.shadeInput.addEventListener('input', () => {
      el.shadeBtn.style.setProperty('--swatch', el.shadeInput.value);
      applyToBlock(b => b.style.backgroundColor = el.shadeInput.value);
    });

    /* --- change case --- */
    popToggle(el.caseBtn, el.caseMenu);
    el.caseMenu.querySelectorAll('[data-case]').forEach(b =>
      b.addEventListener('click', () => { changeCase(b.dataset.case); el.caseMenu.hidden = true; }));

    /* --- line spacing --- */
    popToggle(el.spacingBtn, el.spacingMenu);
    el.spacingMenu.querySelectorAll('[data-sp]').forEach(b =>
      b.addEventListener('click', () => {
        el.spacing.value = b.dataset.sp;
        el.spacing.dispatchEvent(new Event('input', { bubbles: true }));
        el.spacingMenu.hidden = true;
      }));

    /* --- formatting marks (editor-only) --- */
    el.marksBtn.addEventListener('click', () => {
      el.marksBtn.classList.toggle('on');
      el.editor.classList.toggle('marks', el.marksBtn.classList.contains('on'));
    });

    /* --- format painter --- */
    el.fmtPainter.addEventListener('click', () => {
      if (painter) { painter = null; el.fmtPainter.classList.remove('on'); return; }
      painter = capturedStyle();
      el.fmtPainter.classList.toggle('on', !!painter);
    });
    el.editor.addEventListener('mouseup', () => {
      if (!painter) return;
      applyCaptured(painter);
      painter = null; el.fmtPainter.classList.remove('on');
    });

    /* --- Insert: pages --- */
    el.blankPageBtn.addEventListener('click', () =>
      insertHTML('<hr class="pgbreak"><div><br></div><hr class="pgbreak"><div><br></div>'));
    el.coverBtn.addEventListener('click', () => insertHTML(
      '<div style="text-align:center"><span style="font-size:44px"><b>Title</b></span></div>' +
      '<div style="text-align:center"><span style="font-size:22px">Subtitle</span></div>' +
      '<div><br></div><div style="text-align:center">Name &nbsp;&nbsp; Date</div>' +
      '<hr class="pgbreak"><div><br></div>'));
    el.pageBreakBtn.addEventListener('click', () =>
      insertHTML('<hr class="pgbreak"><div><br></div>'));

    /* --- Insert: pictures --- */
    el.pictureBtn.addEventListener('click', () => el.pictureInput.click());
    el.pictureInput.addEventListener('change', () => {
      const f = el.pictureInput.files && el.pictureInput.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        insertHTML('<div><img src="' + rd.result + '" alt=""></div><div><br></div>');
      };
      rd.readAsDataURL(f);
      el.pictureInput.value = '';
    });

    /* --- Insert: shapes --- */
    popToggle(el.shapeBtn, el.shapeMenu);
    el.shapeMenu.querySelectorAll('[data-shape]').forEach(b =>
      b.addEventListener('click', () => {
        const s = b.dataset.shape;
        if (s === 'hr') insertHTML('<hr class="rule"><div><br></div>');
        if (s === 'box') insertHTML('<div class="textbox"><br></div><div><br></div>');
        if (s === 'writing') insertHTML('<hr class="writinglines"><div><br></div>');
        el.shapeMenu.hidden = true;
      }));

    /* --- Insert: links --- */
    el.linkBtn.addEventListener('click', () => {
      const url = prompt('Link address:', 'https://');
      if (url) exec('createLink', url);
    });
    el.unlinkBtn.addEventListener('click', () => exec('unlink'));

    /* --- Insert: header / footer / page number --- */
    popToggle(el.headerBtn, el.headerMenu, () => setTimeout(() => el.headerText.focus(), 0));
    popToggle(el.footerBtn, el.footerMenu, () => setTimeout(() => el.footerText.focus(), 0));
    [el.headerText, el.headerAlign, el.headerSize, el.headerRule,
     el.footerText, el.footerAlign, el.footerSize].forEach(c =>
      c.addEventListener('input', () => { refresh(); scheduleSave(); }));
    el.pageNumBtn.addEventListener('click', () => {
      pageNumbers = !pageNumbers;
      el.pageNumBtn.classList.toggle('on', pageNumbers);
      setStatus(pageNumbers ? 'Page numbers on' : 'Page numbers off');
      refresh(); scheduleSave();
    });

    /* --- Insert: text --- */
    el.textBoxBtn.addEventListener('click', () =>
      insertHTML('<div class="textbox">Text box</div><div><br></div>'));
    el.wordArtBtn.addEventListener('click', () =>
      insertHTML('<div class="wordart">WordArt</div><div><br></div>'));
    el.dropCapBtn.addEventListener('click', () => applyToBlock(b => b.classList.toggle('dropcap')));
    el.dateBtn.addEventListener('click', () => {
      const d = new Date();
      insertHTML(d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }));
    });

    /* --- Insert: symbols (only what this font can actually draw) --- */
    popToggle(el.symbolBtn, el.symbolMenu, buildSymbolGrid);

    popToggle(el.tableBtn, el.tableMenu);
    el.tableInsert.addEventListener('click', () => {
      insertTable(Math.max(1, Math.min(20, +el.tableRows.value || 2)),
                  Math.max(1, Math.min(8,  +el.tableCols.value || 2)),
                  el.tableHeader.checked);
      closeMenus();
    });
  }

  /* ---------- ribbon helpers ---------- */
  let painter = null, pageNumbers = false;

  function insertHTML(html) {
    el.editor.focus();
    document.execCommand('insertHTML', false, html);
    refresh(); scheduleSave();
  }

  function closeMenus() {
    document.querySelectorAll('.popmenu').forEach(m => m.hidden = true);
  }

  /* Menus are position:fixed, so place them from the button's viewport rect
     and clamp so they never hang off the edge of the window. */
  function placeMenu(btn, menu) {
    menu.hidden = false;
    menu.style.visibility = 'hidden';
    const b = btn.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    // innerWidth/innerHeight can be 0 in a hidden or not-yet-composited view;
    // fall back so the clamp never decides the whole window is off screen.
    const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const vh = window.innerHeight || document.documentElement.clientHeight || 768;
    let left = b.left;
    let top = b.bottom + 3;
    if (left + m.width > vw - 8) left = Math.max(8, vw - m.width - 8);
    // only flip above the button when there is genuinely more room up there
    if (top + m.height > vh - 8 && b.top - m.height - 3 >= 8) top = b.top - m.height - 3;
    if (top + m.height > vh - 8) top = Math.max(8, vh - m.height - 8);
    if (top < 8) top = 8;
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.style.visibility = '';
  }

  function popToggle(btn, menu, onOpen) {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const opening = menu.hidden;
      closeMenus();
      if (!opening) return;
      if (onOpen) onOpen();
      placeMenu(btn, menu);
    });
    menu.addEventListener('click', e => e.stopPropagation());
  }
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });
  window.addEventListener('resize', closeMenus);
  document.querySelector('.stage')?.addEventListener('scroll', closeMenus);

  function switchTab(name) {
    const t = document.querySelector('.rb-tab[data-tab="' + name + '"]');
    if (t) t.click();
  }

  /* The block element containing the caret — used by shading and drop cap. */
  function currentBlock() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.getRangeAt(0).startContainer;
    if (n.nodeType === 3) n = n.parentNode;
    while (n && n !== el.editor && !/^(DIV|P|LI|H1|H2|H3|TD|TH)$/.test(n.tagName)) n = n.parentNode;
    return n === el.editor ? null : n;
  }
  function applyToBlock(fn) {
    const b = currentBlock();
    if (!b) { setStatus('Put the cursor in a paragraph first'); return; }
    fn(b); refresh(); scheduleSave();
  }

  function changeCase(mode) {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { setStatus('Select some text first'); return; }
    const text = sel.toString();
    let out = text;
    if (mode === 'upper') out = text.toUpperCase();
    else if (mode === 'lower') out = text.toLowerCase();
    else if (mode === 'title') out = text.replace(/\b\w/g, c => c.toUpperCase());
    else if (mode === 'sentence') out = text.toLowerCase().replace(/(^\s*\w|[.!?]\s+\w)/g, c => c.toUpperCase());
    else if (mode === 'toggle') out = [...text].map(c =>
      c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join('');
    el.editor.focus();
    document.execCommand('insertText', false, out);
    refresh(); scheduleSave();
  }

  /* Format painter: remember the styling at the caret, then re-apply it. */
  function capturedStyle() {
    const b = currentBlock();
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.getRangeAt(0).startContainer;
    if (n.nodeType === 3) n = n.parentNode;
    const cs = getComputedStyle(n);
    return {
      bold: +cs.fontWeight >= 600, italic: cs.fontStyle === 'italic',
      underline: cs.textDecorationLine.includes('underline'),
      size: Math.round(parseFloat(cs.fontSize)), color: cs.color,
      align: b ? (b.style.textAlign || 'left') : null
    };
  }
  function applyCaptured(st) {
    if (!st) return;
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    el.editor.focus();
    document.execCommand('removeFormat');
    if (st.bold) document.execCommand('bold');
    if (st.italic) document.execCommand('italic');
    if (st.underline) document.execCommand('underline');
    if (st.color) document.execCommand('foreColor', false, st.color);
    if (st.size) { el.sizeInput.value = st.size; el.sizeInput.dispatchEvent(new Event('change', { bubbles: true })); }
    if (st.align) {
      const b = currentBlock();
      if (b) b.style.textAlign = st.align;
    }
    refresh(); scheduleSave();
  }

  /* Only offer symbols the font can actually draw — the tofu set is excluded. */
  function buildSymbolGrid() {
    if (el.symbolGrid.childElementCount) return;
    const cps = [];
    for (const [cp] of FONT.CMAP) if (FONT.usable(cp) && cp > 32) cps.push(cp);
    cps.sort((a, b) => a - b);
    el.symbolGrid.innerHTML = cps.map(cp =>
      '<button type="button" data-cp="' + cp + '" title="U+' +
      cp.toString(16).toUpperCase().padStart(4, '0') + '">' +
      String.fromCodePoint(cp).replace('&', '&amp;').replace('<', '&lt;') + '</button>').join('');
    el.symbolGrid.querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => {
        el.editor.focus();
        document.execCommand('insertText', false, String.fromCodePoint(+b.dataset.cp));
        el.symbolMenu.hidden = true; refresh(); scheduleSave();
      }));
  }

  /* ---------- font size ----------
   * execCommand('fontSize') is unusable here. It only understands the legacy
   * 1-7 scale, what it emits depends on styleWithCSS, and with a collapsed
   * caret it reaches for the nearest inline ancestor — which is how changing
   * the size for a new paragraph could silently restyle the previous one.
   *
   * Instead we work on the Range directly: split the boundary text nodes so
   * only the selected characters are affected, wrap each selected text node in
   * its own span, and clear any font-size inside that span so the new value
   * wins. With a collapsed caret we insert an empty styled span and park the
   * caret in it, so the size applies to what is typed next and to nothing else.
   */
  const ZWSP = '​';

  function applySize(px) {
    px = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(+px || 0)));
    el.sizeInput.value = px;
    el.editor.focus();

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    let range = sel.getRangeAt(0);
    if (!el.editor.contains(range.commonAncestorContainer)) return;

    if (range.collapsed) {
      const span = document.createElement('span');
      span.style.fontSize = px + 'px';
      span.appendChild(document.createTextNode(ZWSP));
      range.insertNode(span);
      const r = document.createRange();
      r.setStart(span.firstChild, 1);
      r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
      refresh(); scheduleSave();
      return;
    }

    // split the partially-selected boundary nodes so we never touch
    // characters outside the selection
    let { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo } = range;
    if (ec.nodeType === 3 && eo > 0 && eo < ec.nodeValue.length) {
      ec.splitText(eo);
      if (sc === ec && so > eo) { sc = ec; }
    }
    if (sc.nodeType === 3 && so > 0 && so < sc.nodeValue.length) {
      const after = sc.splitText(so);
      if (ec === sc) ec = after;
      sc = after; so = 0;
    }
    range = document.createRange();
    range.setStart(sc, sc.nodeType === 3 ? 0 : so);
    range.setEnd(ec, ec.nodeType === 3 ? ec.nodeValue.length : eo);

    const targets = [];
    const walker = document.createTreeWalker(el.editor, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue.length) continue;
      if (range.intersectsNode(n)) targets.push(n);
    }
    if (!targets.length) return;

    let first = null, last = null;
    for (const t of targets) {
      if (!t.parentNode) continue;
      const span = document.createElement('span');
      span.style.fontSize = px + 'px';
      t.parentNode.insertBefore(span, t);
      span.appendChild(t);
      // an ancestor size is overridden by this span; a *descendant* size would
      // beat it, but a text node has none, so nothing further is needed here
      first = first || span; last = span;
    }
    // strip now-redundant sizes on ancestors that only wrapped this run
    const r2 = document.createRange();
    if (first && last) {
      r2.setStartBefore(first); r2.setEndAfter(last);
      sel.removeAllRanges(); sel.addRange(r2);
    }
    refresh(); scheduleSave();
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
          margin: el.margin.value, wsName: el.wsName.value,
          headerText: el.headerText.value, headerAlign: el.headerAlign.value,
          headerSize: el.headerSize.value, headerRule: el.headerRule.checked,
          footerText: el.footerText.value, footerAlign: el.footerAlign.value,
          footerSize: el.footerSize.value, pageNumbers: pageNumbers, at: Date.now()
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
    if (s.headerText) el.headerText.value = s.headerText;
    if (s.headerAlign) el.headerAlign.value = s.headerAlign;
    if (s.headerSize) el.headerSize.value = s.headerSize;
    if (s.headerRule !== undefined) el.headerRule.checked = !!s.headerRule;
    if (s.footerText) el.footerText.value = s.footerText;
    if (s.footerAlign) el.footerAlign.value = s.footerAlign;
    if (s.footerSize) el.footerSize.value = s.footerSize;
    pageNumbers = !!s.pageNumbers;
    if (el.pageNumBtn) el.pageNumBtn.classList.toggle('on', pageNumbers);
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

      // embed every distinct image once
      const imgCache = new Map();
      for (const pg of pages) for (const it of pg) {
        if (it.kind !== 'image' || imgCache.has(it.src)) continue;
        try {
          const b64 = String(it.src).split(',')[1];
          const bin = atob(b64); const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const isPng = String(it.src).slice(0, 20).toLowerCase().indexOf('image/png') > 0;
          imgCache.set(it.src, isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes));
        } catch (err) { console.warn('image skipped:', err.message); imgCache.set(it.src, null); }
      }

      pages.forEach((lines, pi) => {
        const page = pdf.addPage([o.pageW, o.pageH]);
        page.node.setFontDictionary(P.PDFName.of(KEY), font.ref);
        const top = o.pageH - flowOpts.marginTop;

        if (worksheet) drawWorksheetHeader(P, page, font, KEY, o);
        drawRunningHeader(P, page, font, KEY, o);
        drawRunningFooter(P, page, font, KEY, o, pi + 1, pages.length);

        for (const item of lines) {
          if (item.kind === 'image') {
            const img = imgCache.get(item.src);
            if (img) page.drawImage(img, { x: o.marginL + item.x, y: top - item.y - item.h,
                                           width: item.w, height: item.h });
            continue;
          }
          if (item.kind === 'rule') {
            const x1 = o.marginL, x2 = o.pageW - o.marginR;
            const ops = [P.pushGraphicsState()];
            if (item.variant === 'writinglines') {
              for (let k = 0; k < item.count; k++) {
                const yy = top - item.y - (k + 1) * item.gap;
                ops.push(P.setLineWidth(k % 2 ? 0.5 : 0.8),
                         P.setStrokingRgbColor(k % 2 ? 0.62 : 0.50, k % 2 ? 0.78 : 0.70, k % 2 ? 0.90 : 0.87),
                         P.moveTo(x1, yy), P.lineTo(x2, yy), P.stroke());
              }
            } else {
              const yy = top - item.y - item.h / 2;
              ops.push(P.setLineWidth(0.8), P.setStrokingRgbColor(0.45, 0.5, 0.56),
                       P.moveTo(x1, yy), P.lineTo(x2, yy), P.stroke());
            }
            ops.push(P.popGraphicsState());
            page.pushOperators(...ops);
            continue;
          }
          if (item.kind === 'row') {
            drawTableRow(P, page, font, KEY, o, item.row, top - item.y, tracing);
            continue;
          }
          const ln = item.line;
          const baseY = top - ln.y;

          if (ln.shade) {
            const c = NTEditor.rgbToArr(ln.shade);
            page.pushOperators(
              P.pushGraphicsState(), P.setFillingRgbColor(c[0], c[1], c[2]),
              P.moveTo(o.marginL, baseY - ln.descent), P.lineTo(o.pageW - o.marginR, baseY - ln.descent),
              P.lineTo(o.pageW - o.marginR, baseY + ln.ascent), P.lineTo(o.marginL, baseY + ln.ascent),
              P.closePath(), P.fill(), P.popGraphicsState());
          }
          if (showRules) drawRules(P, page, o, baseY, ln);

          if (ln.listMark) {
            drawRun(P, page, font, KEY, ln.listMark, ln.markStyle,
                    o.marginL + ln.indent, baseY, tracing);
          }
          drawLineItems(P, page, font, KEY, ln, o.marginL, baseY, tracing);
        }
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
      const sub = it.style.sub, sup = it.style.sup;
      const dy = sub ? -it.style.size * 0.18 : sup ? it.style.size * 0.34 : 0;
      drawRun(P, page, font, KEY, it.text, it.style, x, baseY + dy, tracing);
      if (it.style.strike) {
        const c2 = NTEditor.rgbToArr(it.style.color);
        const sy = baseY + dy + it.style.size * 0.22;
        page.pushOperators(
          P.pushGraphicsState(), P.setStrokingRgbColor(c2[0], c2[1], c2[2]),
          P.setLineWidth(Math.max(0.5, it.style.size * 0.045)),
          P.moveTo(x, sy), P.lineTo(x + it.w, sy), P.stroke(), P.popGraphicsState());
      }
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
    let size = style.size || NTEditor.DEFAULT_SIZE;
    if (style.sub || style.sup) size *= NTLayout.SUBSUP;
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

  /* Header and footer sit inside the page margins and repeat on every page,
     the same way Word does it, so the body text never has to make room. */
  function alignedX(text, size, align, o) {
    const w = NTLayout.runWidth(FONT, text, { size: size });
    if (align === 'center') return (o.pageW - w) / 2;
    if (align === 'right') return o.pageW - o.marginR - w;
    return o.marginL;
  }

  function drawRunningHeader(P, page, font, KEY, o) {
    const text = (el.headerText.value || '').trim();
    if (!text) return;
    const size = Math.max(6, Math.min(36, +el.headerSize.value || 11));
    const baseY = o.pageH - Math.max(14, o.marginTop * 0.5);
    const folded = NTEngine.fold(FONT, text).text;
    drawRun(P, page, font, KEY, folded,
            { size: size, color: 'rgb(90,100,112)' },
            alignedX(folded, size, el.headerAlign.value, o), baseY, false);
    if (el.headerRule.checked) {
      const y = baseY - size * 0.42;
      page.pushOperators(
        P.pushGraphicsState(), P.setLineWidth(0.6), P.setStrokingRgbColor(0.72, 0.77, 0.82),
        P.moveTo(o.marginL, y), P.lineTo(o.pageW - o.marginR, y), P.stroke(), P.popGraphicsState());
    }
  }

  function drawRunningFooter(P, page, font, KEY, o, n, total) {
    let text = (el.footerText.value || '').trim();
    if (pageNumbers) text = text ? text + '   ' + n + ' / ' + total : n + ' / ' + total;
    if (!text) return;
    const size = Math.max(6, Math.min(36, +el.footerSize.value || 10));
    const baseY = Math.max(12, o.marginBottom * 0.45);
    const folded = NTEngine.fold(FONT, text).text;
    drawRun(P, page, font, KEY, folded,
            { size: size, color: 'rgb(110,120,132)' },
            alignedX(folded, size, el.footerAlign.value, o), baseY, false);
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
