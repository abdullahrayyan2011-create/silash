// app.js
// هذا الملف مسؤول عن كل شي بيصير بالمتصفح: تبديل الشاشات، إرسال الطلبات للسيرفر،
// والتعامل مع الرسائل الفورية عبر Socket.io

// ============================================================
// أدوات مساعدة عامة
// ============================================================

// نخزن هون بيانات الجلسة الحالية بالذاكرة (بعد تسجيل الدخول)
let currentUser = null; // { id, name, email }
let authToken = null;
let socket = null;
let activeContact = null; // المستخدم اللي فاتح معه شات حالياً
let onlineUserIds = new Set();

// دالة بسيطة لإظهار شاشة معينة وإخفاء الباقي
function showView(viewId) {
  document.querySelectorAll('.auth-view, .chat-view').forEach((el) => {
    el.classList.add('hidden');
  });
  document.getElementById(viewId).classList.remove('hidden');
}

// دالة لإرسال طلبات API مع إرفاق التوكن تلقائياً إذا موجود
async function apiRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'حدث خطأ غير متوقع');
  }
  return data;
}

// حفظ بيانات الجلسة بالمتصفح عشان ما يضطر يسجل دخول كل مرة يفتح الصفحة
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

// ============================================================
// 1) نموذج التسجيل
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
    await apiRequest('/api/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    });

    pendingVerifyEmail = email;
    document.getElementById('verify-email-label').textContent = email;
    showView('view-verify');
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ============================================================
// 2) نموذج التحقق من الرمز
// ============================================================
document.getElementById('form-verify').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('verify-error');
  const successEl = document.getElementById('verify-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const code = document.getElementById('verify-code').value.trim();

  try {
    await apiRequest('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ email: pendingVerifyEmail, code }),
    });

    successEl.textContent = 'تم تفعيل حسابك! جاري تحويلك لتسجيل الدخول...';
    setTimeout(() => showView('view-login'), 1200);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('resend-code-btn').addEventListener('click', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('verify-error');
  const successEl = document.getElementById('verify-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  try {
    await apiRequest('/api/resend-code', {
      method: 'POST',
      body: JSON.stringify({ email: pendingVerifyEmail }),
    });
    successEl.textContent = 'تم إرسال رمز جديد لإيميلك';
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ============================================================
// 3) نموذج تسجيل الدخول
// ============================================================
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  try {
    const data = await apiRequest('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    saveSession(data.token, data.user);
    enterChatApp();
  } catch (err) {
    if (err.message.includes('تفعيل')) {
      pendingVerifyEmail = email;
      document.getElementById('verify-email-label').textContent = email;
      showView('view-verify');
    }
    errorEl.textContent = err.message;
  }
});

// ============================================================
// روابط التبديل بين الشاشات (تسجيل <-> دخول)
// ============================================================
document.querySelectorAll('[data-goto]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    showView(link.dataset.goto);
  });
});

// ============================================================
// تسجيل الخروج
// ============================================================
document.getElementById('logout-btn').addEventListener('click', () => {
  if (socket) socket.disconnect();
  clearSession();
  activeContact = null;
  showView('view-login');
});

// ============================================================
// 4) الدخول لواجهة الشات بعد تسجيل الدخول بنجاح
// ============================================================
async function enterChatApp() {
  document.getElementById('current-user-name').textContent = currentUser.name;
  showView('view-chat');

  connectSocket();
  await loadContacts();
}

// الاتصال بـ Socket.io باستخدام التوكن للتحقق من الهوية
function connectSocket() {
  socket = io({
    auth: { token: authToken },
  });

  // رسالة جديدة وصلت من طرف ثاني
  socket.on('new-message', (message) => {
    if (activeContact && message.sender_id === activeContact.id) {
      renderMessage(message);
      scrollMessagesToBottom();
    }
  });

  // تأكيد إرسال رسالتنا نحن
  socket.on('message-sent', (message) => {
    if (activeContact && message.receiver_id === activeContact.id) {
      renderMessage(message);
      scrollMessagesToBottom();
    }
  });

  // تحديث حالة اتصال مستخدم (متصل / غير متصل)
  socket.on('user-status', ({ userId, online }) => {
    if (online) {
      onlineUserIds.add(userId);
    } else {
      onlineUserIds.delete(userId);
    }
    updateContactStatusUI(userId, online);
  });
}

// ============================================================
// 5) تحميل قائمة المستخدمين (جهات الاتصال)
// ============================================================
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
      item.innerHTML = `
        <div class="contact-avatar">${user.name.charAt(0).toUpperCase()}</div>
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(user.name)}</div>
          <div class="contact-status" data-status-for="${user.id}">غير متصل</div>
        </div>
      `;
      item.addEventListener('click', () => openChatWith(user));
      listEl.appendChild(item);
    });
  } catch (err) {
    listEl.innerHTML = `<p class="empty-contacts">${err.message}</p>`;
  }
}

function updateContactStatusUI(userId, online) {
  const statusEl = document.querySelector(`[data-status-for="${userId}"]`);
  if (statusEl) {
    statusEl.textContent = online ? 'متصل الآن' : 'غير متصل';
    statusEl.classList.toggle('online', online);
  }
  if (activeContact && activeContact.id === userId) {
    document.getElementById('chat-with-status').classList.toggle('online', online);
  }
}

// ============================================================
// 6) فتح محادثة مع مستخدم معيّن
// ============================================================
async function openChatWith(user) {
  activeContact = user;

  // تمييز جهة الاتصال المختارة بالقائمة
  document.querySelectorAll('.contact-item').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.userId) === user.id);
  });

  document.getElementById('chat-placeholder').classList.add('hidden');
  document.getElementById('chat-active').classList.remove('hidden');
  document.getElementById('chat-with-name').textContent = user.name;
  document.getElementById('chat-with-status').classList.toggle('online', onlineUserIds.has(user.id));

  // لعرض الشات بالموبايل بدل القائمة
  document.getElementById('view-chat').classList.add('chat-open');

  const messagesArea = document.getElementById('messages-area');
  messagesArea.innerHTML = '<p style="text-align:center; color:#667781; font-size:13px;">جاري تحميل الرسائل...</p>';

  try {
    const data = await apiRequest(`/api/messages/${user.id}`);
    messagesArea.innerHTML = '';
    data.messages.forEach(renderMessage);
    scrollMessagesToBottom();
  } catch (err) {
    messagesArea.innerHTML = `<p style="text-align:center; color:#d32f2f; font-size:13px;">${err.message}</p>`;
  }
}

// عرض رسالة واحدة كفقاعة بالشات
function renderMessage(message) {
  const messagesArea = document.getElementById('messages-area');
  const isMine = message.sender_id === currentUser.id;

  const bubble = document.createElement('div');
  bubble.className = `bubble ${isMine ? 'mine' : 'theirs'}`;
  bubble.innerHTML = `
    ${escapeHtml(message.content)}
    <span class="bubble-time">${formatTime(message.created_at)}</span>
  `;
  messagesArea.appendChild(bubble);
}

function scrollMessagesToBottom() {
  const messagesArea = document.getElementById('messages-area');
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

// ============================================================
// 7) إرسال رسالة جديدة
// ============================================================
document.getElementById('form-send-message').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!activeContact) return;

  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content) return;

  socket.emit('send-message', { receiverId: activeContact.id, content });
  input.value = '';
});

// ============================================================
// أدوات صغيرة مساعدة
// ============================================================

// لمنع أي مستخدم من كتابة كود HTML خبيث داخل الرسائل (XSS)
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
}

// ============================================================
// عند فتح الصفحة: تحقق إذا فيه جلسة محفوظة مسبقاً
// ============================================================
(function init() {
  const savedToken = localStorage.getItem('chat_token');
  const savedUser = localStorage.getItem('chat_user');

  if (savedToken && savedUser) {
    authToken = savedToken;
    currentUser = JSON.parse(savedUser);
    enterChatApp();
  } else {
    showView('view-register');
  }
})();
