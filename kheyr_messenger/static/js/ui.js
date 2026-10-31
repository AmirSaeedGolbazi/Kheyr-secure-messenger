/* ============================================================
   Kheyr UI core — prefs, keys, toasts, time, service worker
   (unpinned module; pinned modules may rely on window.UI)
   ============================================================ */
(function () {
    'use strict';

    const UI = {};

    /* ---------- tiny dom helpers ---------- */
    UI.q = (sel, root) => (root || document).querySelector(sel);
    UI.qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    UI.icon = (name, cls) => `<svg class="icon ${cls || ''}"><use href="#i-${name}"/></svg>`;
    UI.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    UI.csrf = () => (window.APP && window.APP.csrf) || UI.cookie('csrftoken');
    UI.cookie = (name) => {
        const m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
        return m ? m.pop() : '';
    };

    UI.postJSON = (url, body) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': UI.csrf() },
        body: JSON.stringify(body || {}),
    }).then(r => r.json().then(j => ({ status: r.status, json: j })));

    UI.getJSON = (url) => fetch(url, { credentials: 'same-origin' }).then(r => r.json());

    /* ---------- prefs ---------- */
    const LS_KEY = 'kheyr_ui';
    UI.prefs = Object.assign({}, window.__UI_PREFS || {});

    UI.applyPrefs = function (s) {
        UI.prefs = Object.assign({}, UI.prefs, s || {});
        const el = document.documentElement;
        const theme = UI.prefs.theme === 'light' ? 'light'
            : (UI.prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
        el.dataset.theme = theme;
        el.dataset.glass = UI.prefs.glass === false ? 'off' : 'on';
        el.dataset.anim = UI.prefs.animations === false ? 'off' : 'on';
        el.dataset.bubble = UI.prefs.bubble_style || 'pill';
        el.dataset.density = UI.prefs.density || 'comfy';
        el.dataset.wallpaper = UI.prefs.wallpaper || 'mesh';
        if (UI.prefs.accent) el.style.setProperty('--accent', UI.prefs.accent);
        el.style.setProperty('--fs', (UI.prefs.font_scale || 100) + '%');
        el.style.setProperty('--blur', (UI.prefs.blur_strength == null ? 18 : UI.prefs.blur_strength) + 'px');
        try { localStorage.setItem(LS_KEY, JSON.stringify(UI.prefs)); } catch (e) {}
        document.dispatchEvent(new CustomEvent('kheyr:prefs', { detail: UI.prefs }));
    };

    UI.savePrefs = function (patch) {
        UI.applyPrefs(patch);
        if (!(window.APP && window.APP.me && window.APP.me.id)) return Promise.resolve(UI.prefs);
        return UI.postJSON('/accounts/api/settings/', patch)
            .then(res => {
                if (res && res.json && !res.json.error) UI.applyPrefs(res.json);
                return res.json;
            })
            .catch(() => UI.prefs);
    };

    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (UI.prefs.theme === 'auto') UI.applyPrefs({});
    });

    /* ---------- numbers & time (Persian) ---------- */
    const PD = '۰۱۲۳۴۵۶۷۸۹';
    UI.fa = (v) => String(v).replace(/\d/g, d => PD[+d]);
    UI.nfa = UI.fa;

    UI.timeOf = (iso) => {
        try {
            const d = new Date(iso);
            return UI.fa(d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0'));
        } catch (e) { return ''; }
    };
    UI.dayKey = (iso) => { try { const d = new Date(iso); return d.toDateString(); } catch (e) { return ''; } };
    UI.dayLabel = (iso) => {
        const d = new Date(iso), today = new Date();
        const one = new Date(today); one.setDate(one.getDate() - 1);
        const same = (a, b) => a.toDateString() === b.toDateString();
        try {
            if (same(d, today)) return 'امروز';
            if (same(d, one)) return 'دیروز';
            return new Intl.DateTimeFormat('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
        } catch (e) { return ''; }
    };
    UI.ago = (iso) => {
        const diff = (Date.now() - new Date(iso).getTime()) / 1000;
        if (diff < 60) return 'الان';
        if (diff < 3600) return UI.fa(Math.floor(diff / 60)) + ' دقیقه';
        if (diff < 86400) return UI.fa(Math.floor(diff / 3600)) + ' ساعت';
        if (diff < 604800) return UI.fa(Math.floor(diff / 86400)) + ' روز';
        try { return new Intl.DateTimeFormat('fa-IR', { day: 'numeric', month: 'short' }).format(new Date(iso)); }
        catch (e) { return ''; }
    };
    UI.mmss = (ms) => {
        const s = Math.max(0, Math.round((ms || 0) / 1000));
        return UI.fa(Math.floor(s / 60)) + ':' + UI.fa(String(s % 60).padStart(2, '0'));
    };
    UI.bytes = (n) => {
        n = Number(n) || 0;
        const u = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'];
        let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return UI.fa(n.toFixed(i ? 1 : 0)).replace('.۰', '') + ' ' + u[i];
    };

    /* ---------- toasts ---------- */
    UI.toast = function (msg, kind, ms) {
        const host = UI.q('#toast-host');
        if (!host) { if (kind === 'err') console.error(msg); return; }
        const t = document.createElement('div');
        t.className = 'toast ' + (kind || 'info');
        t.innerHTML = (kind === 'err' ? UI.icon('info') : kind === 'ok' ? UI.icon('check') : '') +
            '<span>' + UI.esc(msg) + '</span>';
        host.appendChild(t);
        requestAnimationFrame(() => t.classList.add('show'));
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 350); }, ms || 3200);
    };

    /* ---------- feedback sound (synthesised, no assets) ---------- */
    let audioCtx = null;
    UI.ping = function (kind) {
        if (UI.prefs.sounds === false) return;
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            const o = audioCtx.createOscillator(), g = audioCtx.createGain();
            o.type = 'sine';
            o.frequency.value = kind === 'send' ? 880 : 620;
            g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.06, audioCtx.currentTime + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.28);
            o.connect(g); g.connect(audioCtx.destination);
            o.start(); o.stop(audioCtx.currentTime + 0.3);
        } catch (e) {}
    };

    /* ---------- integrity gate ---------- */
    UI.ready = (async function () {
        if (typeof checkCodeIntegrity === 'function') {
            const res = await checkCodeIntegrity();
            return !!(res && res.ok);
        }
        return true;
    })();

    /* ---------- key material ---------- */
    UI.unlock = async function (opts) {
        opts = opts || {};
        const uname = (window.APP && window.APP.me.username) || sessionStorage.getItem('chat_username') || '';
        if (!uname) throw new Error('no-user');
        const keys = await UI.getJSON('/accounts/api/my-keys/');
        if (!keys.crypto_salt) throw new Error('no-salt');

        let cached = null;
        try {
            const seedB64 = await KeyDB.get('seed_' + uname);
            if (seedB64) {
                cached = CryptoHelpers.keyPairFromSeed(CryptoHelpers.secretKeyFromB64(seedB64));
            }
        } catch (e) {}
        /* A cached seed is only ours while the server still lists the key derived
           from it. A security wipe re-salts every account, and reusing the stale
           key would seal messages to a public key nobody holds. */
        if (cached && keys.public_key === CryptoHelpers.publicKeyToB64(cached.publicKey)) {
            window.__MY_KEYPAIR = cached;
            return cached;
        }

        let pwd = sessionStorage.getItem('chat_password_temp');
        if (!pwd && opts.prompt !== false) pwd = await UI.askPassword(opts.requiredText);
        if (!pwd) throw new Error('locked');
        sessionStorage.setItem('chat_password_temp', pwd);

        const seed = await CryptoHelpers.deriveSeed(uname, pwd, keys.crypto_salt);
        const kp = CryptoHelpers.keyPairFromSeed(seed);
        await KeyDB.set('seed_' + uname, CryptoHelpers.secretKeyToB64(seed));
        if (keys.public_key !== CryptoHelpers.publicKeyToB64(kp.publicKey)) {
            await UI.postJSON('/accounts/api/set-public-key/', { public_key: CryptoHelpers.publicKeyToB64(kp.publicKey) });
        }
        window.__MY_KEYPAIR = kp;
        return kp;
    };

    UI.askPassword = function (text) {
        return new Promise((resolve) => {
            const box = UI.q('#reenter-pwd');
            if (!box) {
                const p = window.prompt(text || 'رمز اصلی:');
                return resolve(p || null);
            }
            const input = UI.q('#reenter-pwd-input');
            const btn = UI.q('#reenter-pwd-btn');
            const hint = UI.q('#reenter-pwd-hint');
            if (text && hint) hint.textContent = text;
            box.classList.add('show');
            const done = () => {
                box.classList.remove('show');
                input.removeEventListener('keydown', onKey);
                btn.removeEventListener('click', onBtn);
                const v = input.value; input.value = '';
                resolve(v || null);
            };
            const onBtn = () => done();
            const onKey = (e) => { if (e.key === 'Enter') done(); };
            btn.addEventListener('click', onBtn);
            input.addEventListener('keydown', onKey);
            setTimeout(() => input.focus(), 60);
        });
    };

    UI.lock = async function () {
        try { await KeyDB.clear(); } catch (e) {}
        sessionStorage.removeItem('chat_password_temp');
        window.__MY_KEYPAIR = null;
    };

    /* ---------- service worker + push ---------- */
    UI.sw = {
        register() {
            if (!('serviceWorker' in navigator)) return Promise.resolve(null);
            return navigator.serviceWorker.register('/serviceworker.js', { scope: '/' })
                .catch(e => { console.warn('sw', e); return null; });
        },
        reg() {
            return ('serviceWorker' in navigator)
                ? navigator.serviceWorker.getRegistration() : Promise.resolve(null);
        },
        async unregisterAll() {
            const rs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(rs.map(r => r.unregister()));
            const ks = await caches.keys();
            await Promise.all(ks.map(k => caches.delete(k)));
        },
        urlBase64ToUint8Array(b64) {
            const pad = '='.repeat((4 - b64.length % 4) % 4);
            const data = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
            const raw = atob(data);
            const out = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
            return out;
        },
        async enable() {
            if (!('PushManager' in window)) throw new Error('مرورگر شما از push پشتیبانی نمی‌کند');
            const reg = await UI.sw.register() || await UI.sw.reg();
            if (!reg) throw new Error('service worker در دسترس نیست');
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') throw new Error('اجازه‌ی اعلان داده نشد');
            const { key } = await UI.getJSON('/api/push/public-key/');
            if (!key) throw new Error('کلید VAPID روی سرور تنظیم نشده — manage.py make_vapid_keys');
            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
                sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: UI.sw.urlBase64ToUint8Array(key),
                });
            }
            await UI.postJSON('/api/push/subscribe/', sub.toJSON());
            return sub;
        },
        async disable() {
            const reg = await UI.sw.reg();
            const sub = reg && await reg.pushManager.getSubscription();
            if (sub) {
                await UI.postJSON('/api/push/unsubscribe/', { endpoint: sub.endpoint });
                try { await sub.unsubscribe(); } catch (e) {}
            }
        },
        status() {
            return UI.sw.reg().then(async reg => {
                const sub = reg && await reg.pushManager.getSubscription();
                return {
                    sw: !!reg,
                    permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
                    subscribed: !!sub,
                    endpoint: sub ? sub.endpoint.slice(0, 48) + '…' : null,
                };
            });
        },
    };

    /* ---------- boot ---------- */
    UI.applyPrefs({});
    if (navigator.serviceWorker) {
        window.addEventListener('load', () => UI.sw.register());
    }

    window.UI = UI;
})();
