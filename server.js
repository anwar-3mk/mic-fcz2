const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// تخزين البيانات في الذاكرة
let playersData = {}; // { userId: { socketId, pos: {x,y,z}, userId, isMuted, isDeafened } }
let linkCodes = {}; // { code: userId }
let pendingConfirmations = {}; // { userId: { socketId, timestamp } }

// --- [ مسارات الـ API للعبة روبلوكس ] ---

// 1. توليد كود ربط جديد (يطلبه سيرفر روبلوكس)
app.post('/generate_link', (req, res) => {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).send("بيانات غير مكتملة");
    
    const cleanCode = String(code).trim();
    linkCodes[cleanCode] = userId;
    console.log(`[Roblox] New Link Code: ${cleanCode} for User: ${userId}`);
    res.json({ success: true });
});

// 2. تحديث الإحداثيات واسترجاع طلبات التأكيد المعلقة
app.post('/update', (req, res) => {
    const { players } = req.body;
    let pendingList = [];
    let states = {};
    let radioMembers = {};

    if (players) {
        players.forEach(p => {
            // تحديث موقع وبيانات اللاعب إذا كان مرتبطاً بالمتصفح
            if (playersData[p.userId]) {
                playersData[p.userId].pos = p.pos;
                playersData[p.userId].frequency = p.frequency;
                playersData[p.userId].callsign = p.callsign;
                playersData[p.userId].isTransmitting = !!p.isTransmitting;
                playersData[p.userId].signalInfo = p.signalInfo; // تخزين معلومات الإشارة والبرج

                states[p.userId] = {
                    isMuted: !!playersData[p.userId].isMuted,
                    isDeafened: !!playersData[p.userId].isDeafened
                };
            }
            // التحقق من وجود طلب تحقق معلق للاعب
            if (pendingConfirmations[p.userId]) {
                pendingList.push({
                    userId: p.userId,
                    socketId: pendingConfirmations[p.userId].socketId
                });
            }
        });

        // تجميع قائمة المتصلين بالراديو لكل لاعب
        players.forEach(p => {
            const playerState = playersData[p.userId];
            if (playerState && playerState.frequency) {
                const myFreq = playerState.frequency;
                const members = Object.values(playersData)
                    .filter(other => other.userId !== p.userId && other.frequency === myFreq)
                    .map(other => ({
                        userId: other.userId,
                        callsign: other.callsign || `لاعب ${other.userId}`,
                        isTransmitting: !!other.isTransmitting
                    }));
                radioMembers[p.userId] = members;
            }
        });
    }

    // إرسال التحديثات لجميع المتصفحات المتصلة بالمايك
    io.emit('positions_updated', playersData);

    res.json({ 
        success: true, 
        pendingLinks: pendingList, 
        states: states,
        radioMembers: radioMembers
    });
});

// 3. استقبال موافقة أو رفض الربط من روبلوكس
app.post('/confirm_link', (req, res) => {
    const { userId, socketId, accepted } = req.body;
    const pending = pendingConfirmations[userId];

    if (pending && pending.socketId === socketId) {
        if (accepted) {
            // إتمام عملية الربط بنجاح
            playersData[userId] = {
                socketId: socketId,
                pos: { x: 0, y: 0, z: 0 },
                userId: userId,
                isMuted: false,
                isDeafened: false,
                frequency: null,
                callsign: "",
                isTransmitting: false,
                signalInfo: { closestTowerName: "None", distToTower: 99999, towerPos: {x:0, y:0, z:0} } // تهيئة افتراضية
            };

            // إعلام المتصفح بالنجاح
            io.to(socketId).emit('link_success', { userId });
            console.log(`[Success] Web Link Approved for Roblox User: ${userId} to Socket: ${socketId}`);
        } else {
            // إعلام المتصفح بالرفض
            io.to(socketId).emit('link_rejected', "تم رفض طلب الربط من داخل اللعبة.");
            console.log(`[Rejected] Web Link Rejected for Roblox User: ${userId}`);
        }
        delete pendingConfirmations[userId];
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, error: "لا يوجد طلب معلق مطابق" });
    }
});

// 4. خروج اللاعب من روبلوكس (إلغاء الربط وفصل المايك فورا)
app.post('/player_left', (req, res) => {
    const { userId } = req.body;
    console.log(`[Roblox] Player Left: ${userId}`);

    // حذف أي طلبات معلقة له
    if (pendingConfirmations[userId]) {
        const socketId = pendingConfirmations[userId].socketId;
        io.to(socketId).emit('link_rejected', "غادر اللاعب اللعبة.");
        delete pendingConfirmations[userId];
    }

    // حذف الربط وإبلاغ الكلاينت للفصل
    if (playersData[userId]) {
        const socketId = playersData[userId].socketId;
        io.to(socketId).emit('server_force_disconnect', "غادرت اللعبة، تم قطع اتصال المايك.");
        delete playersData[userId];
    }

    res.json({ success: true });
});

// 5. تحقق هل اللاعب مرتبط بالمتصفح أم لا
app.get('/is_linked/:userId', (req, res) => {
    const isLinked = !!playersData[req.params.userId];
    res.json({ linked: isLinked });
});

// 6. التحكم بالمايك من روبلوكس (كتم الصوت)
app.post('/toggle_mic', (req, res) => {
    const { userId, muted } = req.body;
    if (playersData[userId]) {
        playersData[userId].isMuted = muted;
        io.to(playersData[userId].socketId).emit('server_mute_toggle', muted);
        return res.json({ success: true });
    }
    res.status(404).json({ success: false });
});

// 7. التحكم بالسماعة من روبلوكس (عزل الصوت)
app.post('/toggle_deafen', (req, res) => {
    const { userId, deafened } = req.body;
    if (playersData[userId]) {
        playersData[userId].isDeafened = deafened;
        io.to(playersData[userId].socketId).emit('server_deafen_toggle', deafened);
        return res.json({ success: true });
    }
    res.status(404).json({ success: false });
});

// 8. التحكم بالإرسال السريع للراديو (Push-to-Talk) من روبلوكس
app.post('/toggle_ptt', (req, res) => {
    const { userId, transmitting } = req.body;
    if (playersData[userId]) {
        playersData[userId].isTransmitting = !!transmitting;
        // بث التحديث فوراً لجميع المتصفحات المتصلة لتقليل زمن استجابة الصوت
        io.emit('positions_updated', playersData);
        return res.json({ success: true });
    }
    res.status(404).json({ success: false });
});



// --- [ منطق اتصال الـ Socket للموقع ] ---

io.on('connection', (socket) => {
    console.log('Browser connected:', socket.id);

    // عندما يطلب المتصفح الربط باستخدام كود
    socket.on('link_account', (code) => {
        const cleanCode = String(code).trim();
        const userId = linkCodes[cleanCode];

        if (userId) {
            // تسجيل الطلب كمعلق وبانتظار موافقة اللاعب من روبلوكس
            pendingConfirmations[userId] = {
                socketId: socket.id,
                timestamp: Date.now()
            };
            socket.userId = userId;

            socket.emit('link_pending', "بانتظار موافقة اللاعب من داخل روبلوكس...");
            console.log(`[Pending] Web Link requested using code: ${cleanCode} for Roblox User: ${userId}`);
            
            // حذف الكود لعدم إعادة استخدامه
            delete linkCodes[cleanCode];
        } else {
            socket.emit('link_error', "كود الربط غير صحيح أو انتهت صلاحيته.");
        }
    });

    // مزامنة حالة كتم الصوت من المتصفح لروبلوكس
    socket.on('client_mute_toggle', (muted) => {
        if (socket.userId && playersData[socket.userId]) {
            playersData[socket.userId].isMuted = muted;
            console.log(`[Browser] User ${socket.userId} toggled Mute to: ${muted}`);
        }
    });

    // مزامنة حالة عزل الصوت من المتصفح لروبلوكس
    socket.on('client_deafen_toggle', (deafened) => {
        if (socket.userId && playersData[socket.userId]) {
            playersData[socket.userId].isDeafened = deafened;
            console.log(`[Browser] User ${socket.userId} toggled Deafen to: ${deafened}`);
        }
    });

    // تبادل بيانات الإشارة للـ WebRTC الصوت
    socket.on('signal', (data) => {
        io.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal,
            userId: socket.userId
        });
    });

    socket.on('disconnect', () => {
        console.log('Browser disconnected:', socket.id);
        
        // مسح الجلسة المعلقة إن وجدت
        for (const userId in pendingConfirmations) {
            if (pendingConfirmations[userId].socketId === socket.id) {
                delete pendingConfirmations[userId];
            }
        }

        // مسح الجلسة النشطة
        if (socket.userId && playersData[socket.userId]) {
            delete playersData[socket.userId];
            io.emit('player_disconnected', socket.id);
        }
    });
});

// تنظيف طلبات التأكيد المعلقة القديمة (أكثر من دقيقة)
setInterval(() => {
    const now = Date.now();
    for (const userId in pendingConfirmations) {
        if (now - pendingConfirmations[userId].timestamp > 60000) {
            io.to(pendingConfirmations[userId].socketId).emit('link_error', "انتهت مهلة التأكيد داخل روبلوكس.");
            delete pendingConfirmations[userId];
        }
    }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Web Proximity Voice Server running on port ${PORT}`);
});
