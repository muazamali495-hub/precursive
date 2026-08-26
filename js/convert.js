/* convert.js — the standalone "Convert to NT Pre-Cursive" tool.
 *
 * A dedicated front door: drop a Word or PDF file in, see the text that was
 * recovered, and get it back as a handwriting PDF. It reuses the same import,
 * layout and PDF code as the editor, so what you preview is what you get.
 */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);
  let picked = null;          // { name, html, kind, words, chars, lost }

  function bytesLabel(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function show(view) {
    ['cvDrop', 'cvBusy', 'cvResult', 'cvError'].forEach(id => {
      const el = $(id); if (el) el.hidden = (id !== view);
    });
  }

  function open() {
    $('cvOverlay').hidden = false;
    if (!picked) show('cvDrop');
    document.addEventListener('keydown', onKey);
  }
  function close() {
    $('cvOverlay').hidden = true;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  async function handleFile(file, api) {
    if (!file) return;
    show('cvBusy');
    $('cvBusyName').textContent = file.name + ' · ' + bytesLabel(file.size);
    try {
      // let the browser paint the busy state before the heavy parse
      await new Promise(r => setTimeout(r, 30));
      const res = await NTImport.fileToHtml(file);

      // measure what the handwriting font can actually draw
      const probe = document.createElement('div');
      probe.innerHTML = res.html;
      const doc = NTEditor.parseDocument(probe, NTEditor.DEFAULT_SIZE);
      const folded = NTEditor.foldDocument(api.font(), doc, NTEngine.fold);
      const text = NTEditor.docText(folded.doc);
      const words = (text.match(/\S+/g) || []).length;
      const lost = [...folded.lost.values()].reduce((a, b) => a + b, 0);
      const changed = [...folded.changes.values()].reduce((a, c) => a + c.count, 0);

      if (!words) throw new Error('No readable text was found in that file.');

      picked = { name: file.name, html: res.html, kind: res.kind,
                 words: words, chars: text.replace(/\n/g, '').length,
                 lost: lost, changed: changed };

      $('cvResName').textContent = file.name;
      $('cvResKind').textContent = res.kind;
      $('cvResStats').textContent = words.toLocaleString() + ' words · ' +
        picked.chars.toLocaleString() + ' characters';
      const notes = [];
      if (changed) notes.push(changed + ' character' + (changed > 1 ? 's' : '') +
        ' adjusted for this font (e.g. café → cafe)');
      if (lost) notes.push(lost + ' character' + (lost > 1 ? 's' : '') +
        ' this font cannot draw were replaced with ?');
      $('cvResNote').innerHTML = notes.length ? notes.map(n => '<span>' + n + '</span>').join('') : '';
      $('cvResNote').hidden = !notes.length;

      // preview in the handwriting face
      $('cvPreview').innerHTML = res.html;
      show('cvResult');
    } catch (e) {
      $('cvErrorMsg').textContent = e.message || String(e);
      show('cvError');
    }
  }

  function wire(api) {
    $('convertFileBtn').addEventListener('click', open);
    $('cvClose').addEventListener('click', close);
    $('cvOverlay').addEventListener('click', e => { if (e.target === $('cvOverlay')) close(); });
    $('cvPick').addEventListener('click', () => $('cvInput').click());
    $('cvTryAgain').addEventListener('click', () => { picked = null; show('cvDrop'); });
    $('cvAnother').addEventListener('click', () => { picked = null; show('cvDrop'); });

    $('cvInput').addEventListener('change', () => {
      const f = $('cvInput').files && $('cvInput').files[0];
      $('cvInput').value = '';
      handleFile(f, api);
    });

    const zone = $('cvDrop');
    ['dragenter', 'dragover'].forEach(ev =>
      zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev =>
      zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', e => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleFile(f, api);
    });

    // download the converted document straight as a handwriting PDF
    $('cvDownload').addEventListener('click', async () => {
      if (!picked) return;
      $('cvDownload').disabled = true;
      const label = $('cvDownload').textContent;
      $('cvDownload').textContent = 'Building PDF…';
      try {
        await api.exportHtmlAsPdf(picked.html, picked.name.replace(/\.[^.]+$/, ''));
      } catch (e) {
        $('cvErrorMsg').textContent = 'Could not build the PDF: ' + e.message;
        show('cvError');
      } finally {
        $('cvDownload').disabled = false;
        $('cvDownload').textContent = label;
      }
    });

    // hand the converted text to the editor for further work
    $('cvEdit').addEventListener('click', async () => {
      if (!picked) return;
      await api.loadIntoEditor(picked.html, picked.kind);
      close();
    });
  }

  global.NTConvert = { wire, open, close };
})(window);
