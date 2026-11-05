// Where the browser test's pieces listen, each on a port of its own so the
// test runs beside `just dev`, and the token and constants key its server
// takes: test values, never real secrets.
export const stack = {
  app: "http://127.0.0.1:14173",
  server: "http://127.0.0.1:18080",
  upstream: "http://127.0.0.1:18090",
  token: "e2e-only-token-0123456789abcdef0123456789abcdef",
  // 32 bytes, as base64: "e2e-only-constants-key-012345678".
  constantsKey: "ZTJlLW9ubHktY29uc3RhbnRzLWtleS0wMTIzNDU2Nzg=",
};
