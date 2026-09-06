const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
// برای انتشار عمومی بهتر است ADMIN_PASSWORD را در Environment Variables هاست تنظیم کنی.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pstar9922';

const DATA = path.join(__dirname, 'data.json');
const UPLOADS = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(DATA)) fs.writeFileSync(DATA, '[]');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS));

const sessions = new Map();
const uploadSessions = new Map();

function getCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function getToken(req) {
  // Primary auth: HttpOnly cookie. This avoids putting user-entered/Persian text
  // into HTTP headers and also avoids stale tokens in sessionStorage.
  const cookieToken = getCookie(req, 'dstar_session');
  if (cookieToken) return cookieToken;

  // Backward compatibility for old clients. The new frontend never sends this.
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `dstar_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'dstar_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function auth(req, res, next) {
  const token = getToken(req);
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'جلسه ورود منقضی شده است. دوباره وارد شوید.' });
  }
  next();
}


const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// Abasthan/Nginx can reject large single HTTP requests with 413. We therefore
// upload media in small binary chunks. Each request stays well below 1 MB.
const CHUNK_BYTES = 256 * 1024;
const ALLOWED_TYPES = new Set([
  'image/jpeg','image/png','image/gif','image/webp','image/svg+xml',
  'video/mp4','video/webm','video/quicktime','video/x-matroska'
]);

function safeFilename(name = 'upload') {
  const base = path.basename(String(name)).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || 'upload';
}

function contentTypeToExtension(type = '') {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg',
    'video/mp4': '.mp4', 'video/webm': '.webm',
    'video/quicktime': '.mov', 'video/x-matroska': '.mkv'
  };
  return map[type] || '';
}

function readProjects() {
  try {
    const raw = fs.readFileSync(DATA, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('data.json read error:', err);
    return [];
  }
}

function saveProjects(items) {
  const temp = DATA + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(temp, DATA);
}

app.post('/api/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'رمز عبور اشتباه است.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  setSessionCookie(res, token);
  res.json({ ok: true });
});

app.post('/api/logout', auth, (req, res) => {
  sessions.delete(getToken(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/projects', (_, res) => res.json(readProjects()));

// Step 1: create a temporary upload session. The body is tiny JSON, so it is
// not affected by the large-file proxy limit.
app.post('/api/upload/start', auth, (req, res) => {
  const name = String(req.body?.name || 'upload');
  const type = String(req.body?.type || '').toLowerCase();
  const size = Number(req.body?.size || 0);
  const title = String(req.body?.title || '').trim();
  const category = String(req.body?.category || 'Other');
  const description = String(req.body?.description || '');

  if (!ALLOWED_TYPES.has(type)) return res.status(400).json({ error: 'نوع فایل پشتیبانی نمی‌شود.' });
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'فایل خالی یا نامعتبر است.' });
  if (size > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'حجم فایل بیشتر از 100MB است.' });
  if (!title) return res.status(400).json({ error: 'عنوان پروژه را وارد کنید.' });

  const id = crypto.randomBytes(16).toString('hex');
  const tempPath = path.join(UPLOADS, `.upload-${id}.part`);
  fs.writeFileSync(tempPath, '');

  const upload = {
    id, tempPath, name: safeFilename(name), type, size,
    title, category, description,
    received: 0,
    nextIndex: 0,
    createdAt: Date.now()
  };
  uploadSessions.set(id, upload);
  res.json({ uploadId: id, chunkSize: CHUNK_BYTES, totalChunks: Math.ceil(size / CHUNK_BYTES) });
});

// Step 2: send one small binary chunk. No filename/title/etc. are placed in
// HTTP headers, which also avoids the Persian ByteString fetch error.
app.post('/api/upload/chunk', auth, (req, res) => {
  const id = String(req.headers['x-upload-id'] || '');
  const index = Number(req.headers['x-chunk-index']);
  const upload = uploadSessions.get(id);

  if (!upload) return res.status(404).json({ error: 'جلسه آپلود پیدا نشد. دوباره آپلود را شروع کنید.' });
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'شماره بخش آپلود نامعتبر است.' });
  // If the client retries a chunk whose response was lost, don't append it twice.
  if (index < upload.nextIndex) return res.json({ ok: true, received: upload.received, size: upload.size, duplicate: true });
  if (index !== upload.nextIndex) return res.status(409).json({ error: 'ترتیب بخش‌های فایل نامعتبر است.' });

  let chunkSize = 0;
  let settled = false;
  const output = fs.createWriteStream(upload.tempPath, { flags: 'a' });

  const fail = (status, message) => {
    if (settled) return;
    settled = true;
    try { output.destroy(); } catch (_) {}
    return res.status(status).json({ error: message });
  };

  req.on('data', chunk => {
    chunkSize += chunk.length;
    if (chunkSize > CHUNK_BYTES || upload.received + chunkSize > upload.size) {
      req.destroy();
      fail(413, 'بخش فایل بزرگ‌تر از حد مجاز است.');
    }
  });
  req.on('error', () => fail(400, 'آپلود فایل قطع شد.'));
  output.on('error', () => fail(500, 'امکان ذخیره فایل روی سرور وجود ندارد.'));
  output.on('finish', () => {
    if (settled) return;
    settled = true;
    if (chunkSize === 0) return res.status(400).json({ error: 'بخش فایل خالی است.' });
    upload.received += chunkSize;
    upload.nextIndex = index + 1;
    res.json({ ok: true, received: upload.received, size: upload.size });
  });

  req.pipe(output);
});

// Step 3: verify the complete file and create the portfolio item.
app.post('/api/upload/finish', auth, (req, res) => {
  const id = String(req.body?.uploadId || '');
  const upload = uploadSessions.get(id);
  if (!upload) return res.status(404).json({ error: 'جلسه آپلود پیدا نشد.' });

  if (upload.received !== upload.size) {
    return res.status(400).json({ error: `آپلود کامل نشده است (${upload.received} از ${upload.size} بایت).` });
  }

  const ext = path.extname(upload.name) || contentTypeToExtension(upload.type);
  const finalName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const destination = path.join(UPLOADS, finalName);

  try {
    fs.renameSync(upload.tempPath, destination);
    const project = {
      id: Date.now().toString(),
      title: upload.title,
      category: upload.category,
      description: upload.description,
      media: '/uploads/' + finalName,
      type: upload.type.startsWith('video/') ? 'video' : 'image',
      createdAt: new Date().toISOString()
    };
    const projects = readProjects();
    projects.unshift(project);
    saveProjects(projects);
    uploadSessions.delete(id);
    res.json(project);
  } catch (err) {
    console.error('upload finish error:', err);
    try { if (fs.existsSync(upload.tempPath)) fs.unlinkSync(upload.tempPath); } catch (_) {}
    try { if (fs.existsSync(destination)) fs.unlinkSync(destination); } catch (_) {}
    uploadSessions.delete(id);
    res.status(500).json({ error: 'ذخیره نمونه‌کار انجام نشد.' });
  }
});

app.delete('/api/projects/:id', auth, (req, res) => {
  const projects = readProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'پروژه پیدا نشد.' });

  const file = path.join(__dirname, project.media.replace(/^\/uploads\//, 'uploads/'));
  if (fs.existsSync(file)) fs.unlinkSync(file);
  saveProjects(projects.filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});

// Remove abandoned temporary uploads so failed/interrupted uploads do not pile up.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, upload] of uploadSessions) {
    if (upload.createdAt < cutoff) {
      try { if (fs.existsSync(upload.tempPath)) fs.unlinkSync(upload.tempPath); } catch (_) {}
      uploadSessions.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

app.use((err, _, res, __) => {
  console.error('API error:', err);
  res.status(500).json({ error: err.message || 'خطا در عملیات.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DStar Portfolio running on port ${PORT}`);
});
