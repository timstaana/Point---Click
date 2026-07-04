const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8443;
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
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  });
}

function startServer() {
  var useHttps = fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE);
  if (useHttps) {
    var options = {
      key: fs.readFileSync(KEY_FILE),
      cert: fs.readFileSync(CRT_FILE)
    };
    https.createServer(options, serveFile).listen(PORT, function () {
      console.log('HTTPS server running at https://localhost:' + PORT);
    });
  } else {
    http.createServer(serveFile).listen(PORT, function () {
      console.log('HTTP server running at http://localhost:' + PORT);
      console.log('Run `npm run generate-certs` to create certs for HTTPS.');
    });
  }
}

startServer();
