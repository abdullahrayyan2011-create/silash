// app.js - Silash
let currentUser = null;
let authToken = null;
let socket = null;
let activeContact = null;
let onlineUserIds = new Set();

function showView(viewId) {
  document.querySelectorAll('.auth-view, .chat-view').forEach((el) => el.classList.add('hidden'));
  document.getElementById(viewId).classList.remove('hidden');
}

async function apiRequest(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');
  return data;
}

function saveSession(token, user) {
  authToken = token;
  currentUser = user;
  localStorage.setItem('chat_token', token);
  localStorage.setItem('chat_user', JSON.stringify(user));
}

function clearSession() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('chat_token');
  localStorage.removeItem('chat_user');
}

function isPremium() {
  return currentUser?.plan === 'premium' && (!currentUser.premiumUntil || currentUser.premiumUntil > Date.now());
}

// ============================================================
// التسجيل والتحقق والدخول
// ============================================================
let pendingVerifyEmail = null;

document.getElementById('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('register-error');
  errorEl.textContent = '';
  const name = document.getElementById('register-name').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  try {
    await apiRequest('/api/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });
    pendingVerifyEmail = email;
    document.getElementById('verify-email-label').textContent = email;
    showView('view-verify');
  } catch (err) { errorEl.textContent = err.message; }
});

document.getElementById('form-verify').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('verify-error');
  const successEl = document.getElementById('verify-success');
  errorEl.textContent = '';
  successEl.textContent = '';
  const code = document.getElementById('verify-code').value.trim();
  try {
    await apiRequest('/api/verify', { method: 'POST', body: JSON.stringify({ email: pendingVerifyEmail, code }) });
    successEl.textContent = 'تم تفعيل حسابك! جاري تحويلك لتسجيل الدخول...';
    setTimeout(() => showView('view-login'), 1200);
  } catch (err) { errorEl.textContent = err.message; }
});

document.getElementById('resend-code-btn').addEventListener('click', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('verify-error');
  const successEl = document.getElementById('verify-success');
  errorEl.textContent = '';
  successEl.textContent = '';
  try {
    await apiRequest('/api/resend-code', { method: 'POST', body: JSON.stringify({ email: pendingVerifyEmail }) });
    successEl.textContent = 'تم إرسال رمز جديد لإيميلك';
  } catch (err) { errorEl.textContent = err.message; }
});

document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  try {
    const data = await apiRequest('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    saveSession(data.token, data.user);
    await enterChatApp();
  } catch (err) { errorEl.textContent = err.message; }
});

document.querySelectorAll('[data-goto]').forEach((link) => {
  link.addEventListener('click', (e) => { e.preventDefault(); showView(link.dataset.goto); });
});

document.getElementById('logout-btn').addEventListener('click', () => {
  if (socket) socket.disconnect();
  clearSession();
  activeContact = null;
  document.getElementById('view-chat').classList.remove('chat-open');
  showView('view-login');
});

// ============================================================
// الحساب وPremium
// ============================================================
async function enterChatApp() {
  document.getElementById('current-user-name').textContent = currentUser.name;
  showView('view-chat');
  applySavedTheme();
  connectSocket();
  await loadCurrentUser();
  renderAdVisibility();
  await loadContacts();
}

async function loadCurrentUser() {
  try {
    const data = await apiRequest('/api/me');
    currentUser = { ...currentUser, ...data.user };
    localStorage.setItem('chat_user', JSON.stringify(currentUser));
    document.getElementById('current-user-name').textContent = currentUser.name;
    updatePlanBadge();
    renderAdVisibility();
  } catch (err) { console.warn('تعذر تحميل بيانات الحساب:', err.message); }
}

function updatePlanBadge() {
  const badge = document.getElementById('current-user-plan');
  const premiumBtn = document.getElementById('premium-btn');
  const premium = isPremium();
  if (badge) {
    badge.textContent = premium ? '⭐ PREMIUM' : 'FREE';
    badge.classList.toggle('premium', premium);
  }
  if (premiumBtn) premiumBtn.textContent = premium ? '⭐ Premium' : '⭐ Premium';
  document.body.classList.toggle('is-premium', premium);
}

function renderAdVisibility() {
  const ad = document.getElementById('free-ad');
  if (ad) ad.classList.toggle('hidden', isPremium());
}

const premiumModal = document.getElementById('premium-modal');
document.getElementById('premium-btn').addEventListener('click', () => {
  premiumModal.classList.remove('hidden');
  document.getElementById('premium-message').textContent = '';
  updatePremiumModal();
});
document.getElementById('close-premium').addEventListener('click', () => premiumModal.classList.add('hidden'));
premiumModal.addEventListener('click', (e) => { if (e.target === premiumModal) premiumModal.classList.add('hidden'); });

document.getElementById('activate-premium-btn').addEventListener('click', async () => {
  if (isPremium()) {
    document.querySelectorAll('.theme-choice').forEach((el) => el.classList.toggle('selected', el.dataset.theme === (document.body.dataset.theme || 'classic')));
    document.getElementById('premium-message').textContent = `Premium فعال حتى ${formatDate(currentUser.premiumUntil)}`;
    return;
  }
  const code = prompt('أدخل رمز Premium التجريبي:');
  if (!code) return;
  const msg = document.getElementById('premium-message');
  msg.textContent = '';
  try {
    const data = await apiRequest('/api/premium/test-activate', { method: 'POST', body: JSON.stringify({ code }) });
    currentUser.plan = 'premium';
    currentUser.premiumUntil = data.premiumUntil;
    localStorage.setItem('chat_user', JSON.stringify(currentUser));
    updatePlanBadge();
    renderAdVisibility();
    updatePremiumModal();
    msg.textContent = 'تم تفعيل Premium لمدة 30 يوم ⭐';
  } catch (err) { msg.textContent = err.message; }
});

function updatePremiumModal() {
  const status = document.getElementById('premium-status');
  const activate = document.getElementById('activate-premium-btn');
  if (isPremium()) {
    status.textContent = `⭐ حسابك Premium فعال حتى ${formatDate(currentUser.premiumUntil)}`;
    status.classList.add('active');
    activate.textContent = 'Premium مفعّل';
  } else {
    status.textContent = 'حسابك حالياً مجاني';
    status.classList.remove('active');
    activate.textContent = 'تفعيل Premium';
  }
}

// ============================================================
// الثيمات Premium
// ============================================================
const THEMES = ['classic', 'midnight', 'ocean', 'violet'];
function applyTheme(theme) {
  if (!isPremium()) {
    document.getElementById('premium-message').textContent = 'الثيمات الحصرية متاحة لمستخدمي Premium ⭐';
    return;
  }
  if (!THEMES.includes(theme)) return;
  document.body.dataset.theme = theme;
  localStorage.setItem('silash_theme', theme);
  document.querySelectorAll('.theme-choice').forEach((el) => el.classList.toggle('selected', el.dataset.theme === theme));
}
function applySavedTheme() {
  const saved = localStorage.getItem('silash_theme') || 'classic';
  document.body.dataset.theme = isPremium() && THEMES.includes(saved) ? saved : 'classic';
}
document.querySelectorAll('.theme-choice').forEach((el) => {
  el.addEventListener('click', () => applyTheme(el.dataset.theme));
});

// ============================================================
// Socket.io
// ============================================================
function connectSocket() {
  socket = io({ auth: { token: authToken } });
  socket.on('new-message', (message) => {
    if (activeContact && message.sender_id === activeContact.id) {
      renderMessage(message); scrollMessagesToBottom();
    }
  });
  socket.on('message-sent', (message) => {
    if (activeContact && message.receiver_id === activeContact.id) {
      renderMessage(message); scrollMessagesToBottom();
    }
  });
  socket.on('user-status', ({ userId, online }) => {
    if (online) onlineUserIds.add(userId); else onlineUserIds.delete(userId);
    updateContactStatusUI(userId, online);
  });
}

async function loadContacts() {
  const listEl = document.getElementById('contacts-list');
  try {
    const data = await apiRequest('/api/users');
    if (data.users.length === 0) {
      listEl.innerHTML = '<p class="empty-contacts">لا يوجد مستخدمون آخرون بعد. شارك التطبيق مع أصدقائك!</p>';
      return;
    }
    listEl.innerHTML = '';
    data.users.forEach((user) => {
      const item = document.createElement('div');
      item.className = 'contact-item';
      item.dataset.userId = user.id;
      const premium = user.plan === 'premium' && (!user.premium_until || user.premium_until > Date.now());
      item.innerHTML = `
        <div class="contact-avatar">${escapeHtml(user.name.charAt(0).toUpperCase())}</div>
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(user.name)} ${premium ? '<span class="mini-premium">⭐</span>' : ''}</div>
          <div class="contact-status" data-status-for="${user.id}">غير متصل</div>
        </div>`;
      item.addEventListener('click', () => openChatWith(user));
      listEl.appendChild(item);
    });
  } catch (err) { listEl.innerHTML = `<p class="empty-contacts">${escapeHtml(err.message)}</p>`; }
}

function updateContactStatusUI(userId, online) {
  const statusEl = document.querySelector(`[data-status-for="${userId}"]`);
  if (statusEl) { statusEl.textContent = online ? 'متصل الآن' : 'غير متصل'; statusEl.classList.toggle('online', online); }
  if (activeContact && activeContact.id === userId) document.getElementById('chat-with-status').classList.toggle('online', online);
}

async function openChatWith(user) {
  activeContact = user;
  document.querySelectorAll('.contact-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.userId) === user.id));
  document.getElementById('chat-placeholder').classList.add('hidden');
  document.getElementById('chat-active').classList.remove('hidden');
  document.getElementById('chat-with-name').innerHTML = `${escapeHtml(user.name)} ${user.plan === 'premium' ? '<span class="chat-premium-badge">⭐ PREMIUM</span>' : ''}`;
  document.getElementById('chat-with-status').classList.toggle('online', onlineUserIds.has(user.id));
  document.getElementById('view-chat').classList.add('chat-open');
  const messagesArea = document.getElementById('messages-area');
  messagesArea.innerHTML = '<p class="loading-messages">جاري تحميل الرسائل...</p>';
  try {
    const data = await apiRequest(`/api/messages/${user.id}`);
    messagesArea.innerHTML = '';
    data.messages.forEach(renderMessage);
    scrollMessagesToBottom();
  } catch (err) { messagesArea.innerHTML = `<p class="loading-messages error">${escapeHtml(err.message)}</p>`; }
}

function renderMessage(message) {
  const messagesArea = document.getElementById('messages-area');
  const isMine = message.sender_id === currentUser.id;
  const bubble = document.createElement('div');
  bubble.className = `bubble ${isMine ? 'mine' : 'theirs'}`;
  bubble.dataset.messageId = message.id;

  let contentHtml = '';
  if (message.message_type === 'file' && message.file_url) {
    const image = /^image\//i.test(message.file_mime || '');
    contentHtml += image
      ? `<a class="file-card image-file" href="${escapeAttr(message.file_url)}" target="_blank" rel="noopener"><img src="${escapeAttr(message.file_url)}" alt="${escapeAttr(message.file_name || 'صورة')}" loading="lazy"><span>${escapeHtml(message.file_name || 'صورة')}</span></a>`
      : `<a class="file-card" href="${escapeAttr(message.file_url)}" target="_blank" rel="noopener">📎 <span>${escapeHtml(message.file_name || 'ملف')}</span><small>${formatBytes(message.file_size || 0)}</small></a>`;
  }
  if (message.content) contentHtml += `<div class="message-text">${escapeHtml(message.content)}</div>`;
  bubble.innerHTML = `${contentHtml}<span class="bubble-time">${formatTime(message.created_at)}</span>`;

  if (isPremium()) {
    const reaction = document.createElement('button');
    reaction.type = 'button';
    reaction.className = 'reaction-btn';
    reaction.textContent = message.reaction || '＋';
    reaction.title = 'تفاعل Premium';
    reaction.addEventListener('click', () => reactToMessage(message.id, reaction));
    bubble.appendChild(reaction);
  } else if (message.reaction) {
    const reaction = document.createElement('span');
    reaction.className = 'reaction-display'; reaction.textContent = message.reaction; bubble.appendChild(reaction);
  }
  messagesArea.appendChild(bubble);
}

async function reactToMessage(messageId, button) {
  if (!isPremium()) return;
  const choices = ['❤️', '👍', '😂', '🔥', '😮', ''];
  const current = button.textContent === '＋' ? '' : button.textContent;
  const next = choices[(choices.indexOf(current) + 1) % choices.length];
  try {
    await apiRequest(`/api/messages/${messageId}/react`, { method: 'POST', body: JSON.stringify({ reaction: next || null }) });
    button.textContent = next || '＋';
  } catch (err) { document.getElementById('premium-message').textContent = err.message; }
}

function scrollMessagesToBottom() {
  const messagesArea = document.getElementById('messages-area');
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

// ============================================================
// إرسال النص + الملفات
// ============================================================
document.getElementById('form-send-message').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeContact) return;
  const input = document.getElementById('message-input');
  const fileInput = document.getElementById('file-input');
  const content = input.value.trim();
  const file = fileInput.files[0];
  if (!content && !file) return;

  const sendButton = document.getElementById('send-message-btn');
  sendButton.disabled = true;
  try {
    let attachment = null;
    if (file) {
      const max = isPremium() ? 25 * 1024 * 1024 : 5 * 1024 * 1024;
      if (file.size > max) {
        throw new Error(isPremium() ? 'الحد الأقصى للملف 25MB' : 'الحساب المجاني يسمح بملفات حتى 5MB. فعّل Premium لرفع ملفات أكبر.');
      }
      const dataUrl = await readFileAsDataUrl(file);
      const data = await apiRequest('/api/upload', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, mime: file.type || 'application/octet-stream', size: file.size, data: dataUrl })
      });
      attachment = data;
      attachment.mime = file.type;
    }
    socket.emit('send-message', { receiverId: activeContact.id, content, attachment });
    input.value = '';
    fileInput.value = '';
    updateFileLabel();
  } catch (err) {
    alert(err.message);
  } finally { sendButton.disabled = false; }
});

document.getElementById('file-input').addEventListener('change', updateFileLabel);
function updateFileLabel() {
  const fileInput = document.getElementById('file-input');
  const label = document.getElementById('file-label');
  if (!fileInput.files[0]) { label.textContent = '📎'; label.title = isPremium() ? 'إرفاق ملف حتى 25MB' : 'إرفاق ملف حتى 5MB'; return; }
  label.textContent = '✓'; label.title = fileInput.files[0].name;
}

function escapeHtml(text) { const div = document.createElement('div'); div.textContent = String(text ?? ''); return div.innerHTML; }
function escapeAttr(text) { return escapeHtml(text).replace(/"/g, '&quot;'); }
function formatTime(timestamp) { return new Date(timestamp).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }); }
function formatDate(timestamp) { return new Date(timestamp).toLocaleDateString('ar', { year: 'numeric', month: 'short', day: 'numeric' }); }
function formatBytes(bytes) { if (!bytes) return ''; const units = ['B','KB','MB','GB']; let i=0, n=bytes; while(n>=1024 && i<units.length-1){n/=1024;i++;} return `${n.toFixed(i ? 1 : 0)} ${units[i]}`; }
function readFileAsDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('تعذر قراءة الملف')); reader.readAsDataURL(file); }); }

// ============================================================
// البداية
// ============================================================
(function init() {
  const savedToken = localStorage.getItem('chat_token');
  const savedUser = localStorage.getItem('chat_user');
  if (savedToken && savedUser) {
    try {
      authToken = savedToken; currentUser = JSON.parse(savedUser); enterChatApp();
    } catch { clearSession(); showView('view-login'); }
  } else showView('view-register');
})();
