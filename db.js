// db.js
// هذا الملف مسؤول عن إنشاء قاعدة البيانات وتجهيز الجداول
// نستخدم SQLite لأنه بسيط جداً - عبارة عن ملف واحد على جهازك بدون سيرفر منفصل

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// بينشئ ملف باسم chat.db في نفس مجلد المشروع لو مش موجود
const db = new DatabaseSync(path.join(__dirname, 'chat.db'));

// تفعيل بعض الإعدادات لتحسين الأداء (اختياري بس مفيد)
db.exec('PRAGMA journal_mode = WAL');

// ============ جدول المستخدمين ============
// id: رقم فريد لكل مستخدم
// name: اسم المستخدم
// email: الإيميل (لازم يكون فريد - ما ينكرر)
// password_hash: كلمة السر بعد التشفير (ما نخزن كلمة السر الحقيقية أبداً)
// is_verified: 0 يعني لسا ما تحقق من إيميله، 1 يعني تحقق
// verification_code: رمز التحقق المكوّن من 6 أرقام
// code_expires_at: وقت انتهاء صلاحية الرمز (بعد 15 دقيقة من إرساله)
// created_at: تاريخ إنشاء الحساب
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_verified INTEGER NOT NULL DEFAULT 0,
    verification_code TEXT,
    code_expires_at INTEGER,
    created_at INTEGER NOT NULL
  )
`);

// ============ جدول الرسائل ============
// id: رقم فريد لكل رسالة
// sender_id: رقم المستخدم اللي أرسل الرسالة
// receiver_id: رقم المستخدم اللي استقبل الرسالة
// content: نص الرسالة
// created_at: وقت إرسال الرسالة
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (receiver_id) REFERENCES users(id)
  )
`);

// نصدّر الاتصال بقاعدة البيانات عشان نستخدمه بملفات ثانية (server.js)
module.exports = db;
