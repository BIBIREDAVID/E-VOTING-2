import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 50,
  duration: "30s",
};

const BASE_URL = "https://lasuawards.com";

export default function () {
  // 1. Load homepage
  let res = http.get(`${BASE_URL}/`);
  check(res, {
    "homepage loaded": (r) => r.status === 200,
  });
  sleep(1);

  // 2. Load a specific category page (update the hash/param to match your real URL)
  res = http.get(`${BASE_URL}/#categories`);
  check(res, {
    "categories page loaded": (r) => r.status === 200,
  });
  sleep(1);

  // 3. Simulate hitting the nominees endpoint (adjust path to your actual API/page)
  res = http.get(`${BASE_URL}/nominees`);
  check(res, {
    "nominees loaded": (r) => r.status === 200 || r.status === 404,
  });
  sleep(2);

  // 4. Simulate a vote submission (POST — update endpoint and payload to match your actual structure)
  const payload = JSON.stringify({
    nominee_id: "test-nominee-123",
    category_id: "best-developer",
    voter_email: `testuser_${__VU}@example.com`,
  });

  res = http.post(`${BASE_URL}/api/vote`, payload, {
    headers: { "Content-Type": "application/json" },
  });

  check(res, {
    "vote submitted or reached endpoint": (r) =>
      r.status === 200 || r.status === 201 || r.status === 400,
  });

  sleep(2);
}