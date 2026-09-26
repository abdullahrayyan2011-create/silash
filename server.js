// server.js
// هذا هو قلب التطبيق - فيه كل المسارات (routes) ومنطق الرسائل الفورية

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-غيرني';

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // بيقدّم ملفات مجلد public تلقائياً (index.html, style.css, app.js)

// حماية عامة: لو صار خطأ غير متوقع بأي مكان بالكود، نطبعه بس ما نخلي السيرفر ينهار بالكامل
process.on('unhandledRejection', (err) => {
  console.error('حدث خطأ غير متوقع (unhandledRejection):', err.message || err);
});

// ============================================================
// Middleware للتحقق من تسجيل الدخول (JWT)
// أي مسار بيحتاج المستخدم يكون مسجّل دخول بيمرّ من هون أول
// ============================================================
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

    // ملاحظة: التحقق من الإيميل معطّل حالياً - الحساب يُفعّل مباشرة (is_verified = 1)
    db.prepare(`
      INSERT INTO users (name, email, password_hash, is_verified, created_at)
      VALUES (?, ?, ?, 1, ?)
    `).run(name, email, passwordHash, Date.now());

    res.json({ message: 'تم إنشاء الحساب بنجاح، يمكنك تسجيل الدخول الآن' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ، حاول مرة أخرى' });
  }
});

// ============================================================
// 2) تسجيل الدخول
// ============================================================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(400).json({ error: 'الإيميل أو كلمة السر غير صحيحة' });
  }

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    return res.status(400).json({ error: 'الإيميل أو كلمة السر غير صحيحة' });
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

// ============================================================
// 3) قائمة كل المستخدمين (عشان تختار مين تحكي معه)
// ============================================================
app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, name, email FROM users WHERE id != ? AND is_verified = 1')
    .all(req.userId);
  res.json({ users });
});

// ============================================================
// 4) سجل الرسائل بين المستخدم الحالي ومستخدم ثاني
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
  socket.on('send-message', ({ receiverId, content }) => {
    if (!content || !content.trim()) return;

    const createdAt = Date.now();

    const result = db.prepare(`
      INSERT INTO messages (sender_id, receiver_id, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(socket.userId, receiverId, content.trim(), createdAt);

    const message = {
      id: result.lastInsertRowid,
      sender_id: socket.userId,
      receiver_id: receiverId,
      content: content.trim(),
      created_at: createdAt,
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
