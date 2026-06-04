const crypto = require('node:crypto');
const admin = require('firebase-admin');

const PUBLIC_SQUAD_KEY = process.env.SQUAD_PUBLIC_KEY || '';
const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY || '';
const SQUAD_ENV = String(process.env.SQUAD_ENV || 'sandbox').toLowerCase();
const LOGO_URL = process.env.LOGO_URL || '';
const SQUAD_VERIFY_BASE =
  process.env.SQUAD_VERIFY_BASE ||
  (SQUAD_ENV === 'live' ? 'https://api-d.squadco.com' : 'https://sandbox-api-d.squadco.com');
const ADMIN_SEED_USERNAME = String(process.env.ADMIN_SEED_USERNAME || 'admin').trim();
const ADMIN_SEED_PASSWORD = String(process.env.ADMIN_SEED_PASSWORD || 'nacos2026');

const COLLECTIONS = {
  categories: 'categories',
  nominees: 'nominees',
  transactions: 'transactions',
  voteItems: 'vote_items',
  admins: 'admins',
  adminSessions: 'admin_sessions'
};

let firebaseReady = false;
let firestore = null;
let fieldValue = null;

function normalizeName(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeLookup(value) {
  return String(value || '').trim().toLowerCase();
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function parseJson(rawBody) {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return {};
  }
}

function toTimestamp() {
  return admin.firestore.Timestamp.fromDate(new Date());
}

function getServiceAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = String(serviceAccount.private_key).replace(/\\n/g, '\n');
    }
    return serviceAccount;
  }

  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      privateKey
    };
  }

  throw new Error('Firebase service account env vars are missing');
}

function hasFirebaseCredentials() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) return true;
  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || '').trim();
  return Boolean(projectId && clientEmail && privateKey);
}

function ensureFirebase() {
  if (firebaseReady) return;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(getServiceAccount())
    });
  }

  firestore = admin.firestore();
  fieldValue = admin.firestore.FieldValue;
  firebaseReady = true;
}

async function db() {
  ensureFirebase();
  return firestore;
}

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

function setSessionCookie(response, token) {
  const cookieParts = [`admin_session=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax'];
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    cookieParts.push('Secure');
  }
  response.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseRequestPath(req) {
  return new URL(req.url || '/', 'http://localhost');
}

function extractCart(payload) {
  const source = payload?.cart || payload?.metadata?.cart || payload?.custom_fields?.cart || [];
  if (!Array.isArray(source)) return [];

  return source
    .map(item => {
      const votes = Array.isArray(item.votes)
        ? item.votes
            .map(vote => {
              if (Array.isArray(vote)) {
                return { name: normalizeName(vote[0]), votes: Number(vote[1]) || 0 };
              }
              if (vote && typeof vote === 'object') {
                return {
                  name: normalizeName(vote.name || vote.nominee || vote.nomineeName),
                  votes: Number(vote.votes ?? vote.count ?? 0) || 0
                };
              }
              return { name: '', votes: 0 };
            })
            .filter(vote => vote.name && vote.votes > 0)
        : [];

      return {
        categoryId: String(item.categoryId || item.category_id || '').trim(),
        category: String(item.category || '').trim(),
        votes
      };
    })
    .filter(item => item.categoryId && item.votes.length);
}

function getVerifiedPayloadShape(payload) {
  const data = payload?.data || payload || {};
  const transactionRef =
    data.transaction_ref ||
    data.transaction_reference ||
    payload?.transaction_ref ||
    payload?.transaction_reference ||
    payload?.reference;
  const email =
    data.email ||
    payload?.email ||
    payload?.customer_email ||
    payload?.customer?.email ||
    payload?.metadata?.email ||
    payload?.custom_fields?.email;
  const amount = Number(data.transaction_amount ?? data.amount ?? payload?.amount ?? payload?.transaction_amount ?? 0);
  const customerName =
    data.customer_name ||
    payload?.customer_name ||
    payload?.name ||
    payload?.customer?.name ||
    payload?.metadata?.customer_name;
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
  if (!SQUAD_SECRET_KEY) return false;
  const signatureHeader = headers['x-squad-signature'] || headers['x-squad-encrypted-body'];
  if (!signatureHeader) return false;
  const hash = crypto.createHmac('sha512', SQUAD_SECRET_KEY).update(rawBody).digest('hex').toUpperCase();
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

function sendReceiptEmail() {
  return Promise.resolve(false);
}

function buildHealthPayload() {
  return {
    ok: true,
    firestoreConfigured: hasFirebaseCredentials(),
    squadConfigured: Boolean(PUBLIC_SQUAD_KEY)
  };
}

function buildEmptyState() {
  return {
    categories: [],
    voteRecords: {},
    stats: {
      categories: 0,
      nominees: 0,
      votes: 0,
      openPolls: 0
    }
  };
}

async function getAdminFromRequest(request) {
  ensureFirebase();
  const cookies = parseCookies(request);
  const token = cookies.admin_session;
  if (!token) return null;

  const sessionSnap = await firestore.collection(COLLECTIONS.adminSessions).doc(token).get();
  if (!sessionSnap.exists) return null;
  const session = sessionSnap.data();
  const expiresAt = session?.expiresAt?.toDate ? session.expiresAt.toDate() : new Date(session?.expiresAt || 0);

  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    await firestore.collection(COLLECTIONS.adminSessions).doc(token).delete().catch(() => {});
    return null;
  }

  const adminSnap = await firestore.collection(COLLECTIONS.admins).doc(String(session.adminId)).get();
  if (!adminSnap.exists) return null;

  return {
    id: adminSnap.id,
    username: adminSnap.get('username'),
    token
  };
}

async function issueSession(adminId, response) {
  ensureFirebase();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
  await firestore.collection(COLLECTIONS.adminSessions).doc(token).set({
    adminId: String(adminId),
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    createdAt: toTimestamp()
  });
  setSessionCookie(response, token);
  return token;
}

async function seedAdminIfMissing() {
  ensureFirebase();
  const adminSnap = await firestore.collection(COLLECTIONS.admins).limit(1).get();
  if (!adminSnap.empty) return;

  const { salt, hash } = createPasswordMaterial(ADMIN_SEED_PASSWORD);
  const doc = firestore.collection(COLLECTIONS.admins).doc();
  await doc.set({
    username: ADMIN_SEED_USERNAME,
    usernameLower: normalizeLookup(ADMIN_SEED_USERNAME),
    password_salt: salt,
    password_hash: hash,
    createdAt: toTimestamp(),
    updatedAt: toTimestamp()
  });
}

async function collectState() {
  ensureFirebase();
  const [categoriesSnap, nomineesSnap] = await Promise.all([
    firestore.collection(COLLECTIONS.categories).orderBy('createdAt', 'asc').get(),
    firestore.collection(COLLECTIONS.nominees).orderBy('createdAt', 'asc').get()
  ]);

  const nomineesByCategory = new Map();
  nomineesSnap.forEach(doc => {
    const data = doc.data();
    const categoryId = String(data.categoryId || '').trim();
    if (!categoryId) return;
    if (!nomineesByCategory.has(categoryId)) nomineesByCategory.set(categoryId, []);
    nomineesByCategory.get(categoryId).push({
      id: doc.id,
      name: data.name,
      votes: Number(data.votes) || 0
    });
  });

  const categories = [];
  categoriesSnap.forEach(doc => {
    const data = doc.data();
    const nominees = nomineesByCategory.get(doc.id) || [];
    categories.push({
      id: doc.id,
      name: data.name,
      price: Number(data.price) || 0,
      open: Boolean(data.open),
      nominees
    });
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
      votes: categories.reduce(
        (count, category) => count + category.nominees.reduce((inner, nominee) => inner + nominee.votes, 0),
        0
      ),
      openPolls: categories.filter(category => category.open).length
    }
  };
}

async function recordVerifiedPayment({ transactionRef, email, amount, customerName, cart, rawPayload }) {
  ensureFirebase();
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
  const categoryRefs = new Map();

  for (const item of cart) {
    const categorySnap = await firestore.collection(COLLECTIONS.categories).doc(String(item.categoryId)).get();
    if (!categorySnap.exists) {
      throw new Error(`Category ${item.categoryId} no longer exists`);
    }
    categoryRefs.set(String(item.categoryId), categorySnap.data());
  }

  const expectedAmount = cart.reduce((sum, item) => {
    const category = categoryRefs.get(String(item.categoryId));
    return (
      sum +
      (Number(category.price) || 0) *
        item.votes.reduce((innerSum, entry) => innerSum + (Number(entry.votes) || 0), 0)
    );
  }, 50) * 100;

  if (Number(amount) !== expectedAmount) {
    throw new Error(`Amount mismatch. Expected ${expectedAmount}, received ${Number(amount)}`);
  }

  const transactionRefDoc = firestore.collection(COLLECTIONS.transactions).doc(String(transactionRef));
  const result = await firestore.runTransaction(async tx => {
    const existingSnap = await tx.get(transactionRefDoc);
    if (existingSnap.exists) {
      const existingItemsSnap = await firestore
        .collection(COLLECTIONS.voteItems)
        .where('transactionRef', '==', String(transactionRef))
        .orderBy('createdAt', 'asc')
        .get();
      return {
        duplicate: true,
        transaction: { id: existingSnap.id, ...existingSnap.data() },
        items: existingItemsSnap.docs.map(doc => {
          const data = doc.data();
          return {
            category: data.category,
            nominee: data.nominee,
            votes: Number(data.votes) || 0
          };
        })
      };
    }

    const recordedItems = [];

    tx.set(transactionRefDoc, {
      reference: String(transactionRef),
      email: normalizedEmail,
      amount: Number(amount),
      customerName: normalizedCustomerName,
      status: 'confirmed',
      rawPayload: rawPayload || {},
      createdAt: toTimestamp()
    });

    for (const item of cart) {
      const categoryData = categoryRefs.get(String(item.categoryId));
      const categoryName = categoryData.name;

      for (const entry of item.votes) {
        const nomineeQuery = firestore
          .collection(COLLECTIONS.nominees)
          .where('categoryId', '==', String(item.categoryId))
          .where('nameLower', '==', normalizeLookup(entry.name))
          .limit(1);
        const nomineeQuerySnap = await tx.get(nomineeQuery);
        const nomineeDoc = nomineeQuerySnap.docs[0];
        if (!nomineeDoc) {
          throw new Error(`Nominee "${entry.name}" was not found in ${categoryName}`);
        }

        const nomineeRef = firestore.collection(COLLECTIONS.nominees).doc(nomineeDoc.id);
        const currentVotes = Number(nomineeDoc.data().votes) || 0;
        tx.update(nomineeRef, {
          votes: currentVotes + Number(entry.votes),
          updatedAt: toTimestamp()
        });

        const voteDoc = firestore.collection(COLLECTIONS.voteItems).doc();
        tx.set(voteDoc, {
          transactionRef: String(transactionRef),
          categoryId: String(item.categoryId),
          category: categoryName,
          nominee: nomineeDoc.data().name,
          votes: Number(entry.votes) || 0,
          createdAt: toTimestamp()
        });

        recordedItems.push({
          category: categoryName,
          nominee: nomineeDoc.data().name,
          votes: Number(entry.votes) || 0
        });
      }
    }

    return {
      duplicate: false,
      transaction: {
        id: String(transactionRef),
        reference: String(transactionRef),
        email: normalizedEmail,
        amount: Number(amount),
        customerName: normalizedCustomerName,
        status: 'confirmed'
      },
      items: recordedItems
    };
  });

  return result;
}

async function handleConfigApi(req, res) {
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

async function handleStateApi(req, res) {
  if ((req.method || 'GET') !== 'GET') {
    return sendJson(res, 405, { success: false, message: 'Method not allowed' });
  }

  if (!hasFirebaseCredentials()) {
    return sendJson(res, 200, buildEmptyState());
  }

  await seedAdminIfMissing().catch(() => {});
  return sendJson(res, 200, await collectState());
}

async function handleAdminApi(req, res, body, parts) {
  await seedAdminIfMissing();
  const method = req.method || 'GET';
  const action = parts[2] || '';
  const currentAdmin = await getAdminFromRequest(req);

  if (method === 'GET' && action === 'status') {
    const adminSnap = await firestore.collection(COLLECTIONS.admins).limit(1).get();
    return sendJson(res, 200, {
      bootstrapRequired: adminSnap.empty,
      authenticated: Boolean(currentAdmin),
      username: currentAdmin ? currentAdmin.username : null
    });
  }

  if (method === 'POST' && action === 'bootstrap') {
    const adminSnap = await firestore.collection(COLLECTIONS.admins).limit(1).get();
    if (!adminSnap.empty) {
      return sendJson(res, 409, { success: false, message: 'Admin account already exists' });
    }

    const payload = parseJson(body);
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    if (!username || !password) {
      return sendJson(res, 400, { success: false, message: 'Username and password are required' });
    }

    const { salt, hash } = createPasswordMaterial(password);
    const adminRef = firestore.collection(COLLECTIONS.admins).doc();
    await adminRef.set({
      username,
      usernameLower: normalizeLookup(username),
      password_salt: salt,
      password_hash: hash,
      createdAt: toTimestamp(),
      updatedAt: toTimestamp()
    });
    await issueSession(adminRef.id, res);
    return sendJson(res, 201, { success: true, message: 'Admin account created' });
  }

  if (method === 'POST' && action === 'login') {
    const payload = parseJson(body);
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    const adminSnap = await firestore
      .collection(COLLECTIONS.admins)
      .where('usernameLower', '==', normalizeLookup(username))
      .limit(1)
      .get();
    const adminDoc = adminSnap.docs[0];
    if (!adminDoc) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }

    const adminData = adminDoc.data();
    const candidate = hashPassword(password, adminData.password_salt);
    if (candidate !== adminData.password_hash) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }

    await issueSession(adminDoc.id, res);
    return sendJson(res, 200, { success: true, message: 'Logged in' });
  }

  if (method === 'POST' && action === 'logout') {
    const cookies = parseCookies(req);
    if (cookies.admin_session) {
      await firestore.collection(COLLECTIONS.adminSessions).doc(cookies.admin_session).delete().catch(() => {});
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

    const duplicateSnap = await firestore
      .collection(COLLECTIONS.admins)
      .where('usernameLower', '==', normalizeLookup(username))
      .limit(1)
      .get();
    const duplicateDoc = duplicateSnap.docs[0];
    if (duplicateDoc && duplicateDoc.id !== currentAdmin.id) {
      return sendJson(res, 409, { success: false, message: 'Username already exists' });
    }

    const { salt, hash } = createPasswordMaterial(password);
    await firestore.collection(COLLECTIONS.admins).doc(currentAdmin.id).update({
      username,
      usernameLower: normalizeLookup(username),
      password_salt: salt,
      password_hash: hash,
      updatedAt: toTimestamp()
    });
    return sendJson(res, 200, { success: true, message: 'Credentials updated' });
  }

  return sendJson(res, 404, { success: false, message: 'Not found' });
}

async function handleCategoriesApi(req, res, body, parts) {
  await seedAdminIfMissing();
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
    return sendJson(res, 200, await collectState());
  }

  if (method === 'POST' && parts.length === 3 && parts[2] === 'bulk-status') {
    if (!requireAdmin()) return;
    const payload = parseJson(body);
    if (typeof payload.open !== 'boolean') {
      return sendJson(res, 400, { success: false, message: 'open must be a boolean' });
    }

    const categoriesSnap = await firestore.collection(COLLECTIONS.categories).get();
    const batch = firestore.batch();
    categoriesSnap.docs.forEach(doc => {
      batch.update(doc.ref, { open: payload.open, updatedAt: toTimestamp() });
    });
    await batch.commit();
    return sendJson(res, 200, await collectState());
  }

  if (method === 'POST' && parts.length === 2) {
    if (!requireAdmin()) return;
    const payload = parseJson(body);
    const name = normalizeName(payload.name);
    const price = Number(payload.price) || 0;
    if (!name) return sendJson(res, 400, { success: false, message: 'Category name is required' });

    const duplicateSnap = await firestore
      .collection(COLLECTIONS.categories)
      .where('nameLower', '==', normalizeLookup(name))
      .limit(1)
      .get();
    if (!duplicateSnap.empty) {
      return sendJson(res, 409, { success: false, message: 'Category already exists' });
    }

    await firestore.collection(COLLECTIONS.categories).doc().set({
      name,
      nameLower: normalizeLookup(name),
      price,
      open: true,
      createdAt: toTimestamp(),
      updatedAt: toTimestamp()
    });
    return sendJson(res, 201, await collectState());
  }

  if (parts.length === 3) {
    const categoryId = String(parts[2]);
    if (!categoryId) return sendJson(res, 400, { success: false, message: 'Invalid category id' });

    if (method === 'PATCH') {
      if (!requireAdmin()) return;
      const payload = parseJson(body);
      const categoryRef = firestore.collection(COLLECTIONS.categories).doc(categoryId);
      const categorySnap = await categoryRef.get();
      if (!categorySnap.exists) {
        return sendJson(res, 404, { success: false, message: 'Category not found' });
      }

      const updates = { updatedAt: toTimestamp() };
      if (typeof payload.open === 'boolean') {
        updates.open = payload.open;
      }
      if (payload.name !== undefined) {
        const name = normalizeName(payload.name);
        if (!name) return sendJson(res, 400, { success: false, message: 'Category name is required' });
        const duplicateSnap = await firestore
          .collection(COLLECTIONS.categories)
          .where('nameLower', '==', normalizeLookup(name))
          .limit(1)
          .get();
        const duplicateDoc = duplicateSnap.docs[0];
        if (duplicateDoc && duplicateDoc.id !== categoryId) {
          return sendJson(res, 409, { success: false, message: 'Category already exists' });
        }
        updates.name = name;
        updates.nameLower = normalizeLookup(name);
      }
      if (payload.price !== undefined) {
        updates.price = Number(payload.price) || 0;
      }
      await categoryRef.update(updates);
      return sendJson(res, 200, await collectState());
    }

    if (method === 'DELETE') {
      if (!requireAdmin()) return;
      const categoryRef = firestore.collection(COLLECTIONS.categories).doc(categoryId);
      const categorySnap = await categoryRef.get();
      if (!categorySnap.exists) {
        return sendJson(res, 404, { success: false, message: 'Category not found' });
      }

      const nomineesSnap = await firestore
        .collection(COLLECTIONS.nominees)
        .where('categoryId', '==', categoryId)
        .get();
      const batch = firestore.batch();
      nomineesSnap.docs.forEach(doc => batch.delete(doc.ref));
      batch.delete(categoryRef);
      await batch.commit();
      return sendJson(res, 200, await collectState());
    }
  }

  if (parts.length === 4 && parts[3] === 'nominees') {
    const categoryId = String(parts[2]);
    if (!categoryId) return sendJson(res, 400, { success: false, message: 'Invalid category id' });

    if (method === 'POST') {
      if (!requireAdmin()) return;
      const payload = parseJson(body);
      const name = normalizeName(payload.name);
      if (!name) return sendJson(res, 400, { success: false, message: 'Nominee name is required' });

      const categorySnap = await firestore.collection(COLLECTIONS.categories).doc(categoryId).get();
      if (!categorySnap.exists) {
        return sendJson(res, 404, { success: false, message: 'Category not found' });
      }

      const duplicateSnap = await firestore
        .collection(COLLECTIONS.nominees)
        .where('categoryId', '==', categoryId)
        .where('nameLower', '==', normalizeLookup(name))
        .limit(1)
        .get();
      if (!duplicateSnap.empty) {
        return sendJson(res, 409, { success: false, message: 'Nominee already exists' });
      }

      await firestore.collection(COLLECTIONS.nominees).doc().set({
        categoryId,
        name,
        nameLower: normalizeLookup(name),
        votes: 0,
        createdAt: toTimestamp(),
        updatedAt: toTimestamp()
      });
      return sendJson(res, 201, await collectState());
    }
  }

  if (parts.length === 5 && parts[3] === 'nominees') {
    const categoryId = String(parts[2]);
    const nomineeName = normalizeName(safeDecodeURIComponent(parts[4]));
    if (!categoryId) return sendJson(res, 400, { success: false, message: 'Invalid category id' });
    if (!nomineeName) return sendJson(res, 400, { success: false, message: 'Invalid nominee name' });

    if (method === 'DELETE') {
      if (!requireAdmin()) return;
      const nomineeSnap = await firestore
        .collection(COLLECTIONS.nominees)
        .where('categoryId', '==', categoryId)
        .where('nameLower', '==', normalizeLookup(nomineeName))
        .limit(1)
        .get();
      const nomineeDoc = nomineeSnap.docs[0];
      if (!nomineeDoc) {
        return sendJson(res, 404, { success: false, message: 'Nominee not found' });
      }
      await nomineeDoc.ref.delete();
      return sendJson(res, 200, await collectState());
    }
  }

  return sendJson(res, 404, { success: false, message: 'Not found' });
}

async function handlePaymentVerification(req, res, body) {
  await seedAdminIfMissing();
  try {
    const payload = parseJson(body);
    const reference = String(
      payload.reference || payload.transaction_ref || payload.transaction_reference || ''
    ).trim();
    if (!reference) {
      return sendJson(res, 400, { success: false, message: 'Transaction reference is required' });
    }

    const verification = await verifyWithSquad(reference);
    const verified = getVerifiedPayloadShape(verification);
    const cart = extractCart(verified.metadata || payload);
    const receipt = await recordVerifiedPayment({
      transactionRef: verified.transactionRef || reference,
      email: verified.email,
      amount: verified.amount,
      customerName: verified.customerName,
      cart,
      rawPayload: verification
    });
    const state = await collectState();

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
        categories: state.categories,
        stats: state.stats
      }
    });
  } catch (error) {
    return sendJson(res, 400, { success: false, message: error.message || 'Payment verification failed' });
  }
}

async function handleWebhook(req, res, rawBody) {
  await seedAdminIfMissing();
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

    const receipt = await recordVerifiedPayment({
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

async function handleRequest(req, res) {
  const requestPath = parseRequestPath(req);
  const pathname = requestPath.pathname;
  const parts = pathname.split('/').filter(Boolean);

  try {
    if (pathname === '/api') {
      return sendJson(res, 200, buildHealthPayload());
    }

    if (pathname === '/api/config') {
      return await handleConfigApi(req, res);
    }

    if (pathname === '/api/state') {
      return await handleStateApi(req, res);
    }

    if (pathname.startsWith('/api/admin')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
      return await handleAdminApi(req, res, body, parts);
    }

    if (pathname.startsWith('/api/categories')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
      return await handleCategoriesApi(req, res, body, parts);
    }

    if (pathname === '/api/payments/verify' && req.method === 'POST') {
      const body = await readBody(req);
      return await handlePaymentVerification(req, res, body);
    }

    if (pathname === '/api/webhooks/squad' && req.method === 'POST') {
      const body = await readBody(req);
      return await handleWebhook(req, res, body);
    }

    if (pathname === '/favicon.ico') {
      res.statusCode = 204;
      return res.end();
    }

    return sendJson(res, 404, { success: false, message: 'Not found' });
  } catch (error) {
    return sendJson(res, 500, { success: false, message: error.message || 'Internal server error' });
  }
}

module.exports = {
  handleRequest,
  ensureFirebase,
  collectState,
  buildHealthPayload,
  seedAdminIfMissing
};
