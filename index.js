const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_FILE = 'output.csv';

// --- Helper Functions ---
const cleanKey = (key) => key.trim().replace(/^\ufeff/, '').replace(/\s+/g, '_').toLowerCase();

// ฟังก์ชันลบคำนำหน้าชื่อ (เพื่อให้เทียบชื่อครูได้ตรงกัน)
const normalizeName = (name) => {
    if (!name) return '';
    return name.replace(/^(นาย|นางสาว|นาง|ครู|ว่าที่ร้อยตรี|ดร\.|ผศ\.)/g, '').trim().split(' ')[0]; 
};

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

function writeCSV(filePath, data) {
    const headers = ['group_id', 'timeslot_id', 'day', 'period', 'subject_id', 'teacher_id', 'room_id'];
    const csvContent = [
        headers.join(','), 
        ...data.map(row => headers.map(fieldName => row[fieldName]).join(','))
    ].join('\n');

    fs.writeFileSync(filePath, csvContent, 'utf8');
}

// ==========================================
// 🧠 AI SCHEDULER LOGIC
// ==========================================
async function generateTimetable() {
    console.log("🚀 Starting Scheduler Process (Distributed Days)...");
    
    // 1. Load Data
    const [subjects, teachers, rooms, groups, teach, register, timeslots] = await Promise.all([
        readCSV(path.join(DATA_DIR, 'subject.csv')),
        readCSV(path.join(DATA_DIR, 'teacher.csv')),
        readCSV(path.join(DATA_DIR, 'room.csv')),
        readCSV(path.join(DATA_DIR, 'student_group.csv')),
        readCSV(path.join(DATA_DIR, 'teach.csv')),
        readCSV(path.join(DATA_DIR, 'register.csv')),
        readCSV(path.join(DATA_DIR, 'timeslot.csv'))
    ]);

    // 2. Prepare Maps
    const subjectMap = {}; subjects.forEach(s => subjectMap[s.subject_id] = s);
    
    const teacherNameMap = {}; 
    teachers.forEach(t => {
        const clean = normalizeName(t.teacher_name);
        teacherNameMap[clean] = t.teacher_id;
    });
    
    const roomMap = {};
    const roomsByType = {};
    rooms.forEach(r => {
        roomMap[r.room_id] = r;
        if (!roomsByType[r.room_type]) roomsByType[r.room_type] = [];
        roomsByType[r.room_type].push(r.room_id);
    });
    
    const teacherSkills = {};
    teach.forEach(t => {
        if (!teacherSkills[t.subject_id]) teacherSkills[t.subject_id] = [];
        teacherSkills[t.subject_id].push(t.teacher_id);
    });

    const resourceUsage = { teacher: {}, room: {}, group: {} };
    const checkBusy = (type, id, day, period) => resourceUsage[type][id]?.[day]?.[period];
    
    const book = (gids, tid, rid, sid, d, p) => {
        gids.forEach(g => {
            if(!resourceUsage.group[g]) resourceUsage.group[g] = {};
            if(!resourceUsage.group[g][d]) resourceUsage.group[g][d] = {};
            resourceUsage.group[g][d][p] = true;
        });
        if(tid) {
            if(!resourceUsage.teacher[tid]) resourceUsage.teacher[tid] = {};
            if(!resourceUsage.teacher[tid][d]) resourceUsage.teacher[tid][d] = {};
            resourceUsage.teacher[tid][d][p] = true;
        }
        if(rid) {
            if(!resourceUsage.room[rid]) resourceUsage.room[rid] = {};
            if(!resourceUsage.room[rid][d]) resourceUsage.room[rid][d] = {};
            resourceUsage.room[rid][d][p] = true;
        }
    };

    const outputRows = [];
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

    // Constraint 10: Block Manager Meeting (Tue P8)
    teachers.forEach(t => {
        if (t.role === 'Manager') {
            book([], t.teacher_id, null, 'MEETING', 1, 8); 
        }
    });

    // Prepare Tasks
    let allTasks = [];
    const groupRegis = {};
    register.forEach(r => {
        if(!groupRegis[r.group_id]) groupRegis[r.group_id] = [];
        groupRegis[r.group_id].push(r.subject_id);
    });

    // รหัสวิชากิจกรรม
    const targetActivityIds = ['20000-2002', '20000-2005', '20000-2007', '30000-2002', '30000-2004'];

    for (const [gid, sids] of Object.entries(groupRegis)) {
        sids.forEach(sid => {
            const subj = subjectMap[sid];
            if (!subj) return;

            const isActivity = targetActivityIds.includes(sid);
            const isCommon = (sid.startsWith('20000') || sid.startsWith('30000')) && !isActivity;
            
            // เช็ค IOT
            const isIOT = sid.includes('IOT') || (subj.subject_name && subj.subject_name.includes('IOT'));

            if (parseInt(subj.theory) > 0) {
                allTasks.push({
                    groups: [gid], subject_id: sid, type: 'Theory', 
                    duration: isActivity ? 2 : 1, 
                    count: parseInt(subj.theory), isActivity, isCommon, isIOT, fixed: isActivity
                });
            }
            if (parseInt(subj.practice) > 0) {
                allTasks.push({
                    groups: [gid], subject_id: sid, type: 'Practice', 
                    duration: isActivity ? 2 : parseInt(subj.practice), 
                    count: 1, isActivity, isCommon, isIOT, fixed: isActivity
                });
            }
        });

        // Constraint 11: HOMEROOM
        const groupInfo = groups.find(g => g.group_id === gid);
        let advisorId = null;
        if(groupInfo && groupInfo.advisor) {
            const names = groupInfo.advisor.split('/').map(n => normalizeName(n));
            for(let n of names) {
                if(teacherNameMap[n]) { advisorId = teacherNameMap[n]; break; }
            }
        }
        allTasks.push({
            groups: [gid], subject_id: 'HOMEROOM', type: 'Theory', duration: 1, count: 1,
            isHomeroom: true, specificTeacher: advisorId
        });
    }

    // Constraint 13: Merge Common Tasks
    const mergedTasks = [];
    const usedIndices = new Set();
    allTasks.sort((a,b) => (b.fixed?1:0) - (a.fixed?1:0));

    for (let i = 0; i < allTasks.length; i++) {
        if (usedIndices.has(i)) continue;
        const taskA = allTasks[i];

        if (taskA.isCommon) {
            let partnerIdx = -1;
            for (let j = i + 1; j < allTasks.length; j++) {
                if (usedIndices.has(j)) continue;
                const taskB = allTasks[j];
                if (taskB.isCommon && taskB.subject_id === taskA.subject_id && taskB.type === taskA.type && taskB.duration === taskA.duration) {
                    partnerIdx = j;
                    break;
                }
            }
            if (partnerIdx !== -1) {
                taskA.groups.push(...allTasks[partnerIdx].groups);
                usedIndices.add(partnerIdx);
            }
        }
        mergedTasks.push(taskA);
        usedIndices.add(i);
    }

    // Scheduling Loop
    for (const task of mergedTasks) {
        let candidates = [];
        if (task.isHomeroom) {
            candidates = task.specificTeacher ? [task.specificTeacher] : ['T_UNKNOWN']; 
        } else {
            candidates = teacherSkills[task.subject_id] || [];
        }
        if (candidates.length === 0 && !task.isHomeroom) candidates = ['T_UNKNOWN'];

        let dayStart=0, dayEnd=4;
        let pStart=1, pEnd=10;
        
        // ล็อกเวลากิจกรรม (พุธ 8-9)
        if (task.isActivity) {
            dayStart=2; dayEnd=2; pStart=8; pEnd=8;
        }

        for (let c = 0; c < task.count; c++) {
            let placed = false;
            let tryDays = [0,1,2,3,4];

            if(task.isActivity) {
                tryDays = [2]; // กิจกรรมบังคับวันพุธ
            } else {
                // --- [ส่วนที่แก้ไข] สุ่มลำดับวันเพื่อกระจายวิชา ---
                // ถ้าไม่ใช่วิชาที่ล็อกวัน ให้สลับลำดับวันที่จะลองลง
                tryDays.sort(() => Math.random() - 0.5);
                // ---------------------------------------------
            }

            for (const d of tryDays) {
                if (placed) break;
                for (let p = pStart; p <= pEnd; p++) {
                    if (placed) break;
                    if (p === 5) continue;
                    if (p + task.duration - 1 > 10) continue; 

                    // ทฤษฎีห้ามหลังคาบ 9
                    if (task.type === 'Theory' && (p + task.duration - 1) >= 10) {
                        continue;
                    }
                    
                    let hitsLunch = false;
                    for(let t=0; t<task.duration; t++) if(p+t === 5) hitsLunch=true;
                    if(hitsLunch) continue;

                    let groupBusy = false;
                    for (const gid of task.groups) {
                        for(let t=0; t<task.duration; t++) {
                            if(checkBusy('group', gid, d, p+t)) groupBusy = true;
                        }
                    }
                    if (groupBusy) continue;

                    for (const tid of candidates) {
                        if (placed) break;
                        let teacherBusy = false;
                        if(tid !== 'T_UNKNOWN') {
                            for(let t=0; t<task.duration; t++) {
                                if(checkBusy('teacher', tid, d, p+t)) teacherBusy = true;
                            }
                        }
                        // อนุญาตให้ครูซ้อนได้เฉพาะวิชากิจกรรม
                        if (teacherBusy && !task.isActivity) continue;

                        let validRoom = null;
                        if (task.isHomeroom) {
                            validRoom = 'R_HOME'; 
                        } else if (task.isIOT) {
                            // IOT ต้องห้อง R6201
                            const rid = 'R6201';
                            if (roomMap[rid]) {
                                let roomBusy = false;
                                for(let t=0; t<task.duration; t++) {
                                    if(checkBusy('room', rid, d, p+t)) roomBusy = true;
                                }
                                if (!roomBusy || task.isActivity) validRoom = rid;
                            }
                        } else {
                            // ห้องปกติ (ทฤษฎี/ปฏิบัติ)
                            const targetTypes = task.type === 'Theory' ? ['Theory'] : ['Computer Lab','Network Lab','AI Lab','IOT Lab','Factory','English Lab','Computer Graphic Lab','Practice'];
                            for (const [rid, rdata] of Object.entries(roomMap)) {
                                if (rid === 'R6201') continue; // กันที่ให้ IOT

                                if (targetTypes.includes(rdata.room_type)) {
                                    let roomBusy = false;
                                    for(let t=0; t<task.duration; t++) {
                                        if(checkBusy('room', rid, d, p+t)) roomBusy = true;
                                    }
                                    if (!roomBusy || task.isActivity) { validRoom = rid; break; }
                                }
                            }
                        }

                        if (validRoom) {
                            for(let t=0; t<task.duration; t++) {
                                book(task.groups, tid, validRoom, task.subject_id, d, p+t);
                                const tsInfo = timeslots.find(ts => ts.day === days[d] && parseInt(ts.period) === p+t);
                                const tsId = tsInfo ? tsInfo.timeslot_id : `${days[d]}_${p+t}`;

                                task.groups.forEach(gid => {
                                    outputRows.push({
                                        group_id: gid,
                                        timeslot_id: tsId,
                                        day: days[d],
                                        period: p+t,
                                        subject_id: task.subject_id,
                                        teacher_id: tid === 'T_UNKNOWN' ? '' : tid,
                                        room_id: validRoom
                                    });
                                });
                            }
                            placed = true;
                        }
                    }
                }
            }
            if(!placed) console.warn(`Unscheduled: ${task.subject_id} for ${task.groups.join(',')}`);
        }
    }

    writeCSV(path.join(DATA_DIR, OUTPUT_FILE), outputRows);
    console.log('✅ Schedule generated and saved to output.csv');
}

generateTimetable();