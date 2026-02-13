const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');
const multer = require('multer');
const { exec } = require('child_process');
// ทดสอบ ci cd
const app = express();
const db = new Database('users.db');
const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_FILE = 'output.csv';
//test ci cd
// --- Database Init ---
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
if (!stmt.get('admin')) {
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('admin', 'password');
}

const settingStmt = db.prepare("SELECT * FROM settings WHERE key = ?");
if (!settingStmt.get('timetable_active')) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('timetable_active', '0');
}

// --- Multer Config ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
        cb(null, DATA_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- Middleware ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: 'secret-key', resave: false, saveUninitialized: true }));
app.use('/Prompt-Light.ttf', express.static(path.join(__dirname, 'Prompt-Light.ttf')));

const requireLogin = (req, res, next) => {
    if (req.session.user) next();
    else res.redirect('/login');
};

const cleanKey = (key) => key.trim().replace(/^\ufeff/, '').replace(/\s+/g, '_').toLowerCase();

function readCSV(filePath) {
    return new Promise((resolve) => {
        const results = [];
        if (!fs.existsSync(filePath)) { return resolve([]); }
        fs.createReadStream(filePath)
            .pipe(csv({ mapHeaders: ({ header }) => cleanKey(header) }))
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', (err) => { console.error(err); resolve([]); });
    });
}

// === ระบบตรวจจับชนิดไฟล์จาก Header (Auto Detect) ===
const FILE_SCHEMAS = {
    'subject.csv': ['subject_id', 'subject_name', 'theory', 'practice', 'credit'],
    'teacher.csv': ['teacher_id', 'teacher_name', 'role'],
    'room.csv': ['room_id', 'room_name', 'room_type'],
    'student_group.csv': ['group_id', 'group_name', 'student_count', 'advisor'],
    'timeslot.csv': ['timeslot_id', 'day', 'period', 'start', 'end'],
    'teach.csv': ['teacher_id', 'subject_id'],
    'register.csv': ['group_id', 'subject_id'],
    'output.csv': ['group_id', 'timeslot_id', 'day', 'period', 'subject_id', 'teacher_id', 'room_id']
};

function detectAndRenameFile(filePath) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        let headers = [];
        let isDetected = false;

        stream.pipe(csv({ mapHeaders: ({ header }) => cleanKey(header) }))
            .on('headers', (h) => {
                headers = h;
                stream.destroy();
                
                for (const [targetName, requiredCols] of Object.entries(FILE_SCHEMAS)) {
                    const isMatch = requiredCols.every(col => headers.includes(col));
                    if (isMatch) {
                        const newPath = path.join(path.dirname(filePath), targetName);
                        setTimeout(() => {
                            try {
                                fs.renameSync(filePath, newPath);
                                resolve({ success: true, type: targetName });
                            } catch (err) { reject(err); }
                        }, 100);
                        isDetected = true;
                        break;
                    }
                }
                if (!isDetected) {
                    try { fs.unlinkSync(filePath); } catch(e){}
                    resolve({ success: false, message: 'Unknown format' });
                }
            });
    });
}

// ==========================================
// Caching & Data Loading
// ==========================================
let CACHED_DATA = { ready: false };

async function loadAllData() {
    console.log('🔄 Server: Updating memory cache...');
    try {
        const outputP = path.join(DATA_DIR, OUTPUT_FILE);
        
        // โหลดไฟล์พื้นฐานรวมถึง Register
        const [subjects, teachers, rooms, timeslots, groups, register] = await Promise.all([
            readCSV(path.join(DATA_DIR, 'subject.csv')),
            readCSV(path.join(DATA_DIR, 'teacher.csv')),
            readCSV(path.join(DATA_DIR, 'room.csv')),
            readCSV(path.join(DATA_DIR, 'timeslot.csv')),
            readCSV(path.join(DATA_DIR, 'student_group.csv')),
            readCSV(path.join(DATA_DIR, 'register.csv')) 
        ]);

        // คำนวณจำนวนคาบที่ควรจะมี (Expected)
        let expectedTotalPeriods = 0;
        register.forEach(reg => {
            const sub = subjects.find(s => s.subject_id === reg.subject_id);
            if (sub) {
                expectedTotalPeriods += (parseInt(sub.theory || 0) + parseInt(sub.practice || 0));
            }
        });

        let outputData = [];
        if (fs.existsSync(outputP)) {
            outputData = await readCSV(outputP);
            console.log('📊 Found output.csv, loading schedule data.');
        }

        // === ส่วนที่เพิ่ม: ฟังชั่นเช็ควิชาที่หายไป ===
        let missingDetails = [];
        register.forEach(reg => {
            const sub = subjects.find(s => s.subject_id === reg.subject_id);
            if (sub) {
                const expected = (parseInt(sub.theory || 0) + parseInt(sub.practice || 0));
                // นับจำนวนคาบที่มีจริงใน output สำหรับกลุ่มและวิชานี้
                const actualCount = outputData.filter(row => 
                    row.group_id === reg.group_id && row.subject_id === reg.subject_id
                ).length;

                if (actualCount < expected) {
                    missingDetails.push({
                        group_id: reg.group_id,
                        subject_id: reg.subject_id,
                        subject_name: sub.subject_name,
                        count: expected - actualCount
                    });
                }
            }
        });

        const subMap = {}; 
        const subjectDetailsMap = {};
        subjects.forEach(s => {
            subMap[s.subject_id] = s.subject_name;
            subjectDetailsMap[s.subject_id] = { 
                name: s.subject_name, theory: s.theory, practice: s.practice, credit: s.credit 
            };
        });

        const teachMap = {}; teachers.forEach(t => teachMap[t.teacher_id] = t.teacher_name);
        const groupMap = {}; 
        const advisorMap = {};
        groups.forEach(g => {
            groupMap[g.group_id] = g.group_name;
            advisorMap[g.group_id] = g.advisor || '-';
        });

        const nameMap = {};
        groups.forEach(g => nameMap[g.group_id] = `${g.group_id} - ${g.group_name}`);
        teachers.forEach(t => nameMap[t.teacher_id] = `${t.teacher_id} - ${t.teacher_name}`);
        rooms.forEach(r => nameMap[r.room_id] = `${r.room_id} ${r.room_name?'- '+r.room_name:''}`);

        const dropdownLists = {
            group: groups.map(g => ({ id: g.group_id, name: nameMap[g.group_id] })),
            teacher: teachers.map(t => ({ id: t.teacher_id, name: nameMap[t.teacher_id] })),
            room: rooms.map(r => ({ id: r.room_id, name: nameMap[r.room_id] }))
        };

        const tsMap = {}; 
        const periodTimeMap = {};
        timeslots.forEach(ts => {
            const pid = parseInt(ts.period);
            tsMap[ts.timeslot_id] = { day: ts.day, period: pid };
            if(!periodTimeMap[pid]) periodTimeMap[pid] = `${ts.start}-${ts.end}`;
        });

        CACHED_DATA = { 
            ready: true, outputData, subjects, teachers, rooms, timeslots, groups,
            subMap, teachMap, groupMap, tsMap, advisorMap, nameMap, periodTimeMap, 
            subjectDetailsMap, dropdownLists,
            stats: { 
                expected: expectedTotalPeriods, 
                actual: outputData.length,
                missingDetails: missingDetails // ส่งข้อมูลวิชาที่หายไป
            } 
        };
        console.log(`✅ Cache refreshed: ${outputData.length}/${expectedTotalPeriods} periods.`);
    } catch (e) { console.error('Load Error:', e); }
}

loadAllData();

// --- Routes ---
app.get('/', (req, res) => res.redirect('/timetable'));

app.get('/management', requireLogin, (req, res) => {
    if (req.session.user.role !== 'admin') return res.redirect('/timetable');
    
    const { status, files: filesList, count, fail: failCount } = req.query;
    const serverLog = req.session.serverLog || '';
    delete req.session.serverLog;

    let existingFiles = [];
    try { if (fs.existsSync(DATA_DIR)) existingFiles = fs.readdirSync(DATA_DIR); } catch (err) {}

    res.render('management', { 
        user: req.session.user, 
        status, 
        filesList, 
        count, 
        failCount, 
        files: existingFiles,
        serverLog: serverLog,
        stats: CACHED_DATA.stats || { expected: 0, actual: 0, missingDetails: [] } 
    });
});

app.post('/admin/generate-timetable', requireLogin, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).send('Unauthorized');
    
    const requiredFiles = ['subject.csv', 'teacher.csv', 'room.csv', 'student_group.csv', 'timeslot.csv', 'teach.csv', 'register.csv'];
    const missingFiles = requiredFiles.filter(file => !fs.existsSync(path.join(DATA_DIR, file)));

    if (missingFiles.length > 0) {
        return res.redirect(`/management?status=missing_files&files=${missingFiles.join(', ')}`);
    }

    exec('node index.js', async (error, stdout, stderr) => {
        if (error) { 
            req.session.serverLog = `Error: ${error.message}`;
            return res.redirect('/management?status=error&msg=GenFailed'); 
        }
        req.session.serverLog = stdout; 
        await loadAllData();
        res.redirect('/management?status=gen_success');
    });
});

app.get('/login', (req, res) => {
    res.render('login', { error: null, teachers: CACHED_DATA.teachers || [], groups: CACHED_DATA.groups || [] });
});

app.post('/login', (req, res) => {
    const { loginType, username, password, teacherId, teacherName, groupId, groupName } = req.body;
    if (loginType === 'admin') {
        const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
        if (user) { req.session.user = { ...user, role: 'admin' }; res.redirect('/timetable'); }
        else res.redirect('/login?error=Invalid');
    } else if (loginType === 'teacher') {
        req.session.user = { id: teacherId, username: teacherName, role: 'teacher' };
        res.redirect('/timetable');
    } else if (loginType === 'student') {
        req.session.user = { id: groupId, username: groupName, role: 'student' };
        res.redirect('/timetable');
    }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.post('/admin/toggle-timetable', requireLogin, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).send('Unauthorized');
    const { status } = req.body;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'timetable_active'").run(status);
    res.redirect('/timetable');
});

app.post('/admin/delete-file', requireLogin, async (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).send('Unauthorized');
    const filename = req.body.filename;
    if (!filename || filename.includes('/') || filename.includes('\\')) {
        return res.redirect('/management?status=error');
    }
    const filePath = path.join(DATA_DIR, filename);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            await loadAllData(); 
        }
        res.redirect('/management?status=deleted');
    } catch (err) { res.redirect('/management?status=error'); }
});

app.get('/download-csv', requireLogin, (req, res) => {
    const file = path.join(DATA_DIR, OUTPUT_FILE);
    if (fs.existsSync(file)) res.download(file);
    else res.status(404).send('Not found');
});

app.post('/upload-csv', requireLogin, upload.array('csvFiles'), async (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).send('Unauthorized');
    if (!req.files || req.files.length === 0) return res.redirect('/management?status=error&msg=NoFiles');
    let successFiles = [];
    let failFiles = [];
    try {
        for (const file of req.files) {
            const result = await detectAndRenameFile(file.path);
            if (result.success) successFiles.push(result.type);
            else failFiles.push(file.originalname);
        }
        await loadAllData();
        if (successFiles.length > 0) {
            const status = failFiles.length > 0 ? 'partial' : 'success';
            res.redirect(`/management?status=${status}&count=${successFiles.length}&files=${successFiles.join(', ')}&fail=${failFiles.length}`);
        } else {
            res.redirect(`/management?status=error&msg=AllFailed`);
        }
    } catch (error) { res.redirect('/management?status=error'); }
});

app.get('/timetable', requireLogin, (req, res) => {
    const user = req.session.user;
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'timetable_active'").get();
    const isActive = setting ? (setting.value === '1') : false;
    let viewType = req.query.type || 'group';
    let selectedId = req.query.id || 'all';
    if (user.role === 'teacher') { viewType = 'teacher'; selectedId = user.id; }
    else if (user.role === 'student') { viewType = 'group'; selectedId = user.id; }
    const { outputData, subMap, teachMap, groupMap, tsMap, advisorMap, nameMap, periodTimeMap, subjectDetailsMap, dropdownLists } = CACHED_DATA;
    let scheduleData = {};
    if ((isActive || user.role === 'admin') && CACHED_DATA.ready) {
        outputData.forEach(row => {
            let itemKey = (viewType === 'group') ? row.group_id : (viewType === 'teacher') ? row.teacher_id : row.room_id;
            if (selectedId !== 'all' && itemKey !== selectedId) return;
            if (!itemKey) return;
            if (!scheduleData[itemKey]) scheduleData[itemKey] = {};
            const tsInfo = tsMap[row.timeslot_id] || { day: row.day, period: row.period };
            if (!scheduleData[itemKey][tsInfo.day]) scheduleData[itemKey][tsInfo.day] = {};
            scheduleData[itemKey][tsInfo.day][tsInfo.period] = {
                subject_id: row.subject_id,
                subject_name: subMap[row.subject_id] || row.subject_id,
                teacher_name: teachMap[row.teacher_id] || row.teacher_id,
                group_name: groupMap[row.group_id] || row.group_id,
                room_name: row.room_id
            };
        });
    }
    res.render('timetable', { user, viewType, selectedId, dropdownLists, scheduleData, periodTimeMap, nameMap, subjectDetailsMap, advisorMap, isTimetableActive: isActive });
});

const PORT = 80;
app.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });