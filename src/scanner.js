'use strict';
// Minimal clamd client using the INSTREAM command over TCP. The ClamAV
// container never gets access to the upload volume; files are streamed to it.
const net = require('node:net');
const fs = require('node:fs');
const config = require('./config');

class ScannerUnavailableError extends Error {}

const CHUNK = 1024 * 1024;

function scanFile(filePath, opts = {}) {
  const host = opts.host || config.clamav.host;
  const port = opts.port || config.clamav.port;
  const timeoutMs = opts.timeoutMs || config.clamav.timeoutMs;

  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let response = '';
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (stream) stream.destroy();
      err ? reject(err) : resolve(val);
    };

    let stream = null;
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs, () => finish(new ScannerUnavailableError('clamd timed out')));
    socket.on('error', (e) => finish(connected ? e : new ScannerUnavailableError(`cannot reach clamd at ${host}:${port}: ${e.message}`)));
    socket.on('data', (d) => { response += d.toString('utf8'); });
    socket.on('end', () => {
      const text = response.replace(/\0/g, '').trim();
      if (!text) return finish(new ScannerUnavailableError('clamd closed the connection without a result'));
      // "stream: OK" | "stream: Eicar-Test-Signature FOUND" | "... ERROR"
      if (/:\s*OK$/.test(text)) return finish(null, { clean: true, signature: null, raw: text });
      const found = text.match(/:\s*(.+)\s+FOUND$/);
      if (found) return finish(null, { clean: false, signature: found[1], raw: text });
      finish(new Error(`clamd error: ${text}`));
    });

    socket.on('connect', () => {
      connected = true;
      socket.write('zINSTREAM\0');
      stream = fs.createReadStream(filePath, { highWaterMark: CHUNK });
      stream.on('error', (e) => finish(e));
      stream.on('data', (chunk) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length, 0);
        const ok = socket.write(Buffer.concat([len, chunk]));
        if (!ok) {
          stream.pause();
          socket.once('drain', () => stream.resume());
        }
      });
      stream.on('end', () => socket.write(Buffer.alloc(4))); // zero-length chunk ends the stream
    });
  });
}

function ping(opts = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: opts.host || config.clamav.host, port: opts.port || config.clamav.port });
    let out = '';
    socket.setTimeout(3000, () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (d) => { out += d; });
    socket.on('end', () => resolve(out.replace(/\0/g, '').trim() === 'PONG'));
  });
}

module.exports = { scanFile, ping, ScannerUnavailableError };
