const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (error) {
  nodemailer = null;
}

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, 'index.html');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'e-voting.sqlite');
const PUBLIC_SQUAD_KEY = process.env.SQUAD_PUBLIC_KEY || '';
const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY || '';
const SQUAD_ENV = (process.env.SQUAD_ENV || 'sandbox').toLowerCase();
const LOGO_URL = process.env.LOGO_URL || '';
const SQUAD_VERIFY_BASE =
  process.env.SQUAD_VERIFY_BASE ||
  (SQUAD_ENV === 'live' ? 'https://api-d.squadco.com' : 'https://sandbox-api-d.squadco.com');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

ensureDataDir();

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  price INTEGER NOT NULL DEFAULT 0,
  open INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nominees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  votes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(category_id, name)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  amount INTEGER NOT NULL,
  customer_name TEXT,
  status TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vote_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  nominee_name TEXT NOT NULL,
  votes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function repairVoteItemsSchema() {
  const voteItems = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vote_items'`).get();
  if (!voteItems || !String(voteItems.sql || '').includes('transactions_old')) {
    const lingeringOld = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions_old'`).get();
    if (lingeringOld) {
      db.exec('DROP TABLE IF EXISTS transactions_old;');
    }
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      ALTER TABLE vote_items RENAME TO vote_items_old;
      CREATE TABLE vote_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        nominee_name TEXT NOT NULL,
        votes INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO vote_items (id, transaction_id, category_id, nominee_name, votes, created_at)
      SELECT id, transaction_id, category_id, nominee_name, votes, created_at
      FROM vote_items_old;
      DROP TABLE vote_items_old;
    `);
    const lingeringOld = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions_old'`).get();
    if (lingeringOld) {
      db.exec('DROP TABLE IF EXISTS transactions_old;');
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

repairVoteItemsSchema();

const statements = {
  listCategories: db.prepare(`
    SELECT id, name, price, open
    FROM categories
    ORDER BY id ASC
  `),
  listNomineesByCategory: db.prepare(`
    SELECT id, name, votes
    FROM nominees
    WHERE category_id = ?
    ORDER BY id ASC
  `),
  countVotesByCategory: db.prepare(`
    SELECT category_id, nominee_name, SUM(votes) AS votes
    FROM vote_items
    GROUP BY category_id, nominee_name
  `),
  insertCategory: db.prepare(`
    INSERT INTO categories (name, price, open)
    VALUES (?, ?, 1)
  `),
  updateCategoryName: db.prepare(`
    UPDATE categories
    SET name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `),
  updateCategoryPrice: db.prepare(`
    UPDATE categories
    SET price = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `),
  updateCategoryOpen: db.prepare(`
    UPDATE categories
    SET open = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `),
  deleteCategory: db.prepare(`
    DELETE FROM categories
    WHERE id = ?
  `),
  insertNominee: db.prepare(`
    INSERT INTO nominees (category_id, name, votes)
    VALUES (?, ?, 0)
  `),
  deleteNominee: db.prepare(`
    DELETE FROM nominees
    WHERE category_id = ? AND name = ?
  `),
  updateNomineeVotes: db.prepare(`
    UPDATE nominees
    SET votes = votes + ?, updated_at = CURRENT_TIMESTAMP
    WHERE category_id = ? AND name = ?
  `),
  findCategoryById: db.prepare(`
    SELECT id, name, price, open
    FROM categories
    WHERE id = ?
  `),
  findCategoryByName: db.prepare(`
    SELECT id, name, price, open
    FROM categories
    WHERE UPPER(name) = UPPER(?)
  `),
  findNomineeByCategoryAndName: db.prepare(`
    SELECT id, category_id, name, votes
    FROM nominees
    WHERE category_id = ? AND UPPER(name) = UPPER(?)
  `),
  findTxByReference: db.prepare(`
    SELECT id, reference, email, amount, customer_name, status, raw_payload, created_at
    FROM transactions
    WHERE reference = ?
  `),
  findTxByEmail: db.prepare(`
    SELECT id, reference, email, amount, customer_name, status, raw_payload, created_at
    FROM transactions
    WHERE LOWER(email) = LOWER(?)
  `),
  insertTransaction: db.prepare(`
    INSERT INTO transactions (reference, email, amount, customer_name, status, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  insertVoteItem: db.prepare(`
    INSERT INTO vote_items (transaction_id, category_id, nominee_name, votes)
    VALUES (?, ?, ?, ?)
  `),
  listVoteItemsByTransaction: db.prepare(`
    SELECT category_id, nominee_name, votes
    FROM vote_items
    WHERE transaction_id = ?
  `),
  upsertSetting: db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  getSetting: db.prepare(`
    SELECT value
    FROM settings
    WHERE key = ?
  `),
  countAdmins: db.prepare(`
    SELECT COUNT(*) AS count
    FROM admins
  `),
  findAdminByUsername: db.prepare(`
    SELECT id, username, password_salt, password_hash
    FROM admins
    WHERE LOWER(username) = LOWER(?)
  `),
  findAdminById: db.prepare(`
    SELECT id, username, password_salt, password_hash
    FROM admins
    WHERE id = ?
  `),
  insertAdmin: db.prepare(`
    INSERT INTO admins (username, password_salt, password_hash)
    VALUES (?, ?, ?)
  `),
  updateAdminCredentials: db.prepare(`
    UPDATE admins
    SET username = ?, password_salt = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `),
  insertSession: db.prepare(`
    INSERT INTO admin_sessions (token, admin_id, expires_at)
    VALUES (?, ?, ?)
  `),
  findSession: db.prepare(`
    SELECT s.token, s.admin_id, s.expires_at, a.username
    FROM admin_sessions s
    JOIN admins a ON a.id = s.admin_id
    WHERE s.token = ?
  `),
  deleteSession: db.prepare(`
    DELETE FROM admin_sessions
    WHERE token = ?
  `)
};

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), 120000, 64, 'sha512').toString('hex');
}

function createPasswordMaterial(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

function parseCookies(request) {
  const header = request.headers.cookie || '';
  return header.split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function getAdminFromRequest(request) {
  const cookies = parseCookies(request);
  const token = cookies.admin_session;
  if (!token) return null;
  const session = statements.findSession.get(token);
  if (!session) return null;
  const expiresAt = new Date(session.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    statements.deleteSession.run(token);
    return null;
  }
  return { id: session.admin_id, username: session.username, token };
}

function setSessionCookie(response, token) {
  response.setHeader('Set-Cookie', `admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`);
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function issueSession(adminId, response) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
  statements.insertSession.run(token, adminId, expiresAt);
  setSessionCookie(response, token);
  return token;
}

function migrateTransactionsSchema() {
  const indexes = db.prepare(`PRAGMA index_list(transactions)`).all();
  const hasEmailUniqueIndex = indexes.some(index => {
    if (!index.unique) return false;
    const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all();
    return columns.some(column => String(column.name || '').toLowerCase() === 'email');
  });

  if (!hasEmailUniqueIndex) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      ALTER TABLE transactions RENAME TO transactions_old;
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reference TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        amount INTEGER NOT NULL,
        customer_name TEXT,
        status TEXT NOT NULL,
        raw_payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO transactions (id, reference, email, amount, customer_name, status, raw_payload, created_at)
      SELECT id, reference, email, amount, customer_name, status, raw_payload, created_at
      FROM transactions_old;
      DROP TABLE transactions_old;
    `);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

migrateTransactionsSchema();

function seedAdminIfMissing() {
  const seedUsername = String(process.env.ADMIN_SEED_USERNAME || 'admin').trim();
  const seedPassword = String(process.env.ADMIN_SEED_PASSWORD || 'admin@1234');
  const { salt, hash } = createPasswordMaterial(seedPassword);
  const adminCount = statements.countAdmins.get().count;
  const seedAdmin = statements.findAdminByUsername.get(seedUsername);

  if (!seedAdmin && adminCount > 0) return;

  if (seedAdmin) {
    statements.updateAdminCredentials.run(seedUsername, salt, hash, seedAdmin.id);
    console.log(`Seeded admin account updated: ${seedUsername}`);
    return;
  }

  statements.insertAdmin.run(seedUsername, salt, hash);
  console.log(`Seeded first admin account: ${seedUsername}`);
}

seedAdminIfMissing();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function normalizeName(value) {
  return String(value || '').trim().toUpperCase();
}

function toBool(value) {
  return value ? 1 : 0;
}

function parseJson(rawBody) {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return {};
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw);
    });
    req.on('error', reject);
  });
}

function collectState() {
  const categories = statements.listCategories.all().map(category => {
    const nominees = statements.listNomineesByCategory.all(category.id).map(nominee => ({
      id: nominee.id,
      name: nominee.name,
      votes: nominee.votes
    }));
    return {
      id: category.id,
      name: category.name,
      price: category.price,
      open: Boolean(category.open),
      nominees
    };
  });

  const voteRecords = {};
  categories.forEach(category => {
    voteRecords[category.name] = {};
    category.nominees.forEach(nominee => {
      voteRecords[category.name][nominee.name] = nominee.votes;
    });
  });

  return {
    categories: categories.map(category => ({
      id: category.id,
      name: category.name,
      price: category.price,
      open: category.open,
      nominees: category.nominees.map(nominee => nominee.name)
    })),
    voteRecords,
    stats: {
      categories: categories.length,
      nominees: categories.reduce((count, category) => count + category.nominees.length, 0),
      votes: categories.reduce((count, category) => count + category.nominees.reduce((inner, nominee) => inner + nominee.votes, 0), 0),
      openPolls: categories.filter(category => category.open).length
    }
  };
}

function buildHealthPayload() {
  const hasFirestoreCredentials =
    Boolean(String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()) ||
    (Boolean(String(process.env.FIREBASE_PROJECT_ID || '').trim()) &&
      Boolean(String(process.env.FIREBASE_CLIENT_EMAIL || '').trim()) &&
      Boolean(String(process.env.FIREBASE_PRIVATE_KEY || '').trim()));

  return {
    ok: true,
    firestoreConfigured: hasFirestoreCredentials,
    squadConfigured: Boolean(PUBLIC_SQUAD_KEY)
  };
}

function buildReceiptLines(items) {
  const grouped = new Map();
  items.forEach(item => {
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category).push(`${item.nominee} x${item.votes}`);
  });
  return [...grouped.entries()]
    .map(([category, selections]) => `- ${category}: ${selections.join(', ')}`)
    .join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildReceiptSections(items) {
  const grouped = new Map();
  items.forEach(item => {
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category).push({
      nominee: item.nominee,
      votes: item.votes
    });
  });

  return [...grouped.entries()].map(([category, selections]) => ({
    category,
    selections,
    totalVotes: selections.reduce((sum, selection) => sum + Number(selection.votes || 0), 0)
  }));
}

function renderLogoMarkup(size = 36, fontSize = 12) {
  if (LOGO_URL) {
    return `<img src="${escapeHtml(LOGO_URL)}" alt="NACOS logo" style="width:${size}px;height:${size}px;object-fit:contain;display:block;border-radius:8px;background:#fff" />`;
  }
  return `<div style="width:${size}px;height:${size}px;border-radius:9px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.25);display:inline-flex;align-items:center;justify-content:center;font-size:${fontSize}px;font-weight:700;letter-spacing:.02em">LA</div>`;
}

function extractCart(payload) {
  const source = payload?.cart || payload?.metadata?.cart || payload?.custom_fields?.cart || [];
  if (!Array.isArray(source)) return [];
  return source.map(item => {
    const votes = Array.isArray(item.votes)
      ? item.votes.map(v => {
          if (Array.isArray(v)) {
            return { name: String(v[0] || '').trim().toUpperCase(), votes: Number(v[1]) || 0 };
          }
          if (v && typeof v === 'object') {
            return {
              name: normalizeName(v.name || v.nominee || v.nomineeName),
              votes: Number(v.votes ?? v.count ?? 0) || 0
            };
          }
          return { name: '', votes: 0 };
        }).filter(v => v.name && v.votes > 0)
      : [];

    return {
      categoryId: Number(item.categoryId || item.category_id || 0),
      category: String(item.category || '').trim(),
      votes
    };
  }).filter(item => item.categoryId && item.votes.length);
}

function getVerifiedPayloadShape(payload) {
  const data = payload?.data || payload || {};
  const transactionRef = data.transaction_ref || data.transaction_reference || payload?.transaction_ref || payload?.transaction_reference || payload?.reference;
  const email = data.email || payload?.email || payload?.customer_email || payload?.customer?.email || payload?.metadata?.email || payload?.custom_fields?.email;
  const amount = Number(data.transaction_amount ?? data.amount ?? payload?.amount ?? payload?.transaction_amount ?? 0);
  const customerName = data.customer_name || payload?.customer_name || payload?.name || payload?.customer?.name || payload?.metadata?.customer_name;
  const metadata = data.metadata || data.custom_fields || payload?.metadata || payload?.custom_fields || {};

  return {
    transactionRef,
    email,
    amount,
    customerName,
    metadata,
    raw: payload
  };
}

function verifyWebhookSignature(rawBody, headers) {
  const secret = SQUAD_SECRET_KEY;
  if (!secret) return false;
  const signatureHeader = headers['x-squad-signature'] || headers['x-squad-encrypted-body'];
  if (!signatureHeader) return false;
  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex').toUpperCase();
  const provided = String(signatureHeader).trim().toUpperCase();
  if (hash.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'utf8'), Buffer.from(provided, 'utf8'));
}

async function verifyWithSquad(reference) {
  if (!SQUAD_SECRET_KEY) {
    throw new Error('Missing SQUAD_SECRET_KEY');
  }

  const response = await fetch(`${SQUAD_VERIFY_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: {
      Authorization: `Bearer ${SQUAD_SECRET_KEY}`,
      Accept: 'application/json'
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.message || `Squad verification failed with status ${response.status}`;
    throw new Error(message);
  }

  const transactionStatus = String(data?.data?.transaction_status || '').toLowerCase();
  if (transactionStatus !== 'success') {
    throw new Error(`Transaction not successful: ${data?.data?.transaction_status || 'unknown'}`);
  }

  return data;
}

function sendReceiptEmail({ email, transactionRef, customerName, amount, items }) {
  return Promise.resolve(false);
  }

function recordVerifiedPayment({ transactionRef, email, amount, customerName, cart, rawPayload }) {
  if (!transactionRef) {
    throw new Error('Transaction reference is required');
  }
  if (!email) {
    throw new Error('Verified transaction did not include an email address');
  }
  if (!Array.isArray(cart) || !cart.length) {
    throw new Error('No vote selections were supplied with this payment');
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedCustomerName = String(customerName || '').trim() || null;
  const expectedAmount = cart.reduce((sum, item) => {
    const category = statements.findCategoryById.get(item.categoryId);
    if (!category) {
      throw new Error(`Category ${item.categoryId} no longer exists`);
    }
    return sum + (Number(category.price) || 0) * item.votes.reduce((innerSum, entry) => innerSum + entry.votes, 0);
  }, 50) * 100;

  if (Number(amount) !== expectedAmount) {
    throw new Error(`Amount mismatch. Expected ${expectedAmount}, received ${Number(amount)}`);
  }

  const tx = db.transaction(() => {
    const existingByRef = statements.findTxByReference.get(transactionRef);
    if (existingByRef) {
      return {
        duplicate: true,
        transaction: existingByRef,
        items: statements.listVoteItemsByTransaction.all(existingByRef.id)
      };
    }

    const insertResult = statements.insertTransaction.run(
      transactionRef,
      normalizedEmail,
      Number(amount),
      normalizedCustomerName,
      'confirmed',
      JSON.stringify(rawPayload || {})
    );

    const transactionId = insertResult.lastInsertRowid;
    const recordedItems = [];

    cart.forEach(item => {
      const category = statements.findCategoryById.get(item.categoryId);
      if (!category) {
        throw new Error(`Category ${item.categoryId} not found`);
      }

      item.votes.forEach(entry => {
        const nominee = statements.findNomineeByCategoryAndName.get(item.categoryId, entry.name);
        if (!nominee) {
          throw new Error(`Nominee "${entry.name}" was not found in ${category.name}`);
        }

        statements.insertVoteItem.run(transactionId, item.categoryId, entry.name, entry.votes);
        statements.updateNomineeVotes.run(entry.votes, item.categoryId, entry.name);
        recordedItems.push({
          category: category.name,
          nominee: entry.name,
          votes: entry.votes
        });
      });
    });

    return {
      duplicate: false,
      transaction: statements.findTxByReference.get(transactionRef),
      items: recordedItems
    };
  });

  return tx();
}

function parseRequestPath(requestUrl) {
  return new URL(requestUrl, `http://localhost:${PORT}`);
}

async function handlePaymentVerification(req, res, body) {
  try {
    const payload = parseJson(body);
    const reference = String(payload.reference || payload.transaction_ref || payload.transaction_reference || '').trim();
    if (!reference) {
      return sendJson(res, 400, { success: false, message: 'Transaction reference is required' });
    }

    const verification = await verifyWithSquad(reference);
    const verified = getVerifiedPayloadShape(verification);
    const cart = extractCart(verified.metadata || payload);
    const receipt = recordVerifiedPayment({
      transactionRef: verified.transactionRef || reference,
      email: verified.email,
      amount: verified.amount,
      customerName: verified.customerName,
      cart,
      rawPayload: verification
    });

    if (!receipt.duplicate) {
      await sendReceiptEmail({
        email: verified.email,
        transactionRef: verified.transactionRef || reference,
        customerName: verified.customerName,
        amount: verified.amount,
        items: receipt.items
      }).catch(error => {
        console.error('Receipt email failed:', error);
      });
    }

    return sendJson(res, 200, {
      success: true,
      message: receipt.duplicate ? 'Payment already processed' : 'Payment verified and votes recorded',
      data: {
        transactionRef: verified.transactionRef || reference,
        email: verified.email,
        duplicate: receipt.duplicate,
        categories: collectState().categories,
        stats: collectState().stats
      }
    });
  } catch (error) {
    return sendJson(res, 400, { success: false, message: error.message || 'Payment verification failed' });
  }
}

async function handleWebhook(req, res, rawBody) {
  try {
    if (!verifyWebhookSignature(rawBody, req.headers)) {
      return sendJson(res, 401, { success: false, message: 'Invalid webhook signature' });
    }

    const payload = parseJson(rawBody);
    const verified = getVerifiedPayloadShape(payload);
    const cart = extractCart(verified.metadata || payload);

    if (!verified.transactionRef) {
      return sendJson(res, 400, { success: false, message: 'Missing transaction reference' });
    }

    const receipt = recordVerifiedPayment({
      transactionRef: verified.transactionRef,
      email: verified.email,
      amount: verified.amount,
      customerName: verified.customerName,
      cart,
      rawPayload: payload
    });

    if (!receipt.duplicate) {
      await sendReceiptEmail({
        email: verified.email,
        transactionRef: verified.transactionRef,
        customerName: verified.customerName,
        amount: verified.amount,
        items: receipt.items
      }).catch(error => {
        console.error('Receipt email failed:', error);
      });
    }

    return sendJson(res, 200, { success: true, message: 'Webhook processed' });
  } catch (error) {
    return sendJson(res, 400, { success: false, message: error.message || 'Webhook processing failed' });
  }
}

function handleCategoriesApi(req, res, body) {
  const parts = parseRequestPath(req.url).pathname.split('/').filter(Boolean);
  const method = req.method || 'GET';
  const currentAdmin = getAdminFromRequest(req);

  const requireAdmin = () => {
    if (!currentAdmin) {
      sendJson(res, 401, { success: false, message: 'Admin login required' });
      return false;
    }
    return true;
  };

  if (method === 'GET' && parts.length === 2) {
    if (!currentAdmin) {
      return sendJson(res, 401, { success: false, message: 'Admin login required' });
    }
    return sendJson(res, 200, collectState());
  }

  if (method === 'POST' && parts.length === 3 && parts[2] === 'bulk-status') {
    if (!requireAdmin()) return;
    const payload = parseJson(body);
    if (typeof payload.open !== 'boolean') {
      return sendJson(res, 400, { success: false, message: 'open must be a boolean' });
    }
    const categories = statements.listCategories.all();
    const update = db.transaction(() => {
      categories.forEach(category => {
        statements.updateCategoryOpen.run(toBool(payload.open), category.id);
      });
    });
    update();
    return sendJson(res, 200, collectState());
  }

  if (method === 'POST' && parts.length === 2) {
    if (!requireAdmin()) return;
    const payload = parseJson(body);
    const name = normalizeName(payload.name);
    const price = Number(payload.price) || 0;
    if (!name) return sendJson(res, 400, { success: false, message: 'Category name is required' });

    try {
      const existing = statements.findCategoryByName.get(name);
      if (existing) return sendJson(res, 409, { success: false, message: 'Category already exists' });
      statements.insertCategory.run(name, price);
      return sendJson(res, 201, collectState());
    } catch (error) {
      return sendJson(res, 400, { success: false, message: error.message });
    }
  }

    if (parts.length === 3) {
      const categoryId = Number(parts[2]);
      if (!categoryId) return sendJson(res, 400, { success: false, message: 'Invalid category id' });

      if (method === 'PATCH') {
      if (!requireAdmin()) return;
        const payload = parseJson(body);
        const category = statements.findCategoryById.get(categoryId);
        if (!category) return sendJson(res, 404, { success: false, message: 'Category not found' });

      try {
        if (typeof payload.open === 'boolean') {
          statements.updateCategoryOpen.run(toBool(payload.open), categoryId);
        }
        if (payload.name !== undefined) {
          const name = normalizeName(payload.name);
          if (!name) return sendJson(res, 400, { success: false, message: 'Category name is required' });
          const duplicate = statements.findCategoryByName.get(name);
          if (duplicate && duplicate.id !== categoryId) {
            return sendJson(res, 409, { success: false, message: 'Category already exists' });
          }
          statements.updateCategoryName.run(name, categoryId);
        }
        if (payload.price !== undefined) {
          statements.updateCategoryPrice.run(Number(payload.price) || 0, categoryId);
        }
        return sendJson(res, 200, collectState());
      } catch (error) {
        return sendJson(res, 400, { success: false, message: error.message });
      }
      }

      if (method === 'DELETE') {
        if (!requireAdmin()) return;
        const category = statements.findCategoryById.get(categoryId);
        if (!category) return sendJson(res, 404, { success: false, message: 'Category not found' });
        statements.deleteCategory.run(categoryId);
      return sendJson(res, 200, collectState());
    }
  }

    if (parts.length === 4 && parts[3] === 'nominees') {
      const categoryId = Number(parts[2]);
      if (!categoryId) return sendJson(res, 400, { success: false, message: 'Invalid category id' });

      if (method === 'POST') {
        if (!requireAdmin()) return;
        const payload = parseJson(body);
        const name = normalizeName(payload.name);
        if (!name) return sendJson(res, 400, { success: false, message: 'Nominee name is required' });

      const category = statements.findCategoryById.get(categoryId);
      if (!category) return sendJson(res, 404, { success: false, message: 'Category not found' });

      const existing = statements.findNomineeByCategoryAndName.get(categoryId, name);
      if (existing) return sendJson(res, 409, { success: false, message: 'Nominee already exists' });
      statements.insertNominee.run(categoryId, name);
      return sendJson(res, 201, collectState());
    }
  }

  if (parts.length === 5 && parts[3] === 'nominees') {
    const categoryId = Number(parts[2]);
    const nomineeName = normalizeName(decodeURIComponent(parts[4]));
    if (!categoryId) return sendJson(res, 400, { success: false, message: 'Invalid category id' });
      if (!nomineeName) return sendJson(res, 400, { success: false, message: 'Invalid nominee name' });

      if (method === 'DELETE') {
        if (!requireAdmin()) return;
        const category = statements.findCategoryById.get(categoryId);
        if (!category) return sendJson(res, 404, { success: false, message: 'Category not found' });
        statements.deleteNominee.run(categoryId, nomineeName);
      return sendJson(res, 200, collectState());
    }
  }

  return sendJson(res, 404, { success: false, message: 'Not found' });
}

function handleStateApi(req, res) {
  const method = req.method || 'GET';
  if (method !== 'GET') {
    return sendJson(res, 405, { success: false, message: 'Method not allowed' });
  }
  const currentAdmin = getAdminFromRequest(req);
  if (!currentAdmin) {
    return sendJson(res, 401, { success: false, message: 'Admin login required' });
  }
  return sendJson(res, 200, collectState());
}

function handleAdminApi(req, res, body) {
  const parts = parseRequestPath(req.url).pathname.split('/').filter(Boolean);
  const method = req.method || 'GET';
  const currentAdmin = getAdminFromRequest(req);
  const action = parts[2] || '';

  if (method === 'GET' && action === 'status') {
    const adminCount = statements.countAdmins.get().count;
    return sendJson(res, 200, {
      bootstrapRequired: adminCount === 0,
      authenticated: Boolean(currentAdmin),
      username: currentAdmin ? currentAdmin.username : null
    });
  }

  if (method === 'POST' && action === 'bootstrap') {
    const adminCount = statements.countAdmins.get().count;
    if (adminCount > 0) {
      return sendJson(res, 409, { success: false, message: 'Admin account already exists' });
    }

    const payload = parseJson(body);
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    if (!username || !password) {
      return sendJson(res, 400, { success: false, message: 'Username and password are required' });
    }

    const { salt, hash } = createPasswordMaterial(password);
    const created = statements.insertAdmin.run(username, salt, hash);
    issueSession(created.lastInsertRowid, res);
    return sendJson(res, 201, { success: true, message: 'Admin account created' });
  }

  if (method === 'POST' && action === 'login') {
    const payload = parseJson(body);
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    const admin = statements.findAdminByUsername.get(username);
    if (!admin) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }

    const candidate = hashPassword(password, admin.password_salt);
    if (candidate !== admin.password_hash) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }

    issueSession(admin.id, res);
    return sendJson(res, 200, { success: true, message: 'Logged in' });
  }

  if (method === 'POST' && action === 'logout') {
    const cookies = parseCookies(req);
    if (cookies.admin_session) {
      statements.deleteSession.run(cookies.admin_session);
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { success: true, message: 'Logged out' });
  }

  if (method === 'POST' && action === 'change-credentials') {
    if (!currentAdmin) {
      return sendJson(res, 401, { success: false, message: 'Admin login required' });
    }

    const payload = parseJson(body);
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    if (!username || !password) {
      return sendJson(res, 400, { success: false, message: 'Username and password are required' });
    }

    const duplicate = statements.findAdminByUsername.get(username);
    if (duplicate && duplicate.id !== currentAdmin.id) {
      return sendJson(res, 409, { success: false, message: 'Username already exists' });
    }

    const { salt, hash } = createPasswordMaterial(password);
    statements.updateAdminCredentials.run(username, salt, hash, currentAdmin.id);
    return sendJson(res, 200, { success: true, message: 'Credentials updated' });
  }

  return sendJson(res, 404, { success: false, message: 'Not found' });
}

function handleConfigApi(req, res) {
  if ((req.method || 'GET') !== 'GET') {
    return sendJson(res, 405, { success: false, message: 'Method not allowed' });
  }
  return sendJson(res, 200, {
    squadPublicKey: PUBLIC_SQUAD_KEY,
    squadEnv: SQUAD_ENV,
    paymentVerificationEnabled: Boolean(SQUAD_SECRET_KEY),
    logoUrl: LOGO_URL
  });
}

async function serveIndex(res) {
  const html = await fsp.readFile(INDEX_PATH, 'utf8');
  sendText(res, 200, html, 'text/html; charset=utf-8');
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = parseRequestPath(req.url || '/');
    const pathname = requestUrl.pathname;

    if (pathname === '/api') {
      return sendJson(res, 200, buildHealthPayload());
    }

    if (pathname === '/api/config') {
      return await handleConfigApi(req, res);
    }

    if (pathname.startsWith('/api/admin')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
      return await handleAdminApi(req, res, body);
    }

    if (pathname === '/api/state') {
      return await handleStateApi(req, res);
    }

    if (pathname.startsWith('/api/categories')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
      return await handleCategoriesApi(req, res, body);
    }

    if (pathname === '/api/payments/verify' && req.method === 'POST') {
      const body = await readBody(req);
      return await handlePaymentVerification(req, res, body);
    }

    if (pathname === '/api/webhooks/squad' && req.method === 'POST') {
      const body = await readBody(req);
      return await handleWebhook(req, res, body);
    }

    if (pathname === '/' || pathname === '/index.html') {
      return await serveIndex(res);
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: error.message || 'Internal server error' }));
      return;
    }

    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`E-voting server running on http://localhost:${PORT}`);
});
