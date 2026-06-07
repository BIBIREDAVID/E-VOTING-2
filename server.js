const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// ── Firebase Admin ──────────────────────────────────────────────────────────
const admin = require('firebase-admin');

if (!admin.apps.length) {
  let credential;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    const sa = JSON.parse(serviceAccountJson);
    credential = admin.credential.cert(sa);
  } else {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    });
  }
  admin.initializeApp({ credential });
}

const db = admin.firestore();

// ── Constants ────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, 'index.html');
const PUBLIC_SQUAD_KEY = process.env.SQUAD_PUBLIC_KEY || '';
const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY || '';
const SQUAD_ENV = (process.env.SQUAD_ENV || 'sandbox').toLowerCase();
const LOGO_URL = process.env.LOGO_URL || '';
const SQUAD_VERIFY_BASE =
  process.env.SQUAD_VERIFY_BASE ||
  (SQUAD_ENV === 'live'
    ? 'https://api-d.squadco.com'
    : 'https://sandbox-api-d.squadco.com');

// ── Helpers ──────────────────────────────────────────────────────────────────
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function normalizeName(value) {
  return String(value || '').trim().toUpperCase();
}

function parseJson(rawBody) {
  if (!rawBody) return {};
  try { return JSON.parse(rawBody); } catch { return {}; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseRequestPath(requestUrl) {
  return new URL(requestUrl, `http://localhost:${PORT}`);
}

function parseCookies(request) {
  const header = request.headers.cookie || '';
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    return acc;
  }, {});
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), 120000, 64, 'sha512').toString('hex');
}

function createPasswordMaterial(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

// ── Firestore collections ────────────────────────────────────────────────────
const COL = {
  categories: 'categories',
  nominees: 'nominees',       // subcollection of categories
  transactions: 'transactions',
  voteItems: 'voteItems',     // subcollection of transactions
  admins: 'admins',
  sessions: 'sessions',
};

// ── State collector ──────────────────────────────────────────────────────────
async function collectState() {
  const catsSnap = await db.collection(COL.categories).orderBy('createdAt', 'asc').get();

  const categories = await Promise.all(
    catsSnap.docs.map(async doc => {
      const data = doc.data();
      const nomsSnap = await db
        .collection(COL.categories)
        .doc(doc.id)
        .collection(COL.nominees)
        .orderBy('createdAt', 'asc')
        .get();
      const nominees = nomsSnap.docs.map(n => ({
        id: n.id,
        name: n.data().name,
        votes: n.data().votes || 0,
      }));
      return {
        id: doc.id,
        name: data.name,
        price: data.price || 0,
        open: Boolean(data.open),
        nominees,
      };
    })
  );

  const voteRecords = {};
  categories.forEach(cat => {
    voteRecords[cat.name] = {};
    cat.nominees.forEach(n => { voteRecords[cat.name][n.name] = n.votes; });
  });

  return {
    categories: categories.map(cat => ({
      id: cat.id,
      name: cat.name,
      price: cat.price,
      open: cat.open,
      nominees: cat.nominees.map(n => n.name),
    })),
    voteRecords,
    stats: {
      categories: categories.length,
      nominees: categories.reduce((s, c) => s + c.nominees.length, 0),
      votes: categories.reduce(
        (s, c) => s + c.nominees.reduce((ss, n) => ss + n.votes, 0),
        0
      ),
      openPolls: categories.filter(c => c.open).length,
    },
  };
}

// ── Admin seed ───────────────────────────────────────────────────────────────
async function seedAdminIfMissing() {
  const seedUsername = String(process.env.ADMIN_SEED_USERNAME || 'admin').trim();
  const seedPassword = String(process.env.ADMIN_SEED_PASSWORD || 'admin@1234');

  const snap = await db.collection(COL.admins).limit(1).get();
  if (!snap.empty) return; // already have at least one admin

  const { salt, hash } = createPasswordMaterial(seedPassword);
  await db.collection(COL.admins).add({
    username: seedUsername,
    passwordSalt: salt,
    passwordHash: hash,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`Seeded first admin account: ${seedUsername}`);
}

// ── Session helpers ───────────────────────────────────────────────────────────
function setSessionCookie(response, token) {
  response.setHeader(
    'Set-Cookie',
    `admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    'Set-Cookie',
    'admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'
  );
}

async function issueSession(adminId, response) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
  await db.collection(COL.sessions).doc(token).set({
    adminId,
    expiresAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  setSessionCookie(response, token);
  return token;
}

async function getAdminFromRequest(request) {
  const cookies = parseCookies(request);
  const token = cookies.admin_session;
  if (!token) return null;

  const sessionDoc = await db.collection(COL.sessions).doc(token).get();
  if (!sessionDoc.exists) return null;

  const session = sessionDoc.data();
  if (new Date(session.expiresAt) <= new Date()) {
    await db.collection(COL.sessions).doc(token).delete();
    return null;
  }

  const adminDoc = await db.collection(COL.admins).doc(session.adminId).get();
  if (!adminDoc.exists) return null;

  return { id: session.adminId, username: adminDoc.data().username, token };
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function handleStateApi(req, res) {
  if ((req.method || 'GET') !== 'GET')
    return sendJson(res, 405, { success: false, message: 'Method not allowed' });
  const currentAdmin = await getAdminFromRequest(req);
  if (!currentAdmin)
    return sendJson(res, 401, { success: false, message: 'Admin login required' });
  return sendJson(res, 200, await collectState());
}

async function handlePublicStateApi(req, res) {
  if ((req.method || 'GET') !== 'GET')
    return sendJson(res, 405, { success: false, message: 'Method not allowed' });
  const state = await collectState();
 return sendJson(res, 200, {
  categories: state.categories.map(cat => ({
    id: cat.id,
    name: cat.name,
    price: cat.price,
    open: cat.open,
    nominees: cat.nominees,
    nomineeCount: cat.nominees.length,
  })),
});
}

async function handleConfigApi(req, res) {
  if ((req.method || 'GET') !== 'GET')
    return sendJson(res, 405, { success: false, message: 'Method not allowed' });
  return sendJson(res, 200, {
    squadPublicKey: PUBLIC_SQUAD_KEY,
    squadEnv: SQUAD_ENV,
    paymentVerificationEnabled: Boolean(SQUAD_SECRET_KEY),
    logoUrl: LOGO_URL,
  });
}

async function handleCategoriesApi(req, res, body) {
  const parts = parseRequestPath(req.url).pathname.split('/').filter(Boolean);
  const method = req.method || 'GET';
  const currentAdmin = await getAdminFromRequest(req);

  const requireAdmin = () => {
    if (!currentAdmin) {
      sendJson(res, 401, { success: false, message: 'Admin login required' });
      return false;
    }
    return true;
  };

  // GET /api/categories
  if (method === 'GET' && parts.length === 2) {
    if (!requireAdmin()) return;
    return sendJson(res, 200, await collectState());
  }

  // POST /api/categories/bulk-status
  if (method === 'POST' && parts.length === 3 && parts[2] === 'bulk-status') {
    if (!requireAdmin()) return;
    const payload = parseJson(body);
    if (typeof payload.open !== 'boolean')
      return sendJson(res, 400, { success: false, message: 'open must be a boolean' });
    const catsSnap = await db.collection(COL.categories).get();
    const batch = db.batch();
    catsSnap.docs.forEach(doc =>
      batch.update(doc.ref, { open: payload.open, updatedAt: admin.firestore.FieldValue.serverTimestamp() })
    );
    await batch.commit();
    return sendJson(res, 200, await collectState());
  }

  // POST /api/categories
  if (method === 'POST' && parts.length === 2) {
    if (!requireAdmin()) return;
    const payload = parseJson(body);
    const name = normalizeName(payload.name);
    const price = Number(payload.price) || 0;
    if (!name) return sendJson(res, 400, { success: false, message: 'Category name is required' });

    const existing = await db.collection(COL.categories).where('name', '==', name).limit(1).get();
    if (!existing.empty) return sendJson(res, 409, { success: false, message: 'Category already exists' });

    await db.collection(COL.categories).add({
      name,
      price,
      open: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return sendJson(res, 201, await collectState());
  }

  // /api/categories/:id
  if (parts.length >= 3) {
    const categoryId = parts[2];
    if (!categoryId) return sendJson(res, 400, { success: false, message: 'Invalid category id' });
    const catRef = db.collection(COL.categories).doc(categoryId);

    // PATCH /api/categories/:id
    if (method === 'PATCH' && parts.length === 3) {
      if (!requireAdmin()) return;
      const catDoc = await catRef.get();
      if (!catDoc.exists) return sendJson(res, 404, { success: false, message: 'Category not found' });

      const payload = parseJson(body);
      const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

      if (typeof payload.open === 'boolean') updates.open = payload.open;
      if (payload.name !== undefined) {
        const name = normalizeName(payload.name);
        if (!name) return sendJson(res, 400, { success: false, message: 'Category name is required' });
        const dup = await db.collection(COL.categories).where('name', '==', name).limit(1).get();
        if (!dup.empty && dup.docs[0].id !== categoryId)
          return sendJson(res, 409, { success: false, message: 'Category already exists' });
        updates.name = name;
      }
      if (payload.price !== undefined) updates.price = Number(payload.price) || 0;

      await catRef.update(updates);
      return sendJson(res, 200, await collectState());
    }

    // DELETE /api/categories/:id
    if (method === 'DELETE' && parts.length === 3) {
      if (!requireAdmin()) return;
      const catDoc = await catRef.get();
      if (!catDoc.exists) return sendJson(res, 404, { success: false, message: 'Category not found' });

      // Delete all nominees subcollection
      const nomsSnap = await catRef.collection(COL.nominees).get();
      const batch = db.batch();
      nomsSnap.docs.forEach(d => batch.delete(d.ref));
      batch.delete(catRef);
      await batch.commit();
      return sendJson(res, 200, await collectState());
    }

    // POST /api/categories/:id/nominees
    if (method === 'POST' && parts.length === 4 && parts[3] === 'nominees') {
      if (!requireAdmin()) return;
      const catDoc = await catRef.get();
      if (!catDoc.exists) return sendJson(res, 404, { success: false, message: 'Category not found' });

      const payload = parseJson(body);
      const name = normalizeName(payload.name);
      if (!name) return sendJson(res, 400, { success: false, message: 'Nominee name is required' });

      const nomsRef = catRef.collection(COL.nominees);
      const existing = await nomsRef.where('name', '==', name).limit(1).get();
      if (!existing.empty) return sendJson(res, 409, { success: false, message: 'Nominee already exists' });

      await nomsRef.add({
        name,
        votes: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return sendJson(res, 201, await collectState());
    }

    // DELETE /api/categories/:id/nominees/:name
    if (method === 'DELETE' && parts.length === 5 && parts[3] === 'nominees') {
      if (!requireAdmin()) return;
      const catDoc = await catRef.get();
      if (!catDoc.exists) return sendJson(res, 404, { success: false, message: 'Category not found' });

      const nomineeName = normalizeName(decodeURIComponent(parts[4]));
      const nomsSnap = await catRef
        .collection(COL.nominees)
        .where('name', '==', nomineeName)
        .limit(1)
        .get();
      if (!nomsSnap.empty) await nomsSnap.docs[0].ref.delete();
      return sendJson(res, 200, await collectState());
    }
  }

  return sendJson(res, 404, { success: false, message: 'Not found' });
}

async function handleAdminApi(req, res, body) {
  const parts = parseRequestPath(req.url).pathname.split('/').filter(Boolean);
  const method = req.method || 'GET';
  const action = parts[2] || '';
  const currentAdmin = await getAdminFromRequest(req);

  const parseCredentials = () => {
    const payload = parseJson(body);
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    if (!username || !password) return { error: 'Username and password are required' };
    return { username, password };
  };

  // GET /api/admin/status
  if (method === 'GET' && action === 'status') {
    const snap = await db.collection(COL.admins).limit(1).get();
    return sendJson(res, 200, {
      bootstrapRequired: snap.empty,
      authenticated: Boolean(currentAdmin),
      username: currentAdmin ? currentAdmin.username : null,
    });
  }

  // POST /api/admin/login
  if (method === 'POST' && action === 'login') {
    const payload = parseJson(body);
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    const snap = await db
      .collection(COL.admins)
      .where('username', '==', username)
      .limit(1)
      .get();
    if (snap.empty) return sendJson(res, 401, { success: false, message: 'Invalid credentials' });

    const adminDoc = snap.docs[0];
    const data = adminDoc.data();
    const candidate = hashPassword(password, data.passwordSalt);
    if (candidate !== data.passwordHash)
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });

    await issueSession(adminDoc.id, res);
    return sendJson(res, 200, { success: true, message: 'Logged in' });
  }

  // POST /api/admin/logout
  if (method === 'POST' && action === 'logout') {
    const cookies = parseCookies(req);
    if (cookies.admin_session) {
      await db.collection(COL.sessions).doc(cookies.admin_session).delete().catch(() => {});
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { success: true, message: 'Logged out' });
  }

  // POST /api/admin/create-account
  if (method === 'POST' && action === 'create-account') {
    const creds = parseCredentials();
    if (creds.error) return sendJson(res, 400, { success: false, message: creds.error });

    const dup = await db.collection(COL.admins).where('username', '==', creds.username).limit(1).get();
    if (!dup.empty) return sendJson(res, 409, { success: false, message: 'Username already exists' });

    const { salt, hash } = createPasswordMaterial(creds.password);
    const created = await db.collection(COL.admins).add({
      username: creds.username,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await issueSession(created.id, res);
    return sendJson(res, 201, { success: true, message: 'Admin account created' });
  }

  // POST /api/admin/reset
  if (method === 'POST' && action === 'reset') {
    const creds = parseCredentials();
    if (creds.error) return sendJson(res, 400, { success: false, message: creds.error });

    const { salt, hash } = createPasswordMaterial(creds.password);
    const allAdmins = await db.collection(COL.admins).orderBy('createdAt', 'asc').limit(1).get();

    if (allAdmins.empty) {
      const created = await db.collection(COL.admins).add({
        username: creds.username,
        passwordSalt: salt,
        passwordHash: hash,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await issueSession(created.id, res);
      return sendJson(res, 201, { success: true, message: 'Admin account created' });
    }

    const firstAdmin = allAdmins.docs[0];
    const dup = await db.collection(COL.admins).where('username', '==', creds.username).limit(1).get();
    if (!dup.empty && dup.docs[0].id !== firstAdmin.id)
      return sendJson(res, 409, { success: false, message: 'Username already exists' });

    await firstAdmin.ref.update({
      username: creds.username,
      passwordSalt: salt,
      passwordHash: hash,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await issueSession(firstAdmin.id, res);
    return sendJson(res, 200, { success: true, message: 'Admin account reset' });
  }

  // POST /api/admin/change-credentials
  if (method === 'POST' && action === 'change-credentials') {
    if (!currentAdmin) return sendJson(res, 401, { success: false, message: 'Admin login required' });

    const payload = parseJson(body);
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    if (!username || !password)
      return sendJson(res, 400, { success: false, message: 'Username and password are required' });

    const dup = await db.collection(COL.admins).where('username', '==', username).limit(1).get();
    if (!dup.empty && dup.docs[0].id !== currentAdmin.id)
      return sendJson(res, 409, { success: false, message: 'Username already exists' });

    const { salt, hash } = createPasswordMaterial(password);
    await db.collection(COL.admins).doc(currentAdmin.id).update({
      username,
      passwordSalt: salt,
      passwordHash: hash,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return sendJson(res, 200, { success: true, message: 'Credentials updated' });
  }

  return sendJson(res, 404, { success: false, message: 'Not found' });
}

// ── Payment ───────────────────────────────────────────────────────────────────
function verifyWebhookSignature(rawBody, headers) {
  if (!SQUAD_SECRET_KEY) return false;
  const sig = headers['x-squad-signature'] || headers['x-squad-encrypted-body'];
  if (!sig) return false;
  const hash = crypto.createHmac('sha512', SQUAD_SECRET_KEY).update(rawBody).digest('hex').toUpperCase();
  const provided = String(sig).trim().toUpperCase();
  if (hash.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'utf8'), Buffer.from(provided, 'utf8'));
}

async function verifyWithSquad(reference) {
  if (!SQUAD_SECRET_KEY) throw new Error('Missing SQUAD_SECRET_KEY');
  const res = await fetch(
    `${SQUAD_VERIFY_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${SQUAD_SECRET_KEY}`,
        Accept: 'application/json',
      },
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Squad verification failed: ${res.status}`);
  if (String(data?.data?.transaction_status || '').toLowerCase() !== 'success')
    throw new Error(`Transaction not successful: ${data?.data?.transaction_status || 'unknown'}`);
  return data;
}

function extractCart(payload) {
  const source = payload?.cart || payload?.metadata?.cart || payload?.custom_fields?.cart || [];
  if (!Array.isArray(source)) return [];
  return source
    .map(item => {
      const votes = Array.isArray(item.votes)
        ? item.votes
            .map(v => {
              if (Array.isArray(v)) return { name: String(v[0] || '').trim().toUpperCase(), votes: Number(v[1]) || 0 };
              if (v && typeof v === 'object') return { name: normalizeName(v.name || v.nominee || ''), votes: Number(v.votes ?? v.count ?? 0) || 0 };
              return { name: '', votes: 0 };
            })
            .filter(v => v.name && v.votes > 0)
        : [];
      return {
        categoryId: String(item.categoryId || item.category_id || ''),
        category: String(item.category || '').trim(),
        votes,
      };
    })
    .filter(item => item.categoryId && item.votes.length);
}

function getVerifiedPayloadShape(payload) {
  const data = payload?.data || payload || {};
  return {
    transactionRef: data.transaction_ref || data.transaction_reference || payload?.transaction_ref || payload?.reference,
    email: data.email || payload?.email || payload?.customer?.email || payload?.metadata?.email,
    amount: Number(data.transaction_amount ?? data.amount ?? payload?.amount ?? 0),
    customerName: data.customer_name || payload?.customer_name || payload?.customer?.name,
    metadata: data.metadata || data.custom_fields || payload?.metadata || payload?.custom_fields || {},
    raw: payload,
  };
}

async function recordVerifiedPayment({ transactionRef, email, amount, customerName, cart, rawPayload }) {
  if (!transactionRef) throw new Error('Transaction reference is required');
  if (!email) throw new Error('No email in verified transaction');
  if (!Array.isArray(cart) || !cart.length) throw new Error('No vote selections supplied');

  // Recalculate expected amount from DB prices
  let expectedKobo = 50 * 100; // platform fee in kobo
  for (const item of cart) {
  const catDoc = await db.collection(COL.categories).doc(item.categoryId).get();
  if (!catDoc.exists) throw new Error(`Category ${item.categoryId} not found`);
  const totalVotes = item.votes.reduce((sum, v) => sum + v.votes, 0);
  expectedKobo += (Number(catDoc.data().price) || 0) * totalVotes * 100;
}
  if (Number(amount) !== expectedKobo) {
    throw new Error(`Amount mismatch. Expected ₦${expectedKobo/100}, received ₦${Number(amount)/100}`);
}

  // Check duplicate
  const existingSnap = await db.collection(COL.transactions).where('reference', '==', transactionRef).limit(1).get();
  if (!existingSnap.empty) {
    const txId = existingSnap.docs[0].id;
    const itemsSnap = await db.collection(COL.transactions).doc(txId).collection(COL.voteItems).get();
    return { duplicate: true, items: itemsSnap.docs.map(d => d.data()) };
  }

  // Write transaction + vote items + update nominee vote counts in a batch
  const txRef = await db.collection(COL.transactions).add({
    reference: transactionRef,
    email: email.trim().toLowerCase(),
    amount: Number(amount),
    customerName: String(customerName || '').trim() || null,
    status: 'confirmed',
    rawPayload: JSON.stringify(rawPayload || {}),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const batch = db.batch();
  const recordedItems = [];

  for (const item of cart) {
    const catRef = db.collection(COL.categories).doc(item.categoryId);
    const catDoc = await catRef.get();
    if (!catDoc.exists) throw new Error(`Category ${item.categoryId} not found`);

    for (const entry of item.votes) {
      const nomsSnap = await catRef
        .collection(COL.nominees)
        .where('name', '==', entry.name)
        .limit(1)
        .get();
      if (nomsSnap.empty) throw new Error(`Nominee "${entry.name}" not found in ${catDoc.data().name}`);

      const nomRef = nomsSnap.docs[0].ref;
      batch.update(nomRef, { votes: admin.firestore.FieldValue.increment(entry.votes), updatedAt: admin.firestore.FieldValue.serverTimestamp() });

      const voteItemRef = db.collection(COL.transactions).doc(txRef.id).collection(COL.voteItems).doc();
      batch.set(voteItemRef, {
        category: catDoc.data().name,
        categoryId: item.categoryId,
        nominee: entry.name,
        votes: entry.votes,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      recordedItems.push({ category: catDoc.data().name, nominee: entry.name, votes: entry.votes });
    }
  }

  await batch.commit();
  return { duplicate: false, items: recordedItems };
}

async function handlePaymentVerification(req, res, body) {
  try {
    const payload = parseJson(body);
    const reference = String(payload.reference || payload.transaction_ref || '').trim();
    if (!reference) return sendJson(res, 400, { success: false, message: 'Transaction reference is required' });

    const verification = await verifyWithSquad(reference);
    const verified = getVerifiedPayloadShape(verification);
    const cart = extractCart(verified.metadata || payload);
    const receipt = await recordVerifiedPayment({
      transactionRef: verified.transactionRef || reference,
      email: verified.email,
      amount: verified.amount,
      customerName: verified.customerName,
      cart,
      rawPayload: verification,
    });

    return sendJson(res, 200, {
      success: true,
      message: receipt.duplicate ? 'Payment already processed' : 'Payment verified and votes recorded',
    data: { transactionRef: verified.transactionRef || reference, duplicate: receipt.duplicate, items: receipt.items },    });
  } catch (error) {
    return sendJson(res, 400, { success: false, message: error.message || 'Payment verification failed' });
  }
}

async function handleWebhook(req, res, rawBody) {
  try {
    if (!verifyWebhookSignature(rawBody, req.headers))
      return sendJson(res, 401, { success: false, message: 'Invalid webhook signature' });

    const payload = parseJson(rawBody);
    console.log('WEBHOOK PAYLOAD:', JSON.stringify(payload));
    const verified = getVerifiedPayloadShape(payload);
    const cart = extractCart(verified.metadata || payload);
    if (!verified.transactionRef) return sendJson(res, 400, { success: false, message: 'Missing transaction reference' });

    await recordVerifiedPayment({
      transactionRef: verified.transactionRef,
      email: verified.email,
      amount: verified.amount,
      customerName: verified.customerName,
      cart,
      rawPayload: payload,
    });
    return sendJson(res, 200, { success: true, message: 'Webhook processed' });
  } catch (error) {
    return sendJson(res, 400, { success: false, message: error.message || 'Webhook processing failed' });
  }
}

// ── Bootstrap & Server ────────────────────────────────────────────────────────
seedAdminIfMissing().catch(err => console.error('seedAdminIfMissing error:', err));

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = parseRequestPath(req.url || '/');
    const pathname = requestUrl.pathname;

    if (pathname === '/api') {
      return sendJson(res, 200, { ok: true, squadConfigured: Boolean(PUBLIC_SQUAD_KEY) });
    }
    if (pathname === '/api/config') return handleConfigApi(req, res);
    if (pathname === '/api/state') return handleStateApi(req, res);
    if (pathname === '/api/public-state') return handlePublicStateApi(req, res);

    if (pathname.startsWith('/api/admin')) {
      const body = req.method === 'GET' ? '' : await readBody(req);
      return handleAdminApi(req, res, body);
    }
    if (pathname.startsWith('/api/categories')) {
      const body = req.method === 'GET' ? '' : await readBody(req);
      return handleCategoriesApi(req, res, body);
    }
    if (pathname === '/api/payments/verify' && req.method === 'POST') {
      return handlePaymentVerification(req, res, await readBody(req));
    }
    if (pathname === '/api/webhooks/squad' && req.method === 'POST') {
      return handleWebhook(req, res, await readBody(req));
    }

    if (pathname === '/' || pathname === '/index.html') {
      const html = await fsp.readFile(INDEX_PATH, 'utf8');
      return sendText(res, 200, html, 'text/html; charset=utf-8');
    }

    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    console.error('Request error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: error.message || 'Internal server error' }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`E-voting server running on http://localhost:${PORT}`);
});