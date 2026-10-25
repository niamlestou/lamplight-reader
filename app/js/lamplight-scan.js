/* Loaded only after the user opens Scan to PDF. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = {
    backdrop: $('scanBackdrop'), close: $('scanCloseBtn'), camera: $('cameraView'), corner: $('cornerAdjustView'), processing: $('scanProcessingView'),
    video: $('cameraVideo'), hint: $('cameraHint'), shutter: $('shutterBtn'), upload: $('scanUploadInsteadBtn'), done: $('scanDoneBtn'),
    photos: $('photoInput'), thumbs: $('cameraThumbs'), image: $('cornerImage'), stage: $('cornerStage'), polygon: $('cornerPolygon'),
    reset: $('cornerResetBtn'), retake: $('cornerRetakeBtn'), confirm: $('cornerConfirmBtn'), processingText: $('scanProcessingText'),
    banner: $('scanResultBanner'), resultText: $('scanResultText'), download: $('scanDownloadLink'), dismiss: $('scanResultDismiss')
  };
  let cameraStream = null, scanPages = [], selectedFilter = 'bw', cornerPoints = [], dragging = null;
  let sourceCanvas = null, doneWithCorner = null, uploadQueue = [], tesseractWorker = null, tesseractLoading = null;
  let warpWorker = null, warpRequest = 0, downloadUrl = null;
  const pendingWarps = new Map();

  function showView(name) {
    el.camera.hidden = name !== 'camera'; el.corner.hidden = name !== 'corner'; el.processing.hidden = name !== 'processing';
  }
  async function open() {
    el.backdrop.hidden = false; showView('camera'); el.done.disabled = scanPages.length === 0; renderThumbnails();
    if (cameraStream || !navigator.mediaDevices?.getUserMedia) return;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      el.video.srcObject = cameraStream;
    } catch (_) { el.hint.textContent = "Couldn't access the camera — use Upload photos instead."; }
  }
  function close() { el.backdrop.hidden = true; stopCamera(); }
  function stopCamera() {
    if (cameraStream) { cameraStream.getTracks().forEach(track => track.stop()); cameraStream = null; }
  }
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const image = new Image(), url = URL.createObjectURL(file);
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image could not be loaded')); };
      image.src = url;
    });
  }
  async function processNextUpload() {
    if (!uploadQueue.length) { showView('camera'); return; }
    try {
      const image = await loadImage(uploadQueue.shift());
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      openCornerAdjust(canvas, false, processNextUpload);
    } catch (_) { processNextUpload(); }
  }
  function openCornerAdjust(canvas, fromCamera, onDone) {
    sourceCanvas = canvas; doneWithCorner = onDone; el.retake.textContent = fromCamera ? 'Retake' : 'Skip';
    el.image.onload = initialiseCorners;
    el.image.src = canvas.toDataURL('image/jpeg', .9);
    showView('corner');
  }
  function initialiseCorners() {
    const { width, height } = el.image.getBoundingClientRect(), insetX = width * .08, insetY = height * .08;
    cornerPoints = [{ x: insetX, y: insetY }, { x: width - insetX, y: insetY }, { x: width - insetX, y: height - insetY }, { x: insetX, y: height - insetY }];
    renderCorners();
  }
  function renderCorners() {
    cornerPoints.forEach((point, index) => {
      const handle = $(`handle-${index}`); handle.style.left = `${point.x}px`; handle.style.top = `${point.y}px`;
    });
    el.polygon.setAttribute('points', cornerPoints.map(point => `${point.x},${point.y}`).join(' '));
  }
  function thumbnail(canvas) {
    const max = 180, scale = Math.min(1, max / Math.max(canvas.width, canvas.height));
    const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(canvas.width * scale)); out.height = Math.max(1, Math.round(canvas.height * scale));
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
    return applyFilter(out, selectedFilter).toDataURL('image/jpeg', .62);
  }
  function renderThumbnails() {
    el.thumbs.replaceChildren();
    scanPages.forEach((page, index) => {
      const wrapper = document.createElement('div'); wrapper.className = 'camera-thumb';
      const image = document.createElement('img'); image.src = thumbnail(page.canvas);
      const remove = document.createElement('button'); remove.className = 'thumb-remove'; remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove page ${index + 1}`);
      remove.addEventListener('click', () => { scanPages.splice(index, 1); renderThumbnails(); el.done.disabled = scanPages.length === 0; });
      wrapper.append(image, remove); el.thumbs.appendChild(wrapper);
    });
  }

  // ---------- Perspective correction ----------
  function outputSize(corners) {
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const [tl, tr, br, bl] = corners;
    return { width: Math.max(200, Math.min(Math.round(Math.max(distance(tl, tr), distance(bl, br))), 2200)),
      height: Math.max(200, Math.min(Math.round(Math.max(distance(tl, bl), distance(tr, br))), 2800)) };
  }
  function getWarpWorker() {
    if (warpWorker || !window.Worker) return warpWorker;
    try {
      warpWorker = new Worker('js/lamplight-warp-worker.js');
      warpWorker.onmessage = event => {
        const pending = pendingWarps.get(event.data.id); if (!pending) return;
        pendingWarps.delete(event.data.id); pending.resolve(event.data);
      };
      warpWorker.onerror = error => {
        for (const { reject } of pendingWarps.values()) reject(error);
        pendingWarps.clear(); warpWorker?.terminate(); warpWorker = null;
      };
    } catch (_) { warpWorker = null; }
    return warpWorker;
  }
  function workerWarp(sourceData, width, height, corners, output) {
    const worker = getWarpWorker();
    if (!worker) return Promise.reject(new Error('Worker unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++warpRequest; pendingWarps.set(id, { resolve, reject });
      worker.postMessage({ id, source: sourceData.buffer, sourceWidth: width, sourceHeight: height, corners, output }, [sourceData.buffer]);
    });
  }
  async function warpPerspective(canvas, corners) {
    const source = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    const result = await workerWarp(source.data, canvas.width, canvas.height, corners, outputSize(corners));
    const out = document.createElement('canvas'); out.width = result.width; out.height = result.height;
    out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height), 0, 0);
    return out;
  }
  function applyFilter(canvas, filter) {
    if (filter === 'original') return canvas;
    const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
    const context = out.getContext('2d', { willReadFrequently: true }); context.drawImage(canvas, 0, 0);
    const image = context.getImageData(0, 0, out.width, out.height), data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = .299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2];
      const value = filter === 'bw' ? Math.max(0, Math.min(255, (gray - 128) * 1.6 + 148)) : gray;
      data[i] = data[i + 1] = data[i + 2] = value;
    }
    context.putImageData(image, 0, 0); return out;
  }

  // ---------- OCR and PDF creation ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
  }
  async function ensureTesseract() {
    if (tesseractWorker) return tesseractWorker;
    if (!tesseractLoading) tesseractLoading = (async () => {
      if (!window.Tesseract) { setProcessingText('Setting up text recognition (first time only, ~15 MB)…'); await loadScript('vendor/tesseract/tesseract.min.js'); }
      const base = new URL('vendor/tesseract/', document.baseURI).href;
      return tesseractWorker = await window.Tesseract.createWorker('eng', 1, { workerPath: `${base}worker.min.js`, corePath: base, langPath: base, workerBlobURL: false });
    })().catch(error => { tesseractLoading = null; throw error; });
    return tesseractLoading;
  }
  async function recognizeLines(canvas) {
    const result = await (await ensureTesseract()).recognize(canvas);
    return (result.data?.lines || []).filter(line => line?.text?.trim() && line.bbox).map(line => ({ text: line.text.trim(), bbox: line.bbox }));
  }
  function setProcessingText(text) { el.processingText.textContent = text; }
  function nextFrame() { return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }
  async function createPdf() {
    if (!scanPages.length) return;
    showView('processing'); stopCamera();
    try {
      if (!window.jspdf) {
        setProcessingText('Loading PDF tools…');
        await loadScript('vendor/jspdf.umd.min.js');
      }
    } catch (error) {
      console.error('Could not load the PDF tools.', error);
      el.hint.textContent = 'Could not load the PDF tools. Check your connection and try again.';
      showView('camera');
      return;
    }
    const { jsPDF } = window.jspdf, pointsPerPixel = 72 / 150; let documentPdf = null;
    for (let index = 0; index < scanPages.length; index++) {
      setProcessingText(`Enhancing page ${index + 1} of ${scanPages.length}…`); await nextFrame();
      const filtered = applyFilter(scanPages[index].canvas, selectedFilter), pageWidth = filtered.width * pointsPerPixel, pageHeight = filtered.height * pointsPerPixel;
      if (!documentPdf) documentPdf = new jsPDF({ unit: 'pt', format: [pageWidth, pageHeight] }); else documentPdf.addPage([pageWidth, pageHeight]);
      documentPdf.addImage(filtered.toDataURL('image/jpeg', .86), 'JPEG', 0, 0, pageWidth, pageHeight);
      setProcessingText(`Reading text on page ${index + 1} of ${scanPages.length}…`); await nextFrame();
      try {
        for (const line of await recognizeLines(filtered)) {
          documentPdf.setFontSize(Math.max(6, (line.bbox.y1 - line.bbox.y0) * pointsPerPixel) * .82);
          documentPdf.text(line.text, line.bbox.x0 * pointsPerPixel, line.bbox.y1 * pointsPerPixel, { renderingMode: 'invisible' });
        }
      } catch (error) { console.error('OCR failed for a page; it remains visible but is not selectable.', error); }
    }
    setProcessingText('Finishing up…'); await nextFrame();
    const blob = documentPdf.output('blob'), name = `scan-${new Date().toISOString().slice(0, 10)}.pdf`, pageCount = scanPages.length;
    scanPages = []; el.backdrop.hidden = true;
    if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = URL.createObjectURL(blob);
    el.download.href = downloadUrl; el.download.download = name; el.resultText.textContent = `Saved "${name}" — now loaded below.`; el.banner.hidden = false;
    window.Lamplight.loadPdf(new File([blob], name, { type: 'application/pdf' }), { method: 'scan' });
  }

  // ---------- Scan event wiring ----------
  el.close.addEventListener('click', close); el.backdrop.addEventListener('click', event => { if (event.target === el.backdrop) close(); });
  el.shutter.addEventListener('click', () => {
    if (!el.video.videoWidth) return;
    const canvas = document.createElement('canvas'); canvas.width = el.video.videoWidth; canvas.height = el.video.videoHeight;
    canvas.getContext('2d').drawImage(el.video, 0, 0); openCornerAdjust(canvas, true, () => showView('camera'));
  });
  el.upload.addEventListener('click', () => el.photos.click());
  el.photos.addEventListener('change', () => { uploadQueue = Array.from(el.photos.files || []); el.photos.value = ''; processNextUpload(); });
  el.reset.addEventListener('click', initialiseCorners); el.retake.addEventListener('click', () => doneWithCorner?.());
  el.confirm.addEventListener('click', async () => {
    const rect = el.image.getBoundingClientRect(), corners = cornerPoints.map(point => [point.x * el.image.naturalWidth / rect.width, point.y * el.image.naturalHeight / rect.height]);
    if (scanPages.length >= 500) { alert('A scan can have up to 500 pages. Create the PDF, then start a new scan.'); return; }
    el.confirm.disabled = true; const label = el.confirm.textContent; el.confirm.textContent = 'Correcting…';
    try { scanPages.push({ canvas: await warpPerspective(sourceCanvas, corners) }); el.done.disabled = false; renderThumbnails(); doneWithCorner?.(); }
    catch (error) { console.error(error); alert('This page could not be straightened. Please try again.'); }
    finally { el.confirm.disabled = false; el.confirm.textContent = label; }
  });
  for (let index = 0; index < 4; index++) $("handle-" + index).addEventListener('pointerdown', event => { dragging = index; event.currentTarget.setPointerCapture?.(event.pointerId); });
  el.stage.addEventListener('pointermove', event => {
    if (dragging === null) return; const rect = el.stage.getBoundingClientRect();
    cornerPoints[dragging] = { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) }; renderCorners();
  });
  ['pointerup', 'pointercancel'].forEach(type => el.stage.addEventListener(type, () => { dragging = null; }));
  document.querySelectorAll('.filter-btn').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(other => other.classList.remove('active')); button.classList.add('active'); selectedFilter = button.dataset.filter; renderThumbnails();
  }));
  el.done.addEventListener('click', createPdf); el.dismiss.addEventListener('click', () => { el.banner.hidden = true; });
  window.LamplightScan = { open, close };
})();
