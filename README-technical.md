# NACOS-LASU Awards — Technical Documentation

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (SPA, no framework) |
| Backend | Node.js + HTTP module (no Express) |
| Database | Firebase Firestore |
| Auth | Cookie-based sessions (PBKDF2 password hashing) |
| Payments | Squad (GTBank/HabariPay) |
| Deployment | Vercel (serverless, `@vercel/node`) |
| Icons | Tabler Icons |
| Fonts | Inter (Google Fonts) |

---

## Project Structure

```
E-VOTING-2/
├── index.html        # Full SPA frontend
├── server.js         # Express-less Node.js backend
├── vercel.json       # Routes all requests to server.js
├── package.json
└── .gitignore
```

---

## Architecture

Single `server.js` handles all routing via `http.createServer`. No Express. Routes are matched manually via `pathname`. All Firestore operations are async/await.

### Firestore Collections

| Collection | Purpose |
|---|---|
| `categories` | Award categories (name, price, open status) |
| `categories/{id}/nominees` | Nominees per category (name, votes) |
| `transactions` | Confirmed payment records |
| `transactions/{id}/voteItems` | Individual vote line items |
| `admins` | Admin accounts (hashed passwords) |
| `sessions` | Active admin sessions (7-day expiry) |
| `rateLimits` | IP-based rate limit tracking |

---

## Environment Variables

Set these in Vercel → Settings → Environment Variables:

| Variable | Description |
|---|---|
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Service account email |
| `FIREBASE_PRIVATE_KEY` | Service account private key |
| `SQUAD_PUBLIC_KEY` | Squad public key (`pk_...`) |
| `SQUAD_SECRET_KEY` | Squad secret key (`sk_...`) |
| `SQUAD_ENV` | `live` or `sandbox` |
| `ADMIN_SEED_USERNAME` | Default admin username |
| `ADMIN_SEED_PASSWORD` | Default admin password |
| `LOGO_URL` | Direct image URL for logo |

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api` | None | Health check |
| GET | `/api/config` | None | Squad public key + env |
| GET | `/api/public-state` | None | Categories + nominees (public) |
| GET | `/api/state` | Admin | Full state with vote counts |
| GET | `/api/admin/status` | None | Auth status + bootstrap flag |
| POST | `/api/admin/login` | None | Login (rate limited: 5/min) |
| POST | `/api/admin/logout` | Admin | Logout |
| POST | `/api/admin/change-credentials` | Admin | Update username/password |
| POST | `/api/categories` | Admin | Create category |
| PATCH | `/api/categories/:id` | Admin | Update name/price/open status |
| DELETE | `/api/categories/:id` | Admin | Delete category |
| POST | `/api/categories/bulk-status` | Admin | Open/close all categories |
| POST | `/api/categories/:id/nominees` | Admin | Add nominee |
| DELETE | `/api/categories/:id/nominees/:name` | Admin | Remove nominee |
| POST | `/api/payments/verify` | None | Verify Squad payment + record votes (rate limited: 10/min) |
| POST | `/api/webhooks/squad` | Squad sig | Squad webhook handler |

---

## Payment Flow

1. User builds cart in frontend
2. Squad modal opens with amount + cart in `metadata`
3. On `onSuccess`, frontend calls `/api/payments/verify` with reference + cart
4. Server verifies with Squad API, recalculates expected amount from DB prices, records votes via Firestore batch write
5. Squad webhook at `/api/webhooks/squad` handles cases where browser closes before callback

---

## Security

- Passwords hashed with PBKDF2 (120,000 iterations, SHA-512)
- Sessions stored in Firestore with 7-day expiry
- Squad webhook verified via HMAC-SHA512 signature
- Server-side amount validation — client cart totals are never trusted
- Rate limiting on login (5 req/min) and payment verify (10 req/min) via Firestore
- All sensitive config via environment variables, never in code

---

## Local Development

```bash
git clone https://github.com/BIBIREDAVID/E-VOTING-2
cd E-VOTING-2
npm install
```

Create a `.env` file:
```
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-client-email
FIREBASE_PRIVATE_KEY="your-private-key"
SQUAD_PUBLIC_KEY=pk_...
SQUAD_SECRET_KEY=sk_...
SQUAD_ENV=sandbox
ADMIN_SEED_USERNAME=admin
ADMIN_SEED_PASSWORD=admin@1234
PORT=3000
```

```bash
node server.js
```

Visit `http://localhost:3000`

---

## Deployment

Push to `master` → Vercel auto-deploys via GitHub integration.

```bash
git add .
git commit -m "your message"
git push
```

Production URL: [nacoslasuawards.vercel.app](https://nacoslasuawards.vercel.app)

---

## Known Limitations

- Vercel serverless functions have no persistent memory — rate limiting uses Firestore which adds latency
- Squad webhook metadata depends on client correctly passing cart in `metadata` field at payment initiation
- No email receipts currently implemented (`sendReceiptEmail` is a stub)

---

*Built by [Bibiresanmi David](https://sleek-portfolio-wine.vercel.app/) · © 2026 NACOS-LASU*
