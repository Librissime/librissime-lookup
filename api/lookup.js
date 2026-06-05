// api/lookup.js
// Service de recherche de livres par ISBN
// Sources : Renaud-Bray, leslibraires.ca, Open Library

const https = require('https');
const http = require('http');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8',
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

async function searchRenaudBray(isbn) {
  try {
    const url = `https://www.renaud-bray.com/Recherche.aspx?Categorie=1&Recherche=${isbn}`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return null;
    const html = res.body;
    const titleMatch = html.match(/class="[^"]*titre[^"]*"[^>]*>([^<]+)</i) || html.match(/itemprop="name"[^>]*>([^<]+)</i);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const authorMatch = html.match(/class="[^"]*auteur[^"]*"[^>]*>([^<]+)</i) || html.match(/itemprop="author"[^>]*>([^<]+)</i);
    const author = authorMatch ? authorMatch[1].trim() : null;
    const priceMatch = html.match(/(\d+[,\.]\d{2})\s*\$/);
    const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : null;
    const yearMatch = html.match(/(\d{4})/g);
    const year = yearMatch ? yearMatch.find(y => parseInt(y) >= 1900 && parseInt(y) <= new Date().getFullYear()) : null;
    if (title || author) return { source: 'Renaud-Bray', title, author, year, price };
    return null;
  } catch(e) { return null; }
}

async function searchLesLibraires(isbn) {
  try {
    const url = `https://www.leslibraires.ca/livres/recherche/?q=${isbn}`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return null;
    const html = res.body;
    const titleMatch = html.match(/itemprop="name"[^>]*>([^<]+)</i) || html.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)</i);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const authorMatch = html.match(/itemprop="author"[^>]*>([^<]+)</i);
    const author = authorMatch ? authorMatch[1].trim() : null;
    const priceMatch = html.match(/(\d+[,\.]\d{2})\s*\$/);
    const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : null;
    const yearMatch = html.match(/(\d{4})/g);
    const year = yearMatch ? yearMatch.find(y => parseInt(y) >= 1900 && parseInt(y) <= new Date().getFullYear()) : null;
    if (title || author) return { source: 'leslibraires.ca', title, author, year, price };
    return null;
  } catch(e) { return null; }
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
    return { source: 'Open Library', title: book.title || null, author: book.authors ? book.authors.map(a => a.name).join(', ') : null, year: book.publish_date ? book.publish_date.slice(-4) : null, price: null };
  } catch(e) { return null; }
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
  const [renaudBray, lesLibraires, openLibrary] = await Promise.all([
    searchRenaudBray(isbnClean),
    searchLesLibraires(isbnClean),
    searchOpenLibrary(isbnClean)
  ]);
  const result = renaudBray || lesLibraires || openLibrary;
  if (!result) return res.status(404).json({ error: 'Livre non trouvé', isbn: isbnClean });
  return res.status(200).json(result);
};
