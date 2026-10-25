/* Converts eBible.org USFM downloads into app/bible/<lang>/*.json.
 * Usage: node scripts/build-bible.js <folder holding the unzipped eng-web/, spaRV1909/, fraLSG/, deu1912/, porbrbsl/>
 * Sources (all public domain): https://ebible.org/Scriptures/<id>_usfm.zip */
'use strict';
const fs = require('fs');
const path = require('path');

const TRANSLATIONS = {
  en: { id: 'eng-web', title: 'World English Bible', license: 'Public domain · eBible.org', chapterLabel: 'Chapter' },
  es: { id: 'spaRV1909', title: 'Reina-Valera 1909', license: 'Dominio público · eBible.org', chapterLabel: 'Capítulo' },
  fr: { id: 'fraLSG', title: 'Louis Segond 1910', license: 'Domaine public · eBible.org', chapterLabel: 'Chapitre' },
  de: { id: 'deu1912', title: 'Lutherbibel 1912', license: 'Gemeinfrei · eBible.org', chapterLabel: 'Kapitel' },
  pt: { id: 'porbrbsl', title: 'Bíblia Portuguesa Mundial', license: 'Domínio público · eBible.org', chapterLabel: 'Capítulo' },
};
// The 66-book canon every translation shares; deuterocanonical extras in some downloads are skipped.
const BOOKS = ('GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO ' +
  'OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV').split(' ');
// Lines with these markers are metadata, introductions, or editorial headings — not text to read aloud.
const SKIP = /^(id|ide|h|toc\d|mt\d?|mte\d?|imt\d?|is\d?|ip|ipi|im|io\d?|ior|iot|ie|s\d?|ms\d?|mr|r|sr|rem|sts|cl|cp|ca|va|vp|usfm)$/;

function parseBook(usfm) {
  const text = usfm.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    .replace(/\\(f|fe|x|ef|ex)\s[\s\S]*?\\\1\*/g, '')                // footnotes and cross references
    .replace(/\\\+?w\s+([^|\\]*?)(?:\|[^\\]*)?\\\+?w\*/g, '$1');     // \w word|strong="H1234"\w*
  const meta = marker => (text.match(new RegExp(`^\\\\${marker}\\s+(.+)$`, 'm')) || [])[1]?.trim();
  const chapters = [];
  let verses = null;
  for (const line of text.split('\n')) {
    const [, tag = '', rest = line] = line.match(/^\\(\S+)\s*(.*)$/) || [];
    if (tag === 'c') { verses = []; chapters.push(verses); continue; }
    if (!verses || SKIP.test(tag)) continue;
    const clean = (tag === 'v' ? rest.replace(/^\S+\s*/, '') : rest)
      .replace(/\\\+?[a-z]+\d*\*/g, '').replace(/\\\+?[a-z]+\d*\s?/g, '').replace(/\s+/g, ' ').trim();
    if (tag === 'v' || !verses.length) verses.push(clean);
    else if (clean) verses[verses.length - 1] = `${verses[verses.length - 1]} ${clean}`.trim();
  }
  return { id: meta('id')?.slice(0, 3), name: meta('toc2') || meta('h') || meta('toc1'), chapters: chapters.map(verseList => verseList.filter(Boolean)) };
}

const source = process.argv[2];
if (!source) { console.error('Usage: node scripts/build-bible.js <folder of unzipped eBible USFM downloads>'); process.exit(1); }
const outRoot = path.join(__dirname, '..', 'frontend', 'bible');
for (const [lang, translation] of Object.entries(TRANSLATIONS)) {
  const dir = path.join(source, translation.id), books = new Map();
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.usfm'))) {
    const book = parseBook(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (BOOKS.includes(book.id)) books.set(book.id, book);
  }
  const missing = BOOKS.filter(id => !books.has(id));
  if (missing.length) throw new Error(`${translation.id} is missing ${missing.join(', ')}`);
  fs.mkdirSync(path.join(outRoot, lang), { recursive: true });
  const index = [];
  for (const id of BOOKS) {
    const { name, chapters } = books.get(id);
    const json = JSON.stringify({ id, chapters });
    if (/\\\\[a-z+]/.test(json) || chapters.some(chapter => !chapter.length)) throw new Error(`${translation.id} ${id}: unconverted markup or empty chapter`);
    fs.writeFileSync(path.join(outRoot, lang, `${id}.json`), json);
    index.push({ id, name: name || id, chapters: chapters.length });
  }
  const { title, license, chapterLabel } = translation;
  fs.writeFileSync(path.join(outRoot, lang, 'index.json'), JSON.stringify({ title, license, chapterLabel, books: index }));
  console.log(`${lang}: ${index.length} books, ${index.reduce((sum, book) => sum + book.chapters, 0)} chapters`);
}
