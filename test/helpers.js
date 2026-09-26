'use strict';
// Shared test helpers: a fake clamd and a cookie-keeping HTTP client.
const net = require('node:net');

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

// Speaks clamd's PING and INSTREAM commands; flags anything containing EICAR.
function startFakeClamd() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let mode = null;
      const chunks = [];
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!mode) {
          const z = buf.indexOf(0);
          if (z === -1) return;
          mode = buf.subarray(0, z).toString();
          buf = buf.subarray(z + 1);
          if (mode === 'zPING') return sock.end('PONG\0');
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            const body = Buffer.concat(chunks).toString('latin1');
            return sock.end(body.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          }
          if (buf.length < 4 + len) return;
          chunks.push(buf.subarray(4, 4 + len));
          buf = buf.subarray(4 + len);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function client(base, defaultHeaders = {}) {
  let cookie = '';
  let csrf = '';
  async function req(method, url, { form, body, headers = {} } = {}) {
    const h = { ...defaultHeaders, ...headers };
    if (cookie) h.cookie = cookie;
    let payload = body;
    if (form) {
      payload = new URLSearchParams({ _csrf: csrf, ...form });
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    const m = text.match(/name="_csrf" value="([^"]+)"/) || text.match(/name="csrf" content="([^"]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, buf, headers: res.headers };
  }
  async function enter() {
    await req('GET', '/age-check');
    await req('POST', '/age-check', { form: { confirm: 'yes' } });
  }
  async function login(loginName, password) {
    await enter();
    await req('GET', '/login');
    return req('POST', '/login', { form: { login: loginName, password } });
  }
  function multipart(fields, files = []) {
    const fd = new FormData();
    fd.set('_csrf', csrf);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    for (const [field, name, data, type] of files) fd.append(field, new Blob([data], { type }), name);
    return fd;
  }
  return { req, enter, login, multipart, get csrf() { return csrf; } };
}

module.exports = { EICAR, startFakeClamd, client };
