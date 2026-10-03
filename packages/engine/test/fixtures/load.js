import http from 'k6/http';
const BASE = __ENV.BASE_URL;
export const options = {
  scenarios: {
    open: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      stages: [
        { target: 200, duration: '30s' },
        { duration: '1m', target: 200 },
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: { http_req_duration: ['p(99)<400'], http_req_failed: ['rate<0.01'] },
};
export default function () {
  http.get(`${BASE}/orders/${Math.floor(Math.random() * 1000)}`);
  http.get(`${BASE}/orders/${Math.floor(Math.random() * 1000)}`);
  http.post(`${BASE}/orders`, JSON.stringify({}));
}
