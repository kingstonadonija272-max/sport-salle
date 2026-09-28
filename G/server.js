const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = __dirname;
const databaseDirectory = path.join(root, 'data');
fs.mkdirSync(databaseDirectory, { recursive: true });
const reservationsFile = path.join(root, 'reservations.json');
if (!fs.existsSync(reservationsFile)) fs.writeFileSync(reservationsFile, '[]\n', 'utf8');
const database = new DatabaseSync(path.join(databaseDirectory, 'atelier-forme.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    age INTEGER NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    service TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    age INTEGER NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    product_key TEXT NOT NULL,
    product_name TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const products = {
  shoes: { name: 'Chaussures de sport', price: 49200 },
  bottle: { name: 'Gourde sport', price: 11800 },
  rope: { name: 'Corde à sauter', price: 9800 },
  bag: { name: 'Sac de sport', price: 25600 },
};
const allowedServices = new Set([
  'Accès libre', 'Cours collectif', 'Coaching individuel',
  'Abonnement Essentiel', 'Abonnement Studio', 'Abonnement Intense',
]);
const sessions = new Map();
const loginAttempts = new Map();
const sessionDuration = 8 * 60 * 60 * 1000;
const loginWindow = 15 * 60 * 1000;
const maxLoginAttempts = 5;
const sessionCookie = 'atelier_session';
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/inde.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/mana.min.js', ['mana.min.js', 'text/javascript; charset=utf-8']],
]);

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16_384) {
        reject(new Error('La demande est trop volumineuse.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Les informations envoyées sont invalides.'));
      }
    });
    request.on('error', reject);
  });
}

function readReservations() {
  const content = fs.readFileSync(reservationsFile, 'utf8');
  const reservations = JSON.parse(content || '[]');
  if (!Array.isArray(reservations)) throw new Error('Le fichier des réservations est invalide.');
  return reservations;
}

function writeReservations(reservations) {
  fs.writeFileSync(reservationsFile, `${JSON.stringify(reservations, null, 2)}\n`, 'utf8');
}

function cleanText(value, label, maxLength) {
  if (typeof value !== 'string') throw new Error(`Veuillez renseigner ${label}.`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`Le champ « ${label} » est invalide.`);
  }
  return cleaned;
}

function customerFrom(body) {
  const firstName = cleanText(body.firstName, 'votre prénom', 80);
  const lastName = cleanText(body.lastName, 'votre nom', 80);
  const email = cleanText(body.email, 'votre e-mail', 254);
  const age = Number(body.age);
  if (!Number.isInteger(age) || age < 1 || age > 120) throw new Error('Veuillez indiquer un âge valide.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Veuillez indiquer une adresse e-mail valide.');
  const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 30) : '';
  return { firstName, lastName, age, email, phone };
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isAdmin(request) {
  const token = parseCookies(request.headers.cookie)[sessionCookie];
  const expiresAt = sessions.get(token);
  if (!token || !expiresAt) return false;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function sessionCookieHeader(token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function ownerCredentialsConfigured() {
  return Boolean(process.env.OWNER_USERNAME && process.env.OWNER_PASSWORD);
}

function clientAddress(request) {
  return request.socket.remoteAddress || 'unknown';
}

function loginRateLimit(request) {
  const attempt = loginAttempts.get(clientAddress(request));
  if (!attempt) return null;
  if (Date.now() - attempt.startedAt >= loginWindow) {
    loginAttempts.delete(clientAddress(request));
    return null;
  }
  if (attempt.count >= maxLoginAttempts) {
    return Math.ceil((loginWindow - (Date.now() - attempt.startedAt)) / 1000);
  }
  return null;
}

function recordFailedLogin(request) {
  const address = clientAddress(request);
  const now = Date.now();
  const previous = loginAttempts.get(address);
  if (!previous || now - previous.startedAt >= loginWindow) {
    loginAttempts.set(address, { startedAt: now, count: 1 });
    return;
  }
  previous.count += 1;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function handleApi(request, response, url) {
  if (request.method === 'POST' && url.pathname === '/api/reservations') {
    const body = await readJson(request);
    const customer = customerFrom(body);
    const service = cleanText(body.service, 'une activité', 60);
    if (!allowedServices.has(service)) throw new Error('Veuillez choisir une activité disponible.');
    if (!validDate(body.date) || body.date < new Date().toISOString().slice(0, 10)) throw new Error('Veuillez choisir une date valide à partir d’aujourd’hui.');
    if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) throw new Error('Veuillez choisir une heure valide.');
    const reservations = readReservations();
    const nextId = reservations.reduce((highestId, reservation) => Math.max(highestId, Number(reservation.id) || 0), 0) + 1;
    reservations.push({
      id: nextId,
      firstName: customer.firstName,
      lastName: customer.lastName,
      age: customer.age,
      email: customer.email,
      phone: customer.phone,
      service,
      date: body.date,
      time: body.time,
      createdAt: new Date().toISOString(),
    });
    writeReservations(reservations);
    sendJson(response, 201, { ok: true, id: nextId });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/purchases') {
    const body = await readJson(request);
    const customer = customerFrom(body);
    const product = products[body.product];
    const quantity = Number(body.quantity);
    if (!product) throw new Error('Veuillez choisir une formule disponible.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new Error('La quantité doit être comprise entre 1 et 10.');
    const total = product.price * quantity;
    database.prepare(`INSERT INTO purchases (first_name, last_name, age, email, phone, product_key, product_name, unit_price, quantity, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      customer.firstName, customer.lastName, customer.age, customer.email, customer.phone,
      body.product, product.name, product.price, quantity, total,
    );
    sendJson(response, 201, { ok: true, product: product.name, total });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/login') {
    if (!ownerCredentialsConfigured()) {
      sendJson(response, 503, { error: 'La connexion propriétaire doit être configurée sur le serveur.' });
      return;
    }
    const retryAfter = loginRateLimit(request);
    if (retryAfter) {
      sendJson(response, 429, { error: 'Trop de tentatives. Réessayez plus tard.' }, { 'Retry-After': String(retryAfter) });
      return;
    }
    const body = await readJson(request);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!safeEqual(username, process.env.OWNER_USERNAME) || !safeEqual(password, process.env.OWNER_PASSWORD)) {
      recordFailedLogin(request);
      sendJson(response, 401, { error: 'Identifiant ou mot de passe incorrect.' });
      return;
    }
    loginAttempts.delete(clientAddress(request));
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + sessionDuration);
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookieHeader(token, sessionDuration / 1000) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
    const token = parseCookies(request.headers.cookie)[sessionCookie];
    if (token) sessions.delete(token);
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookieHeader('', 0) });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/requests') {
    if (!isAdmin(request)) {
      sendJson(response, 401, { error: 'Connexion propriétaire requise.' });
      return;
    }
    const reservations = readReservations().sort((left, right) => Number(right.id) - Number(left.id));
    const purchases = database.prepare(`SELECT id, first_name AS firstName, last_name AS lastName, age, email, phone,
      product_key AS productKey, product_name AS productName, unit_price AS unitPrice, quantity, total,
      created_at AS createdAt FROM purchases ORDER BY id DESC`).all();
    sendJson(response, 200, { reservations, purchases });
    return;
  }

  sendJson(response, 404, { error: 'Page introuvable.' });
}

const requestHandler = async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Méthode non autorisée.' });
      return;
    }
    const entry = publicFiles.get(url.pathname);
    if (!entry) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      response.end('Page introuvable.');
      return;
    }
    const [fileName, contentType] = entry;
    const content = fs.readFileSync(path.join(root, fileName));
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (!response.headersSent) {
      const status = /invalide|choisir|indiqu|quantité|renseigner|volumineuse/i.test(error.message) ? 400 : 500;
      sendJson(response, status, { error: status === 500 ? 'Une erreur est survenue. Réessayez.' : error.message });
    }
    if (error.code && !response.destroyed) console.error(error);
  }
};

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const httpsEnabled = process.env.HTTPS === 'true';
let server;
if (httpsEnabled) {
  if (!process.env.HTTPS_KEY_PATH || !process.env.HTTPS_CERT_PATH) {
    throw new Error('HTTPS activé mais HTTPS_KEY_PATH ou HTTPS_CERT_PATH est manquant.');
  }
  server = https.createServer({
    key: fs.readFileSync(process.env.HTTPS_KEY_PATH),
    cert: fs.readFileSync(process.env.HTTPS_CERT_PATH),
  }, requestHandler);
} else {
  server = http.createServer(requestHandler);
}
server.listen(port, host, () => {
  console.log(`Atelier Forme disponible sur ${httpsEnabled ? 'https' : 'http'}://${host}:${port}`);
  console.log(`Base de données : ${path.join(databaseDirectory, 'atelier-forme.sqlite')}`);
  if (!ownerCredentialsConfigured()) console.warn('Espace propriétaire désactivé : définissez OWNER_USERNAME et OWNER_PASSWORD dans .env.');
});
