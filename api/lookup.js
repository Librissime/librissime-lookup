const https = require('https');

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8',
        ...headers
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchUrl(next, headers).then(resolve).catch(reject);
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
    const res = await fetchUrl(`https://api2.isbndb.com/book/${isbn}`, {
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

// Prix via Google Books (CA) — listPrice/retailPrice en CAD quand disponible
async function getPriceGoogleBooks(isbn) {
  try {
    const res = await fetchUrl(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&country=CA`);
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    if (!data.items || !data.items.length) return null;
    const sale = data.items[0].saleInfo;
    if (!sale) return null;
    let price = null;
    if (sale.listPrice && sale.listPrice.currencyCode === 'CAD') price = sale.listPrice.amount;
    else if (sale.retailPrice && sale.retailPrice.currencyCode === 'CAD') price = sale.retailPrice.amount;
    if (price && price > 2 && price < 200) {
      console.log('Google Books CA price:', price);
      return price;
    }
    return null;
  } catch(e) {
    console.error('Google Books error:', e.message);
    return null;
  }
}

async function getRenaudBrayHtml(isbn) {
  try {
    const res = await fetchUrl(`https://www.renaud-bray.com/Recherche.aspx?Categorie=1&Recherche=${isbn}`);
    return { status: res.status, html: res.body };
  } catch(e) {
    return { status: 0, html: '', error: e.message };
  }
}

function extractPriceFromHtml(html) {
  const patterns = [
    /itemprop="price"[^>]*content="(\d+[\.,]\d{2})"/i,
    /"price"\s*:\s*"?(\d+[\.,]\d{2})"?/i,
    /class="[^"]*(?:price|prix)[^"]*"[^>]*>[^0-9]*(\d+[,\.]\d{2})\s*\$/i,
    /(\d{1,3}[,\.]\d{2})\s*\$/
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const price = parseFloat(m[1].replace(',', '.'));
      if (price > 2 && price < 200) return price;
    }
  }
  return null;
}

async function searchOpenLibrary(isbn) {
  try {
    const res = await fetchUrl(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    const book = data[`ISBN:${isbn}`];
    if (!book) return null;
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
  const { isbn, debug } = req.query;
  if (!isbn) return res.status(400).json({ error: 'ISBN requis' });
  const isbnClean = isbn.replace(/[-\s]/g, '');

  // MODE DEBUG : retourne le HTML brut de Renaud-Bray pour diagnostic
  if (debug === 'rb') {
    const rb = await getRenaudBrayHtml(isbnClean);
    return res.status(200).json({
      statusRB: rb.status,
      erreur: rb.error || null,
      tailleHtml: rb.html.length,
      extraitDebut: rb.html.substring(0, 2000),
      extraitPrix: (() => {
        const idx = rb.html.search(/\d{1,3}[,\.]\d{2}\s*\$/);
        if (idx === -1) return 'AUCUN MOTIF DE PRIX TROUVÉ';
        return rb.html.substring(Math.max(0, idx - 800), idx + 400);
      })()
    });
  }

  const [isbndb, openLib, priceGB, rbResult] = await Promise.all([
    searchISBNdb(isbnClean),
    searchOpenLibrary(isbnClean),
    getPriceGoogleBooks(isbnClean),
    getRenaudBrayHtml(isbnClean)
  ]);

  const bookInfo = isbndb || openLib;
  if (!bookInfo) {
    return res.status(404).json({ error: 'Livre non trouve', isbn: isbnClean });
  }

  const priceRB = rbResult.html ? extractPriceFromHtml(rbResult.html) : null;
  const price = priceRB || priceGB || null;
  bookInfo.price = price;
  bookInfo.priceSource = priceRB ? 'Renaud-Bray' : (priceGB ? 'Google Books CA' : null);

  console.log(`${bookInfo.title} — prix: ${price} (${bookInfo.priceSource})`);
  return res.status(200).json(bookInfo);
};
