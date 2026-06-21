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
  nominees: 'nominees',
  transactions: 'transactions',
  voteItems: 'voteItems',
  admins: 'admins',
  sessions: 'sessions',
};

// ── Rate Limiting ────────────────────────────────────────────────────────────
async function checkRateLimit(ip, endpoint, maxRequests, windowSeconds) {
  const key = `${endpoint}_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  const windowStart = now - (windowSeconds * 1000);

  const ref = db.collection('rateLimits').doc(key);
  const doc = await ref.get();

  if (!doc.exists) {
    await ref.set({ requests: [now], endpoint, ip, updatedAt: now });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  const data = doc.data();
  const requests = (data.requests || []).filter(t => t > windowStart);

  if (requests.length >= maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  requests.push(now);
  await ref.set({ requests, endpoint, ip, updatedAt: now });
  return { allowed: true, remaining: maxRequests - requests.length };
}

async function cleanupRateLimits() {
  const cutoff = Date.now() - (3600 * 1000);
  const snap = await db.collection('rateLimits').where('updatedAt', '<', cutoff).limit(50).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  if (!snap.empty) await batch.commit();
}

async function cleanupExpiredSessions() {
  const now = new Date().toISOString();
  const snap = await db.collection(COL.sessions).where('expiresAt', '<', now).limit(50).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  if (!snap.empty) await batch.commit();
}

// ── State collector ──────────────────────────────────────────────────────────
let stateCache = null;
let stateCacheTime = 0;
const STATE_CACHE_TTL = 10000;

async function collectState() {
  const now = Date.now();
  if (stateCache && (now - stateCacheTime) < STATE_CACHE_TTL) {
    return stateCache;
  }

  const catsSnap = await db.collection(COL.categories).orderBy('createdAt', 'asc').get();
  const allNomsSnap = await db.collectionGroup(COL.nominees).orderBy('createdAt', 'asc').get();

  const nomsByCategory = {};
  allNomsSnap.docs.forEach(n => {
    const catId = n.ref.parent.parent.id;
    if (!nomsByCategory[catId]) nomsByCategory[catId] = [];
    nomsByCategory[catId].push({ id: n.id, name: n.data().name, votes: n.data().votes || 0 });
  });

  const categories = catsSnap.docs.map(doc => {
    const data = doc.data();
    return {
      id: doc.id,
      name: data.name,
      price: data.price || 0,
      open: Boolean(data.open),
      nominees: nomsByCategory[doc.id] || [],
    };
  });

  const voteRecords = {};
  categories.forEach(cat => {
    voteRecords[cat.name] = {};
    cat.nominees.forEach(n => { voteRecords[cat.name][n.name] = n.votes; });
  });

  const result = {
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
      votes: categories.reduce((s, c) => s + c.nominees.reduce((ss, n) => ss + n.votes, 0), 0),
      openPolls: categories.filter(c => c.open).length,
    },
  };

  stateCache = result;
  stateCacheTime = now;
  return result;
}

function invalidateStateCache() { stateCache = null; }

// ── Admin seed ───────────────────────────────────────────────────────────────
async function seedAdminIfMissing() {
  const seedUsername = String(process.env.ADMIN_SEED_USERNAME || 'admin').trim();
  const seedPassword = String(process.env.ADMIN_SEED_PASSWORD || 'admin@1234');

  const snap = await db.collection(COL.admins).limit(1).get();
  if (!snap.empty) return;

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

// ── Activity logging ─────────────────────────────────────────────────────────
async function logAdminActivity(adminId, username, action, details, req) {
  try {
    await db.collection('adminLogs').add({
      adminId,
      username,
      action,
      details: details || {},
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('logAdminActivity error:', e);
  }
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

  if (method === 'GET' && parts.length === 2) {
    if (!requireAdmin()) return;
    return sendJson(res, 200, await collectState());
  }

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
    await logAdminActivity(currentAdmin.id, currentAdmin.username, payload.open ? 'OPEN_ALL_CATEGORIES' : 'CLOSE_ALL_CATEGORIES', {}, req);
    return sendJson(res, 200, await collectState());
  }

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
    await logAdminActivity(currentAdmin.id, currentAdmin.username, 'ADD_CATEGORY', { name, price }, req);
    return sendJson(res, 201, await collectState());
  }

  if (parts.length >= 3) {
    const categoryId = parts[2];
    if (!categoryId) return sendJson(res, 400, { success: false, message: 'Invalid category id' });
    const catRef = db.collection(COL.categories).doc(categoryId);

    if (method === 'PATCH' && parts.length === 3) {
      if (!requireAdmin()) return;
      const catDoc = await catRef.get();
      if (!catDoc.exists) return sendJson(res, 404, { success: false, message: 'Category not found' });

      const payload = parseJson(body);
      const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      const logDetails = { categoryId, name: catDoc.data().name };
      let isOnlyStatusChange = false;

      if (typeof payload.open === 'boolean') {
        updates.open = payload.open;
        logDetails.openChanged = payload.open;
        isOnlyStatusChange = true;
      }
      if (payload.name !== undefined) {
        const name = normalizeName(payload.name);
        if (!name) return sendJson(res, 400, { success: false, message: 'Category name is required' });
        const dup = await db.collection(COL.categories).where('name', '==', name).limit(1).get();
        if (!dup.empty && dup.docs[0].id !== categoryId)
          return sendJson(res, 409, { success: false, message: 'Category already exists' });
        updates.name = name;
        logDetails.renamedTo = name;
        isOnlyStatusChange = false;
      }
      if (payload.price !== undefined) {
        updates.price = Number(payload.price) || 0;
        logDetails.newPrice = updates.price;
        isOnlyStatusChange = false;
      }

      await catRef.update(updates);

      const action = isOnlyStatusChange
        ? (payload.open ? 'OPEN_CATEGORY' : 'CLOSE_CATEGORY')
        : 'UPDATE_CATEGORY';
      await logAdminActivity(currentAdmin.id, currentAdmin.username, action, logDetails, req);

      return sendJson(res, 200, await collectState());
    }

    if (method === 'DELETE' && parts.length === 3) {
      if (!requireAdmin()) return;
      const catDoc = await catRef.get();
      if (!catDoc.exists) return sendJson(res, 404, { success: false, message: 'Category not found' });

      const nomsSnap = await catRef.collection(COL.nominees).get();
      const batch = db.batch();
      nomsSnap.docs.forEach(d => batch.delete(d.ref));
      batch.delete(catRef);
      await batch.commit();

      await logAdminActivity(currentAdmin.id, currentAdmin.username, 'DELETE_CATEGORY', { name: catDoc.data().name }, req);

      return sendJson(res, 200, await collectState());
    }

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

      await logAdminActivity(currentAdmin.id, currentAdmin.username, 'ADD_NOMINEE', { category: catDoc.data().name, nominee: name }, req);

      return sendJson(res, 201, await collectState());
    }

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

      await logAdminActivity(currentAdmin.id, currentAdmin.username, 'DELETE_NOMINEE', { category: catDoc.data().name, nominee: nomineeName }, req);

      return sendJson(res, 200, await collectState());
    }
  }

  // POST /api/categories/bulk-import
if (method === 'POST' && parts.length === 3 && parts[2] === 'bulk-import') {
  if (!requireAdmin()) return;
  const payload = parseJson(body);
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) return sendJson(res, 400, { success: false, message: 'No rows provided' });

  const results = { categoriesCreated: 0, nomineesCreated: 0, errors: [] };
  const catCache = {};

  for (const row of rows) {
    const catName = normalizeName(row.category);
    const price = Number(row.price) || 100;
    const nomName = normalizeName(row.nominee);
    if (!catName || !nomName) { results.errors.push(`Skipped invalid row: ${JSON.stringify(row)}`); continue; }

    let catRef;
    if (catCache[catName]) {
      catRef = catCache[catName];
    } else {
      const existing = await db.collection(COL.categories).where('name', '==', catName).limit(1).get();
      if (existing.empty) {
        const created = await db.collection(COL.categories).add({
          name: catName, price, open: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        catRef = created;
        results.categoriesCreated++;
      } else {
        catRef = existing.docs[0].ref;
      }
      catCache[catName] = catRef;
    }

    const nomsRef = catRef.collection(COL.nominees);
    const existingNom = await nomsRef.where('name', '==', nomName).limit(1).get();
    if (existingNom.empty) {
      await nomsRef.add({
        name: nomName, votes: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      results.nomineesCreated++;
    }
  }

  await logAdminActivity(currentAdmin.id, currentAdmin.username, 'BULK_IMPORT', results, req);
  return sendJson(res, 200, { success: true, ...results });
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

  if (method === 'GET' && action === 'status') {
    const snap = await db.collection(COL.admins).limit(1).get();
    return sendJson(res, 200, {
      bootstrapRequired: snap.empty,
      authenticated: Boolean(currentAdmin),
      username: currentAdmin ? currentAdmin.username : null,
      adminId: currentAdmin ? currentAdmin.id : null,
    });
  }

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
    await logAdminActivity(adminDoc.id, data.username, 'LOGIN', {}, req);
    return sendJson(res, 200, { success: true, message: 'Logged in' });
  }

  if (method === 'POST' && action === 'logout') {
    const cookies = parseCookies(req);
    if (cookies.admin_session) {
      await db.collection(COL.sessions).doc(cookies.admin_session).delete().catch(() => {});
    }
    if (currentAdmin) {
      await logAdminActivity(currentAdmin.id, currentAdmin.username, 'LOGOUT', {}, req);
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { success: true, message: 'Logged out' });
  }

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
    await logAdminActivity(created.id, creds.username, 'CREATE_ACCOUNT', {}, req);
    return sendJson(res, 201, { success: true, message: 'Admin account created' });
  }

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
      await logAdminActivity(created.id, creds.username, 'CREATE_ACCOUNT', {}, req);
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
    await logAdminActivity(firstAdmin.id, creds.username, 'RESET_ADMIN', {}, req);
    return sendJson(res, 200, { success: true, message: 'Admin account reset' });
  }

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

    await logAdminActivity(currentAdmin.id, currentAdmin.username, 'CHANGE_CREDENTIALS', { newUsername: username }, req);

    return sendJson(res, 200, { success: true, message: 'Credentials updated' });
  }

  if (method === 'GET' && action === 'logs') {
    if (!currentAdmin) return sendJson(res, 401, { success: false, message: 'Admin login required' });
    const snap = await db.collection('adminLogs').orderBy('createdAt', 'desc').limit(100).get();
    const logs = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        username: data.username,
        action: data.action,
        details: data.details,
        ip: data.ip,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
      };
    });
    return sendJson(res, 200, { success: true, logs });
  }

  if (method === 'GET' && action === 'list') {
    if (!currentAdmin) return sendJson(res, 401, { success: false, message: 'Admin login required' });
    const snap = await db.collection(COL.admins).orderBy('createdAt', 'asc').get();
    const admins = snap.docs.map(d => ({ id: d.id, username: d.data().username }));
    return sendJson(res, 200, { success: true, admins, currentAdminId: currentAdmin.id });
  }

  if (method === 'POST' && action === 'invite') {
    if (!currentAdmin) return sendJson(res, 401, { success: false, message: 'Admin login required' });
    const creds = parseCredentials();
    if (creds.error) return sendJson(res, 400, { success: false, message: creds.error });

    const dup = await db.collection(COL.admins).where('username', '==', creds.username).limit(1).get();
    if (!dup.empty) return sendJson(res, 409, { success: false, message: 'Username already exists' });

    const { salt, hash } = createPasswordMaterial(creds.password);
    await db.collection(COL.admins).add({
      username: creds.username,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await logAdminActivity(currentAdmin.id, currentAdmin.username, 'INVITE_ADMIN', { newUsername: creds.username }, req);
    return sendJson(res, 201, { success: true, message: 'Admin account created' });
  }

  if (method === 'DELETE' && action && !['logs', 'list', 'status'].includes(action)) {
    if (!currentAdmin) return sendJson(res, 401, { success: false, message: 'Admin login required' });
    const targetId = action;
    if (targetId === currentAdmin.id) return sendJson(res, 400, { success: false, message: 'Cannot delete your own account' });
    const targetDoc = await db.collection(COL.admins).doc(targetId).get();
    if (!targetDoc.exists) return sendJson(res, 404, { success: false, message: 'Admin not found' });
    await db.collection(COL.admins).doc(targetId).delete();
    await logAdminActivity(currentAdmin.id, currentAdmin.username, 'DELETE_ADMIN', { deletedUsername: targetDoc.data().username }, req);
    return sendJson(res, 200, { success: true, message: 'Admin removed' });
  }

  // GET /api/admin/transactions
if (method === 'GET' && action === 'transactions') {
  if (!currentAdmin) return sendJson(res, 401, { success: false, message: 'Admin login required' });
  const snap = await db.collection(COL.transactions).orderBy('createdAt', 'desc').limit(100).get();
  const txs = await Promise.all(snap.docs.map(async d => {
    const data = d.data();
    const itemsSnap = await db.collection(COL.transactions).doc(d.id).collection(COL.voteItems).get();
    const items = itemsSnap.docs.map(i => i.data());
    return {
      id: d.id,
      reference: data.reference,
      email: data.email,
      customerName: data.customerName || '',
      amount: data.amount,
      status: data.status,
      items,
      createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
    };
  }));
  return sendJson(res, 200, { success: true, transactions: txs });
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
  const url = `${SQUAD_VERIFY_BASE}/transaction/verify/${encodeURIComponent(reference)}`;
  console.log('[verifyWithSquad] Calling:', url, 'with reference:', reference);
  const res = await fetch(
    url,
    {
      headers: {
        Authorization: `Bearer ${SQUAD_SECRET_KEY}`,
        Accept: 'application/json',
      },
    }
  );
  const data = await res.json().catch(() => ({}));
  console.log('[verifyWithSquad] Squad responded with status:', res.status, 'body:', JSON.stringify(data));
  if (!res.ok) throw new Error(data?.message || `Squad verification failed: ${res.status} - ${JSON.stringify(data)}`);
  if (String(data?.data?.transaction_status || '').toLowerCase() !== 'success')
    throw new Error(`Transaction not successful: ${data?.data?.transaction_status || 'unknown'}`);
  return data;
}

function extractCart(payload) {
  let source = payload?.cart || payload?.metadata?.cart || payload?.custom_fields?.cart || [];
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch (e) { source = []; }
  }
  if (!Array.isArray(source)) return [];
  return source
    .map(item => {
      let votesRaw = item.votes;
      if (typeof votesRaw === 'string') {
        try { votesRaw = JSON.parse(votesRaw); } catch (e) { votesRaw = []; }
      }
      const votes = Array.isArray(votesRaw)
        ? votesRaw
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

  let expectedKobo = 50 * 100;
  for (const item of cart) {
    const catDoc = await db.collection(COL.categories).doc(item.categoryId).get();
    if (!catDoc.exists) throw new Error(`Category ${item.categoryId} not found`);
    const totalVotes = item.votes.reduce((sum, v) => sum + v.votes, 0);
    expectedKobo += (Number(catDoc.data().price) || 0) * totalVotes * 100;
  }
  if (Number(amount) !== expectedKobo) {
    throw new Error(`Amount mismatch. Expected ₦${expectedKobo / 100}, received ₦${Number(amount) / 100}`);
  }

  const existingSnap = await db.collection(COL.transactions).where('reference', '==', transactionRef).limit(1).get();
  if (!existingSnap.empty) {
    const txId = existingSnap.docs[0].id;
    const itemsSnap = await db.collection(COL.transactions).doc(txId).collection(COL.voteItems).get();
    return { duplicate: true, items: itemsSnap.docs.map(d => d.data()) };
  }

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
    console.log('[payments/verify] Squad verification response:', JSON.stringify(verification));

    const verified = getVerifiedPayloadShape(verification);
    console.log('[payments/verify] verified shape:', JSON.stringify(verified));

    const hasUsableMetadata = verified.metadata && Array.isArray(verified.metadata.cart) && verified.metadata.cart.length;
    const cart = extractCart(hasUsableMetadata ? verified.metadata : payload);
    console.log('[payments/verify] extracted cart:', JSON.stringify(cart), 'used source:', hasUsableMetadata ? 'squad metadata' : 'client payload');

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
      data: { transactionRef: verified.transactionRef || reference, duplicate: receipt.duplicate, items: receipt.items },
    });
  } catch (error) {
    console.error('[payments/verify] FAILED:', error.message, error.stack);
    return sendJson(res, 400, { success: false, message: error.message || 'Payment verification failed' });
  }
}

async function handleWebhook(req, res, rawBody) {
  try {
    if (!verifyWebhookSignature(rawBody, req.headers)) {
      console.error('[webhooks/squad] Invalid signature. Headers:', JSON.stringify(req.headers));
      return sendJson(res, 401, { success: false, message: 'Invalid webhook signature' });
    }

    const payload = parseJson(rawBody);
    console.log('[webhooks/squad] payload:', JSON.stringify(payload));

    const verified = getVerifiedPayloadShape(payload);
    const hasUsableMetadata = verified.metadata && Array.isArray(verified.metadata.cart) && verified.metadata.cart.length;
    const cart = extractCart(hasUsableMetadata ? verified.metadata : payload);
    console.log('[webhooks/squad] extracted cart:', JSON.stringify(cart), 'used source:', hasUsableMetadata ? 'squad metadata' : 'webhook payload');

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
    console.error('[webhooks/squad] FAILED:', error.message, error.stack);
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
      if (pathname === '/api/admin/login' && req.method === 'POST') {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const limit = await checkRateLimit(ip, 'admin_login', 5, 60);
        if (!limit.allowed) {
          return sendJson(res, 429, { success: false, message: 'Too many login attempts. Please wait 1 minute.' });
        }
      }
      const body = req.method === 'GET' ? '' : await readBody(req);
      return handleAdminApi(req, res, body);
    }

    if (pathname.startsWith('/api/categories')) {
      const body = req.method === 'GET' ? '' : await readBody(req);
      return handleCategoriesApi(req, res, body);
    }

    if (pathname === '/api/payments/verify' && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const limit = await checkRateLimit(ip, 'payment_verify', 10, 60);
      if (!limit.allowed) {
        return sendJson(res, 429, { success: false, message: 'Too many requests. Please wait a moment.' });
      }
      return handlePaymentVerification(req, res, await readBody(req));
    }

    if (pathname === '/api/webhooks/squad' && req.method === 'POST') {
      return handleWebhook(req, res, await readBody(req));
    }

    if (Math.random() < 0.01) cleanupRateLimits().catch(console.error);
  if (Math.random() < 0.01) cleanupExpiredSessions().catch(console.error);

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