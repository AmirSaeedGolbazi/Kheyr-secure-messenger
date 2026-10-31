const GroupCallE2EE = {
    room: null, active: false, callSessionId: null,
    onStateChange: null,

    async join({ token, url, encryptedKeyObj, myKeyPair, callSessionId, video = false,
                 onStateChange, onParticipantsChange }) {
        this.onStateChange = onStateChange || (() => {});
        this.callSessionId = callSessionId;
        this.onStateChange('connecting');

        if (typeof LivekitClient === 'undefined') throw new Error('LiveKit SDK نیست');
        if (typeof LivekitClient.ExternalE2EEKeyProvider === 'undefined') {
            throw new Error('LiveKit SDK از E2EE پشتیبانی نمی‌کند');
        }

        if (!encryptedKeyObj.sender_pub) {
            throw new Error('sender_pub در کلید رمزشده موجود نیست (پیام قدیمی یا نسخه‌ی قدیمی کد)');
        }
        const theirPub = CryptoHelpers.publicKeyFromB64(encryptedKeyObj.sender_pub);
        const theirNonce = new Uint8Array(CryptoHelpers.unb64(encryptedKeyObj.nonce));
        const boxed = new Uint8Array(CryptoHelpers.unb64(encryptedKeyObj.box));
        const rawAes = nacl.box.open(boxed, theirNonce, theirPub, myKeyPair.secretKey);
        if (!rawAes) throw new Error('box.open برای کلید AES ناموفق');

        let aesB64 = '';
        for (let i = 0; i < rawAes.length; i++) aesB64 += String.fromCharCode(rawAes[i]);
        aesB64 = btoa(aesB64);

        const keyProvider = new LivekitClient.ExternalE2EEKeyProvider();
        await keyProvider.setKey(aesB64);

        this.room = new LivekitClient.Room({
            adaptiveStream: true, dynacast: true,
            e2ee: {
                keyProvider,
                worker: new Worker('/static/js/e2ee-worker.js'),
            },
        });

        this.room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, pub, participant) => {
            this._attachTrack(track, participant);
        });
        this.room.on(LivekitClient.RoomEvent.Disconnected, () => this.leave());

        await this.room.connect(url, token);
        this.active = true;

        try {
            const p = this.room.localParticipant;
            await p.setMicrophoneEnabled(true);
            if (video) await p.setCameraEnabled(true);
            this._attachLocal(p);
        } catch (e) { console.warn(e); }

        this.onStateChange('connected');
    },

    _attachLocal(p) {
        const box = document.getElementById('lk-local-box');
        if (!box) return;
        box.querySelectorAll('audio,video').forEach((el) => el.remove());
        for (const pub of p.getTrackPublications()) {
            const t = pub.track;
            if (t && (t.source === 'camera' || t.source === 'microphone')) {
                const el = t.attach();
                el.style.width = '100%';
                el.style.borderRadius = '6px';
                el.style.background = '#000';
                if (el.tagName === 'VIDEO') el.style.transform = 'scaleX(-1)';
                box.appendChild(el);
            }
        }
    },

    _attachTrack(track, participant) {
        const id = 'lk-remote-' + participant.identity.replace(/[^a-zA-Z0-9_-]/g, '_');
        let box = document.getElementById(id);
        if (!box) {
            box = document.createElement('div');
            box.id = id;
            box.className = 'lk-tile';
            const label = document.createElement('div');
            label.className = 'lk-label';
            label.textContent = participant.name || participant.identity;
            box.appendChild(label);
            document.getElementById('lk-remote-container').appendChild(box);
        }
        const el = track.attach();
        el.style.width = '100%'; el.style.borderRadius = '6px'; el.style.background = '#000';
        box.appendChild(el);
    },

    async leave() {
        if (this.room) { try { await this.room.disconnect(); } catch (e) {} this.room = null; }
        this.active = false;
        const c = document.getElementById('lk-remote-container');
        if (c) c.innerHTML = '';
        const lb = document.getElementById('lk-local-box');
        if (lb) lb.querySelectorAll('audio,video').forEach((el) => el.remove());
        this.onStateChange('idle');
    },

    toggleMic() {
        if (!this.room || !this.room.localParticipant) return;
        const p = this.room.localParticipant;
        p.setMicrophoneEnabled(!p.isMicrophoneEnabled).then(() => this._attachLocal(p));
    },
    toggleCam() {
        if (!this.room || !this.room.localParticipant) return;
        const p = this.room.localParticipant;
        p.setCameraEnabled(!p.isCameraEnabled).then(() => this._attachLocal(p));
    },
};