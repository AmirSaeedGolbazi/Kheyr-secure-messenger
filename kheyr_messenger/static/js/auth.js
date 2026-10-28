(function () {
    const regForm = document.getElementById('register-form');
    if (regForm) {
        regForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const username = regForm.querySelector('[name=username]').value.trim();
            const pwd1 = document.getElementById('pwd1').value;
            const pwd2 = document.getElementById('pwd2').value;
            try {
                if (typeof nacl === 'undefined') throw new Error('tweetnacl بارگذاری نشد');

                const authHash = await CryptoHelpers.deriveAuthHash(username, pwd1);
                const duressHash = await CryptoHelpers.deriveAuthHash(username, pwd2);

                const saltBytes = crypto.getRandomValues(new Uint8Array(16));
                const saltB64 = CryptoHelpers.b64(saltBytes);

                const seed = await CryptoHelpers.deriveSeed(username, pwd1, saltB64);
                const kp = CryptoHelpers.keyPairFromSeed(seed);

                document.getElementById('auth_hash_field').value = authHash;
                document.getElementById('duress_hash_field').value = duressHash;
                document.getElementById('public_key_field').value = CryptoHelpers.publicKeyToB64(kp.publicKey);
                document.getElementById('crypto_salt_field').value = saltB64;

                document.getElementById('pwd1').value = '';
                document.getElementById('pwd2').value = '';
                regForm.submit();
            } catch (err) {
                alert('خطا در رمزنگاری: ' + err.message);
            }
        });
    }

    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const username = document.getElementById('login-username').value.trim();
            const pwd = document.getElementById('login-pwd').value;
            try {
                const authHash = await CryptoHelpers.deriveAuthHash(username, pwd);
                sessionStorage.setItem('chat_username', username);
                sessionStorage.setItem('chat_password_temp', pwd);
                document.getElementById('login-auth-hash').value = authHash;
                document.getElementById('login-pwd').value = '';
                loginForm.submit();
            } catch (err) {
                alert('خطا در رمزنگاری: ' + err.message);
            }
        });
    }
})();