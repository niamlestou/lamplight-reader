/* Loaded when the Bible is opened. Public-domain texts are static files in bible/<lang>/. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = { backdrop: $('bibleBackdrop'), close: $('bibleCloseBtn'), language: $('bibleLanguage'), book: $('bibleBook'), chapter: $('bibleChapter'), read: $('bibleReadBtn'), status: $('bibleStatus'), credit: $('bibleCredit') };
  const LANGUAGES = ['en', 'es', 'fr', 'de', 'pt'], LANGUAGE_KEY = 'lamplightLang';
  const files = new Map();

  function preferredLanguage() {
    try { const saved = localStorage.getItem(LANGUAGE_KEY); if (LANGUAGES.includes(saved)) return saved; } catch (_) { /* storage blocked */ }
    for (const lang of navigator.languages || [navigator.language || 'en']) {
      const code = String(lang).slice(0, 2).toLowerCase();
      if (LANGUAGES.includes(code)) return code;
    }
    return 'en';
  }
  function load(path) {
    if (!files.has(path)) {
      files.set(path, fetch(path).then(response => response.ok ? response.json() : Promise.reject(new Error(`Could not load ${path}`)))
        .catch(error => { files.delete(path); throw error; }));
    }
    return files.get(path);
  }
  const index = () => load(`bible/${el.language.value}/index.json`);
  const selectedBook = async () => (await index()).books.find(book => book.id === el.book.value);

  async function showChapters() {
    const book = await selectedBook();
    el.chapter.replaceChildren(...Array.from({ length: book.chapters }, (_, i) => new Option(String(i + 1))));
  }
  async function showBooks() {
    el.read.disabled = true; el.status.textContent = 'Loading…';
    try {
      const { title, license, books } = await index();
      el.book.replaceChildren(...books.map(book => new Option(book.name, book.id)));
      el.credit.textContent = `${title} · ${license}`;
      await showChapters();
      el.status.textContent = ''; el.read.disabled = false;
    } catch (error) { console.error(error); el.status.textContent = 'The Bible could not be loaded. Check your connection and try again.'; }
  }
  async function read() {
    el.read.disabled = true; el.status.textContent = 'Loading…';
    try {
      const lang = el.language.value, { title, chapterLabel } = await index(), book = await selectedBook();
      const { chapters } = await load(`bible/${lang}/${book.id}.json`);
      window.Lamplight.loadTextModel({ pages: chapters.map((verses, i) => ({ page: i + 1, text: verses.join(' ') })) }, `${book.name} · ${title}`, { pageLabel: chapterLabel, lang, content: 'bible' });
      window.Lamplight.goToPage(Number(el.chapter.value));
      el.status.textContent = ''; close();
    } catch (error) { console.error(error); el.status.textContent = 'That book could not be loaded. Please try again.'; }
    finally { el.read.disabled = false; }
  }
  function open() {
    el.backdrop.hidden = false;
    if (!el.book.options.length) { el.language.value = preferredLanguage(); showBooks(); }
  }
  function close() { el.backdrop.hidden = true; }

  el.language.addEventListener('change', () => {
    try { localStorage.setItem(LANGUAGE_KEY, el.language.value); } catch (_) { /* storage blocked */ }
    showBooks();
  });
  el.book.addEventListener('change', showChapters);
  el.read.addEventListener('click', read);
  el.close.addEventListener('click', close);
  el.backdrop.addEventListener('click', event => { if (event.target === el.backdrop) close(); });
  window.LamplightBible = { open, close };
})();
