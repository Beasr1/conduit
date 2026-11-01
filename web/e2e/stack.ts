// Where the browser test's pieces listen, each on a port of its own so the
// test runs beside `just dev`, and the token its server takes: a test value,
// never a real secret.
export const stack = {
  app: "http://127.0.0.1:14173",
  server: "http://127.0.0.1:18080",
  upstream: "http://127.0.0.1:18090",
  token: "e2e-only-token-0123456789abcdef0123456789abcdef",
};
