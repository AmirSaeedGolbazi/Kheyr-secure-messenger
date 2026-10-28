(async function () {
    if (typeof nacl === 'undefined') { console.error('tweetnacl بارگذاری نشد'); return; }

    if (typeof checkCodeIntegrity === 'function') {
        const result = await checkCodeIntegrity();
        if (!result.ok) return;
    }

    const roomEl = document.getElementById('room-data');
    if (!roomEl) return;
    const room = JSON.parse(roomEl.textContent);
    if (!room || !room.id) return;

    const me = window.APP.me;
    if (!me.id) return;

    const sessionActive = sessionStorage.getItem('chat_username');
    if (!sessionActive) { try { await KeyDB.clear(); } catch (e) {} }

    const username = window.APP.me.username || sessionStorage.getItem('chat_username') || '';
    if (!username) { window.location.href = '/accounts/login/'; return; }

    function getCookie(name) {
        const v = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
        return v ? v.pop() : '';
    }

    const AUTO_LOCK_MS = 10 * 60 * 1000;
    let autoLockTimer = null;
    let isLocked = false;
    function lockNow() {
        if (isLocked) return;
        isLocked = true;
        try { KeyDB.clear(); } catch (e) {}
        sessionStorage.removeItem('chat_password_temp');
        sessionStorage.removeItem('chat_username');
        alert('به دلیل ۱۰ دقیقه بی‌فعالیتی، پیام‌رسان قفل شد.');
        window.location.href = '/accounts/login/';
    }
    function resetAutoLock() {
        if (isLocked) return;
        if (autoLockTimer) clearTimeout(autoLockTimer);
        autoLockTimer = setTimeout(lockNow, AUTO_LOCK_MS);
    }
    ['click', 'keydown', 'mousemove', 'touchstart', 'scroll', 'wheel'].forEach(evt => {
        document.addEventListener(evt, resetAutoLock, { passive: true });
    });
    resetAutoLock();

    let knownEpoch = null;
    async function checkEpoch() {
        try {
            const d = await (await fetch('/accounts/api/wipe-status/')).json();
            if (knownEpoch === null) { knownEpoch = d.epoch; return false; }
            if (d.epoch !== knownEpoch) {
                for (const k of Object.keys(sessionStorage)) if (k.startsWith('chat_')) sessionStorage.removeItem(k);
                try { await KeyDB.clear(); } catch (e) {}
                alert('داده‌ها پاک شدند.');
                window.location.href = '/accounts/login/';
                return true;
            }
        } catch (e) {}
        return false;
    }
    if (await checkEpoch()) return;
    setInterval(checkEpoch, 10000);

    let myKeyPair = null;

    try {
        const seedB64 = await KeyDB.get('seed_' + username);
        if (seedB64) {
            const seed = CryptoHelpers.secretKeyFromB64(seedB64);
            myKeyPair = CryptoHelpers.keyPairFromSeed(seed);
        }
    } catch (e) {}

    if (!myKeyPair) {
        let pwd = sessionStorage.getItem('chat_password_temp');
        if (!pwd) {
            const reenterBox = document.getElementById('reenter-pwd');
            const reenterInput = document.getElementById('reenter-pwd-input');
            const reenterBtn = document.getElementById('reenter-pwd-btn');
            reenterBox.style.display = 'block';
            await new Promise((resolve) => {
                reenterBtn.addEventListener('click', () => {
                    const v = reenterInput.value;
                    if (!v) return;
                    sessionStorage.setItem('chat_password_temp', v);
                    reenterInput.value = '';
                    reenterBox.style.display = 'none';
                    resolve();
                });
                reenterInput.addEventListener('keydown', e => { if (e.key === 'Enter') reenterBtn.click(); });
            });
            pwd = sessionStorage.getItem('chat_password_temp');
        }

        const keys = await (await fetch('/accounts/api/my-keys/')).json();
        if (!keys.crypto_salt) {
            alert('salt یافت نشد. دوباره وارد شوید.');
            window.location.href = '/accounts/login/';
            return;
        }

        const seed = await CryptoHelpers.deriveSeed(username, pwd, keys.crypto_salt);
        myKeyPair = CryptoHelpers.keyPairFromSeed(seed);
        await KeyDB.set('seed_' + username, CryptoHelpers.secretKeyToB64(seed));

        const newPubB64 = CryptoHelpers.publicKeyToB64(myKeyPair.publicKey);
        if (keys.public_key !== newPubB64) {
            await fetch('/accounts/api/set-public-key/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCookie('csrftoken') },
                body: JSON.stringify({ public_key: newPubB64 }),
            });
        }
    }

    window.__MY_KEYPAIR = myKeyPair;

    document.getElementById('chat-input-row').style.display = 'flex';

    let memberPublicKeys = {};

    try {
        const mk = await (await fetch(`/api/room/${room.id}/members-public-keys/`)).json();
        for (const [uid, pub] of Object.entries(mk.keys)) {
            if (!pub) continue;
            memberPublicKeys[uid] = pub;
        }
    } catch (e) { console.error(e); }

    const log = document.getElementById('chat-log');
    function appendTextMsg(username, text, mine) {
        const div = document.createElement('div');
        div.className = 'msg ' + (mine ? 'mine' : 'other');
        const s = document.createElement('div'); s.className = 'sender'; s.textContent = username;
        const t = document.createElement('div'); t.textContent = text;
        div.appendChild(s); div.appendChild(t);
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
    }
    function appendFileMsg(username, fileName, fileId, iv, encryptedKeys, mimeType, mine) {
        const div = document.createElement('div');
        div.className = 'msg ' + (mine ? 'mine' : 'other');
        const s = document.createElement('div'); s.className = 'sender'; s.textContent = username;
        const t = document.createElement('div'); t.textContent = `📎 ${fileName} `;
        const btn = document.createElement('button');
        btn.textContent = 'دانلود'; btn.className = 'btn-small';
        btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = '...';
            try {
                const resp = await fetch(`/api/file/${fileId}/download/`);
                const ctBuf = await resp.arrayBuffer();
                const ek = encryptedKeys[String(me.id)];
                if (!ek) throw new Error('کلید این فایل برای شما نیست');
                const ptBuf = await CryptoHelpers.decryptFile(ctBuf, iv, ek, myKeyPair);
                const blob = new Blob([ptBuf], { type: mimeType || 'application/octet-stream' });
                if (mimeType && mimeType.startsWith('image/')) {
                    const u = URL.createObjectURL(blob);
                    const img = document.createElement('img');
                    img.src = u; img.style.maxWidth = '100%'; img.style.marginTop = '6px';
                    t.appendChild(img);
                }
                const u2 = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = u2; a.download = fileName;
                document.body.appendChild(a); a.click(); a.remove();
                btn.textContent = 'دانلود مجدد'; btn.disabled = false;
            } catch (err) {
                alert('خطا: ' + err.message);
                btn.textContent = 'تلاش مجدد'; btn.disabled = false;
            }
        });
        t.appendChild(btn);
        div.appendChild(s); div.appendChild(t);
        log.appendChild(div);
    }
    async function renderMessage(m) {
        if (m.file_name && m.file_id) {
            appendFileMsg(m.sender_username, m.file_name, m.file_id, m.iv, m.encrypted_keys, m.mime_type, m.sender_id === me.id);
            return;
        }
        const text = await CryptoHelpers.decryptMessage(m, myKeyPair, me.id);
        appendTextMsg(m.sender_username, text, m.sender_id === me.id);
    }

    try {
        const hdata = await (await fetch(`/api/room/${room.id}/messages/`)).json();
        for (const m of hdata.messages) await renderMessage(m);
    } catch (e) {}

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/chat/${room.id}/`);

    const groupUI = {
        btnCallGroup: document.getElementById('btn-call-group'),
        box: document.getElementById('group-call-box'),
        localBox: document.getElementById('lk-local-box'),
        hangup: document.getElementById('group-hangup'),
        toggleMic: document.getElementById('group-toggle-mic'),
        toggleCam: document.getElementById('group-toggle-cam'),
        inviteBox: document.getElementById('group-invite-box'),
        inviteFrom: document.getElementById('group-invite-from'),
        inviteJoin: document.getElementById('group-invite-join'),
        inviteIgnore: document.getElementById('group-invite-ignore'),
    };

    async function startGroupCall() {
        const aesKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
        );
        const rawAes = new Uint8Array(await crypto.subtle.exportKey('raw', aesKey));
        const senderPubB64 = CryptoHelpers.publicKeyToB64(myKeyPair.publicKey);
        const encryptedKeys = {};
        for (const [uid, pubB64] of Object.entries(memberPublicKeys)) {
            const theirPub = CryptoHelpers.publicKeyFromB64(pubB64);
            const nonce = nacl.randomBytes(nacl.box.nonceLength);
            const boxed = nacl.box(rawAes, nonce, theirPub, myKeyPair.secretKey);
            encryptedKeys[uid] = {
                nonce: CryptoHelpers.b64(nonce),
                box: CryptoHelpers.b64(boxed),
                sender_pub: senderPubB64,
            };
        }
        const res = await fetch(`/api/room/${room.id}/create-call-session/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCookie('csrftoken') },
            body: JSON.stringify({ encrypted_keys: encryptedKeys }),
        });
        if (!res.ok) throw new Error('create session failed: ' + res.status);
        const data = await res.json();
        ws.send(JSON.stringify({ type: 'call_group_invite', call_session_id: data.call_session_id }));
        await joinGroupCall(data.call_session_id);
    }

    async function joinGroupCall(callSessionId) {
        try {
            const res = await fetch(`/api/room/${room.id}/livekit-token/${callSessionId}/`);
            if (!res.ok) throw new Error('token failed: ' + res.status);
            const data = await res.json();
            groupUI.box.style.display = 'block';
            await GroupCallE2EE.join({
                token: data.token, url: data.url,
                encryptedKeyObj: data.encrypted_aes_key_for_me,
                myKeyPair: myKeyPair,
                callSessionId: callSessionId,
                onStateChange: (s) => { if (s === 'idle') groupUI.box.style.display = 'none'; },
            });
        } catch (e) {
            alert('خطا در ورود به تماس: ' + e.message);
            groupUI.box.style.display = 'none';
        }
    }

    groupUI.btnCallGroup.addEventListener('click', async () => {
        try { await startGroupCall(); } catch (e) { alert('خطا: ' + e.message); }
    });
    groupUI.inviteJoin.addEventListener('click', async () => {
        const sid = groupUI.inviteBox.dataset.sessionId;
        groupUI.inviteBox.style.display = 'none';
        if (sid) await joinGroupCall(parseInt(sid, 10));
    });
    groupUI.inviteIgnore.addEventListener('click', () => { groupUI.inviteBox.style.display = 'none'; });
    groupUI.hangup.addEventListener('click', async () => { await GroupCallE2EE.leave(); });
    groupUI.toggleMic.addEventListener('click', () => GroupCallE2EE.toggleMic());
    groupUI.toggleCam.addEventListener('click', () => GroupCallE2EE.toggleCam());

    ws.onmessage = async (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'chat_message') { await renderMessage(data); return; }
        if (data.type === 'call_group_invite') {
            if (Number(data.from) === Number(me.id)) return;
            if (GroupCallE2EE.active) return;
            groupUI.inviteFrom.textContent = data.from_username;
            groupUI.inviteBox.dataset.sessionId = data.call_session_id;
            groupUI.inviteBox.style.display = 'block';
            return;
        }
    };

    async function sendText() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;
        if (!Object.keys(memberPublicKeys).length) { alert('کلید عمومی نیست.'); return; }
        try {
            const enc = await CryptoHelpers.encryptForMembers(text, memberPublicKeys);
            ws.send(JSON.stringify({ type: 'chat_message', ...enc }));
            input.value = '';
        } catch (err) { alert('خطا: ' + err.message); }
    }
    document.getElementById('chat-send').addEventListener('click', sendText);
    document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });

    const fileInput = document.getElementById('chat-file');
    const attachBtn = document.getElementById('chat-attach');
    const progressEl = document.getElementById('upload-progress');
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        if (!Object.keys(memberPublicKeys).length) { alert('کلید عمومی نیست.'); return; }
        progressEl.style.display = 'block';
        progressEl.textContent = 'رمزنگاری…';
        try {
            const enc = await CryptoHelpers.encryptFileForMembers(file, memberPublicKeys);
            const fd = new FormData();
            fd.append('file', enc.blob, 'enc.bin');
            fd.append('iv', enc.iv);
            fd.append('encrypted_keys', JSON.stringify(enc.encrypted_keys));
            fd.append('original_name', file.name);
            fd.append('mime_type', file.type || '');
            progressEl.textContent = 'آپلود…';
            const res = await fetch(`/api/room/${room.id}/upload-file/`, {
                method: 'POST', headers: { 'X-CSRFToken': getCookie('csrftoken') }, body: fd,
            });
            if (!res.ok) throw new Error(res.status);
            progressEl.textContent = 'انجام شد.';
            setTimeout(() => { progressEl.style.display = 'none'; }, 1500);
        } catch (err) {
            progressEl.textContent = 'خطا: ' + err.message;
        } finally {
            fileInput.value = '';
        }
    });

    window.addEventListener('beforeunload', () => {
        if (GroupCallE2EE.active) { try { GroupCallE2EE.leave(); } catch (e) {} }
        sessionStorage.removeItem('chat_password_temp');
        if (autoLockTimer) clearTimeout(autoLockTimer);
    });
})();