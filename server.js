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

/* ---------- editor API (dev tool, used by /editor.html) ---------- */

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store' });
  res.end(body);
}

function listFiles(dir, ext) {
  try {
    return fs.readdirSync(path.join(__dirname, dir))
      .filter(function (f) { return f.toLowerCase().slice(-ext.length) === ext; })
      .sort();
  } catch (e) {
    return [];
  }
}

// Rebuild scenes.js from editor data, preserving the doc-comment header.
function serializeScenes(d) {
  var header = '';
  try {
    var cur = fs.readFileSync(path.join(__dirname, 'scenes.js'), 'utf8');
    // trim trailing whitespace so repeated saves don't grow the gap
    var m = cur.match(/^\/\*[\s\S]*?\*\//);
    if (m) header = m[0] + '\n';
  } catch (e) {}
  var parts = [header];
  if (d.startRoom) {
    parts.push('window.START_ROOM = ' + JSON.stringify(d.startRoom) + ';\n');
  }
  if (d.startCutscene) {
    parts.push('window.START_CUTSCENE = ' + JSON.stringify(d.startCutscene) + ';\n');
  }
  parts.push('window.CUTSCENES = ' + JSON.stringify(d.cutscenes || {}, null, 2) + ';\n');
  parts.push('window.COMBINE = ' + JSON.stringify(d.combine || [], null, 2) + ';\n');
  if (d.combineHint) {
    parts.push('window.COMBINE_HINT = ' + JSON.stringify(d.combineHint) + ';\n');
  }
  parts.push('window.SCENES = ' + JSON.stringify(d.scenes, null, 2) + ';\n');
  return parts.join('\n');
}

function validScenes(scenes) {
  if (!scenes || typeof scenes !== 'object') return false;
  var names = Object.keys(scenes);
  if (!names.length) return false;
  for (var i = 0; i < names.length; i++) {
    var s = scenes[names[i]];
    if (!s || typeof s.bg !== 'string' || !s.bg ||
        typeof s.idle !== 'string' || !s.idle ||
        !Array.isArray(s.objects)) return false;
  }
  return true;
}

// duration of a PCM WAV in ms (0 if unreadable) — lets the editor set
// hold times from the real voice-line length automatically
function wavMs(file) {
  try {
    var b = fs.readFileSync(file);
    if (b.toString('ascii', 0, 4) !== 'RIFF') return 0;
    var pos = 12, byteRate = 0;
    while (pos + 8 <= b.length) {
      var id = b.toString('ascii', pos, pos + 4);
      var size = b.readUInt32LE(pos + 4);
      if (id === 'fmt ') byteRate = b.readUInt32LE(pos + 16);
      if (id === 'data' && byteRate) return Math.round(size / byteRate * 1000);
      pos += 8 + size + (size % 2);
    }
  } catch (e) {}
  return 0;
}

function handleApi(req, res) {
  var uri = url.parse(req.url).pathname;

  if (uri === '/api/assets' && req.method === 'GET') {
    var sounds = listFiles('sounds', '.wav');
    var soundMs = {};
    sounds.forEach(function (f) {
      soundMs[f] = wavMs(path.join(__dirname, 'sounds', f));
    });
    sendJson(res, 200, {
      images: listFiles('images', '.png'),
      sounds: sounds,
      soundMs: soundMs
    });
    return true;
  }

  if (uri === '/api/scenes' && req.method === 'POST') {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        sendJson(res, 400, { error: 'bad JSON' });
        return;
      }
      if (!validScenes(data.scenes)) {
        sendJson(res, 400, { error: 'scenes failed validation (every room needs bg, idle and an objects list) — nothing written' });
        return;
      }
      var target = path.join(__dirname, 'scenes.js');
      var backupDir = path.join(__dirname, 'backups');
      try {
        if (fs.existsSync(target)) {
          if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
          var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          fs.writeFileSync(path.join(backupDir, 'scenes-' + stamp + '.js'),
                           fs.readFileSync(target));
          // keep the newest 30 backups
          var baks = fs.readdirSync(backupDir)
            .filter(function (f) { return /^scenes-.*\.js$/.test(f); })
            .sort();
          while (baks.length > 30) {
            fs.unlinkSync(path.join(backupDir, baks.shift()));
          }
        }
        fs.writeFileSync(target, serializeScenes(data));
      } catch (e2) {
        sendJson(res, 500, { error: String(e2) });
        return;
      }
      console.log('editor: scenes.js saved (backup in backups/)');
      sendJson(res, 200, { ok: true });
    });
    return true;
  }

  return false;
}

function serveFile(req, res) {
  if (handleApi(req, res)) return;
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

    // Code files are never cached AT ALL (`no-store` + the legacy
    // Pragma/Expires pair old iOS respects): the iOS home-screen web
    // app shell caches far more stubbornly than Safari and will happily
    // relaunch week-old JS. Assets (images/sounds) keep the cheaper
    // policy: stored, but revalidated with a 304 header exchange.
    var noStore = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json';
    var cacheHeaders = noStore
      ? {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      : {
          'Cache-Control': 'no-cache',
          'Last-Modified': lastMod
        };

    // Conditional GET for assets: revalidate instead of re-download.
    var ims = req.headers['if-modified-since'];
    if (!noStore && ims && !isNaN(Date.parse(ims)) && Date.parse(lastMod) <= Date.parse(ims)) {
      res.writeHead(304, cacheHeaders);
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
      res.writeHead(206, Object.assign({
        'Content-Type': mime,
        'Content-Length': end - start + 1,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stats.size,
        'Accept-Ranges': 'bytes'
      }, cacheHeaders));
      fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
      return;
    }

    res.writeHead(200, Object.assign({
      'Content-Type': mime,
      'Content-Length': stats.size,
      'Accept-Ranges': 'bytes'
    }, cacheHeaders));
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
