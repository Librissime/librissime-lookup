const https = require('https');

function fetchUrl(url, headers = {}, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8',
        ...headers
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchUrl(next, headers, timeoutMs).then(resolve).catch(reject);
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
    }, 5000);
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    if (!data.book) return null;
    const book = data.book;
    return {
      source: 'ISBNdb',
      title: book.title || null,
      author: book.authors ? book.authors.join(', ') : null,
      year: book.date_published ? String(book.date_published).substring(0, 4) : null,
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

async function searchOpenLibrary(isbn) {
  try {
    const res = await fetchUrl(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, {}, 5000);
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    const book = data[`ISBN:${isbn}`];
    if (!book) return null;
    return {
      source: 'Open Library',
      title: book.title || null,
      author: book.authors ? book.authors.map(a => a.name).join(', ') : null,
      year: book.publish_date ? String(book.publish_date).slice(-4) : null,
      publisher: book.publishers ? book.publishers.map(p => p.name).join(', ') : null,
      subjects: book.subjects ? book.subjects.map(s => s.name || s) : [],
      binding: null
    };
  } catch(e) {
    return null;
  }
}

function extractPriceLL(html, isbn) {
  const ldBlocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  for (const block of ldBlocks) {
    try {
      const json = JSON.parse(block.replace(/<script type="application\/ld\+json">/, '').replace(/<\/script>/, ''));
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (item.offers) {
          const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
          for (const offer of offers) {
            const p = parseFloat(offer.price);
            if (p > 2 && p < 200) return p;
          }
        }
      }
    } catch(e) {}
  }
  const idx = html.indexOf(isbn);
  if (idx > -1) {
    const zone = html.substring(Math.max(0, idx - 3000), idx + 3000);
    const m2 = zone.match(/text-nowrap[^>]*>\s*(\d+[,\.]\d{2})\s*\$/i);
    if (m2) {
      const price = parseFloat(m2[1].replace(',', '.'));
      if (price > 2 && price < 200) return price;
    }
  }
  return null;
}

async function getPriceLesLibraires(isbn) {
  try {
    const res = await fetchUrl(`https://www.leslibraires.ca/livres/${isbn}`, {}, 5000);
    if (res.status === 200 && res.body.includes(isbn)) {
      return extractPriceLL(res.body, isbn);
    }
  } catch(e) {}
  return null;
}

async function getPriceGoogleBooks(isbn) {
  try {
    const res = await fetchUrl(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&country=CA`, {}, 5000);
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

async function getPrice(isbn) {
  const ll = await getPriceLesLibraires(isbn);
  if (ll) return { price: ll, priceSource: 'leslibraires.ca' };
  const gb = await getPriceGoogleBooks(isbn);
  if (gb) return { price: gb, priceSource: 'Google Books CA' };
  return { price: null, priceSource: null };
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
  const { isbn, debug, prixonly } = req.query;
  if (!isbn) return res.status(400).json({ error: 'ISBN requis' });
  const isbnClean = isbn.replace(/[-\s]/g, '');

  // Endpoint « prix seulement » : appelé séparément par l'application, après l'affichage des infos.
  if (prixonly === '1') {
    const p = await getPrice(isbnClean);
    return res.status(200).json(p);
  }

  // Mode debug
  if (debug === 'prix') {
    try {
      const r = await fetchUrl(`https://www.leslibraires.ca/livres/${isbnClean}`);
      const ldBlocks = r.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
      return res.status(200).json({ nbBlocsJsonLd: ldBlocks.length, blocs: ldBlocks.map(b => b.substring(0, 1200)), prixExtrait: extractPriceLL(r.body, isbnClean) });
    } catch(e) { return res.status(200).json({ erreur: e.message }); }
  }

  // Réponse principale : INFOS DU LIVRE seulement, sans le prix → toujours rapide.
  // Le prix est récupéré séparément par l'application via &prixonly=1.
  let bookInfo = await searchISBNdb(isbnClean);
  if (!bookInfo) bookInfo = await searchOpenLibrary(isbnClean);
  if (!bookInfo) {
    return res.status(404).json({ error: 'Livre non trouve', isbn: isbnClean });
  }
  bookInfo.price = null;
  bookInfo.priceSource = null;
  return res.status(200).json(bookInfo);
};
