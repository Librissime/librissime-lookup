const https = require('https');
const http = require('http');

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8',
        ...headers
      },
      timeout: 10000
    };
    const req = client.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, headers).then(resolve).catch(reject);
        return;
      }
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
      language: book.language || null,
      subjects: book.subjects || [],
      binding: book.binding || null
    };
  } catch(e) {
    console.error('ISBNdb error:', e.message);
    return null;
  }
}

async function getPriceRenaudBray(isbn) {
  try {
    const url = `https://www.renaud-bray.com/Recherche.aspx?Categorie=1&Recherche=${isbn}`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return null;
    const html = res.body;
    const pricePatterns = [
      /class="[^"]*price[^"]*"[^>]*>\s*(\d+[,\.]\d{2})\s*\$/i,
      /class="[^"]*prix[^"]*"[^>]*>\s*(\d+[,\.]\d{2})\s*\$/i,
      /itemprop="price"[^>]*content="(\d+[\.,]\d{2})"/i,
      /(\d+[,\.]\d{2})\s*\$\s*CA/i,
      /prix[^>]*>\s*(\d+[,\.]\d{2})\s*\$/i,
      /"price":\s*"?(\d+[\.,]\d{2})"?/i,
      /(\d{1,3}[,\.]\d{2})\s*\$/,
    ];
    for (const pattern of pricePatterns) {
      const match = html.match(pattern);
      if (match) {
        const price = parseFloat(match[1].replace(',', '.'));
        if (price > 2 && price < 200) {
          console.log('Renaud-Bray price found:', price);
          return price;
        }
      }
    }
    return null;
  } catch(e) {
    console.error('Renaud-Bray error:', e.message);
    return null;
  }
}

async function getPriceLesLibraires(isbn) {
  try {
    const searchUrl = `https://www.leslibraires.ca/recherche/?s=${isbn}`;
    const res = await fetchUrl(searchUrl);
    if (res.status !== 200) return null;
    const html = res.body;
    const pricePatterns = [
      /itemprop="price"[^>]*content="(\d+[\.,]\d{2})"/i,
      /class="[^"]*price[^"]*"[^>]*>\s*(\d+[,\.]\d{2})\s*\$/i,
      /class="[^"]*prix[^"]*"[^>]*>\s*(\d+[,\.]\d{2})\s*\$/i,
      /"price":\s*"?(\d+[\.,]\d{2})"?/i,
      /(\d{1,3}[,\.]\d{2})\s*\$\s/,
    ];
    for (const pattern of pricePatterns) {
      const match = html.match(pattern);
      if (match) {
        const price = parseFloat(match[1].replace(',', '.'));
        if (price > 2 && price < 200) {
          console.log('leslibraires.ca price found:', price);
          return price;
        }
      }
    }
    return null;
  } catch(e) {
    console.error('leslibraires.ca error:', e.message);
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

  // Get book info from ISBNdb, price from Canadian sources
  const [isbndb, openLib, priceRB, priceLL] = await Promise.all([
    searchISBNdb(isbnClean),
    searchOpenLibrary(isbnClean),
    getPriceRenaudBray(isbnClean),
    getPriceLesLibraires(isbnClean)
  ]);

  const bookInfo = isbndb || openLib;
  if (!bookInfo) {
    return res.status(404).json({ error: 'Livre non trouve', isbn: isbnClean });
  }

  // Use Canadian price (Renaud-Bray first, then leslibraires.ca)
  const canadianPrice = priceRB || priceLL || null;
  bookInfo.price = canadianPrice;
  if (canadianPrice) {
    bookInfo.priceSource = priceRB ? 'Renaud-Bray' : 'leslibraires.ca';
  }

  console.log(`Trouve via ${bookInfo.source}: ${bookInfo.title}, prix CAD: ${canadianPrice}`);
  return res.status(200).json(bookInfo);
};
