import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 100,
  duration: "30s",
};

const BASE_URL = "https://lasuawards.com"; // point this at staging if you have one

export default function () {
  // 1. Homepage
  let res = http.get(`${BASE_URL}/`);
  check(res, { "homepage loaded": (r) => r.status === 200 });
  sleep(1);

  // 2. Public state (categories + nominees + open/closed status)
  res = http.get(`${BASE_URL}/api/public-state`);
  check(res, { "public-state loaded": (r) => r.status === 200 });
  sleep(1);

  // 3. Config (squad public key, env flags)
  res = http.get(`${BASE_URL}/api/config`);
  check(res, { "config loaded": (r) => r.status === 200 });
  sleep(1);
}
