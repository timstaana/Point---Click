const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8443;
const HTTP_PORT = process.env.HTTP_PORT || 8080;
const CERT_DIR = path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'localhost.key');
const CRT_FILE = path.join(CERT_DIR, 'localhost.crt');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8'
};

function serveFile(req, res) {
  var uri = url.parse(req.url).pathname;
  if (uri === '/') uri = '/index.html';
  var filePath = path.join(__dirname, uri);

  fs.stat(filePath, function (err, stats) {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    var mime = MIME_TYPES[ext] || 'application/octet-stream';
    var lastMod = stats.mtime.toUTCString();

    // Conditional GET: clients revalidate instead of re-downloading.
    // (`no-cache` = "store it, but ask before reusing" — a 304 header
    // exchange instead of a full transfer, and edits show up instantly.)
    var ims = req.headers['if-modified-since'];
    if (ims && !isNaN(Date.parse(ims)) && Date.parse(lastMod) <= Date.parse(ims)) {
      res.writeHead(304, {
        'Last-Modified': lastMod,
        'Cache-Control': 'no-cache'
      });
      res.end();
      return;
    }

    // iOS Safari's media loader requires Range support and a real
    // Content-Length before it will play audio/video at all.
    var range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      var start = range[1] ? parseInt(range[1], 10) : 0;
      var end = range[2] ? parseInt(range[2], 10) : stats.size - 1;
      if (end >= stats.size) end = stats.size - 1;
      if (start > end || start >= stats.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + stats.size });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Length': end - start + 1,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stats.size,
        'Accept-Ranges': 'bytes',
        'Last-Modified': lastMod,
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stats.size,
      'Accept-Ranges': 'bytes',
      'Last-Modified': lastMod,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function lanAddresses() {
  var out = [];
  var ifaces = os.networkInterfaces();
  for (var name in ifaces) {
    var addrs = ifaces[name] || [];
    for (var i = 0; i < addrs.length; i++) {
      if (addrs[i].family === 'IPv4' && !addrs[i].internal) out.push(addrs[i].address);
    }
  }
  return out;
}

// HTTP and HTTPS run side by side. Old devices (iPad mini iOS 8,
// TenFourFox) should use the HTTP port: a self-signed HTTPS cert breaks
// audio on iOS even after Safari's warning is accepted, because the
// media stack (AVFoundation) does not inherit Safari's cert exception.
function startServer() {
  var hosts = ['localhost'].concat(lanAddresses());

  http.createServer(serveFile).listen(HTTP_PORT, function () {
    hosts.forEach(function (h) {
      console.log('HTTP  : http://' + h + ':' + HTTP_PORT);
    });
  });

  if (fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE)) {
    var options = {
      key: fs.readFileSync(KEY_FILE),
      cert: fs.readFileSync(CRT_FILE)
    };
    https.createServer(options, serveFile).listen(PORT, function () {
      hosts.forEach(function (h) {
        console.log('HTTPS : https://' + h + ':' + PORT);
      });
    });
  } else {
    console.log('No certs — HTTPS disabled. Run `npm run generate-certs`.');
  }
}

startServer();
