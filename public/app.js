let projects = [];
let currentFilter = 'all';
// Authentication uses an HttpOnly cookie. Remove any old token left by previous versions.
sessionStorage.removeItem('dstar_admin_token');
let authToken = 'cookie';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const admin = document.getElementById('admin');
const cursorGlow = document.getElementById('cursorGlow');

async function readResponse(r) {
  const text = await r.text();
  try { return JSON.parse(text); }
  catch (_) { throw new Error(text.slice(0, 180) || `HTTP ${r.status}`); }
}

async function load() {
  try {
    const r = await fetch('/api/projects');
    const out = await readResponse(r);
    if (!r.ok) throw new Error(out.error || `خطای سرور (${r.status})`);
    projects = out;
    render();
    renderAdmin();
  } catch (_) {
    projects = [];
    render();
  }
}

function render() {
  const items = currentFilter === 'all' ? projects : projects.filter(p => p.category === currentFilter);
  grid.innerHTML = items.map(p => `
    <article class="card">
      <div class="media">${p.type === 'video'
        ? `<video src="${p.media}" controls preload="metadata"></video>`
        : `<img src="${p.media}" alt="${escapeHtml(p.title)}" loading="lazy">`}
      </div>
      <div class="card-info">
        <div class="tag">${escapeHtml(p.category)}</div>
        <h3>${escapeHtml(p.title)}</h3>
        <p>${escapeHtml(p.description)}</p>
      </div>
    </article>`).join('');
  empty.style.display = items.length ? 'none' : 'block';
}

function renderAdmin() {
  const list = document.getElementById('adminList');
  const count = document.getElementById('projectCount');
  if (!list) return;
  count.textContent = projects.length;
  list.innerHTML = projects.length
    ? projects.map(p => `<div class="admin-item"><span>${escapeHtml(p.title)}</span><button class="delete" onclick="removeProject('${p.id}')">حذف</button></div>`).join('')
    : `<div style="color:#666;font-size:12px;padding:8px 0">هنوز نمونه‌کاری وجود ندارد.</div>`;
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

document.querySelectorAll('#filters button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#filters button').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    render();
  };
});

function openAdmin() {
  admin.classList.remove('hidden');
  const ok = !!authToken;
  document.getElementById('loginPanel').classList.toggle('hidden', ok);
  document.getElementById('managerPanel').classList.toggle('hidden', !ok);
  if (ok) renderAdmin();
  setTimeout(() => document.getElementById('password')?.focus(), 50);
}

function closeAdmin() { admin.classList.add('hidden'); }

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('loginStatus');
  const password = document.getElementById('password').value;
  status.textContent = 'در حال بررسی...';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      credentials: 'same-origin',
      body: JSON.stringify({ password })
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'ورود ناموفق بود.');
    authToken = 'cookie';
    document.getElementById('password').value = '';
    status.textContent = '';
    openAdmin();
  } catch (err) {
    status.textContent = err.message;
  }
});

async function logout() {
  if (authToken) {
    try { await fetch('/api/logout', {method:'POST', credentials:'same-origin'}); } catch (_) {}
  }
  authToken = '';
  sessionStorage.removeItem('dstar_admin_token');
  openAdmin();
}

document.getElementById('uploadForm').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('status');
  const form = e.target;
  const fileInput = document.getElementById('media');
  const file = fileInput?.files?.[0];

  if (!file) {
    status.textContent = 'خطا: فایل انتخاب نشده است.';
    return;
  }

  if (file.size > 100 * 1024 * 1024) {
    status.textContent = 'خطا: حجم فایل نباید بیشتر از 100MB باشد.';
    return;
  }

  const CHUNK_SIZE = 256 * 1024;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let uploadId = '';
  let cancelled = false;

  const setProgress = (done, total) => {
    const percent = Math.min(100, Math.round((done / total) * 100));
    status.textContent = `در حال آپلود... ${percent}%`;
  };

  try {
    // First request contains only small JSON metadata. Persian text is safe here.
    const startResponse = await fetch('/api/upload/start', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: file.name,
        type: file.type,
        size: file.size,
        title: form.elements.title?.value || '',
        category: form.elements.category?.value || 'Other',
        description: form.elements.description?.value || ''
      })
    });
    const start = await readResponse(startResponse);
    if (startResponse.status === 401) {
      authToken = '';
      sessionStorage.removeItem('dstar_admin_token');
      openAdmin();
      throw new Error('جلسه ورود منقضی شده؛ دوباره وارد شو.');
    }
    if (!startResponse.ok) throw new Error(start.error || 'شروع آپلود ناموفق بود.');
    uploadId = start.uploadId;

    // Every request is only 256KB, avoiding Nginx 413 even for large videos.
    for (let index = 0; index < totalChunks; index++) {
      if (cancelled) throw new Error('آپلود لغو شد.');
      const begin = index * CHUNK_SIZE;
      const end = Math.min(file.size, begin + CHUNK_SIZE);
      const chunk = file.slice(begin, end);

      let response;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await fetch('/api/upload/chunk', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Upload-ID': uploadId,
              'X-Chunk-Index': String(index)
            },
            body: chunk
          });
          if (response.ok || response.status === 401 || response.status === 409) break;
        } catch (err) {
          if (attempt === 3) throw err;
        }
      }

      const result = await readResponse(response);
      if (response.status === 401) {
        authToken = '';
        sessionStorage.removeItem('dstar_admin_token');
        openAdmin();
        throw new Error('جلسه ورود منقضی شده؛ دوباره وارد شو.');
      }
      if (!response.ok) throw new Error(result.error || `ارسال بخش ${index + 1} ناموفق بود.`);
      setProgress(index + 1, totalChunks);
    }

    const finishResponse = await fetch('/api/upload/finish', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uploadId })
    });
    const out = await readResponse(finishResponse);
    if (finishResponse.status === 401) {
      authToken = '';
      sessionStorage.removeItem('dstar_admin_token');
      openAdmin();
      throw new Error('جلسه ورود منقضی شده؛ دوباره وارد شو.');
    }
    if (!finishResponse.ok) throw new Error(out.error || 'تکمیل آپلود ناموفق بود.');

    projects.unshift(out);
    e.target.reset();
    document.getElementById('fileLabel').textContent = '＋ انتخاب تصویر یا ویدیو';
    status.textContent = 'نمونه‌کار با موفقیت اضافه شد ✓';
    render();
    renderAdmin();
  } catch (err) {
    status.textContent = 'خطا: ' + (err.message || 'آپلود ناموفق بود.');
  }
});

async function removeProject(id) {
  if (!confirm('این نمونه‌کار حذف شود؟')) return;
  const r = await fetch('/api/projects/' + encodeURIComponent(id), {method:'DELETE', credentials:'same-origin'});
  if (r.status === 401) return logout();
  if (r.ok) {
    projects = projects.filter(p => p.id !== id);
    render(); renderAdmin();
  }
}

document.getElementById('media').addEventListener('change', e => {
  document.getElementById('fileLabel').textContent = e.target.files[0] ? '✓ ' + e.target.files[0].name : '＋ انتخاب تصویر یا ویدیو';
});

admin.addEventListener('click', e => { if (e.target === admin) closeAdmin(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAdmin(); });

window.addEventListener('mousemove', e => {
  cursorGlow.style.opacity = '1';
  cursorGlow.style.left = e.clientX + 'px';
  cursorGlow.style.top = e.clientY + 'px';
});
window.addEventListener('mouseleave', () => cursorGlow.style.opacity = '0');

load();
