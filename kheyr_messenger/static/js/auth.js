// client-side auth: password hashing, keypair derivation, form helpers

// ============ چک زنده‌ی یوزرنیم ============
(function () {
    const usernameInput = document.getElementById('id_username');
    const usernameFeedback = document.getElementById('username-feedback');
    const registerSubmit = document.getElementById('reg-submit');
    if (!usernameInput || !usernameFeedback || !registerSubmit) return;

    let debounceTimer = null;
    let lastChecked = '';
    let usernameAvailable = true;

    function setFeedback(msg, color) {
        usernameFeedback.textContent = msg;
        usernameFeedback.style.color = color || '';
    }

    function updateSubmit() {
        registerSubmit.disabled = !usernameAvailable;
        registerSubmit.style.opacity = usernameAvailable ? '1' : '0.5';
    }

    async function checkUsername() {
        const val = usernameInput.value.trim();
        if (!val) { setFeedback('', ''); usernameAvailable = true; updateSubmit(); return; }
        if (val === lastChecked) return;
        lastChecked = val;

        if (!/^[a-zA-Z0-9_]+$/.test(val)) {
            setFeedback('فقط حروف انگلیسی، اعداد و _ مجاز است.', '#c0392b');
            usernameAvailable = false;
            updateSubmit();
            return;
        }

        setFeedback('در حال بررسی…', '#7a4a4a');
        try {
            const res = await fetch('/accounts/api/check-username/?username=' + encodeURIComponent(val));
            const data = await res.json();
            if (val !== usernameInput.value.trim()) return;
            if (data.exists) {
                setFeedback('این نام کاربری قبلاً گرفته شده است.', '#c0392b');
                usernameAvailable = false;
            } else {
                setFeedback('این نام کاربری آزاد است.', '#2a7');
                usernameAvailable = true;
            }
        } catch (e) {
            setFeedback('خطا در بررسی', '#c0392b');
            usernameAvailable = true;
        }
        updateSubmit();
    }

    usernameInput.addEventListener('input', function () {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(checkUsername, 300);
    });

    if (usernameInput.value.trim()) checkUsername();
})();

(function () {
    'use strict';

    function fail(msg) {
        if (window.UI && UI.toast) UI.toast(msg, 'err', 5000);
        else console.error(msg);
    }

    function busy(form, on) {
        const btn = form.querySelector('button[type=submit]');
        if (!btn) return;
        btn.disabled = on;
        btn.style.opacity = on ? '.65' : '';
    }

    /* ---------- password visibility ---------- */
    document.querySelectorAll('.pwd-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const inp = document.getElementById(btn.dataset.target);
            if (!inp) return;
            const show = inp.type === 'password';
            inp.type = show ? 'text' : 'password';
            btn.innerHTML = '<svg class="icon"><use href="#i-' + (show ? 'eye-off' : 'eye') + '"/></svg>';
            inp.focus();
        });
    });

    /* ---------- strength meter ---------- */
    const pwd1 = document.getElementById('pwd1');
    const bar = document.getElementById('strength-bar');
    const label = document.getElementById('strength-text');
    if (pwd1 && bar) {
        const WORDS = ['خیلی ضعیف', 'ضعیف', 'متوسط', 'خوب', 'عالی'];
        const COLORS = ['var(--err)', 'var(--err)', 'var(--warn)', '#8fd14f', 'var(--ok)'];
        pwd1.addEventListener('input', () => {
            const v = pwd1.value;
            let s = 0;
            if (v.length >= 6) s++;
            if (v.length >= 10) s++;
            if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
            if (/\d/.test(v)) s++;
            if (/[^\w\s]/.test(v)) s++;
            s = Math.min(4, Math.max(0, s - 1));
            bar.style.width = v ? ((s + 1) * 20) + '%' : '0%';
            bar.style.background = COLORS[s];
            if (label) {
                label.textContent = v ? 'قدرت رمز: ' + WORDS[s] : '';
                label.style.color = COLORS[s];
            }
        });
    }

    /* ---------- register ---------- */
    const regForm = document.getElementById('register-form');
    if (regForm) {
        regForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const username = regForm.querySelector('[name=username]').value.trim();
            const p1 = document.getElementById('pwd1').value;
            const p2 = document.getElementById('pwd2').value;
            if (!username || !p1 || !p2) { fail('همه‌ی فیلدها را پر کنید'); return; }
            if (p2 == p1) { fail('دو رمز باید متفاوت‌ از یکدیگر باشند'); return; }
            busy(regForm, true);
            try {
                if (typeof nacl === 'undefined') throw new Error('tweetnacl بارگذاری نشد');

                const authHash = await CryptoHelpers.deriveAuthHash(username, p1);
                const duressHash = await CryptoHelpers.deriveAuthHash(username, p2);

                const saltBytes = crypto.getRandomValues(new Uint8Array(16));
                const saltB64 = CryptoHelpers.b64(saltBytes);

                const seed = await CryptoHelpers.deriveSeed(username, p1, saltB64);
                const kp = CryptoHelpers.keyPairFromSeed(seed);

                document.getElementById('auth_hash_field').value = authHash;
                document.getElementById('duress_hash_field').value = duressHash;
                document.getElementById('public_key_field').value = CryptoHelpers.publicKeyToB64(kp.publicKey);
                document.getElementById('crypto_salt_field').value = saltB64;

                document.getElementById('pwd1').value = '';
                document.getElementById('pwd2').value = '';
                regForm.submit();
            } catch (err) {
                fail('خطا در رمزنگاری: ' + err.message);
                busy(regForm, false);
            }
        });
    }

    /* ---------- login ---------- */
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const username = document.getElementById('login-username').value.trim();
            const pwd = document.getElementById('login-pwd').value;
            if (!username || !pwd) { fail('نام کاربری و رمز را وارد کنید'); return; }
            busy(loginForm, true);
            try {
                const authHash = await CryptoHelpers.deriveAuthHash(username, pwd);
                sessionStorage.setItem('chat_username', username);
                sessionStorage.setItem('chat_password_temp', pwd);
                document.getElementById('login-auth-hash').value = authHash;
                document.getElementById('login-pwd').value = '';
                loginForm.submit();
            } catch (err) {
                fail('خطا در رمزنگاری: ' + err.message);
                busy(loginForm, false);
            }
        });
    }

    /* ---------- integrity warning once keys are stale ---------- */
    if (window.location.search.indexOf('wiped=1') >= 0 && window.UI) {
        UI.toast('همه‌ی داده‌ها پاک شده‌اند؛ دوباره وارد شوید', 'err', 6000);
    }
})();
