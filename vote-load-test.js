import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 100,
  duration: "30s",
};

// MUST point at a STAGING deployment with LOAD_TEST_MODE=true and the
// verification bypass patch applied. Never point this at production.
const BASE_URL = "https://staging.lasuawards.com";

// Loaded once before VUs start, shared (read-only) across all VUs.
export function setup() {
  const res = http.get(`${BASE_URL}/api/public-state`);
  const body = JSON.parse(res.body);
  // Keep only open categories that actually have nominees
  const categories = body.categories.filter(
    (c) => c.open && c.nominees && c.nominees.length
  );
  return { categories };
}

export default function (data) {
  const { categories } = data;
  if (!categories.length) {
    console.error("No open categories with nominees found — aborting iteration");
    return;
  }

  const category = categories[Math.floor(Math.random() * categories.length)];
  const nominee =
    category.nominees[Math.floor(Math.random() * category.nominees.length)];

  const votes = 1; // votes being "purchased" in this test transaction
  const amountKobo = 5000 + category.price * votes * 100; // flat 5000 kobo base + price*votes*100, matches server logic

  const reference = `LOADTEST-${__VU}-${__ITER}-${Date.now()}`;

  const payload = JSON.stringify({
    reference,
    email: `loadtest_vu${__VU}_${Date.now()}@example.com`,
    amount: amountKobo,
    customerName: `Load Test VU${__VU}`,
    cart: [
      {
        categoryId: category.id,
        category: category.name,
        votes: [{ name: nominee, votes }],
      },
    ],
  });

  const res = http.post(`${BASE_URL}/api/payments/verify`, payload, {
    headers: { "Content-Type": "application/json" },
  });

  if (res.status !== 200) {
    console.log(`Status: ${res.status} | Body: ${res.body}`);
  }

  check(res, {
    "vote recorded": (r) => r.status === 200,
  });

  sleep(1);
}
