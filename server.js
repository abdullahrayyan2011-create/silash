// server.js
// هذا هو قلب التطبيق - فيه كل المسارات (routes) ومنطق الرسائل الفورية

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-غيرني';

app.use(cors());
app.use(express.json({ limit: '35mb' }));
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
app.use(express.static('public')); // بيقدّم ملفات مجلد public تلقائياً (index.html, style.css, app.js)

// ============================================================
// إعداد إرسال الإيميل (nodemailer)
// ============================================================
const emailPort = Number(process.env.EMAIL_PORT) || 587;
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: emailPort,
  secure: emailPort === 465, // منفذ 465 يحتاج اتصال آمن مباشر (SSL)، أما 587 فلا
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  connectionTimeout: 10000, // 10 ثواني كحد أقصى لمحاولة الاتصال
  greetingTimeout: 10000,
  socketTimeout: 10000,
});

// حماية عامة: لو صار خطأ غير متوقع بأي مكان بالكود، نطبعه بس ما نخلي السيرفر ينهار بالكامل
process.on('unhandledRejection', (err) => {
  console.error('حدث خطأ غير متوقع (unhandledRejection):', err.message || err);
});

// دالة بسيطة بترسل رمز التحقق للإيميل
async function sendVerificationEmail(toEmail, code) {
  // Local development: if SMTP is not configured, don't crash the app.
  // The verification code is printed in the terminal instead.
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('========================================');
    console.log(`DEV verification code for ${toEmail}: ${code}`);
    console.log('========================================');
    return;
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: toEmail,
    subject: 'رمز التحقق من حسابك',
    html: `
      <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
        <h2>مرحباً بك 👋</h2>
        <p>رمز التحقق الخاص بك هو:</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 20px 0;">${code}</div>
        <p>هذا الرمز صالح لمدة 15 دقيقة فقط.</p>
      </div>
    `,
  });
}

// دالة بتنشئ رمز عشوائي من 6 أرقام
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function currentUserIsPremium(userId) {
  const user = db.prepare('SELECT plan, premium_until FROM users WHERE id = ?').get(userId);
  return isPremium(user);
}

// ============================================================
// Middleware للتحقق من تسجيل الدخول (JWT)
// أي مسار بيحتاج المستخدم يكون مسجّل دخول بيمرّ من هون أول
// ============================================================
function isPremium(user) {
  return user && user.plan === 'premium' && (!user.premium_until || user.premium_until > Date.now());
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'الجلسة منتهية، سجّل دخول من جديد' });
  }
}

// ============================================================
// 1) تسجيل حساب جديد
// ============================================================
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'الرجاء تعبئة جميع الحقول' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'كلمة السر يجب أن تكون 6 أحرف على الأقل' });
    }

    // نتأكد إنه الإيميل مش مستخدم من قبل
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) {
      return res.status(400).json({ error: 'هذا الإيميل مسجّل مسبقاً' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const code = generateCode();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 دقيقة من الآن

    db.prepare(`
      INSERT INTO users (name, email, password_hash, is_verified, verification_code, code_expires_at, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(name, email, passwordHash, code, expiresAt, Date.now());

    await sendVerificationEmail(email, code);

    res.json({ message: 'تم إنشاء الحساب، تحقق من إيميلك لرمز التفعيل' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ، حاول مرة أخرى' });
  }
});

// ============================================================
// 2) التحقق من الرمز المرسل للإيميل
// ============================================================
app.post('/api/verify', (req, res) => {
  const { email, code } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(400).json({ error: 'هذا الإيميل غير مسجّل' });
  }
  if (user.is_verified) {
    return res.status(400).json({ error: 'هذا الحساب مفعّل مسبقاً' });
  }
  if (user.verification_code !== code) {
    return res.status(400).json({ error: 'الرمز غير صحيح' });
  }
  if (Date.now() > user.code_expires_at) {
    return res.status(400).json({ error: 'انتهت صلاحية الرمز، اطلب رمز جديد' });
  }

  db.prepare('UPDATE users SET is_verified = 1, verification_code = NULL WHERE id = ?').run(user.id);

  res.json({ message: 'تم تفعيل حسابك بنجاح، يمكنك تسجيل الدخول الآن' });
});

// ============================================================
// 3) إعادة إرسال رمز التحقق
// ============================================================
app.post('/api/resend-code', async (req, res) => {
  const { email } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(400).json({ error: 'هذا الإيميل غير مسجّل' });
  }
  if (user.is_verified) {
    return res.status(400).json({ error: 'هذا الحساب مفعّل مسبقاً' });
  }

  const code = generateCode();
  const expiresAt = Date.now() + 15 * 60 * 1000;

  db.prepare('UPDATE users SET verification_code = ?, code_expires_at = ? WHERE id = ?')
    .run(code, expiresAt, user.id);

  await sendVerificationEmail(email, code);

  res.json({ message: 'تم إرسال رمز جديد لإيميلك' });
});

// ============================================================
// 4) تسجيل الدخول
// ============================================================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(400).json({ error: 'الإيميل أو كلمة السر غير صحيحة' });
  }
  // تسجيل الدخول لا يحتاج رمز تحقق.
  // رمز التحقق يُرسل فقط عند إنشاء حساب جديد، ويمكن للمستخدم تسجيل الدخول
  // بعد ذلك بالإيميل وكلمة السر مباشرة.
  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    return res.status(400).json({ error: 'الإيميل أو كلمة السر غير صحيحة' });
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, plan: user.plan || 'free', premiumUntil: user.premium_until || null },
  });
});

// ============================================================
// 5) بيانات المستخدم الحالي وحالة Premium
// ============================================================
app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, name, email, plan, premium_until, created_at FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      plan: isPremium(user) ? 'premium' : 'free',
      premiumUntil: user.premium_until || null,
      createdAt: user.created_at
    }
  });
});

// للاختبار فقط: يمنح حسابك Premium بكود موجود في .env.
// لاحقاً نستبدله ببوابة دفع حقيقية.
app.post('/api/premium/test-activate', authMiddleware, (req, res) => {
  const { code } = req.body || {};
  const adminCode = process.env.PREMIUM_TEST_CODE || 'SILASH2026';
  if (!adminCode || code !== adminCode) {
    return res.status(403).json({ error: 'رمز التفعيل غير صحيح' });
  }
  const until = Date.now() + 30 * 24 * 60 * 60 * 1000;
  db.prepare("UPDATE users SET plan = 'premium', premium_until = ? WHERE id = ?").run(until, req.userId);
  res.json({ message: 'تم تفعيل Premium لمدة 30 يوم', premiumUntil: until });
});

// رفع الملفات: Premium حتى 25MB، والحساب المجاني حتى 5MB.
app.post('/api/upload', authMiddleware, (req, res) => {
  try {
    const { name, mime, size, data } = req.body || {};
    if (!name || !mime || !data) return res.status(400).json({ error: 'لم يتم اختيار ملف' });

    const premium = currentUserIsPremium(req.userId);
    const maxSize = premium ? 25 * 1024 * 1024 : 5 * 1024 * 1024;
    const declaredSize = Number(size) || 0;
    if (declaredSize > maxSize) {
      return res.status(400).json({ error: premium ? 'حجم الملف أكبر من 25MB' : 'الحساب المجاني يسمح بملفات حتى 5MB. فعّل Premium لرفع ملفات أكبر.' });
    }

    const cleanName = path.basename(String(name)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
    const base64 = String(data).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > maxSize) {
      return res.status(400).json({ error: premium ? 'حجم الملف أكبر من 25MB' : 'الحساب المجاني يسمح بملفات حتى 5MB. فعّل Premium لرفع ملفات أكبر.' });
    }

    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${cleanName}`;
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
    res.json({ url: `/uploads/${encodeURIComponent(filename)}`, name: String(name), size: buffer.length, mime: String(mime) });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(400).json({ error: 'تعذر رفع الملف' });
  }
});

// ============================================================
// 6) قائمة كل المستخدمين (عشان تختار مين تحكي معه)
// ============================================================
app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, name, email, plan, premium_until FROM users WHERE id != ? AND is_verified = 1')
    .all(req.userId);
  res.json({ users });
});

// ============================================================
// 6) سجل الرسائل بين المستخدم الحالي ومستخدم ثاني
// ============================================================
app.get('/api/messages/:otherUserId', authMiddleware, (req, res) => {
  const otherUserId = Number(req.params.otherUserId);

  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE (sender_id = ? AND receiver_id = ?)
       OR (sender_id = ? AND receiver_id = ?)
    ORDER BY created_at ASC
  `).all(req.userId, otherUserId, otherUserId, req.userId);

  res.json({ messages });
});

// Premium: تفاعل بسيط على الرسائل (❤️ 👍 😂).
app.post('/api/messages/:messageId/react', authMiddleware, (req, res) => {
  if (!currentUserIsPremium(req.userId)) {
    return res.status(403).json({ error: 'التفاعلات متاحة لمستخدمي Premium فقط' });
  }
  const messageId = Number(req.params.messageId);
  const reaction = req.body?.reaction || null;
  if (reaction && !['❤️', '👍', '😂', '🔥', '😮'].includes(reaction)) {
    return res.status(400).json({ error: 'تفاعل غير مدعوم' });
  }
  const message = db.prepare('SELECT * FROM messages WHERE id = ? AND (sender_id = ? OR receiver_id = ?)').get(messageId, req.userId, req.userId);
  if (!message) return res.status(404).json({ error: 'الرسالة غير موجودة' });
  db.prepare('UPDATE messages SET reaction = ? WHERE id = ?').run(reaction, messageId);
  res.json({ messageId, reaction });
});

// ============================================================
// Socket.io - الرسائل الفورية (Real-time)
// ============================================================

// نخزن هون مين متصل الآن: userId -> socket.id
const onlineUsers = new Map();

// أي اتصال جديد لازم يثبت هويته أول باستخدام التوكن (JWT)
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('لا يوجد توكن دخول'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error('توكن غير صالح'));
  }
});

io.on('connection', (socket) => {
  onlineUsers.set(socket.userId, socket.id);
  console.log(`مستخدم متصل: ${socket.userId}`);

  // بث حالة "متصل الآن" لباقي المستخدمين
  io.emit('user-status', { userId: socket.userId, online: true });

  // استقبال رسالة جديدة من المستخدم وإرسالها للطرف الثاني
  socket.on('send-message', ({ receiverId, content, attachment }) => {
    const text = typeof content === 'string' ? content.trim() : '';
    const hasAttachment = attachment && attachment.url && attachment.name;
    if (!text && !hasAttachment) return;

    const createdAt = Date.now();
    const type = hasAttachment ? 'file' : 'text';
    const result = db.prepare(`
      INSERT INTO messages (sender_id, receiver_id, content, created_at, message_type, file_name, file_url, file_size, file_mime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      socket.userId, receiverId, text, createdAt, type,
      hasAttachment ? attachment.name : null,
      hasAttachment ? attachment.url : null,
      hasAttachment ? Number(attachment.size) || 0 : null,
      hasAttachment ? attachment.mime || null : null
    );

    const message = {
      id: result.lastInsertRowid,
      sender_id: socket.userId,
      receiver_id: receiverId,
      content: text,
      created_at: createdAt,
      message_type: type,
      file_name: hasAttachment ? attachment.name : null,
      file_url: hasAttachment ? attachment.url : null,
      file_size: hasAttachment ? Number(attachment.size) || 0 : null,
      file_mime: hasAttachment ? attachment.mime || null : null,
      reaction: null
    };

    // إرسال الرسالة للطرف الثاني إذا كان متصل الآن
    const receiverSocketId = onlineUsers.get(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('new-message', message);
    }

    // إرجاع نفس الرسالة للمرسل عشان يظهرها بشاشته فوراً
    socket.emit('message-sent', message);
  });

  // عند قطع الاتصال
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.userId);
    io.emit('user-status', { userId: socket.userId, online: false });
    console.log(`مستخدم قطع الاتصال: ${socket.userId}`);
  });
});

server.listen(PORT, () => {
  console.log(`✅ السيرفر شغال على http://localhost:${PORT}`);
});
