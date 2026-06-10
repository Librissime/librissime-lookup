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
      timeout: 6000
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
      res.on('end', () => resolve({ status: res.statusCode, body: data, finalUrl: url }));
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
    return null;
  }
}

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
    if (price && price > 2 && price < 200) return price;
    return null;
  } catch(e) {
    return null;
  }
}

// Extraction du prix sur une page produit leslibraires.ca
function extractPriceLL(html, isbn) {
  // Le prix régulier est dans : <div class="price price--reg"><span><span class="text-nowrap">29,95 $</span>
  const m = html.match(/price\s+price--reg[^>]*>\s*<span[^>]*>\s*<span[^>]*class="text-nowrap"[^>]*>\s*(\d+[,\.]\d{2})\s*\$/i);
  if (m) {
    const price = parseFloat(m[1].replace(',', '.'));
    if (price > 2 && price < 200) return price;
  }
  // Fallback : prix proche de l'ISBN dans le HTML
  const idx = html.indexOf(isbn);
  if (idx > -1) {
    const zone = html.substring(idx, idx + 2000);
    const m2 = zone.match(/text-nowrap[^>]*>\s*(\d+[,\.]\d{2})\s*\$/i);
    if (m2) {
      const price = parseFloat(m2[1].replace(',', '.'));
      if (price > 2 && price < 200) return price;
    }
  }
  return null;
}

async function getPriceLesLibraires(isbn) {
  const urls = [
    `https://www.leslibraires.ca/livres/${isbn}`,
    `https://www.leslibraires.ca/recherche?q=${isbn}`
  ];
  for (const url of urls) {
    try {
      const res = await fetchUrl(url);
      if (res.status === 200 && res.body.includes(isbn)) {
        const price = extractPriceLL(res.body, isbn);
        if (price) return price;
      }
    } catch(e) { /* essayer l'URL suivante */ }
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

  // MODE DEBUG : tester plusieurs formats d'adresses leslibraires.ca
  if (debug === 'find') {
    const candidates = [
      `https://www.leslibraires.ca/livres/${isbnClean}`,
      `https://www.leslibraires.ca/livres/-${isbnClean}`,
      `https://www.leslibraires.ca/recherche?q=${isbnClean}`,
      `https://www.leslibraires.ca/recherche/?q=${isbnClean}`,
      `https://www.leslibraires.ca/catalogue?q=${isbnClean}`
    ];
    const results = [];
    for (const url of candidates) {
      try {
        const r = await fetchUrl(url);
        const hasIsbn = r.body.includes(isbnClean);
        const price = hasIsbn ? extractPriceLL(r.body, isbnClean) : null;
        results.push({ url, status: r.status, taille: r.body.length, contientISBN: hasIsbn, prixTrouve: price });
      } catch(e) {
        results.push({ url, erreur: e.message });
      }
    }
    return res.status(200).json(results);
  }

  const [isbndb, openLib, priceGB, priceLL] = await Promise.all([
    searchISBNdb(isbnClean),
    searchOpenLibrary(isbnClean),
    getPriceGoogleBooks(isbnClean),
    getPriceLesLibraires(isbnClean)
  ]);

  const bookInfo = isbndb || openLib;
  if (!bookInfo) {
    return res.status(404).json({ error: 'Livre non trouve', isbn: isbnClean });
  }

  const price = priceLL || priceGB || null;
  bookInfo.price = price;
  bookInfo.priceSource = priceLL ? 'leslibraires.ca' : (priceGB ? 'Google Books CA' : null);

  return res.status(200).json(bookInfo);
};
