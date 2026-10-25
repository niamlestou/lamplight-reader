/* Fill & sign: stamps text, a checkmark and a signature onto the open PDF with pdf-lib.
 * Runs entirely in the browser; the signed copy is saved as a download. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = { backdrop: $('proBackdrop'), close: $('proCloseBtn'), open: $('fillSignBtn'), formText: $('formText'), placeText: $('placeTextBtn'), placeCheck: $('placeCheckBtn'), typed: $('typedSignature'), canvas: $('signatureCanvas'), clear: $('clearSignatureBtn'), consent: $('signatureConsent'), complete: $('completeSignatureBtn'), status: $('signatureStatus') };
  const state = { marks: [], drawing: false, drew: false, context: el.canvas.getContext('2d') };
  const setStatus = message => { el.status.textContent = message; };
  const file = () => window.Lamplight?.getCurrentFile?.();

  function point(event) { const rect = el.canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * (el.canvas.width / rect.width), y: (event.clientY - rect.top) * (el.canvas.height / rect.height) }; }
  function drawStart(event) { state.drawing = true; state.drew = true; const p = point(event); state.context.beginPath(); state.context.moveTo(p.x, p.y); el.canvas.setPointerCapture?.(event.pointerId); }
  function drawMove(event) { if (!state.drawing) return; const p = point(event); state.context.lineTo(p.x, p.y); state.context.stroke(); }
  function clearCanvas() { state.context.clearRect(0, 0, el.canvas.width, el.canvas.height); state.drew = false; }
  async function pdfLib() {
    if (window.PDFLib) return window.PDFLib;
    await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'vendor/pdf-lib.min.js'; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
    return window.PDFLib;
  }
  function download(bytes, name) { const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

  async function completeSignature() {
    if (!el.consent.checked) { setStatus('Please confirm the electronic-signature checkbox first.'); return; }
    if (!el.typed.value.trim() && !state.drew) { setStatus('Type or draw your signature first.'); return; }
    try {
      setStatus('Creating your signed PDF…');
      const source = await file().arrayBuffer(), { PDFDocument, StandardFonts, rgb } = await pdfLib();
      const pdf = await PDFDocument.load(source); const pages = pdf.getPages(), page = pages[pages.length - 1], font = await pdf.embedFont(StandardFonts.Helvetica);
      const { width } = page.getSize(); let y = 72;
      for (const mark of state.marks) { page.drawText(mark.text, { x: 54, y, size: mark.check ? 18 : 11, font, color: rgb(0, 0, 0) }); y += 18; }
      if (state.drew) { const png = await pdf.embedPng(el.canvas.toDataURL('image/png')); const scale = Math.min(180 / png.width, 54 / png.height); page.drawImage(png, { x: Math.max(54, width - 234), y: 38, width: png.width * scale, height: png.height * scale }); }
      else page.drawText(el.typed.value.trim(), { x: Math.max(54, width - 234), y: 54, size: 18, font: await pdf.embedFont(StandardFonts.TimesRomanItalic), color: rgb(0, 0, 0) });
      page.drawText(`Signed electronically · ${new Date().toISOString()}`, { x: 54, y: 24, size: 7, font, color: rgb(.25, .25, .25) });
      try { pdf.getForm().flatten(); } catch (_) { /* Ordinary PDFs have no form fields. */ }
      download(await pdf.save(), file().name.replace(/\.pdf$/i, '-signed.pdf')); setStatus('Signed PDF saved to your downloads.');
    } catch (error) { console.error(error); setStatus(error.message || 'Could not create the signed PDF.'); }
  }

  const close = () => { el.backdrop.hidden = true; };
  el.open.addEventListener('click', () => { if (file()) el.backdrop.hidden = false; });
  el.close.addEventListener('click', close);
  el.backdrop.addEventListener('click', event => { if (event.target === el.backdrop) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  el.placeText.addEventListener('click', () => { if (el.formText.value.trim()) { state.marks.push({ text: el.formText.value.trim() }); el.formText.value = ''; setStatus('Text will be placed when you create the signed PDF.'); } });
  el.placeCheck.addEventListener('click', () => { state.marks.push({ text: '✓', check: true }); setStatus('Checkmark will be placed when you create the signed PDF.'); });
  el.canvas.addEventListener('pointerdown', drawStart); el.canvas.addEventListener('pointermove', drawMove);
  for (const type of ['pointerup', 'pointercancel']) el.canvas.addEventListener(type, () => { state.drawing = false; });
  el.clear.addEventListener('click', clearCanvas); el.complete.addEventListener('click', completeSignature);
  window.addEventListener('lamplight:document-loaded', () => { el.open.disabled = false; state.marks = []; clearCanvas(); setStatus(''); });
})();
