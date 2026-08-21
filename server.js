// ============================================================
// server.js – EduPlatform v6
// ============================================================
const express = require('express');
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const fs      = require('fs');
const ffmpeg  = require('fluent-ffmpeg');

const app  = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA))      fs.mkdirSync(DATA);
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

function readDB(name) {
  const f = path.join(DATA, name + '.json');
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function writeDB(name, data) {
  fs.writeFileSync(path.join(DATA, name + '.json'), JSON.stringify(data, null, 2));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── DEVELOPER ────────────────────────────────────────────────
app.get('/api/developer', (req, res) => {
  res.json({ name: 'Mustafa Ahmed', phone: '01100492414' });
});

app.post('/api/developer/generate-code', (req, res) => {
  if (req.body.devPassword !== 'MUSTAFA_DEV_2024') return res.json({ ok: false, msg: 'Wrong password' });
  const codes = readDB('teacher_codes');
  const code  = 'TCH-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  codes.push({ code, used: false, created_at: new Date().toISOString() });
  writeDB('teacher_codes', codes);
  res.json({ ok: true, code });
});

// ── TEACHER ──────────────────────────────────────────────────
app.post('/api/teacher/register', (req, res) => {
  const { name, password, regCode } = req.body;
  if (!name || !password || !regCode) return res.json({ ok: false, msg: 'All fields required' });
  const codes = readDB('teacher_codes');
  const entry = codes.find(c => c.code === regCode.toUpperCase() && !c.used);
  if (!entry) return res.json({ ok: false, msg: 'Invalid or already used code' });
  const teachers = readDB('teachers');
  if (teachers.find(t => t.name === name)) return res.json({ ok: false, msg: 'Name already taken' });
  const teacher = { id: uuidv4(), name, password, created_at: new Date().toISOString() };
  teachers.push(teacher);
  writeDB('teachers', teachers);
  entry.used = true;
  writeDB('teacher_codes', codes);
  res.json({ ok: true, teacherId: teacher.id });
});

app.post('/api/teacher/login', (req, res) => {
  const teacher = readDB('teachers').find(t => t.name === req.body.name && t.password === req.body.password);
  if (!teacher) return res.json({ ok: false, msg: 'Wrong name or password' });
  res.json({ ok: true, teacherId: teacher.id, teacherName: teacher.name });
});

app.post('/api/teacher/video', upload.single('video'), (req, res) => {
  const { teacherId, title, maxStudents, videoTimeLimitSecs, quizTimeLimitSecs, hasQuiz, quizFirst } = req.body;
  if (!req.file) return res.json({ ok: false, msg: 'No video file' });

  const origPath = path.join(__dirname, 'uploads', req.file.filename);
  const convName = uuidv4() + '.mp4';
  const convPath = path.join(__dirname, 'uploads', convName);
  console.log('Converting:', req.file.filename);

  ffmpeg(origPath)
    .videoCodec('libx264').audioCodec('aac')
    .outputOptions(['-pix_fmt yuv420p', '-movflags +faststart'])
    .on('end', () => {
      fs.unlinkSync(origPath);
      const videos = readDB('videos');
      const accessCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      const video = {
        id: uuidv4(), teacher_id: teacherId, title,
        filename: convName, access_code: accessCode,
        max_students: parseInt(maxStudents),
        video_time_limit: parseInt(videoTimeLimitSecs),
        quiz_time_limit:  hasQuiz === 'true' ? parseInt(quizTimeLimitSecs) : 0,
        has_quiz:   hasQuiz   === 'true' ? 1 : 0,
        quiz_first: quizFirst === 'true' ? 1 : 0,
        created_at: new Date().toISOString()
      };
      videos.push(video);
      writeDB('videos', videos);
      res.json({ ok: true, videoId: video.id, accessCode });
    })
    .on('error', err => res.json({ ok: false, msg: 'Conversion failed: ' + err.message }))
    .save(convPath);
});

app.post('/api/teacher/quiz', (req, res) => {
  const { videoId, questions } = req.body;
  const existing = readDB('quiz_questions').filter(q => q.video_id !== videoId);
  const newQs = questions.map(q => ({
    id: uuidv4(), video_id: videoId, type: q.type,
    question: q.question, option_a: q.a || '', option_b: q.b || '',
    option_c: q.c || '', option_d: q.d || '', correct: q.correct || ''
  }));
  writeDB('quiz_questions', [...existing, ...newQs]);
  res.json({ ok: true });
});

app.get('/api/teacher/videos/:teacherId', (req, res) => {
  const videos = readDB('videos')
    .filter(v => v.teacher_id === req.params.teacherId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ ok: true, videos });
});

app.get('/api/teacher/results/:videoId', (req, res) => {
  const video    = readDB('videos').find(v => v.id === req.params.videoId);
  const students = readDB('students').filter(s => s.video_id === req.params.videoId);
  const sessions = readDB('watch_sessions');
  const quizRes  = readDB('quiz_results');
  const now      = Date.now();

  const results = students.map(s => {
    const session = sessions.find(x => x.student_id === s.id && x.video_id === req.params.videoId) || null;
    const quiz    = quizRes.find(x  => x.student_id === s.id && x.video_id === req.params.videoId) || null;
    let videoStatus = 'Not started';
    if (session) {
      if (session.video_expired)       videoStatus = 'Time expired';
      else if (session.completed)      videoStatus = 'Completed';
      else if (session.video_started_at) {
        const elapsed = Math.floor((now - new Date(session.video_started_at).getTime()) / 1000);
        if (video && elapsed >= video.video_time_limit) videoStatus = 'Time expired';
        else videoStatus = 'Watching';
      }
    }
    return { student: s, session, quiz, videoStatus };
  });
  res.json({ ok: true, results });
});

app.delete('/api/teacher/video/:videoId', (req, res) => {
  const videos = readDB('videos');
  const video  = videos.find(v => v.id === req.params.videoId);
  if (video) {
    const fp = path.join(__dirname, 'uploads', video.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    writeDB('videos', videos.filter(v => v.id !== req.params.videoId));
  }
  res.json({ ok: true });
});

// ── STUDENT ──────────────────────────────────────────────────

// Check if student ID exists (new flow — ID first)
app.post('/api/student/check-id', (req, res) => {
  const students = readDB('students');
  const student  = students.find(s => s.student_code === req.body.studentCode.toUpperCase());
  if (!student) return res.json({ ok: false, msg: 'Student ID not found. Please register as a new student.' });
  res.json({ ok: true, studentId: student.id, studentCode: student.student_code, name: student.name });
});

// Validate code for existing student — auto-registers them for new video
app.post('/api/student/validate-existing', (req, res) => {
  const { code, studentCode } = req.body;
  const video = readDB('videos').find(v => v.access_code === code.toUpperCase());
  if (!video) return res.json({ ok: false, msg: 'Invalid code' });

  // Find the student by their code
  const students = readDB('students');
  const existing = students.find(s => s.student_code === studentCode.toUpperCase());
  if (!existing) return res.json({ ok: false, msg: 'Student not found' });

  // Check if already registered for this video
  const alreadyForVideo = students.find(s => s.student_code === studentCode.toUpperCase() && s.video_id === video.id);

  if (!alreadyForVideo) {
    // Check class is not full
    const enrolled = students.filter(s => s.video_id === video.id).length;
    if (enrolled >= video.max_students) return res.json({ ok: false, msg: 'Class is full' });

    // Auto-register for this video
    const newEntry = {
      id: uuidv4(),
      student_code: existing.student_code,
      name: existing.name,
      phone: existing.phone,
      parent_phone: existing.parent_phone,
      video_id: video.id,
      registered_at: new Date().toISOString()
    };
    students.push(newEntry);
    writeDB('students', students);
  }

  // Find the student entry for this specific video
  const studentForVideo = readDB('students').find(s => s.student_code === studentCode.toUpperCase() && s.video_id === video.id);

  res.json({
    ok: true,
    videoId: video.id,
    studentId: studentForVideo.id,
    title: video.title,
    videoTimeLimit: video.video_time_limit,
    quizTimeLimit:  video.quiz_time_limit,
    hasQuiz: video.has_quiz,
    quizFirst: video.quiz_first
  });
});

// Validate code for NEW student
app.post('/api/student/validate-code', (req, res) => {
  const video = readDB('videos').find(v => v.access_code === req.body.code.toUpperCase());
  if (!video) return res.json({ ok: false, msg: 'Invalid code' });
  const enrolled = readDB('students').filter(s => s.video_id === video.id).length;
  if (enrolled >= video.max_students) return res.json({ ok: false, msg: 'Class is full' });
  res.json({
    ok: true, videoId: video.id, title: video.title,
    videoTimeLimit: video.video_time_limit,
    quizTimeLimit:  video.quiz_time_limit,
    hasQuiz: video.has_quiz, quizFirst: video.quiz_first
  });
});

// Register new student
app.post('/api/student/register', (req, res) => {
  const { name, phone, parentPhone, videoId } = req.body;
  const studentCode = 'STU-' + Math.random().toString(36).substring(2, 7).toUpperCase();
  const student = { id: uuidv4(), student_code: studentCode, name, phone, parent_phone: parentPhone, video_id: videoId, registered_at: new Date().toISOString() };
  const students = readDB('students');
  students.push(student);
  writeDB('students', students);
  res.json({ ok: true, studentId: student.id, studentCode });
});

// Get video — checks server-side timer, allows rewatch if time not expired
app.get('/api/student/video/:videoId/:studentId', (req, res) => {
  const student = readDB('students').find(s => s.id === req.params.studentId);
  if (!student) return res.json({ ok: false, msg: 'Unauthorized' });
  const video = readDB('videos').find(v => v.id === req.params.videoId);
  if (!video)  return res.json({ ok: false, msg: 'Video not found' });

  const sessions = readDB('watch_sessions');
  const existing = sessions.find(s => s.student_id === student.id && s.video_id === video.id);

  // If manually expired — block
  if (existing && existing.video_expired) {
    return res.json({ ok: false, msg: 'Your video time has expired. You cannot watch this video again.' });
  }

  // If video started — check server clock
  if (existing && existing.video_started_at) {
    const elapsed   = Math.floor((Date.now() - new Date(existing.video_started_at).getTime()) / 1000);
    const remaining = video.video_time_limit - elapsed;
    if (remaining <= 0) {
      // Auto-expire
      const idx = sessions.findIndex(s => s.student_id === student.id && s.video_id === video.id);
      sessions[idx].video_expired   = 1;
      sessions[idx].seconds_watched = video.video_time_limit;
      writeDB('watch_sessions', sessions);
      return res.json({ ok: false, msg: 'Your video time has expired. You cannot watch this video again.' });
    }
    // Allow rewatch — return remaining time
    const quizDone = readDB('quiz_results').find(q => q.student_id === student.id && q.video_id === video.id);
    const { filename, ...safe } = video;
    return res.json({ ok: true, video: safe, videoUrl: '/uploads/' + video.filename, remainingTime: remaining, quizAlreadyDone: !!quizDone });
  }

  // First visit
  const { filename, ...safe } = video;
  res.json({ ok: true, video: safe, videoUrl: '/uploads/' + video.filename, remainingTime: video.video_time_limit, quizAlreadyDone: false });
});

// Record video start time
app.post('/api/student/video-start', (req, res) => {
  const { studentId, videoId } = req.body;
  const sessions = readDB('watch_sessions');
  const idx = sessions.findIndex(s => s.student_id === studentId && s.video_id === videoId);
  if (idx === -1) {
    sessions.push({ id: uuidv4(), student_id: studentId, video_id: videoId, seconds_watched: 0, completed: 0, video_expired: 0, video_started_at: new Date().toISOString(), started_at: new Date().toISOString() });
  } else if (!sessions[idx].video_started_at) {
    sessions[idx].video_started_at = new Date().toISOString();
  }
  writeDB('watch_sessions', sessions);
  res.json({ ok: true });
});

app.post('/api/student/watch-progress', (req, res) => {
  const { studentId, videoId, secondsWatched } = req.body;
  const sessions = readDB('watch_sessions');
  const idx = sessions.findIndex(s => s.student_id === studentId && s.video_id === videoId);
  if (idx !== -1) { sessions[idx].seconds_watched = secondsWatched; writeDB('watch_sessions', sessions); }
  res.json({ ok: true });
});

app.post('/api/student/watch-complete', (req, res) => {
  const { studentId, videoId } = req.body;
  const sessions = readDB('watch_sessions');
  const idx = sessions.findIndex(s => s.student_id === studentId && s.video_id === videoId);
  if (idx !== -1) { sessions[idx].completed = 1; sessions[idx].finished_at = new Date().toISOString(); writeDB('watch_sessions', sessions); }
  res.json({ ok: true });
});

app.post('/api/student/video-expired', (req, res) => {
  const { studentId, videoId } = req.body;
  const sessions = readDB('watch_sessions');
  const idx = sessions.findIndex(s => s.student_id === studentId && s.video_id === videoId);
  if (idx !== -1) { sessions[idx].video_expired = 1; writeDB('watch_sessions', sessions); }
  res.json({ ok: true });
});

app.get('/api/student/quiz/:videoId', (req, res) => {
  const questions = readDB('quiz_questions')
    .filter(q => q.video_id === req.params.videoId)
    .map(({ id, type, question, option_a, option_b, option_c, option_d }) => ({ id, type, question, option_a, option_b, option_c, option_d }));
  res.json({ ok: true, questions });
});

app.post('/api/student/quiz-submit', (req, res) => {
  const { studentId, videoId, answers } = req.body;
  const questions = readDB('quiz_questions').filter(q => q.video_id === videoId);
  let score = 0, choiceTotal = 0;
  const details = questions.map(q => {
    const ans = answers[q.id] || '';
    if (q.type === 'choice') {
      choiceTotal++;
      if (ans === q.correct) score++;
      return { questionId: q.id, type: 'choice', answer: ans, correct: ans === q.correct, correctAnswer: q.correct };
    }
    return { questionId: q.id, type: 'essay', answer: ans };
  });
  const results = readDB('quiz_results');
  results.push({ id: uuidv4(), student_id: studentId, video_id: videoId, score, total: choiceTotal, details, submitted_at: new Date().toISOString() });
  writeDB('quiz_results', results);
  res.json({ ok: true, score, total: choiceTotal, details });
});

app.listen(PORT, () => console.log('\n✅ Server running at http://localhost:' + PORT + '\n'));
