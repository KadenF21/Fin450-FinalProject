const { chromium } = require('playwright');
const fs = require('fs');

process.env.DEBUG = '';

const TOP_N = 10;

const INDICATORS = [
  {
    id: 'median-family-income',
    label: 'Median Family Income',
    searchText: 'Median Family Income',
  },
  {
    id: 'percent-aboriginal-population',
    label: '% Aboriginal Population',
    searchText: '% Aboriginal Population',
  },
];

async function getCoordinates(townName) {
  const cleaned = townName
    .replace(/\s+\d+[A-Z]?$/, '')
    .replace(/\(Part\)/gi, '')
    .replace(/No\.\s*\d+/gi, '')
    .replace(/County/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const attempts = [cleaned, townName];

  for (const attempt of attempts) {
    const query = encodeURIComponent(`${attempt}, Alberta, Canada`);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': '"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"' }
      });
      const data = await res.json();
      if (data.length > 0) {
        return {
          lat: parseFloat(data[0].lat),
          lon: parseFloat(data[0].lon),
        };
      }
    } catch (err) {}

    await new Promise(r => setTimeout(r, 1100));
  }

  return { lat: null, lon: null };
}

async function enrichWithCoords(municipalities) {
  const enriched = [];
  for (const m of municipalities) {
    const coords = await getCoordinates(m.name);
    enriched.push({ ...m, ...coords });
    await new Promise(r => setTimeout(r, 1100));
  }
  return enriched;
}

async function selectIndicator(page, searchText) {
  const clearBtn = page.locator('span.ms-close-btn').first();
  if (await clearBtn.isVisible()) {
    await clearBtn.click();
    await page.waitForTimeout(1000);
  }

  await page.locator('div.ms-trigger').first().click();
  await page.waitForTimeout(1000);

  const input = page.locator('div.ms-sel-ctn input').first();
  await input.click();
  await input.fill('');
  await input.type(searchText, { delay: 50 });
  await page.waitForTimeout(1500);

  const options = page.locator('ul.ms-res-ctn li, div.ms-res-ctn div');
  const count = await options.count();

  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const text = await option.innerText();
    if (text.toLowerCase().includes(searchText.toLowerCase())) {
      await option.click();
      break;
    }
  }

  await page.waitForTimeout(4000);
}

async function scrapeTable(page) {
  const municipalities = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const name = cells[1]?.innerText.trim();
        const rawValue = cells[2]?.innerText.trim().replace(/,/g, '');
        const value = parseFloat(rawValue);
        if (name && !isNaN(value)) {
          results.push({ name, value });
        }
      }
    });
    return results;
  });

  const filtered = municipalities.filter(m => m.value > 0);
  filtered.sort((a, b) => b.value - a.value);

  return {
    top: filtered.slice(0, TOP_N),
    bottom: filtered.slice(-TOP_N).reverse(),
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const results = {};

  await page.goto(
    'https://regionaldashboard.alberta.ca/#/explore-an-indicator?i=median-family-income&d=CalculatedValue',
    { waitUntil: 'networkidle', timeout: 60000 }
  );
  await page.waitForTimeout(5000);

  for (let i = 0; i < INDICATORS.length; i++) {
    const indicator = INDICATORS[i];
    if (i > 0) await selectIndicator(page, indicator.searchText);
    results[indicator.id] = await scrapeTable(page);
  }

  await browser.close();

  for (const indicator of INDICATORS) {
    results[indicator.id].top = await enrichWithCoords(results[indicator.id].top);
    results[indicator.id].bottom = await enrichWithCoords(results[indicator.id].bottom);
  }

  const output = {
    scraped_at: new Date().toISOString(),
    top_n: TOP_N,
    indicators: results,
  };

  // Write file AND output single line to stdout for R
  fs.writeFileSync('results.json', JSON.stringify(output));
  console.log(JSON.stringify(output));
})();