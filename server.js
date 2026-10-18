const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'records.json');
// ✅ 修改点：pendingCodes 持久化，避免重启后重复分配
const PENDING_FILE = path.join(DATA_DIR, 'pending_codes.json');
const ADMIN_PASSWORD = process.env.ADMIN_PWD || 'research2025';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
}

function loadRecords() {
  ensureData();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return []; }
}

function saveRecords(records) {
  ensureData();
  fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2));
}

// ✅ 修改点：pendingCodes 持久化读写
function loadPendingCodes() {
  ensureData();
  try {
    const arr = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) { return new Set(); }
}
function savePendingCodes(set) {
  ensureData();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(Array.from(set)));
}

function getAllocatedCodes() {
  const records = loadRecords();
  const codes = new Set();
  records.forEach(r => { if (r.researchCode && /^\d{4}$/.test(r.researchCode)) codes.add(r.researchCode); });
  // 把磁盘上持久化的 pending 也加进来
  const pending = loadPendingCodes();
  pending.forEach(c => codes.add(c));
  return codes;
}

app.post('/api/allocate-code', (req, res) => {
  const used = getAllocatedCodes();
  if (used.size >= 10000) return res.status(500).json({ error: '所有编码已用完' });

  let code = null;
  for (let i = 0; i < 5000; i++) {
    const candidate = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    if (!used.has(candidate)) { code = candidate; break; }
  }
  if (!code) {
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0');
      if (!used.has(c)) { code = c; break; }
    }
  }
  if (!code) return res.status(500).json({ error: '分配失败' });

  // 持久化 pending
  const pending = loadPendingCodes();
  pending.add(code);
  savePendingCodes(pending);

  console.log('[分配]', code, '已用', used.size + 1, '/10000');
  res.json({ code, used: used.size + 1 });
});

// ✅ 修改点：提交时校验格式 + 编码唯一性检测
app.post('/api/submit', (req, res) => {
  const record = req.body;
  if (!record || !record.id) return res.status(400).json({ error: 'invalid' });

  // 格式校验：researchCode 若存在，必须是 4 位数字
  if (record.researchCode != null && record.researchCode !== '') {
    if (!/^\d{4}$/.test(String(record.researchCode))) {
      return res.status(400).json({ error: 'researchCode must be 4 digits' });
    }
  }

  record.receivedAt = new Date().toISOString();
  record.ip = req.ip;
  record.ua = req.headers['user-agent'] || '';

  const records = loadRecords();
  const idx = records.findIndex(r => r.id === record.id);

  // 同编码多记录检测（不同 id 但同 code）
  let duplicatedCode = false;
  if (record.researchCode) {
    duplicatedCode = records.some(r => r.id !== record.id && r.researchCode === record.researchCode);
    if (duplicatedCode) {
      console.warn('[⚠️ 重复编码]', record.researchCode, 'id=', record.id);
    }
  }

  if (idx >= 0) { records[idx] = record; console.log('[更新]', record.researchCode || '?'); }
  else { records.push(record); console.log('[新增]', record.researchCode || '?'); }
  saveRecords(records);

  // ✅ 提交后从持久化的 pending 中移除该 code
  if (record.researchCode) {
    const pending = loadPendingCodes();
    if (pending.delete(record.researchCode)) savePendingCodes(pending);
  }

  res.json({ ok: true, total: records.length, duplicatedCode });
});

app.get('/api/records', (req, res) => {
  if (req.query.pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
  res.json(loadRecords());
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ✅ 修改点：新增健康检查端点
app.get('/health', (req, res) => {
  try {
    const records = loadRecords();
    res.json({ ok: true, records: records.length, uptime: process.uptime() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('服务器已启动，端口 ' + PORT);
  console.log('数据目录: ' + DATA_DIR);
});
