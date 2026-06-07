// api/lookup.js
// Service de recherche de livres par ISBN pour Librissime
// Sources : ISBNdb (primaire), Open Library (fallback)

const https = require('https');

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Librissime/1.0)',
        ...headers
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function searchISBNdb(isbn) {
  try {
    const url = `https://api2.isbndb.com/book/${isbn}`;
    const res = await fetchUrl(url, {
      'Authorization': '69645_d3478ec48c157a1a8df7c275e9306418'
    });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    if (!data.book) return null;
    const book = data.book;
    return {
      source: 'ISBNdb',
      title: book.title || null,
      author: book.authors ? book.authors.join(', ') : null,
      year: book.date_published ? book.date_published.substring(0, 4) : null,
      publisher: book.publisher || null,
      price: book.msrp ? parseFloat(book.msrp) : null,
      language: book.language || null,
      subjects: book.subjects || [],
      binding: book.binding || null
    };
  } catch(e) {
    console.error('ISBNdb error:', e.message);
    return null;
  }
}

async function searchOpenLibrary(isbn) {
  try {
    const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    const key = `ISBN:${isbn}`;
    if (!data[key]) return null;
    const book = data[key];
    return {
      source: 'Open Library',
      title: book.title || null,
      author: book.authors ? book.authors.map(a => a.name).join(', ') : null,
      year: book.publish_date ? book.publish_date.slice(-4) : null,
      publisher: book.publishers ? book.publishers.map(p => p.name).join(', ') : null,
      price: null,
      subjects: book.subjects ? book.subjects.map(s => s.name || s) : [],
      binding: null
    };
  } catch(e) {
    console.error('Open Library error:', e.message);
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  const { isbn } = req.query;
  if (!isbn) return res.status(400).json({ error: 'ISBN requis' });
  const isbnClean = isbn.replace(/[-\s]/g, '');
  console.log(`Recherche ISBN: ${isbnClean}`);
  const isbndb = await searchISBNdb(isbnClean);
  const result = isbndb || await searchOpenLibrary(isbnClean);
  if (!result) return res.status(404).json({ error: 'Livre non trouvé', isbn: isbnClean });
  console.log(`Trouvé via ${result.source}:`, result.title);
  return res.status(200).json(result);
};
