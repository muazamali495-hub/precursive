/* app.js — UI wiring, rich text toolbar, and styled PDF generation */
(function () {
  'use strict';

  const WS_HEIGHT = 52;   // vertical band reserved for the worksheet header
  const PAGE_SIZES = {
    a4:     { w: 595.28, h: 841.89, label: 'A4' },
    letter: { w: 612,    h: 792,    label: 'Letter' }
  };
  const SAVE_KEY = 'precursive-doc-v2';

  /* Autosave used to write straight to localStorage, which caps at roughly
     5 MB. A few embedded photos pass that easily and setItem throws
     QuotaExceededError, which was swallowed — the teacher's work vanished on
     reload with no warning. IndexedDB has a far larger quota and is tried
     first; localStorage remains the fallback for browsers without it. If both
     refuse, the user is told rather than left to discover it later. */
  const STORE = (function () {
    const DB_NAME = 'precursive', STORE_NAME = 'docs', KEY = 'doc-v2';
    let dbPromise = null;
    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((res, rej) => {
        let req;
        try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return rej(e); }
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      }).catch(() => null);
      return dbPromise;
    }
    return {
      async save(json) {
        const db = await open();
        if (db) {
          try {
            await new Promise((res, rej) => {
              const tx = db.transaction(STORE_NAME, 'readwrite');
              tx.objectStore(STORE_NAME).put(json, KEY);
              tx.oncomplete = res;
              tx.onerror = () => rej(tx.error);
              tx.onabort = () => rej(tx.error || new Error('aborted'));
            });
            try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
            return { ok: true, where: 'indexeddb', bytes: json.length };
          } catch (e) { /* fall through to localStorage */ }
        }
        try {
          localStorage.setItem(SAVE_KEY, json);
          return { ok: true, where: 'localstorage', bytes: json.length };
        } catch (e) {
          return { ok: false, error: e, bytes: json.length };
        }
      },
      async load() {
        const db = await open();
        if (db) {
          try {
            const v = await new Promise((res, rej) => {
              const tx = db.transaction(STORE_NAME, 'readonly');
              const rq = tx.objectStore(STORE_NAME).get(KEY);
              rq.onsuccess = () => res(rq.result);
              rq.onerror = () => rej(rq.error);
            });
            if (v) return v;
          } catch (e) {}
        }
        try { return localStorage.getItem(SAVE_KEY); } catch (e) { return null; }
      }
    };
  })();

  /* Images are what push a document past any quota, so a failed save is
     retried without them: the words survive even if the pictures cannot. */
  function stripImages(html) {
    const t = document.createElement('div');
    t.innerHTML = html;
    const imgs = t.querySelectorAll('img');
    imgs.forEach(im => { im.removeAttribute('src'); im.setAttribute('data-dropped', '1'); });
    return { html: t.innerHTML, dropped: imgs.length };
  }

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
   'footerMenu','footerText','footerAlign','footerSize','pageHeader','pageFooter','tbOverlay']
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
    wireTextBoxes();
    restore();   // async; refreshes when done

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
    [el.pageHeader, el.pageFooter].forEach(rg => {
      rg.addEventListener('input', () => { refresh(); scheduleSave(); });
      rg.addEventListener('focus', markRegion);
      rg.addEventListener('paste', e => {
        e.preventDefault();
        const t = (e.clipboardData || window.clipboardData).getData('text/plain');
        document.execCommand('insertText', false, t);
      });
    });
    el.headerText.addEventListener('input', () => {
      el.pageHeader.textContent = el.headerText.value; refresh(); scheduleSave();
    });
    el.footerText.addEventListener('input', () => {
      el.pageFooter.textContent = el.footerText.value; refresh(); scheduleSave();
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
    focusEditor();
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
        // load first so we know the natural size, then fit it sensibly
        const probe = new Image();
        probe.onload = () => insertImage(rd.result, probe.naturalWidth, probe.naturalHeight);
        probe.onerror = () => insertImage(rd.result, 320, 240);
        probe.src = rd.result;
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
    [el.headerAlign, el.headerSize, el.headerRule,
     el.footerAlign, el.footerSize].forEach(c =>
      c.addEventListener('input', () => { refresh(); scheduleSave(); }));
    el.pageNumBtn.addEventListener('click', () => {
      pageNumbers = !pageNumbers;
      el.pageNumBtn.classList.toggle('on', pageNumbers);
      setStatus(pageNumbers ? 'Page numbers on' : 'Page numbers off');
      refresh(); scheduleSave();
    });

    /* --- Insert: text --- */
    el.textBoxBtn.addEventListener('click', () => {
      insertHTML('<div class="textbox" style="width:340px;height:120px"><div>' +
        '[Grab your reader&rsquo;s attention with a great quote, or use this space ' +
        'to emphasise a key point.]</div></div><div><br></div>');
      const boxes = el.editor.querySelectorAll('.textbox');
      selectTextBox(boxes[boxes.length - 1]);
    });
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
  let painter = null, pageNumbers = false, savedRange = null;

  /* Any ribbon control that takes focus — the size box, a colour input, a
     menu button — moves the caret out of the editor. Calling editor.focus()
     afterwards drops the caret at position 0, which is why applying a size
     used to insert at the very top of the document instead of where you were
     working. So remember the last caret position inside the editor and put it
     back before acting on it. */
  let activeRegion = null;
  const regions = () => [el.editor, el.pageHeader, el.pageFooter].filter(Boolean);
  const regionOf = node => regions().find(rg => rg.contains(node)) || null;

  document.addEventListener('selectionchange', () => {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return;
    const r = s.getRangeAt(0);
    const rg = regionOf(r.commonAncestorContainer);
    if (rg) { savedRange = r.cloneRange(); activeRegion = rg; markRegion(); }
  });

  function markRegion() {
    document.querySelectorAll('.hfzone').forEach(z =>
      z.classList.toggle('show-tab', z.contains(activeRegion)));
  }

  /* Restore the caret into whichever region it was last in, so the ribbon
     formats the header or footer when you are working there, not the body. */
  function focusEditor() {
    const target = activeRegion && document.contains(activeRegion) ? activeRegion : el.editor;
    const s = window.getSelection();
    const inside = r => r && target.contains(r.commonAncestorContainer);
    if (s && s.rangeCount && inside(s.getRangeAt(0))) { target.focus(); return; }
    target.focus();
    const sel = window.getSelection();
    if (savedRange && target.contains(savedRange.commonAncestorContainer)) {
      sel.removeAllRanges(); sel.addRange(savedRange); return;
    }
    const r = document.createRange();
    r.selectNodeContents(target); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
  }

  function insertHTML(html) {
    focusEditor();
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
    const rg = regionOf(n);
    if (!rg) return null;
    while (n && n !== rg && !/^(DIV|P|LI|H1|H2|H3|TD|TH)$/.test(n.tagName)) n = n.parentNode;
    return n === rg ? null : n;
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
    focusEditor();
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
    focusEditor();
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
        focusEditor();
        document.execCommand('insertText', false, String.fromCodePoint(+b.dataset.cp));
        el.symbolMenu.hidden = true; refresh(); scheduleSave();
      }));
  }

  /* Insert an image as a resizable wrapper. If a text box is currently
     selected, the image goes inside that box and flows with its text;
     otherwise it is placed as its own block in the document. */
  function insertImage(src, natW, natH) {
    // target the selected box, or the box the caret is currently inside
    let box = (activeBox && el.editor.contains(activeBox)) ? activeBox : null;
    if (!box) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        let n = sel.getRangeAt(0).commonAncestorContainer;
        if (n.nodeType === 3) n = n.parentNode;
        const t = n && n.closest ? n.closest('.textbox') : null;
        if (t && el.editor.contains(t)) box = t;
      }
    }
    const room = box ? Math.max(60, (box.clientWidth || 300) - 24)
                     : (Math.max(120, el.editor.clientWidth - 8) || 480);
    let w = natW || 320, h = natH || 240;
    if (w > room) { h = Math.round(h * room / w); w = Math.round(room); }
    const html = '<span class="img-wrap" contenteditable="false" style="width:' + w + 'px;height:' + h +
                 'px"><img src="' + src + '" alt=""></span>';
    if (box) {
      // append straight into the box via the DOM — reliable, unlike
      // execCommand into a nested editable after the async file read
      const frag = document.createRange().createContextualFragment('<div>' + html + '</div>');
      box.appendChild(frag);
      selectTextBox(box);
    } else {
      insertHTML('<div>' + html + '</div><div><br></div>');
    }
    refresh(); scheduleSave();
  }

  /* ---------- resizable text boxes ----------
   * The handles live in an overlay outside the editable area, so they can
   * never be typed into, selected or deleted along with the text. Selecting a
   * box only positions that overlay; the box itself stays ordinary editable
   * content, which is what lets bold, size, colour and the rest work on the
   * text inside it exactly as they do anywhere else.
   */
  let activeBox = null;

  function currentTextBox() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let n = sel.getRangeAt(0).startContainer;
    if (n.nodeType === 3) n = n.parentNode;
    const box = n && n.closest ? n.closest('.textbox') : null;
    return (box && el.editor.contains(box)) ? box : null;
  }

  let boxObserver = null;
  function selectTextBox(box) {
    if (activeBox && activeBox !== box) activeBox.classList.remove('active');
    if (boxObserver) { boxObserver.disconnect(); boxObserver = null; }
    activeBox = box || null;
    if (!activeBox) { el.tbOverlay.hidden = true; return; }
    activeBox.classList.add('active');
    positionOverlay();
    // the browser's native resize grip changes the box size without a mouse
    // handler firing; a ResizeObserver keeps the overlay glued and saves it
    if (typeof ResizeObserver !== 'undefined') {
      boxObserver = new ResizeObserver(() => { positionOverlay(); scheduleSave(); });
      boxObserver.observe(activeBox);
    }
  }

  function positionOverlay() {
    if (!activeBox) { el.tbOverlay.hidden = true; return; }
    const stage = document.querySelector('.stage');
    const b = activeBox.getBoundingClientRect(), s = stage.getBoundingClientRect();
    el.tbOverlay.hidden = false;
    el.tbOverlay.style.left = (b.left - s.left + stage.scrollLeft) + 'px';
    el.tbOverlay.style.top = (b.top - s.top + stage.scrollTop) + 'px';
    el.tbOverlay.style.width = b.width + 'px';
    el.tbOverlay.style.height = b.height + 'px';
  }

  function wireTextBoxes() {
    el.editor.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      const box = currentTextBox();
      if (!box) return;                       // normal text: default behaviour
      e.preventDefault();                     // stop the box from being cloned
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();                 // replace any selected text
      const br = document.createElement('br');
      range.insertNode(br);                   // line break, kept inside the box
      range.setStartAfter(br); range.collapse(true);
      // a trailing <br> needs a placeholder for the caret to show on the new line
      if (!br.nextSibling) {
        const zw = document.createTextNode('​');
        br.parentNode.insertBefore(zw, br.nextSibling);
        range.setStartAfter(zw); range.collapse(true);
      }
      sel.removeAllRanges(); sel.addRange(range);
      if (activeBox === box) positionOverlay();
      refresh(); scheduleSave();
    });

    // clicking inside a box selects it; clicking anywhere else deselects
    el.editor.addEventListener('mousedown', e => {
      const box = e.target.closest && e.target.closest('.textbox');
      if (box) selectTextBox(box);
      else if (activeBox) selectTextBox(null);
    });
    document.addEventListener('mousedown', e => {
      if (el.editor.contains(e.target) || el.tbOverlay.contains(e.target)) return;
      if (activeBox) selectTextBox(null);
    });
    el.editor.addEventListener('input', () => { if (activeBox) positionOverlay(); });
    document.querySelector('.stage').addEventListener('scroll', positionOverlay);
    window.addEventListener('resize', positionOverlay);

    el.tbOverlay.querySelectorAll('.tb-h').forEach(h => {
      h.addEventListener('mousedown', ev => {
        if (!activeBox) return;
        ev.preventDefault(); ev.stopPropagation();
        const dir = h.dataset.dir;
        const start = { x: ev.clientX, y: ev.clientY,
                        w: activeBox.offsetWidth, h: activeBox.offsetHeight };
        // Clamp to the page width, but only trust a measurement that looks
        // like a real laid-out page. A hidden or not-yet-composited view can
        // report a few pixels, which would otherwise squash the box.
        const measured = el.editor.clientWidth;
        const maxW = measured > 200 ? measured : 4000;
        const move = m => {
          const dx = m.clientX - start.x, dy = m.clientY - start.y;
          let w = start.w, ht = start.h;
          if (dir.includes('e')) w = start.w + dx;
          if (dir.includes('w')) w = start.w - dx;
          if (dir.includes('s')) ht = start.h + dy;
          if (dir.includes('n')) ht = start.h - dy;
          activeBox.style.width = Math.max(60, Math.min(maxW, Math.round(w))) + 'px';
          activeBox.style.height = Math.max(40, Math.round(ht)) + 'px';
          positionOverlay();
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          refresh(); scheduleSave();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
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
    focusEditor();

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const region = regionOf(range.commonAncestorContainer);
    if (!region) return;

    /* Apply through execCommand('insertHTML') rather than by hand. Direct DOM
       surgery worked, but the browser does not record it, so Ctrl+Z could not
       undo a size change. insertHTML replaces exactly the selection and lands
       on the undo stack. Note this is NOT execCommand('fontSize'), which is
       the call that caused the earlier sizing bugs. */
    if (range.collapsed) {
      document.execCommand('insertHTML', false,
        '<span style="font-size:' + px + 'px" data-pc-caret="1">' + ZWSP + '</span>');
      // put the caret inside the new span so what is typed next takes the size
      const marker = region.querySelector('[data-pc-caret]');
      if (marker) {
        marker.removeAttribute('data-pc-caret');
        const r = document.createRange();
        r.setStart(marker.firstChild || marker, (marker.firstChild || marker).length || 0);
        r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
      }
    } else {
      const tmp = document.createElement('div');
      tmp.appendChild(range.cloneContents());
      // a nested size would beat the one being applied
      tmp.querySelectorAll('[style*="font-size"]').forEach(n => n.style.fontSize = '');
      tmp.querySelectorAll('font[size]').forEach(n => n.removeAttribute('size'));
      document.execCommand('insertHTML', false,
        '<span style="font-size:' + px + 'px">' + tmp.innerHTML + '</span>');
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
    focusEditor();
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
    syncPageHF();
    if (activeBox && el.editor.contains(activeBox)) positionOverlay(); else if (activeBox) selectTextBox(null);
    el.editor.classList.toggle('tracing', el.tracing.checked);
    el.editor.style.setProperty('--ls', el.spacing.value);
    el.convert.disabled = !text.trim();
  }

  /* Mirror the running header and footer onto the on-screen page so the
     teacher sees what will print, the way Word's print layout does. */
  const regionText = rg => (rg ? rg.textContent : '').replace(/​/g, '').trim();

  function syncPageHF() {
    el.pageHeader.style.textAlign = el.headerAlign.value;
    el.pageHeader.style.fontSize = (+el.headerSize.value || 11) + 'pt';
    el.pageHeader.style.borderBottomStyle = el.headerRule.checked ? 'dashed' : 'none';
    el.pageFooter.style.textAlign = el.footerAlign.value;
    el.pageFooter.style.fontSize = (+el.footerSize.value || 10) + 'pt';
    el.pageHeader.classList.toggle('blank', !regionText(el.pageHeader));
    el.pageFooter.classList.toggle('blank', !regionText(el.pageFooter));
    // keep the ribbon field showing the plain text, for quick edits
    if (document.activeElement !== el.headerText) el.headerText.value = regionText(el.pageHeader);
    if (document.activeElement !== el.footerText) el.footerText.value = regionText(el.pageFooter);
  }

  const esc = s => s.replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  let stickyError = false;
  function setStatus(m, err, sticky) {
    // a *build* error must survive the routine "Saved" toast; a storage-save
    // error is not sticky, so a later successful save clears it
    if (stickyError && !err && m === 'Saved') return;
    stickyError = !!err && !!sticky;
    el.status.textContent = m || '';
    el.status.classList.toggle('err', !!err);
  }

  /* ---------- autosave ---------- */
  let saveWarned = false;

  function snapshot(html) {
    return {
      html: html,
      headerHTML: el.pageHeader.innerHTML, footerHTML: el.pageFooter.innerHTML,
      page: el.pageSize.value, orient: el.orientation.value,
      rules: el.rules.checked, tracing: el.tracing.checked,
      worksheet: el.worksheet.checked, spacing: el.spacing.value,
      margin: el.margin.value, wsName: el.wsName.value,
      headerText: el.headerText.value, headerAlign: el.headerAlign.value,
      headerSize: el.headerSize.value, headerRule: el.headerRule.checked,
      footerText: el.footerText.value, footerAlign: el.footerAlign.value,
      footerSize: el.footerSize.value, pageNumbers: pageNumbers, at: Date.now()
    };
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 600);
  }

  async function doSave() {
    let res;
    try {
      res = await STORE.save(JSON.stringify(snapshot(el.editor.innerHTML)));
    } catch (e) {
      res = { ok: false, error: e };
    }

    if (res.ok) {
      saveWarned = false;
      if (!/^Could not build/.test(el.status.textContent)) setStatus('Saved');
      setTimeout(() => { if (el.status.textContent === 'Saved') setStatus(''); }, 1400);
      return;
    }

    // full save refused: keep the text by dropping the pictures
    const reduced = stripImages(el.editor.innerHTML);
    let res2 = { ok: false };
    if (reduced.dropped) {
      try { res2 = await STORE.save(JSON.stringify(snapshot(reduced.html))); } catch (e) {}
    }
    if (res2.ok) {
      setStatus('Document too large to save with pictures — text saved, ' +
                reduced.dropped + ' image' + (reduced.dropped > 1 ? 's' : '') +
                ' not kept. Export your PDF to be safe.', true);
      return;
    }
    if (!saveWarned) {
      saveWarned = true;
      setStatus('Could not save your work — browser storage is full. ' +
                'Export your PDF now; this document will not survive a reload.', true);
    }
  }

  async function restore() {
    let s = null;
    try { s = JSON.parse((await STORE.load()) || 'null'); } catch (e) {}
    if (!s || typeof s !== 'object') { el.editor.innerHTML = '<div><br></div>'; return; }
    el.editor.innerHTML = s.html || '<div><br></div>';
    if (s.headerHTML) el.pageHeader.innerHTML = s.headerHTML;
    if (s.footerHTML) el.pageFooter.innerHTML = s.footerHTML;
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
    if (el.editor.querySelector('img[data-dropped]'))
      setStatus('Some pictures could not be saved last time and are missing.', true);
    refresh();
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

      // embed every distinct image once — standalone and inside text boxes
      const imgCache = new Map();
      const srcs = new Set();
      for (const pg of pages) for (const it of pg) {
        if (it.kind === 'image') srcs.add(it.src);
        else if (it.kind === 'textbox')
          for (const c of it.content) if (c.type === 'image') srcs.add(c.src);
      }
      for (const src of srcs) {
        try {
          const b64 = String(src).split(',')[1];
          const bin = atob(b64); const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const isPng = String(src).slice(0, 20).toLowerCase().indexOf('image/png') > 0;
          imgCache.set(src, isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes));
        } catch (err) { console.warn('image skipped:', err.message); imgCache.set(src, null); }
      }

      pages.forEach((lines, pi) => {
        const page = pdf.addPage([o.pageW, o.pageH]);
        page.node.setFontDictionary(P.PDFName.of(KEY), font.ref);
        const top = o.pageH - flowOpts.marginTop;

        if (worksheet) drawWorksheetHeader(P, page, font, KEY, o);
        drawRunningHeader(P, page, font, KEY, o);
        drawRunningFooter(P, page, font, KEY, o, pi + 1, pages.length);

        for (const item of lines) {
          if (item.kind === 'textbox') {
            const bx = o.marginL + item.x, byTop = top - item.y, byBot = byTop - item.h;
            page.pushOperators(
              P.pushGraphicsState(), P.setLineWidth(0.8), P.setStrokingRgbColor(0.55, 0.60, 0.66),
              P.moveTo(bx, byBot), P.lineTo(bx + item.w, byBot),
              P.lineTo(bx + item.w, byTop), P.lineTo(bx, byTop),
              P.closePath(), P.stroke(), P.popGraphicsState());
            for (const c of item.content) {
              if (c.type === 'image') {
                const im = imgCache.get(c.src);
                if (im) page.drawImage(im, { x: bx + item.pad + c.x,
                        y: byTop - item.pad - c.dy - c.h, width: c.w, height: c.h });
                continue;
              }
              for (const ln of c.lines) {
                drawLineItems(P, page, font, KEY, ln, bx + item.pad, byTop - item.pad - ln.dy, tracing);
                if (ln.listMark)
                  drawRun(P, page, font, KEY, ln.listMark, ln.markStyle,
                          bx + item.pad + ln.indent, byTop - item.pad - ln.dy, tracing);
              }
            }
            continue;
          }
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
      setStatus('Could not build the PDF: ' + e.message, true, true);
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

  /* Draw an editable region (header or footer) as real styled runs, so bold,
     size and colour applied in that area all carry through to the PDF. */
  function drawRegion(P, page, font, KEY, o, regionEl, align, size, baseY, tracing, extra) {
    const raw = NTEditor.parseDocument(regionEl, size);
    const { doc } = NTEditor.foldDocument(FONT, raw, NTEngine.fold);
    const colW = o.pageW - o.marginL - o.marginR;
    let y = baseY, drew = false;
    for (const para of doc) {
      if (para.type) continue;
      if (extra && !drew) para.runs = para.runs.concat([{ text: extra, size: size }]);
      const hasText = para.runs.some(r => (r.text || '').trim());
      if (!hasText) continue;
      const lines = NTLayout.layoutParagraph(FONT, para, colW,
        { baseSize: size, lineSpacing: 1, indentPt: 0 });
      lines.forEach((ln, i) => {
        NTLayout.positionLine(ln, colW, align, i === lines.length - 1);
        drawLineItems(P, page, font, KEY, ln, o.marginL, y, tracing);
        y -= ln.height;
      });
      drew = true;
    }
    return { drew: drew, bottom: y };
  }

  function drawRunningHeader(P, page, font, KEY, o) {
    const size = Math.max(6, Math.min(36, +el.headerSize.value || 11));
    const baseY = o.pageH - Math.max(14, o.marginTop * 0.5);
    const res = drawRegion(P, page, font, KEY, o, el.pageHeader, el.headerAlign.value,
                           size, baseY, false, null);
    if (res.drew && el.headerRule.checked) {
      const y = res.bottom + size * 0.20;
      page.pushOperators(
        P.pushGraphicsState(), P.setLineWidth(0.6), P.setStrokingRgbColor(0.72, 0.77, 0.82),
        P.moveTo(o.marginL, y), P.lineTo(o.pageW - o.marginR, y), P.stroke(), P.popGraphicsState());
    }
  }

  function drawRunningFooter(P, page, font, KEY, o, n, total) {
    const size = Math.max(6, Math.min(36, +el.footerSize.value || 10));
    const baseY = Math.max(12, o.marginBottom * 0.45);
    const num = pageNumbers ? '   ' + n + ' / ' + total : null;
    drawRegion(P, page, font, KEY, o, el.pageFooter, el.footerAlign.value,
               size, baseY, false, num);
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
