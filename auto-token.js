/**
 * auto-token.js
 * ─────────────
 * Logger automatisk inn på Gausium og henter ny Bearer-token.
 */

const puppeteer = require('puppeteer');

const LOGIN_URL = 'https://service-us.gs-robot.com/#/login';
const ROBOT_URL = 'https://service-us.gs-robot.com/#/robot/manager';

async function fetchFreshToken(username, password) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });

  try {
    const page = await browser.newPage();
    let capturedToken = null;

    // Fang token fra alle utgående requests
    await page.setRequestInterception(true);
    page.on('request', req => {
      const auth = req.headers()['authorization'] || '';
      if (auth.startsWith('Bearer ') && auth.length > 200) {
        capturedToken = auth.replace('Bearer ', '').trim();
        console.log('[token] Fanget token fra request:', req.url().slice(0, 80));
      }
      req.continue();
    });

    // Fang også token fra responses (noen ganger i Set-Cookie eller response body)
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('application/json') && res.url().includes('token')) {
          const txt = await res.text().catch(() => '');
          const m = txt.match(/"access_token"\s*:\s*"(eyJ[^"]+)"/);
          if (m) { capturedToken = m[1]; console.log('[token] Fanget fra response body'); }
        }
      } catch {}
    });

    console.log('[token] Åpner innloggingssiden...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    // Debug: logg alle input-felter
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, placeholder: i.placeholder, id: i.id
      }))
    );
    console.log('[token] Input-felter funnet:', JSON.stringify(inputs));

    // Finn brukernavnfelt
    const userInput = await page.$('input[name="username"]')
      || await page.$('input[name="account"]')
      || await page.$('input[type="text"]')
      || await page.$('input:not([type="password"])');

    if (!userInput) throw new Error('Fant ikke brukernavnfelt');
    await userInput.click({ clickCount: 3 });
    await userInput.type(username, { delay: 80 });
    console.log('[token] Brukernavnfelt fylt inn');

    // Finn passordfelt
    const passInput = await page.$('input[type="password"]');
    if (!passInput) throw new Error('Fant ikke passordfelt');
    await passInput.click({ clickCount: 3 });
    await passInput.type(password, { delay: 80 });
    console.log('[token] Passordfelt fylt inn');

    // Klikk logg inn
    const btn = await page.$('button[type="submit"]') || await page.$('button');
    if (btn) {
      await btn.click();
      console.log('[token] Klikket login-knapp');
    } else {
      await passInput.press('Enter');
      console.log('[token] Trykket Enter');
    }

    // Vent på at URL endrer seg fra login
    console.log('[token] Venter på redirect etter login...');
    await page.waitForFunction(
      () => !window.location.href.includes('/login'),
      { timeout: 30000, polling: 500 }
    ).catch(() => console.log('[token] Ingen redirect, fortsetter likevel...'));

    await new Promise(r => setTimeout(r, 3000));
    console.log('[token] URL etter login:', await page.url());

    // Naviger til robot manager for å trigge API-kall
    if (!capturedToken) {
      console.log('[token] Navigerer til robot manager...');
      await page.goto(ROBOT_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        .catch(() => console.log('[token] networkidle2 timeout, fortsetter...'));
      await new Promise(r => setTimeout(r, 4000));
    }

    // Sjekk localStorage
    if (!capturedToken) {
      console.log('[token] Søker i localStorage/sessionStorage...');
      capturedToken = await page.evaluate(() => {
        const stores = [localStorage, sessionStorage];
        for (const store of stores) {
          for (const key of Object.keys(store)) {
            const val = store.getItem(key);
            if (val && val.startsWith('eyJ') && val.length > 200) {
              console.log('Fant token i store, key:', key);
              return val;
            }
            try {
              const obj = JSON.parse(val || '');
              const candidates = [
                obj?.token, obj?.access_token, obj?.accessToken,
                obj?.data?.token, obj?.data?.access_token,
              ];
              for (const t of candidates) {
                if (t && t.startsWith('eyJ') && t.length > 200) return t;
              }
            } catch {}
          }
        }
        return null;
      });
      if (capturedToken) console.log('[token] Funnet i storage!');
    }

    if (!capturedToken) {
      // Logg page HTML for debugging
      const html = await page.content();
      console.log('[token] Side-HTML (første 500 tegn):', html.slice(0, 500));
      console.log('[token] Nåværende URL:', await page.url());
      throw new Error('Klarte ikke fange token etter innlogging');
    }

    return capturedToken;

  } finally {
    await browser.close();
  }
}

module.exports = { fetchFreshToken };
