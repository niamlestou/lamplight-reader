/* Lamp Light's always-on reader code. Scanner and sign-in code load on demand. */
(() => {
  'use strict';

  // Third-party code is bundled in vendor/ (no CDN), so it works offline and inside the app.
  const vendorUrl = file => new URL(`vendor/${file}`, document.baseURI).href;
  // pdf.js loads when the first PDF is opened, not with the page.
  let pdfjsModule = null;
  function pdfjs() {
    pdfjsModule ||= import(vendorUrl('pdfjs/pdf.min.mjs')).then(lib => {
      lib.GlobalWorkerOptions.workerSrc = vendorUrl('pdfjs/pdf.worker.min.mjs');
      return lib;
    }).catch(error => { pdfjsModule = null; throw error; });
    return pdfjsModule;
  }

  const $ = id => document.getElementById(id);
  const elements = {
    mainArea: $('mainArea'), dropzone: $('dropzone'), status: $('status-message'),
    pages: $('pagesContainer'), controls: $('controlBar'), fileInput: $('fileInput'),
    fileLabel: $('fileLabel'), progress: $('progressText'), play: $('playBtn'),
    pause: $('pauseBtn'), stop: $('stopBtn'), rate: $('rateSlider'), rateValue: $('rateValue'),
    voice: $('voiceSelect'), tocButton: $('tocBtn'), tocBackdrop: $('tocBackdrop'),
    tocList: $('tocList'), scan: $('scanBtn'),
    dropzoneScan: $('dropzoneScanBtn'), kokoroAudio: $('kokoroAudio')
  };
  const speechSupported = 'speechSynthesis' in window;
  const state = {
    words: [], wordSpans: [], pageModels: [], pageModelByNumber: new Map(), currentIndex: 0,
    activeSpan: null, isPlaying: false, isPaused: false, rate: 1,
    selectedVoice: null, browserVoices: [], activeEngine: 'browser', toc: [],
    pageObserver: null, viewport: { top: 0, bottom: 0, height: 0 },
    browserSession: 0, loadToken: 0, utterance: null, kokoroTTS: null, kokoroLoading: null,
    kokoroVoiceId: null, kokoroChunkStart: 0, kokoroChunkWords: 0,
    kokoroQueue: new Map(), kokoroChain: Promise.resolve(), kokoroStopped: false, featureLoads: new Map(), currentFile: null, pageCount: 0, pageLabel: 'Page', lang: '', content: ''
  };

  function updateViewport() {
    const { mainArea } = elements;
    state.viewport.top = mainArea.scrollTop;
    state.viewport.height = mainArea.clientHeight;
    state.viewport.bottom = state.viewport.top + state.viewport.height;
  }
  elements.mainArea.addEventListener('scroll', updateViewport, { passive: true });
  new ResizeObserver(updateViewport).observe(elements.mainArea);
  updateViewport();

  // ---------- Loading screen ----------
  const loader = { root: $('loader'), file: $('loaderFile'), fill: $('loaderFill'), meta: $('loaderMeta'), cancel: $('loaderCancel') };
  let loaderFrame = 0;
  function showLoader(name) {
    elements.status.hidden = true; loader.root.hidden = false;
    loader.file.textContent = name; loader.root.classList.add('indeterminate');
    loader.fill.style.transform = 'scaleX(0)'; loader.meta.textContent = 'Opening document…';
  }
  function setLoader(done, total) { // coalesced to one DOM write per frame
    cancelAnimationFrame(loaderFrame);
    loaderFrame = requestAnimationFrame(() => {
      loader.root.classList.remove('indeterminate');
      loader.fill.style.transform = `scaleX(${done / total})`;
      loader.meta.textContent = `Page ${done} of ${total} · ${Math.round(done / total * 100)}%`;
    });
  }
  function hideLoader() { cancelAnimationFrame(loaderFrame); loader.root.hidden = true; }
  loader.cancel.addEventListener('click', () => { state.loadToken++; hideLoader(); elements.dropzone.hidden = false; });

  function showStatus(message, loading) {
    hideLoader();
    elements.status.hidden = false;
    elements.status.textContent = message;
    elements.status.classList.toggle('pulse', Boolean(loading));
  }
  function showEngineStatus(message, pulsing) {
    const el = $('engineStatus');
    el.textContent = message;
    el.hidden = false;
    const prompt = $('kokoroPromptStatus'); prompt.textContent = message; prompt.hidden = $('kokoroBackdrop').hidden;
    el.classList.toggle('pulse', Boolean(pulsing));
  }
  function hideEngineStatus() {
    const el = $('engineStatus');
    el.hidden = true;
    el.classList.remove('pulse');
  }

  // ---------- Lazy page rendering ----------
  function estimatePageHeight(pageWords) {
    const characters = pageWords.reduce((total, word) => total + word.length + 1, 0);
    // Conservative estimate: a 660px reading column fits roughly 64 serif characters.
    return Math.max(160, Math.ceil(characters / 64) * 34);
  }

  function createVirtualPages(models) {
    if (state.pageObserver) state.pageObserver.disconnect();
    elements.pages.replaceChildren();
    state.wordSpans = new Array(state.words.length);
    state.pageModels = models;
    state.pageModelByNumber = new Map(models.map(model => [model.pageNumber, model]));

    for (const model of models) {
      const page = document.createElement('section');
      page.className = 'page';
      page.dataset.pageIndex = String(model.index);
      const label = document.createElement('div');
      label.className = 'page-label';
      label.textContent = `${state.pageLabel} ${model.pageNumber}`;
      const text = document.createElement('div');
      text.className = 'page-text';
      text.style.minHeight = `${model.estimatedHeight}px`;
      page.append(label, text);
      model.element = page;
      model.textElement = text;
      model.rendered = false;
      elements.pages.appendChild(page);
    }

    state.pageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const model = state.pageModels[Number(entry.target.dataset.pageIndex)];
        if (!model) continue;
        if (entry.isIntersecting) {
          model.visible = true;
          materializePage(model);
        } else {
          model.visible = false;
          releasePage(model);
        }
      }
    }, { root: elements.mainArea, threshold: 0 });

    for (const model of models) state.pageObserver.observe(model.element);
    if (models[0]) materializePage(models[0]); // avoids a blank first frame before observer delivery
  }

  function pageForWord(index) {
    const pageNumber = state.words[index] && state.words[index].page;
    return state.pageModelByNumber.get(pageNumber) || null;
  }
  function materializePage(model) {
    if (!model || model.rendered) return;
    model.textElement.style.minHeight = '';
    const fragment = document.createDocumentFragment();
    for (let offset = 0; offset < model.words.length; offset++) {
      const span = document.createElement('span');
      const index = model.startIndex + offset;
      span.className = 'word';
      span.textContent = `${model.words[offset]} `;
      span.dataset.idx = String(index);
      state.wordSpans[index] = span;
      if (index === state.currentIndex && state.activeSpan === null) {
        span.classList.add('speaking');
        state.activeSpan = span;
      }
      fragment.appendChild(span);
    }
    model.textElement.appendChild(fragment);
    model.rendered = true;
  }
  function releasePage(model) {
    if (!model || !model.rendered) return;
    if (state.activeSpan && model.textElement.contains(state.activeSpan)) state.activeSpan = null;
    // Preserve its actual height so removing thousands of spans does not shift later pages.
    model.estimatedHeight = Math.max(1, Math.ceil(model.textElement.getBoundingClientRect().height));
    model.textElement.replaceChildren();
    model.textElement.style.minHeight = `${model.estimatedHeight}px`;
    state.wordSpans.fill(null, model.startIndex, model.startIndex + model.words.length);
    model.rendered = false;
  }
  function pageScrollTop(model) {
    return elements.pages.offsetTop + model.element.offsetTop + model.textElement.offsetTop;
  }
  function ensureWordIsRendered(index) {
    const model = pageForWord(index);
    if (!model) return null;
    if (!model.rendered) materializePage(model);
    return state.wordSpans[index] || null;
  }

  // ---------- PDF extraction ----------
  // Free reading stays in this browser: nothing is uploaded, and the document is
  // discarded when the page closes unless a signed-in Pro user saves it.
  const MAX_PAGES = 500, MAX_BYTES = 150 * 1024 * 1024;
  async function loadPdf(file, { method = 'picker' } = {}) {
    resetReader();
    const token = ++state.loadToken, cancelled = () => token !== state.loadToken;
    if (file.size > MAX_BYTES) { showStatus('That PDF is larger than 150 MB. Please choose a smaller file.', false); return; }
    const pdfBytes = await file.arrayBuffer();
    // Names and MIME types are easy to fake; a real PDF starts with "%PDF-".
    if (new TextDecoder().decode(pdfBytes.slice(0, 5)) !== '%PDF-') {
      showStatus("That doesn't look like a PDF. Please choose a .pdf file.", false);
     
      return;
    }
    elements.dropzone.hidden = true;
    showLoader(file.name);
    try {
      // Defense in depth: never compile font programs with eval (the CVE-2024-4367 attack path).
      const pdf = await (await pdfjs()).getDocument({ data: pdfBytes, isEvalSupported: false }).promise;
      if (pdf.numPages > MAX_PAGES) {
        pdf.destroy(); elements.dropzone.hidden = false;
        showStatus(`Lamp Light reads PDFs up to ${MAX_PAGES} pages. This one has ${pdf.numPages}.`, false); return;
      }
      if (cancelled()) { pdf.destroy(); return; }
      const allWords = [], allLines = [], firstWordByPage = {}, models = [];
      // Extract a few pages at a time so the pdf.js worker stays busy; results are consumed in page order.
      const BATCH = 4, extract = async number => { const page = await pdf.getPage(number); const items = (await page.getTextContent()).items; page.cleanup(); return extractLines(items); };
      let batch = null;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        if ((pageNumber - 1) % BATCH === 0) {
          const first = pageNumber, count = Math.min(BATCH, pdf.numPages - first + 1);
          batch = await Promise.all(Array.from({ length: count }, (_, i) => extract(first + i)));
          if (cancelled()) { pdf.destroy(); return; }
          setLoader(first + count - 1, pdf.numPages);
        }
        const lines = batch[(pageNumber - 1) % BATCH];
        const startIndex = allWords.length;
        const pageWords = [];
        for (const line of lines) {
          const lineWords = line.text.trim().split(/\s+/).filter(Boolean);
          if (!lineWords.length) continue;
          const lineStart = allWords.length;
          for (const text of lineWords) {
            allWords.push({ text, page: pageNumber });
            pageWords.push(text);
          }
          allLines.push({ text: line.text.trim(), fontSize: line.maxFont, page: pageNumber, startIdx: lineStart });
        }
        firstWordByPage[pageNumber] = startIndex;
        if (pageWords.length) {
          models.push({ index: models.length, pageNumber, startIndex, words: pageWords,
            estimatedHeight: estimatePageHeight(pageWords) });
        }
      }
      if (!allWords.length) {
        showStatus("This PDF doesn't seem to contain selectable text — it may be a scanned image. Try a different file.", false);
       
        return;
      }
      state.words = allWords;
      state.currentFile = file;
      state.pageCount = pdf.numPages; state.content = method === 'scan' ? 'scan' : 'pdf';
      state.currentIndex = 0;
      createVirtualPages(models);
      hideLoader(); elements.status.hidden = true;
      elements.pages.hidden = false;
      elements.controls.hidden = false;
      elements.fileLabel.textContent = `${file.name} · ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`;
      populateVoices();
      updateProgress(); updateButtons();
      let toc = [];
      try {
        const outline = await pdf.getOutline();
        if (outline && outline.length) toc = await resolveOutline(outline, pdf, firstWordByPage, 0);
      } catch (_) { /* Heading detection remains a useful fallback. */ }
      state.toc = toc.length ? toc : detectHeadings(allLines, pdf.numPages);
      elements.tocButton.hidden = state.toc.length === 0;
      renderToc();
      window.dispatchEvent(new CustomEvent('lamplight:document-loaded', { detail: { name: file.name, pageCount: pdf.numPages } }));
     
    } catch (error) {
      console.error(error);
      showStatus("Something went wrong opening that file. Make sure it's a valid PDF and try again.", false);
     
    }
  }
  function extractLines(items) {
    const lines = []; let current = null;
    for (const item of items) {
      const text = item.str || '';
      if (!text.trim()) {
        if (item.hasEOL && current) { lines.push(current); current = null; }
        continue;
      }
      const hasTransform = Array.isArray(item.transform) && item.transform.length >= 6;
      const y = hasTransform ? item.transform[5] : 0;
      const fontSize = hasTransform ? Math.hypot(item.transform[2], item.transform[3]) : 10;
      if (current && Math.abs(current.y - y) <= 2) {
        current.text += ` ${text}`;
        current.maxFont = Math.max(current.maxFont, fontSize);
      } else {
        if (current) lines.push(current);
        current = { y, text, maxFont: fontSize };
      }
      if (item.hasEOL) { lines.push(current); current = null; }
    }
    if (current) lines.push(current);
    return lines;
  }
  function resetReader() {
    cancelSpeech();
    state.kokoroStopped = true;
    elements.kokoroAudio.pause();
    if (elements.kokoroAudio.src.startsWith('blob:')) URL.revokeObjectURL(elements.kokoroAudio.src);
    elements.kokoroAudio.removeAttribute('src');
    if (state.pageObserver) state.pageObserver.disconnect();
    Object.assign(state, { words: [], wordSpans: [], pageModels: [], pageModelByNumber: new Map(), currentIndex: 0, activeSpan: null,
      isPlaying: false, isPaused: false, toc: [], kokoroChunkWords: 0, kokoroQueue: new Map(), currentFile: null, pageCount: 0, pageLabel: 'Page', lang: '', content: '' });
    elements.pages.replaceChildren();
    elements.pages.hidden = true; elements.controls.hidden = true; elements.status.hidden = true;
    elements.fileLabel.textContent = ''; elements.dropzone.hidden = false;
    elements.tocButton.hidden = true; closeToc();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }
  // Reads already-extracted text: translations and the Bible. With a custom
  // pageLabel (e.g. "Chapter") every page also becomes a Contents entry.
  function loadTextModel(model, label, { pageLabel = 'Page', lang = '', content = 'text' } = {}) {
    resetReader();
    const allWords = [], models = [], toc = [];
    for (const item of model.pages || []) {
      const pageWords = String(item.text || '').trim().split(/\s+/).filter(Boolean);
      if (!pageWords.length) continue;
      const startIndex = allWords.length;
      for (const text of pageWords) allWords.push({ text, page: item.page });
      models.push({ index: models.length, pageNumber: item.page, startIndex, words: pageWords, estimatedHeight: estimatePageHeight(pageWords) });
      toc.push({ title: `${pageLabel} ${item.page}`, page: item.page, index: startIndex, depth: 0 });
    }
    if (!allWords.length) { showStatus('This text did not contain anything readable.', false); return; }
    Object.assign(state, { words: allWords, currentIndex: 0, pageLabel, lang, content, toc: pageLabel === 'Page' ? [] : toc });
    createVirtualPages(models); elements.status.hidden = true; elements.pages.hidden = false; elements.controls.hidden = false; elements.dropzone.hidden = true;
    elements.fileLabel.textContent = label; elements.tocButton.hidden = !state.toc.length; renderToc();
    populateVoices(); updateProgress(); updateButtons();
  }
  function loadTranslatedModel(model, name) { loadTextModel(model, `${name} · translated`, { content: 'translation' }); }
  function goToPage(pageNumber) {
    const model = state.pageModelByNumber.get(pageNumber);
    if (model) highlightWord(model.startIndex);
  }

  // ---------- Contents ----------
  function detectHeadings(lines, pageCount) {
    if (!lines.length) return [];
    const sizes = new Map();
    for (const line of lines) {
      const key = Math.round(line.fontSize * 2) / 2;
      sizes.set(key, (sizes.get(key) || 0) + line.text.length);
    }
    let bodySize = 0, mostText = -1;
    for (const [size, count] of sizes) if (count > mostText) { bodySize = size; mostText = count; }
    const candidates = lines.filter(line => {
      const words = line.text.split(/\s+/).filter(Boolean);
      return line.fontSize >= bodySize * 1.15 && words.length > 0 && words.length <= 14 &&
        line.text.length >= 2 && !/^[\dIVXLCDM.\-\s]+$/i.test(line.text);
    });
    const copies = new Map();
    for (const item of candidates) copies.set(item.text, (copies.get(item.text) || 0) + 1);
    const unique = candidates.filter(item => copies.get(item.text) < Math.max(2, Math.ceil(pageCount * .25)));
    if (!unique.length) return [];
    const maxSize = Math.max(...unique.map(item => item.fontSize));
    return unique.slice(0, 150).map(item => ({ title: item.text, page: item.page, index: item.startIdx,
      depth: item.fontSize >= maxSize * .92 ? 0 : 1 }));
  }
  async function resolveOutline(items, pdf, firstWordByPage, depth) {
    const result = [];
    for (const item of items) {
      try {
        let destination = item.dest;
        if (typeof destination === 'string') destination = await pdf.getDestination(destination);
        if (Array.isArray(destination) && destination[0] != null) {
          const page = await pdf.getPageIndex(destination[0]) + 1;
          if (firstWordByPage[page] !== undefined) result.push({ title: (item.title || 'Untitled').trim(), page,
            index: firstWordByPage[page], depth });
        }
      } catch (_) { /* Skip outline entries with invalid destinations. */ }
      if (item.items && depth < 2) result.push(...await resolveOutline(item.items, pdf, firstWordByPage, depth + 1));
    }
    return result;
  }
  function renderToc() {
    elements.tocList.replaceChildren();
    for (const entry of state.toc) {
      const button = document.createElement('button'); button.className = 'toc-item';
      button.style.paddingLeft = `${10 + entry.depth * 18}px`;
      const page = document.createElement('span'); page.className = 'toc-page'; page.textContent = state.pageLabel === 'Page' ? `p.${entry.page}` : '';
      const title = document.createElement('span'); title.className = 'toc-title'; title.textContent = entry.title;
      button.append(page, title);
      button.addEventListener('click', () => { closeToc(); startFrom(entry.index); });
      elements.tocList.appendChild(button);
    }
  }
  function openToc() { if (!state.toc.length) return; elements.tocBackdrop.hidden = false; }
  function closeToc() { elements.tocBackdrop.hidden = true; }

  // ---------- Highlighting and selection ----------
  function clearHighlight() {
    if (state.activeSpan) state.activeSpan.classList.remove('speaking');
    state.activeSpan = null;
  }
  function highlightWord(index) {
    if (index < 0 || index >= state.words.length) return;
    state.currentIndex = index;
    updateProgress();
    const model = pageForWord(index);
    if (!model) return;
    let span = ensureWordIsRendered(index);
    if (!model.visible) {
      // A virtualized page may not have observer-delivered yet. Bring only this page into view.
      elements.mainArea.scrollTo({ top: Math.max(0, pageScrollTop(model) - state.viewport.height * .2), behavior: 'smooth' });
    }
    if (!span) return;
    if (span !== state.activeSpan) {
      clearHighlight();
      span.classList.add('speaking');
      state.activeSpan = span;
    }
    // No per-word getBoundingClientRect call: scroll only at the cached viewport edge.
    const wordTop = pageScrollTop(model) + span.offsetTop;
    const wordBottom = wordTop + span.offsetHeight;
    const edge = 84;
    if (wordTop < state.viewport.top + edge || wordBottom > state.viewport.bottom - edge) {
      elements.mainArea.scrollTo({ top: Math.max(0, wordTop - state.viewport.height * .45), behavior: 'smooth' });
    }
  }
  function wordIndexFromNode(node) {
    while (node && node !== elements.pages) {
      if (node.nodeType === 1 && node.classList.contains('word')) return Number(node.dataset.idx);
      node = node.parentNode;
    }
    return null;
  }
  function updateProgress() {
    if (!state.words.length) { elements.progress.textContent = ''; return; }
    const word = state.words[Math.min(state.currentIndex, state.words.length - 1)];
    elements.progress.textContent = `${state.pageLabel} ${word.page} — word ${state.currentIndex + 1} of ${state.words.length}`;
  }
  function updateButtons() {
    elements.play.disabled = state.isPlaying && !state.isPaused;
    elements.pause.disabled = !state.isPlaying || state.isPaused;
    elements.stop.disabled = !state.isPlaying && !state.isPaused && state.currentIndex === 0;
    updateMediaSession();
  }
  // Lock-screen and notification controls, like a music or audiobook app.
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = state.isPlaying && !state.isPaused ? 'playing' : state.isPaused ? 'paused' : 'none';
    if ((state.isPlaying || state.isPaused) && !navigator.mediaSession.metadata && typeof MediaMetadata === 'function') {
      navigator.mediaSession.metadata = new MediaMetadata({ title: elements.fileLabel.textContent || 'Lamp Light', artist: 'Lamp Light' });
    }
  }
  function skipPage(direction) {
    const page = state.words[state.currentIndex]?.page, at = state.pageModels.findIndex(model => model.pageNumber === page);
    const target = state.pageModels[at + direction];
    if (target) startFrom(target.startIndex);
  }
  function startFrom(index) {
    state.currentIndex = index;
    if (state.activeEngine === 'kokoro') {
      state.kokoroStopped = true; elements.kokoroAudio.pause(); playKokoroFrom(index);
    } else speakFrom(index);
  }

  // ---------- Browser speech (bounded utterances) ----------
  function buildWordChunk(startIndex) {
    const maxWords = 45, minWords = 8, chunk = [];
    let index = startIndex;
    while (index < state.words.length && chunk.length < maxWords) {
      const text = state.words[index++].text;
      chunk.push(text);
      if (chunk.length >= minWords && /[.!?;:]["')\]]?$/.test(text)) break;
    }
    return { startIndex, count: chunk.length, text: chunk.join(' ') };
  }
  function cancelSpeech() {
    if (!speechSupported) return;
    state.browserSession++;
    state.utterance = null;
    speechSynthesis.cancel();
  }
  function speakFrom(index) {
    if (!speechSupported || !state.words.length) return;
    cancelSpeech();
    const session = state.browserSession;
    state.isPlaying = true; state.isPaused = false;
    playBrowserChunk(index >= state.words.length ? 0 : index, session);
  }
  function playBrowserChunk(startIndex, session) {
    if (session !== state.browserSession) return;
    const chunk = buildWordChunk(startIndex);
    if (!chunk.count) { state.isPlaying = false; state.isPaused = false; updateButtons(); return; }
    const offsets = []; let position = 0;
    for (let offset = 0; offset < chunk.count; offset++) {
      offsets.push(position); position += state.words[startIndex + offset].text.length + 1;
    }
    const utterance = new SpeechSynthesisUtterance(chunk.text);
    utterance.rate = state.rate;
    if (state.selectedVoice) utterance.voice = state.selectedVoice;
    else if (state.lang) utterance.lang = state.lang; // lets the browser pick a voice for the Bible's language
    let wordOffset = 0;
    utterance.onboundary = event => {
      if (session !== state.browserSession || (event.name && event.name !== 'word')) return;
      while (wordOffset + 1 < offsets.length && offsets[wordOffset + 1] <= event.charIndex) wordOffset++;
      highlightWord(startIndex + wordOffset);
    };
    utterance.onend = () => {
      if (session !== state.browserSession) return;
      const next = startIndex + chunk.count;
      if (next < state.words.length) playBrowserChunk(next, session);
      else { state.isPlaying = false; state.isPaused = false; updateButtons(); }
    };
    utterance.onerror = () => {
      if (session === state.browserSession) { state.isPlaying = false; state.isPaused = false; updateButtons(); }
    };
    state.utterance = utterance;
    highlightWord(startIndex); updateButtons();
    speechSynthesis.speak(utterance);
  }

  // ---------- Kokoro voice (loaded on demand) ----------
  async function ensureKokoroLoaded() {
    if (state.kokoroTTS) return state.kokoroTTS;
    if (state.kokoroLoading) return state.kokoroLoading;
    elements.voice.disabled = true;
    showEngineStatus('Downloading the Kokoro voice model (about 90 MB, one time only)…', true);
    state.kokoroLoading = (async () => {
      const { KokoroTTS, env } = await import(vendorUrl('kokoro/kokoro.web.js'));
      env.wasmPaths = vendorUrl('kokoro/'); // bundled ONNX runtime instead of the jsDelivr default
      const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8', device: 'wasm', progress_callback: progress => {
          if (progress && progress.status === 'progress') showEngineStatus(`Downloading the Kokoro voice model… ${Math.round(progress.progress)}%`, true);
        }
      });
      state.kokoroTTS = tts; populateKokoroVoices(tts); hideEngineStatus(); elements.voice.disabled = false;
      return tts;
    })().catch(error => {
      console.error(error); state.kokoroLoading = null; elements.voice.disabled = false;
      state.activeEngine = 'browser'; elements.voice.value = 'browser:';
      showEngineStatus("Couldn't load the Kokoro voice model. Switched back to your browser's built-in voice.", false);
      setTimeout(hideEngineStatus, 8000); throw error;
    });
    return state.kokoroLoading;
  }
  function populateKokoroVoices(tts) {
    let voices = [];
    try {
      const list = tts.list_voices();
      voices = Array.isArray(list) ? list.map(value => typeof value === 'string' ? { id: value, label: value } : { id: value.id || value.name, label: value.name || value.id }) :
        Object.keys(list || {}).map(id => ({ id, label: (list[id] && (list[id].name || list[id].label)) || id }));
    } catch (_) { /* use known voice identifiers below */ }
    if (!voices.length) voices = ['af_heart', 'af_bella', 'af_sky', 'af_sarah', 'am_adam', 'am_michael'].map(id => ({ id, label: id }));
    const group = $('kokoroOptGroup'); group.replaceChildren();
    voices.forEach((voice, index) => {
      const option = document.createElement('option'); option.value = `kokoro:${voice.id}`; option.textContent = voice.label;
      option.selected = index === 0; group.appendChild(option);
    });
    state.kokoroVoiceId = voices[0].id;
  }
  async function synthesizeChunk(startIndex) {
    const chunk = buildWordChunk(startIndex);
    if (!chunk.count) return null;
    const output = await state.kokoroTTS.generate(chunk.text, { voice: state.kokoroVoiceId });
    return { count: chunk.count, blob: output.toBlob ? output.toBlob() : new Blob([output.toWav()], { type: 'audio/wav' }) };
  }
  // Keeps the next chunks synthesized ahead so audio continues without gaps, including while the
  // phone is locked and the page gets little CPU time. Kokoro runs one synthesis at a time.
  const AUDIO_BUFFER_CHUNKS = 3;
  function synthesizeAhead(index) {
    for (let queued = 0, next = index; queued < AUDIO_BUFFER_CHUNKS && next < state.words.length; queued++) {
      if (!state.kokoroQueue.has(next)) {
        const at = next, job = state.kokoroChain.then(() => synthesizeChunk(at));
        state.kokoroChain = job.catch(() => {}); state.kokoroQueue.set(at, job);
      }
      next += buildWordChunk(next).count;
    }
  }
  async function playKokoroFrom(index) {
    try { await ensureKokoroLoaded(); } catch (_) { return; }
    state.kokoroStopped = false; state.kokoroQueue.clear(); state.currentIndex = index;
    playKokoroChunk(index);
  }
  async function playKokoroChunk(index) {
    if (index >= state.words.length) { state.isPlaying = false; updateButtons(); return; }
    synthesizeAhead(index);
    const result = await state.kokoroQueue.get(index);
    state.kokoroQueue.delete(index);
    if (state.kokoroStopped || !result || !result.blob) return;
    state.kokoroChunkStart = index; state.kokoroChunkWords = result.count;
    if (elements.kokoroAudio.src.startsWith('blob:')) URL.revokeObjectURL(elements.kokoroAudio.src);
    elements.kokoroAudio.src = URL.createObjectURL(result.blob); elements.kokoroAudio.playbackRate = state.rate;
    state.isPlaying = true; state.isPaused = false; highlightWord(index); updateButtons();
    synthesizeAhead(index + result.count);
    try { await elements.kokoroAudio.play(); } catch (error) { console.error(error); }
  }

  // ---------- Controls ----------
  function populateVoices() {
    if (!speechSupported) return;
    const voices = speechSynthesis.getVoices(); if (!voices.length) return;
    state.browserVoices = voices;
    const group = $('browserOptGroup'), current = elements.voice.value;
    group.innerHTML = '<option value="browser:">Default voice</option>';
    voices.forEach((voice, index) => {
      const option = document.createElement('option'); option.value = `browser:${index}`;
      option.textContent = `${voice.name} (${voice.lang})`; group.appendChild(option);
    });
    if (current.startsWith('browser:')) elements.voice.value = current;
  }
  function play() {
    if (!state.words.length) return;
    if (state.activeEngine === 'kokoro') {
      if (state.isPaused) { elements.kokoroAudio.play(); state.isPaused = false; state.isPlaying = true; updateButtons(); }
      else if (!state.isPlaying) playKokoroFrom(state.currentIndex || 0);
    } else if (state.isPaused) {
      speechSynthesis.resume(); state.isPaused = false; state.isPlaying = true; updateButtons();
    } else if (!state.isPlaying) speakFrom(state.currentIndex || 0);
  }
  function pause() {
    if (!state.isPlaying || state.isPaused) return;
    if (state.activeEngine === 'kokoro') elements.kokoroAudio.pause(); else speechSynthesis.pause();
    state.isPaused = true; updateButtons();
  }
  function stop() {
    if (state.activeEngine === 'kokoro') { state.kokoroStopped = true; elements.kokoroAudio.pause(); elements.kokoroAudio.currentTime = 0; }
    else cancelSpeech();
    state.isPlaying = false; state.isPaused = false; state.currentIndex = 0; clearHighlight(); updateProgress(); updateButtons();
    elements.mainArea.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- Deferred features ----------
  function loadFeature(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (state.featureLoads.has(src)) return state.featureLoads.get(src);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = src; script.async = true;
      script.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error(`${src} did not initialize`));
      script.onerror = () => reject(new Error(`Could not load ${src}`)); document.head.appendChild(script);
    });
    state.featureLoads.set(src, promise); return promise;
  }
  async function openScanner() {
   
    try { (await loadFeature('js/lamplight-scan.js', 'LamplightScan')).open(); }
    catch (error) { console.error(error); showStatus('The scanner could not be loaded. Please refresh and try again.', false); }
  }
  async function openBible() {
   
    try { (await loadFeature('js/lamplight-bible.js', 'LamplightBible')).open(); }
    catch (error) { console.error(error); showStatus('The Bible could not be loaded. Please refresh and try again.', false); }
  }

  // ---------- Event wiring ----------
  $('headerUploadBtn').addEventListener('click', () => elements.fileInput.click());
  $('dropzoneChooseBtn').addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', () => { if (elements.fileInput.files[0]) loadPdf(elements.fileInput.files[0]); });
  for (const event of ['dragenter', 'dragover']) elements.dropzone.addEventListener(event, e => { e.preventDefault(); elements.dropzone.classList.add('drag-over'); });
  for (const event of ['dragleave', 'drop']) elements.dropzone.addEventListener(event, e => { e.preventDefault(); elements.dropzone.classList.remove('drag-over'); });
  elements.dropzone.addEventListener('drop', event => { const file = event.dataTransfer.files[0]; if (file) loadPdf(file, { method: 'drop' }); });
  elements.mainArea.addEventListener('dragover', event => event.preventDefault());
  elements.mainArea.addEventListener('drop', event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file && file.type === 'application/pdf') loadPdf(file, { method: 'drop' }); });
  elements.pages.addEventListener('mouseup', event => {
    if (!state.words.length) return;
    const selection = window.getSelection();
    let index = null;
    if (selection && !selection.isCollapsed && selection.rangeCount && elements.pages.contains(selection.anchorNode)) {
      index = wordIndexFromNode(selection.getRangeAt(0).startContainer); selection.removeAllRanges();
    } else { const word = event.target.closest && event.target.closest('.word'); if (word) index = Number(word.dataset.idx); }
    if (Number.isInteger(index)) startFrom(index);
  });
  elements.tocButton.addEventListener('click', openToc); $('tocCloseBtn').addEventListener('click', closeToc);
  elements.tocBackdrop.addEventListener('click', event => { if (event.target === elements.tocBackdrop) closeToc(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeToc(); window.LamplightScan?.close(); window.LamplightBible?.close(); } });
  elements.play.addEventListener('click', play); elements.pause.addEventListener('click', pause); elements.stop.addEventListener('click', stop);
  elements.rate.addEventListener('input', () => { elements.rateValue.textContent = `${Number(elements.rate.value).toFixed(1)}×`; });
  elements.rate.addEventListener('change', () => {
    state.rate = Number(elements.rate.value);
    if (state.activeEngine === 'kokoro') elements.kokoroAudio.playbackRate = state.rate;
    else if (state.isPlaying && !state.isPaused) speakFrom(state.currentIndex);
    else if (state.isPaused) { cancelSpeech(); state.isPaused = false; state.isPlaying = false; updateButtons(); }
  });
  elements.voice.addEventListener('change', async () => {
    const wasPlaying = state.isPlaying && !state.isPaused, resumeAt = state.currentIndex, value = elements.voice.value;
    if (value.startsWith('kokoro:')) {
      const id = value.slice(7);
      if (id === '__load__') { try { await ensureKokoroLoaded(); elements.voice.dispatchEvent(new Event('change')); } catch (_) {} return; }
      state.kokoroVoiceId = id; state.activeEngine = 'kokoro'; if (!state.kokoroTTS) try { await ensureKokoroLoaded(); } catch (_) { return; }
    } else { state.activeEngine = 'browser'; state.selectedVoice = value === 'browser:' ? null : state.browserVoices[Number(value.slice(8))]; }
    cancelSpeech(); state.kokoroStopped = true; elements.kokoroAudio.pause(); state.isPlaying = false; state.isPaused = false;
    if (wasPlaying) startFrom(resumeAt); else updateButtons();
  });
  elements.kokoroAudio.addEventListener('ended', () => { if (state.activeEngine === 'kokoro' && !state.kokoroStopped) playKokoroChunk(state.kokoroChunkStart + state.kokoroChunkWords); });
  elements.kokoroAudio.addEventListener('timeupdate', () => {
    const audio = elements.kokoroAudio;
    if (state.activeEngine === 'kokoro' && state.kokoroChunkWords && audio.duration) highlightWord(state.kokoroChunkStart + Math.floor(Math.min(audio.currentTime / audio.duration, .999) * state.kokoroChunkWords));
  });
  elements.scan.addEventListener('click', openScanner); if (elements.dropzoneScan) elements.dropzoneScan.addEventListener('click', openScanner);
  $('bibleBtn').addEventListener('click', openBible); $('dropzoneBibleBtn').addEventListener('click', openBible);
  if ('mediaSession' in navigator) {
    const actions = { play, pause, stop, previoustrack: () => skipPage(-1), nexttrack: () => skipPage(1) };
    for (const [action, handler] of Object.entries(actions)) { try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) { /* action unsupported here */ } }
  }
  // Mobile browsers drop speech-synthesis audio while the screen is off. When the page is
  // visible again, continue from the last highlighted word instead of sitting silent.
    document.addEventListener('visibilitychange', () => {
    if (!speechSupported || document.visibilityState !== 'visible' || state.activeEngine !== 'browser' || !state.isPlaying || state.isPaused) return;
    if (!speechSynthesis.speaking) speakFrom(state.currentIndex);
  });
  if (speechSupported) { speechSynthesis.onvoiceschanged = populateVoices; populateVoices(); }
  else { showStatus("This browser doesn't support text-to-speech. Try a recent version of Chrome, Edge, or Safari.", false); elements.dropzone.hidden = true; }

  // Desktop app only: first-run offer to download Kokoro. The answer is remembered, so it only asks once.
  (function kokoroPrompt() {
    const backdrop = $('kokoroBackdrop'), install = $('kokoroInstallBtn'), skip = $('kokoroSkipBtn');
    const get = () => { try { return localStorage.getItem('kokoroPrompt'); } catch (_) { return null; } };
    const set = value => { try { localStorage.setItem('kokoroPrompt', value); } catch (_) {} };
    if (get() || !speechSupported) return;
    backdrop.hidden = false;
    skip.addEventListener('click', () => { set('declined'); backdrop.hidden = true; });
    install.addEventListener('click', async () => {
      install.disabled = skip.disabled = true; install.textContent = 'Downloading…';
      try {
        await ensureKokoroLoaded();
        set('installed'); backdrop.hidden = true;
        elements.voice.value = `kokoro:${state.kokoroVoiceId}`; elements.voice.dispatchEvent(new Event('change'));
      } catch (_) { install.disabled = skip.disabled = false; install.textContent = 'Try again'; } // status text already shows the error
    });
  })();

  window.Lamplight = { loadPdf, loadTextModel, loadTranslatedModel, goToPage, getCurrentFile: () => state.currentFile, getPageCount: () => state.pageCount };
})();
