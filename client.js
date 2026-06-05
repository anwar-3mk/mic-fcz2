const socket = io();
let myStream = null;
let peers = {}; // { socketId: SimplePeer }
let myUserId = null;
let isMuted = false;
let isDeafened = false;
let audioCtx = null; // سياق صوتي عالمي موحد لتفادي كثرة الـ Contexts وتجاوز حد المتصفح

// عناصر واجهة المستخدم
const setupPanel = document.getElementById('setupPanel');
const pendingPanel = document.getElementById('pendingPanel');
const activePanel = document.getElementById('activePanel');
const linkCodeInput = document.getElementById('linkCode');
const startBtn = document.getElementById('startBtn');
const cancelPendingBtn = document.getElementById('cancelPendingBtn');
const globalPulse = document.getElementById('globalPulse');

const webMicBtn = document.getElementById('webMicBtn');
const webDeafBtn = document.getElementById('webDeafBtn');
const micStatusLbl = document.getElementById('micStatusLbl');
const deafStatusLbl = document.getElementById('deafStatusLbl');

const micProgressBar = document.getElementById('micProgressBar');
const dBValue = document.getElementById('dBValue');
const playersNearbyContainer = document.getElementById('playersNearby');
const logsContainer = document.getElementById('logs');
const clearLogsBtn = document.getElementById('clearLogsBtn');

// دالة إضافة السجلات
function addLog(msg, type = 'system') {
    const time = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    div.innerHTML = `[${time}] ${msg}`;
    logsContainer.insertBefore(div, logsContainer.firstChild);
}

// مسح السجلات
clearLogsBtn.onclick = () => {
    logsContainer.innerHTML = `<div class="log-entry system">تم تفريغ السجلات...</div>`;
};

// التنقل بين اللوحات
function showPanel(panel) {
    [setupPanel, pendingPanel, activePanel].forEach(p => {
        p.classList.remove('show');
        setTimeout(() => { if (!p.classList.contains('show')) p.style.display = 'none'; }, 300);
    });
    
    setTimeout(() => {
        panel.style.display = 'flex';
        setTimeout(() => panel.classList.add('show'), 50);
    }, 350);
}

// مؤشر قياس مستوى الصوت للمايك المفتوح
function setupMicVisualizer(stream) {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        const analyser = audioCtx.createAnalyser();
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.fftSize = 256;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        function update() {
            if (isMuted) {
                micProgressBar.style.width = '0%';
                dBValue.innerText = '0%';
                requestAnimationFrame(update);
                return;
            }
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for(let i=0; i<dataArray.length; i++) sum += dataArray[i];
            let average = sum / dataArray.length;
            let percent = Math.min(100, Math.floor(average * 2.8));
            micProgressBar.style.width = percent + '%';
            dBValue.innerText = percent + '%';
            requestAnimationFrame(update);
        }
        update();
    } catch (e) {
        console.error("Failed to setup audio visualizer:", e);
    }
}

// البدء وطلب المايك ثم الربط
startBtn.onclick = async () => {
    // تهيئة سياق الصوت العالمي الموحد فور نقر الزر (تفاعل المستخدم)
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    const code = linkCodeInput.value.trim();
    if (code.length !== 4) {
        addLog("يرجى إدخال الكود المكون من 4 أرقام أولاً.", "error");
        return;
    }

    try {
        addLog("جاري طلب صلاحيات المايكروفون...", "system");
        myStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        addLog("تم تفعيل المايك بنجاح ✅", "success");
        
        setupMicVisualizer(myStream);
        
        // إرسال طلب الربط للسيرفر
        socket.emit('link_account', code);
    } catch (err) {
        addLog("⚠️ فشل الوصول للمايكروفون (قد يكون غير مدعوم على هذا الجهاز).", "warning");
        const confirmListen = confirm("فشل تشغيل المايكروفون (جهازك قد لا يدعم الوصول للمايك في المتصفح مثل PlayStation).\n\nهل تريد الاتصال في 'وضع الاستماع فقط' لتسمع الآخرين دون التحدث؟");
        if (confirmListen) {
            myStream = null; // لا يوجد مايكروفون
            setMuteState(true); // كتم افتراضي
            addLog("تم تفعيل وضع الاستماع فقط 🔇 (تستمع للآخرين ولا يمكنهم سماعك)", "success");
            socket.emit('link_account', code);
        } else {
            addLog("تم إلغاء الاتصال لعدم توفر صلاحية المايك.", "error");
        }
    }
};

// استئناف عمل قنوات الصوت عند أي نقرة بالصفحة لتفادي سياسة حظر التشغيل التلقائي للمتصفحات
document.body.addEventListener('click', () => {
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => {
            console.log("Global AudioContext resumed successfully via user click.");
        });
    }
});

// إلغاء الانتظار
cancelPendingBtn.onclick = () => {
    socket.emit('disconnect_client'); // فصل وهمي لإعادة التصفير
    window.location.reload();
};

// أحداث الربط والاتصال
socket.on('link_pending', (msg) => {
    addLog(msg, "warning");
    globalPulse.className = "status-pulse pending";
    showPanel(pendingPanel);
});

socket.on('link_success', (data) => {
    myUserId = data.userId;
    addLog(`تم قبول الربط بنجاح! مرتبط بحساب اللاعب: ${myUserId}`, "success");
    globalPulse.className = "status-pulse linked";
    showPanel(activePanel);
});

socket.on('link_rejected', (msg) => {
    addLog(`❌ تم إلغاء/رفض الاتصال: ${msg}`, "error");
    globalPulse.className = "status-pulse";
    showPanel(setupPanel);
    alert(msg);
});

socket.on('link_error', (msg) => {
    addLog(`❌ خطأ: ${msg}`, "error");
    globalPulse.className = "status-pulse";
    showPanel(setupPanel);
    alert(msg);
});

socket.on('server_force_disconnect', (msg) => {
    addLog(`⚠️ فصل اتصالات السيرفر: ${msg}`, "error");
    globalPulse.className = "status-pulse";
    showPanel(setupPanel);
    if (myStream) {
        myStream.getTracks().forEach(track => track.stop());
    }
    alert(msg);
});

// استقبال حالة كتم المايك من سيرفر روبلوكس
socket.on('server_mute_toggle', (muted) => {
    setMuteState(muted);
    addLog(`تم مزامنة كتم المايك من اللعبة: ${muted ? 'مكتوم 🔇' : 'مفتوح 🎙️'}`, "system");
});

// استقبال حالة عزل الصوت من سيرفر روبلوكس
socket.on('server_deafen_toggle', (deafened) => {
    setDeafenState(deafened);
    addLog(`تم مزامنة عزل الصوت من اللعبة: ${deafened ? 'معزول 🎧' : 'مسموع 🔊'}`, "system");
});

// دوال التحكم بالمايكروفون محلياً
function setMuteState(muted) {
    isMuted = muted;
    if (myStream) {
        myStream.getAudioTracks().forEach(track => track.enabled = !muted);
    }
    
    if (isMuted) {
        webMicBtn.classList.add('active-red');
        webMicBtn.classList.remove('active-green');
        micStatusLbl.innerText = "مكتوم";
        micStatusLbl.className = "status-lbl red";
    } else {
        webMicBtn.classList.remove('active-red');
        webMicBtn.classList.add('active-green');
        micStatusLbl.innerText = "مفتوح";
        micStatusLbl.className = "status-lbl green";
    }
}

function setDeafenState(deafened) {
    isDeafened = deafened;
    
    // كتم/تشغيل جميع الأصوات المستقبلة
    Object.values(peers).forEach(peer => {
        if (peer.audioElement) {
            peer.audioElement.muted = deafened;
        }
    });

    if (isDeafened) {
        webDeafBtn.classList.add('active-red');
        webDeafBtn.classList.remove('active-green');
        deafStatusLbl.innerText = "معزول";
        deafStatusLbl.className = "status-lbl red";
    } else {
        webDeafBtn.classList.remove('active-red');
        webDeafBtn.classList.add('active-green');
        deafStatusLbl.innerText = "ملغي";
        deafStatusLbl.className = "status-lbl green";
    }
}

// الضغط على أزرار المتصفح
webMicBtn.onclick = () => {
    if (!myStream) {
        addLog("❌ لا يمكنك إلغاء الكتم في وضع الاستماع فقط لعدم وجود مايكروفون.", "error");
        alert("المايكروفون غير متصل أو غير مدعوم في هذا المتصفح (وضع الاستماع فقط).");
        return;
    }
    const newState = !isMuted;
    setMuteState(newState);
    socket.emit('client_mute_toggle', newState);
    addLog(`قمت بكتم المايك من المتصفح: ${newState}`, "system");
};

webDeafBtn.onclick = () => {
    const newState = !isDeafened;
    setDeafenState(newState);
    socket.emit('client_deafen_toggle', newState);
    addLog(`قمت بتفعيل العزل من المتصفح: ${newState}`, "system");
};


// --- [ منطق الـ WebRTC وتحديد المواقع والصوت المحيطي ] ---

socket.on('signal', (data) => {
    if (isDeafened) return; // لا نربط إشارات صوتية إذا كان معزولاً
    if (!peers[data.from]) {
        addLog("توصيل بث صوتي ثلاثي الأبعاد مع لاعب...", "system");
        peers[data.from] = createPeer(data.from, false);
    }
    peers[data.from].signal(data.signal);
});

// تحديث المواقع وعرض اللاعبين القريبين وحساب الصوت المحيطي والراديو
socket.on('positions_updated', (allPlayers) => {
    if (!myUserId || !allPlayers[myUserId]) return;
    
    const myState = allPlayers[myUserId];
    const myPos = myState.pos;
    const myFreq = myState.frequency;
    
    const nearbyList = [];
    
    // فلترة وحساب اللاعبين القريبين والمتصلين بالراديو
    Object.values(allPlayers).forEach(player => {
        if (player.userId === myUserId || !player.socketId) return;
        
        const d = Math.sqrt(
            Math.pow(player.pos.x - myPos.x, 2) +
            Math.pow(player.pos.y - myPos.y, 2) +
            Math.pow(player.pos.z - myPos.z, 2)
        );

        const isNearby = (d < 60);
        const onSameRadio = (myFreq && myFreq === player.frequency);

        if (isNearby || onSameRadio) {
            // إدراج اللاعبين القريبين في واجهة المتصفح فقط
            if (isNearby) {
                nearbyList.push({
                    userId: player.userId,
                    socketId: player.socketId,
                    distance: Math.floor(d)
                });
            }

            // إنشاء Peer إذا لم يكن موجوداً
            if (!peers[player.socketId] && socket.id < player.socketId) {
                addLog(`بدء الاتصال الصوتي مع اللاعب ${player.userId} (محيطي/راديو)...`, "system");
                peers[player.socketId] = createPeer(player.socketId, true);
            }

            // --- [ حساب جودة إشارة أبراج الراديو ] ---
            const mySignal = myState.signalInfo || { closestTowerName: "None", distToTower: 99999, towerPos: {x:0, y:0, z:0} };
            const peerSignal = player.signalInfo || { closestTowerName: "None", distToTower: 99999, towerPos: {x:0, y:0, z:0} };

            // التحقق من تواجد اللاعبين معاً داخل الدوائر الحمراء (القطر 5 بلاطات والمدى الأقصى للبرج هو نصف القطر 2.5)
            const isMyPlayerInCircle = (mySignal.closestTowerName !== "None" && mySignal.distToTower <= 2.5);
            const isPeerPlayerInCircle = (peerSignal.closestTowerName !== "None" && peerSignal.distToTower <= 2.5);

            // حساب جودة الرابط الصوتي للراديو
            let transmissionQuality = 0;
            if (isMyPlayerInCircle && isPeerPlayerInCircle) {
                let baseQuality = 1.0;
                if (mySignal.closestTowerName !== peerSignal.closestTowerName) {
                    // تقليل جودة الاتصال بناءً على مسافة البرجين عن بعضهما (الحد الأقصى للتغطية البينية هو 550 بلاطة)
                    let towerDist = Math.sqrt(
                        Math.pow(mySignal.towerPos.x - peerSignal.towerPos.x, 2) +
                        Math.pow(mySignal.towerPos.z - peerSignal.towerPos.z, 2)
                    );
                    // جودة تدرجية بين 1.0 (صافي) إلى 0.12 (مغبش لاسلكي وصوت ضعيف ومفهوم بصعوبة)
                    baseQuality = Math.max(0.12, 1.0 - (towerDist / 550));
                }
                transmissionQuality = baseQuality;
            } else {
                transmissionQuality = 0; // مقطوع بالكامل إذا كان أحد الطرفين خارج أي دائرة حمراء
            }

            // حساب مستوى الصوت المحيطي الطبيعي (يعمل في أي مكان بشكل مستقل عن الأبراج)
            let proximityVolume = 0;
            if (isNearby && !player.isMuted) {
                proximityVolume = Math.pow(Math.max(0, 1 - (d / 60)), 0.6);
            }

            // حساب مستوى صوت الراديو (يتأثر بالأبراج والمسافة)
            let radioVolume = 0;
            const isRadioActive = (onSameRadio && player.isTransmitting && !player.isMuted);
            if (isRadioActive) {
                radioVolume = 1.0 * transmissionQuality;
            }

            if (isDeafened) {
                proximityVolume = 0;
                radioVolume = 0;
            }

            // تحديد الصوت النهائي والتشويش والفلترة
            let finalVolume = 0;
            if (isRadioActive) {
                finalVolume = Math.max(proximityVolume, radioVolume);
            } else {
                finalVolume = proximityVolume;
            }

            if (peers[player.socketId]) {
                const nodes = peers[player.socketId].audioNodes;
                if (nodes) {
                    // 1. تطبيق الكسب الرئيسي (الصوت النهائي)
                    nodes.mainGain.gain.value = finalVolume;
                    
                    if (finalVolume > 0) {
                        if (isRadioActive) {
                            // 2. فلتر التغبيش للراديو (تخفيض الترددات كلما ضعفت الإشارة)
                            nodes.filter.type = 'lowpass';
                            nodes.filter.frequency.value = 600 + (transmissionQuality * 3400);
                            
                            // 3. تشغيل صوت التشويش اللاسلكي للراديو
                            nodes.noiseGain.gain.value = (1.0 - transmissionQuality) * 0.04;
                        } else {
                            // صوت محيطي طبيعي (صافي بالكامل وبدون أي تشويش راديو - يتم تحويل الفلتر إلى allpass لإلغاء أي تشويه أو تلوين للصوت)
                            nodes.filter.type = 'allpass';
                            nodes.noiseGain.gain.value = 0.0;
                        }
                    } else {
                        nodes.noiseGain.gain.value = 0.0;
                    }
                } else if (peers[player.socketId].audioElement) {
                    peers[player.socketId].audioElement.volume = finalVolume;
                }
            }
        } else {
            // حذف الاتصال إذا ابتعد اللاعب وليس على نفس موجة الراديو
            if (peers[player.socketId]) {
                addLog(`قطع الاتصال الصوتي مع اللاعب ${player.userId}.`, "warning");
                destroyPeer(player.socketId);
            }
        }
    });

    // تحديث واجهة اللاعبين القريبين
    updatePlayersUI(nearbyList);
});

// عند فصل لاعب
socket.on('player_disconnected', (socketId) => {
    if (peers[socketId]) {
        addLog("غادر أحد اللاعبين نطاقك تماماً.", "warning");
        destroyPeer(socketId);
    }
});

function createPeer(targetId, initiator) {
    const peer = new SimplePeer({
        initiator: initiator,
        stream: myStream || undefined,
        trickle: false,
        config: { 
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ]
        }
    });

    peer.on('signal', (sig) => {
        socket.emit('signal', { to: targetId, signal: sig });
    });

    peer.on('stream', (stream) => {
        addLog("تم الاتصال الصوتي بنجاح! الصوت المحيطي مفعل.", "success");
        
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.volume = 1.0; // نضع الصوت 1.0 ليبقى مسار الميديا نشطاً بالمتصفح
        audio.muted = false;
        
        audio.play().catch(e => console.log("Autoplay blocked, waiting for click."));
        // تنبيه: لا نلحق عنصر الصوت بالـ DOM مطلقاً لمنع متصفح كروم من تشغيل الصوت الخام وتسريبه
        peer.audioElement = audio;
        
        // إعداد عقد الـ Web Audio API بالبث مباشرة لتجنب كتم الصوت في متصفح كروم والتسريب
        setupPeerAudioNodes(targetId, stream);
    });

    peer.on('error', (err) => {
        console.error("Peer connection error:", err);
        destroyPeer(targetId);
    });

    return peer;
}

function destroyPeer(socketId) {
    if (peers[socketId]) {
        try {
            if (peers[socketId].audioElement) {
                try {
                    peers[socketId].audioElement.pause();
                    peers[socketId].audioElement.srcObject = null;
                } catch(e) {}
            }
            // فصل العقد ومولد الوشوشة لمنع تسريب الذاكرة دون إغلاق الـ Context العالمي
            if (peers[socketId].audioNodes) {
                try {
                    peers[socketId].audioNodes.noiseSource.stop();
                } catch (err) {}
                try {
                    peers[socketId].audioNodes.source.disconnect();
                    peers[socketId].audioNodes.filter.disconnect();
                    peers[socketId].audioNodes.noiseGain.disconnect();
                    peers[socketId].audioNodes.mainGain.disconnect();
                } catch (err) {}
            }
            peers[socketId].destroy();
        } catch (e) {}
        delete peers[socketId];
    }
}

// دالة بناء فلاتر ومولد الوشوشة التكتيكية للراديو (Web Audio API)
function setupPeerAudioNodes(peerSocketId, stream) {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        
        // استخدام createMediaStreamSource على البث مباشرة
        const source = audioCtx.createMediaStreamSource(stream);
        
        // 1. فلتر التغبيش وراديو walkie-talkie (نبدأ بنوع allpass ليكون الصوت المحيطي صافياً بالكامل افتراضياً)
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'allpass';
        filter.frequency.value = 12000; 
        
        // 2. إنشاء مولد وشوشة راديو لاسلكي (White Noise Buffer)
        const bufferSize = 2 * audioCtx.sampleRate;
        const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        
        const noiseSource = audioCtx.createBufferSource(noiseBuffer);
        noiseSource.loop = true;
        
        const noiseGain = audioCtx.createGain();
        noiseGain.gain.value = 0.0; // بدون تشويش في البداية
        
        // توصيل الأجهزة
        noiseSource.connect(noiseGain);
        
        // عقدة التحكم في كسب الصوت الرئيسي
        const mainGain = audioCtx.createGain();
        mainGain.gain.value = 1.0;
        
        // ربط القنوات
        source.connect(filter);
        filter.connect(mainGain);
        noiseGain.connect(mainGain);
        
        // التوصيل بسماعة العميل النهائية
        mainGain.connect(audioCtx.destination);
        noiseSource.start();
        
        // حفظ العقد لتحديثها حيوياً لاحقاً
        peers[peerSocketId].audioNodes = {
            source: source,
            filter: filter,
            noiseSource: noiseSource,
            noiseGain: noiseGain,
            mainGain: mainGain
        };
        console.log("Audio graph nodes setup successfully for peer using stream directly:", peerSocketId);
    } catch (e) {
        console.error("Failed to setup Web Audio nodes for peer:", e);
    }
}

function updatePlayersUI(list) {
    if (list.length === 0) {
        playersNearbyContainer.innerHTML = `
            <div class="no-players">
                <i class="fa-solid fa-users-slash"></i>
                <p>لا يوجد لاعبين قريبين منك حالياً</p>
            </div>
        `;
        return;
    }

    playersNearbyContainer.innerHTML = "";
    list.forEach(p => {
        const card = document.createElement('div');
        card.className = "player-card";
        card.innerHTML = `
            <div class="player-info">
                <div class="player-avatar">
                    <i class="fa-solid fa-user"></i>
                </div>
                <span class="player-name">لاعب روبلوكس (${p.userId})</span>
            </div>
            <span class="player-status speaking">
                <i class="fa-solid fa-volume-high"></i>
                <span>على بعد ${p.distance}m</span>
            </span>
        `;
        playersNearbyContainer.appendChild(card);
    });
}
