const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mm = require('music-metadata');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;

const DEFAULT_PROD_URL = 'https://momomusic-backend.onrender.com';
const RAW_BASE_URL =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  (process.env.NODE_ENV === 'production'
    ? DEFAULT_PROD_URL
    : `http://localhost:${PORT}`);

const BASE_URL = String(RAW_BASE_URL).replace(/\/+$/, '');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Render üzerinden /static/music ve /static/covers dosyalarını sun
app.use('/static', express.static(path.join(__dirname, 'public')));

const musicDir = path.join(__dirname, 'public/music');
const coverDir = path.join(__dirname, 'public/covers');
const dbFile = path.join(__dirname, 'db.json');

if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });
if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'mmustakow06@gmail.com').toLowerCase();
const MAIL_USER = process.env.EMAIL_USER || '';
const MAIL_PASS = process.env.EMAIL_PASS || '';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: MAIL_USER,
    pass: MAIL_PASS,
  },
});

const resolveBaseUrl = (url = '') => {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';

  if (/^https?:\/\/localhost:5000/i.test(trimmed)) {
    return trimmed.replace(/^https?:\/\/localhost:5000/i, BASE_URL);
  }

  if (trimmed.startsWith('/')) {
    return `${BASE_URL}${trimmed}`;
  }

  return trimmed;
};

const normalizeTrackUrls = (track = {}) => ({
  ...track,
  url: resolveBaseUrl(track.url),
  cover:
    resolveBaseUrl(track.cover) ||
    'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=500&auto=format&fit=crop&q=60',
});

const loadDb = () => {
  if (!fs.existsSync(dbFile)) {
    const initialData = { users: [], tracks: [] };
    fs.writeFileSync(dbFile, JSON.stringify(initialData, null, 2), 'utf8');
    return initialData;
  }
  try {
    const data = fs.readFileSync(dbFile, 'utf8');
    const parsed = JSON.parse(data);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      tracks: Array.isArray(parsed.tracks) ? parsed.tracks : [],
    };
  } catch (err) {
    console.error('db.json okuma hatası:', err);
    return { users: [], tracks: [] };
  }
};

const saveDb = (data) => {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2), 'utf8');
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'audio') cb(null, musicDir);
    else if (file.fieldname === 'cover') cb(null, coverDir);
    else cb(null, path.join(__dirname, 'public'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });
const verificationCodes = {};

// --- 2FA AUTH ---
app.post('/api/auth/request-code', async (req, res) => {
  const { email, password, isRegister } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-posta ve şifre zorunludur.' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  verificationCodes[email] = { code, password, isRegister, timestamp: Date.now() };

  const mailOptions = {
    from: `"MOMOMusic" <${MAIL_USER}>`,
    to: email,
    subject: 'Giriş Doğrulama Kodunuz',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 25px; background: #0a0a12; color: #fff; border-radius: 12px; max-width: 400px; margin: 0 auto; border: 1px solid rgba(0,243,255,0.2);">
        <h2 style="color: #00f3ff; margin-top: 0;">Güvenlik Kodu</h2>
        <p style="color: #ccc; font-size: 14px;">Hesabınıza erişim sağlamak için kullanmanız gereken tek kullanımlık doğrulama kodunuz:</p>
        <div style="font-size: 28px; font-weight: bold; color: #ff007f; background: rgba(255,255,255,0.05); padding: 12px 20px; text-align: center; border-radius: 8px; letter-spacing: 6px; margin: 20px 0; border: 1px dashed rgba(255,0,127,0.4);">
          ${code}
        </div>
        <p style="font-size: 11px; color: #777; margin-bottom: 0;">Bu kodu kimseyle paylaşmayın.</p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ message: 'Doğrulama kodu e-postanıza gönderildi.', success: true });
  } catch (error) {
    console.error('E-posta gönderme hatası:', error);
    res.status(500).json({ error: 'E-posta gönderilemedi. SMTP ayarlarınızı kontrol edin.' });
  }
});

app.post('/api/auth/verify-code', (req, res) => {
  const { email, code } = req.body;
  const record = verificationCodes[email];

  if (!record || record.code !== code) {
    return res.status(400).json({ error: 'Geçersiz veya süresi dolmuş doğrulama kodu.' });
  }

  const db = loadDb();
  let user = db.users.find((u) => u.email === email);

  if (record.isRegister && !user) {
    const username = email.split('@')[0];
    user = {
      id: Date.now().toString(),
      username,
      email,
      password: record.password,
      followers: [],
      following: [],
      createdAt: new Date().toLocaleString('tr-TR'),
    };
    db.users.push(user);
    saveDb(db);
  }

  delete verificationCodes[email];
  res.json({ message: 'Giriş başarılı!', user });
});

// --- TRACKS ---
app.get('/api/tracks', (req, res) => {
  const db = loadDb();
  res.json(db.tracks.map(normalizeTrackUrls));
});

app.get('/api/tracks/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const db = loadDb();
  const filtered = db.tracks
    .filter(
      (t) =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.artist || '').toLowerCase().includes(q) ||
        (t.uploader || '').toLowerCase().includes(q) ||
        (t.mood || '').toLowerCase().includes(q)
    )
    .map(normalizeTrackUrls);
  res.json(filtered);
});

app.post('/api/tracks', (req, res) => {
  try {
    const db = loadDb();
    const incoming = req.body || {};
    const trackId = String(incoming.id || Date.now());

    const existingIndex = db.tracks.findIndex((t) => String(t.id) === trackId);
    const trackRecord = normalizeTrackUrls({
      id: trackId,
      title: incoming.title || 'İsimsiz Parça',
      artist: incoming.artist || incoming.uploader || 'Bilinmeyen Sanatçı',
      album: incoming.album || 'Tekli',
      genre: incoming.genre || '',
      mood: incoming.mood || 'chill',
      moodLabel: incoming.moodLabel || '',
      moodConfidence: incoming.moodConfidence || null,
      duration: incoming.duration || '',
      url: incoming.url || '',
      cover:
        incoming.cover ||
        'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=500&auto=format&fit=crop&q=60',
      audioFilename: incoming.audioFilename || null,
      coverFilename: incoming.coverFilename || null,
      uploader: incoming.uploader || 'Misafir',
      uploaderEmail: incoming.uploaderEmail || '',
      createdAt: incoming.createdAt || new Date().toLocaleString('tr-TR'),
      plays: Number(incoming.plays) || 0,
      likes: Array.isArray(incoming.likes) ? incoming.likes : [],
    });

    if (existingIndex > -1) {
      db.tracks[existingIndex] = normalizeTrackUrls({
        ...db.tracks[existingIndex],
        ...trackRecord,
      });
    } else {
      db.tracks.unshift(trackRecord);
    }

    saveDb(db);
    res.json({ success: true, track: trackRecord });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Şarkı db.json içine kaydedilemedi.' });
  }
});

app.post(
  '/api/tracks/upload',
  upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        title,
        artist,
        album,
        duration,
        uploader,
        uploaderEmail,
        mood,
        moodLabel,
        moodConfidence,
        genre,
      } = req.body;
      const audioFile = req.files?.audio ? req.files.audio[0] : null;
      let coverFile = req.files?.cover ? req.files.cover[0] : null;

      if (!audioFile) {
        return res.status(400).json({ error: 'Müzik dosyası zorunludur.' });
      }

      let parsedTitle = title || path.parse(audioFile.originalname).name;
      let parsedArtist = artist || uploader || 'Bilinmeyen Sanatçı';
      let parsedAlbum = album || 'Tekli';
      let durationFormatted = duration || '03:30';

      try {
        const metadata = await mm.parseFile(audioFile.path);
        if (!title && metadata.common.title) parsedTitle = metadata.common.title;
        if (!artist && metadata.common.artist) parsedArtist = metadata.common.artist;
        if (!album && metadata.common.album) parsedAlbum = metadata.common.album;
        if (metadata.format.duration) {
          const mins = Math.floor(metadata.format.duration / 60);
          const secs = Math.floor(metadata.format.duration % 60);
          durationFormatted = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        }

        if (!coverFile && metadata.common.picture?.length > 0) {
          const pic = metadata.common.picture[0];
          const coverName = `${Date.now()}-meta.jpg`;
          fs.writeFileSync(path.join(coverDir, coverName), pic.data);
          coverFile = { filename: coverName };
        }
      } catch (e) {
        console.log('Metadata okunamadı.');
      }

      const db = loadDb();
      const newTrack = {
        id: Date.now().toString(),
        title: parsedTitle,
        artist: parsedArtist,
        album: parsedAlbum,
        genre: genre || '',
        mood: mood || 'chill',
        moodLabel: moodLabel || '',
        moodConfidence: moodConfidence ? Number(moodConfidence) : null,
        duration: durationFormatted,
        audioFilename: audioFile.filename,
        coverFilename: coverFile ? coverFile.filename : null,
        url: `${BASE_URL}/static/music/${audioFile.filename}`,
        cover: coverFile
          ? `${BASE_URL}/static/covers/${coverFile.filename}`
          : 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=500&auto=format&fit=crop&q=60',
        uploader: uploader || 'Misafir',
        uploaderEmail: uploaderEmail || '',
        createdAt: new Date().toLocaleString('tr-TR'),
        plays: 0,
        likes: [],
      };

      db.tracks.unshift(newTrack);
      saveDb(db);

      res.json({ message: 'Şarkı başarıyla eklendi!', track: newTrack });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Sunucu kayıt hatası.' });
    }
  }
);

app.put('/api/tracks/:id', (req, res) => {
  const { title, artist, album, mood, requesterEmail, requesterUsername } = req.body || {};
  const db = loadDb();
  const track = db.tracks.find((t) => String(t.id) === String(req.params.id));

  if (!track) {
    return res.json({
      success: true,
      track: { id: req.params.id, title, artist, album, mood },
    });
  }

  const isAdmin = (requesterEmail || '').trim().toLowerCase() === ADMIN_EMAIL;
  const isOwner =
    track.uploader === requesterUsername ||
    (track.uploader || '').toLowerCase() === (requesterEmail || '').toLowerCase() ||
    (track.uploaderEmail &&
      track.uploaderEmail.toLowerCase() === (requesterEmail || '').toLowerCase());

  if (!isAdmin && !isOwner && (requesterEmail || requesterUsername)) {
    return res.status(403).json({ error: 'Bu şarkıyı düzenleme yetkiniz yok.' });
  }

  if (title !== undefined) track.title = title;
  if (artist !== undefined) track.artist = artist;
  if (album !== undefined) track.album = album;
  if (mood !== undefined) track.mood = mood;

  saveDb(db);
  res.json({ success: true, track: normalizeTrackUrls(track) });
});

app.delete('/api/tracks/:id', (req, res) => {
  const requesterEmail = (req.headers['x-user-email'] || req.body?.requesterEmail || '')
    .trim()
    .toLowerCase();
  const requesterUsername =
    req.headers['x-user-username'] || req.body?.requesterUsername || '';

  const db = loadDb();
  const idx = db.tracks.findIndex((t) => String(t.id) === String(req.params.id));

  if (idx > -1) {
    const track = db.tracks[idx];
    const isAdmin = requesterEmail === ADMIN_EMAIL;
    const isOwner =
      track.uploader === requesterUsername ||
      (track.uploader || '').toLowerCase() === requesterEmail ||
      (track.uploaderEmail && track.uploaderEmail.toLowerCase() === requesterEmail);

    if (!isAdmin && !isOwner && (requesterEmail || requesterUsername)) {
      return res.status(403).json({ error: 'Bu şarkıyı silme yetkiniz yok.' });
    }

    const removeIfExists = (dir, filename) => {
      if (!filename) return;
      const safeName = path.basename(filename);
      const fullPath = path.join(dir, safeName);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    };

    removeIfExists(musicDir, track.audioFilename);
    removeIfExists(coverDir, track.coverFilename);

    db.tracks.splice(idx, 1);
    saveDb(db);
  }

  res.json({ success: true, id: req.params.id });
});

app.post('/api/tracks/:id/play', (req, res) => {
  const db = loadDb();
  const track = db.tracks.find((t) => String(t.id) === String(req.params.id));
  if (track) {
    track.plays = (Number(track.plays) || 0) + 1;
    saveDb(db);
    return res.json({ success: true, plays: track.plays });
  }
  res.json({ success: true });
});

app.post('/api/tracks/:id/like', (req, res) => {
  const actor = req.body?.username || req.body?.userId || req.body?.email;
  const db = loadDb();
  const track = db.tracks.find((t) => String(t.id) === String(req.params.id));
  if (!track) return res.json({ success: true });

  if (!Array.isArray(track.likes)) track.likes = [];
  if (actor) {
    const index = track.likes.indexOf(actor);
    if (index > -1) {
      track.likes.splice(index, 1);
    } else {
      track.likes.push(actor);
    }
    saveDb(db);
  }

  res.json({ success: true, likes: track.likes });
});

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda aktif. BASE_URL: ${BASE_URL}`);
});