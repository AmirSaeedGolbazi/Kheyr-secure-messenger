// رمزنگاری با NaCl Box (X25519 + XSalsa20-Poly1305)
// کلید خصوصی از PBKDF2(پسورد + salt) مشتق می‌شود — deterministic
// هیچ‌جای سرور ذخیره نمی‌شود.

const CryptoHelpers = {
    enc: new TextEncoder(),
    dec: new TextDecoder(),

    b64(buf) {
        const bytes = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    },
    unb64(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    },

    async deriveAuthHash(username, password) {
        const baseKey = await crypto.subtle.importKey(
            'raw', this.enc.encode(password), 'PBKDF2', false, ['deriveBits']
        );
        const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: this.enc.encode(username + ':auth'),
              iterations: 120000, hash: 'SHA-256' },
            baseKey, 256
        );
        return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
    },

    async deriveSeed(username, password, saltB64) {
        const saltBytes = new Uint8Array(this.unb64(saltB64));
        const fullSalt = new Uint8Array(saltBytes.length + username.length);
        fullSalt.set(saltBytes, 0);
        fullSalt.set(this.enc.encode(username), saltBytes.length);
        const baseKey = await crypto.subtle.importKey(
            'raw', this.enc.encode(password), 'PBKDF2', false, ['deriveBits']
        );
        const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: fullSalt, iterations: 200000, hash: 'SHA-256' },
            baseKey, 256
        );
        return new Uint8Array(bits);
    },

    keyPairFromSeed(seed) {
        if (typeof nacl === 'undefined') throw new Error('tweetnacl بارگذاری نشد');
        return nacl.box.keyPair.fromSecretKey(seed);
    },

    secretKeyToB64(secretKey) { return this.b64(secretKey); },
    secretKeyFromB64(b64) { return new Uint8Array(this.unb64(b64)); },
    publicKeyToB64(publicKey) { return this.b64(publicKey); },
    publicKeyFromB64(b64) { return new Uint8Array(this.unb64(b64)); },

    // ============================================
    // رمزنگاری: کلید AES را با NaCl Box برای هر عضو
    // encrypted_keys[uid] = { nonce, box, sender_pub }
    // sender_pub لازم است تا گیرنده بتواند box را باز کند.
    // ============================================
    async encryptForMembers(plaintext, memberPublicKeys) {
        const aesKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
        );
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv }, aesKey, this.enc.encode(plaintext)
        );
        const rawAes = new Uint8Array(await crypto.subtle.exportKey('raw', aesKey));

        const myKeyPair = window.__MY_KEYPAIR;
        if (!myKeyPair) throw new Error('جفت‌کلید شما آماده نیست');
        /* sealing to nobody would store ciphertext no member can ever open */
        if (!Object.keys(memberPublicKeys || {}).length) {
            throw new Error('کلید اعضا در دسترس نیست — دوباره وارد شوید');
        }

        const senderPubB64 = this.publicKeyToB64(myKeyPair.publicKey);
        const encrypted_keys = {};
        for (const [uid, pubB64] of Object.entries(memberPublicKeys)) {
            const theirPub = this.publicKeyFromB64(pubB64);
            const nonce = nacl.randomBytes(nacl.box.nonceLength);
            const boxed = nacl.box(rawAes, nonce, theirPub, myKeyPair.secretKey);
            encrypted_keys[uid] = {
                nonce: this.b64(nonce),
                box: this.b64(boxed),
                sender_pub: senderPubB64,
            };
        }
        return {
            content: this.b64(ct),
            iv: this.b64(iv),
            encrypted_keys,
        };
    },

    // ============================================
    // رمزگشایی: از sender_pub و کلید خصوصی خودمان
    // ============================================
    async decryptMessage(msg, myKeyPair, myUserId) {
        const ek = msg.encrypted_keys[String(myUserId)];
        if (!ek) return '[برای شما رمزنگاری نشده]';
        try {
            if (!ek.sender_pub) return '[پیام قدیمی — sender_pub ندارد]';

            const theirPub = this.publicKeyFromB64(ek.sender_pub);
            const theirNonce = new Uint8Array(this.unb64(ek.nonce));
            const boxed = new Uint8Array(this.unb64(ek.box));

            const rawAes = nacl.box.open(boxed, theirNonce, theirPub, myKeyPair.secretKey);
            if (!rawAes) throw new Error('box.open ناموفق');

            const aesKey = await crypto.subtle.importKey(
                'raw', rawAes, 'AES-GCM', false, ['decrypt']
            );
            const pt = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: new Uint8Array(this.unb64(msg.iv)) },
                aesKey, this.unb64(msg.content)
            );
            return this.dec.decode(pt);
        } catch (e) {
            console.error('decrypt failed:', e);
            return '[پیام قابل رمزگشایی نیست]';
        }
    },

    async encryptFileForMembers(file, memberPublicKeys, meta, caption) {
        const buf = await file.arrayBuffer();
        const aesKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
        );
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, buf);
        const rawAes = new Uint8Array(await crypto.subtle.exportKey('raw', aesKey));

        /* the caption rides the same per-file key as the attachment, so it uses
           the message's own content/iv columns and needs no extra envelope */
        let text = null, text_iv = null;
        if (caption) {
            const tiv = crypto.getRandomValues(new Uint8Array(12));
            const tct = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: tiv }, aesKey, this.enc.encode(caption)
            );
            text = this.b64(new Uint8Array(tct));
            text_iv = this.b64(tiv);
        }

        /* the tag sidecar is sealed with the same per-file key, so a member who
           can open the audio can open its tags and nobody else can */
        let meta_enc = null;
        if (meta) {
            const miv = crypto.getRandomValues(new Uint8Array(12));
            const mct = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: miv }, aesKey, new TextEncoder().encode(JSON.stringify(meta))
            );
            meta_enc = { v: 1, iv: this.b64(miv), data: this.b64(new Uint8Array(mct)) };
        }

        const myKeyPair = window.__MY_KEYPAIR;
        if (!myKeyPair) throw new Error('جفت‌کلید شما آماده نیست');
        /* sealing to nobody would store ciphertext no member can ever open */
        if (!Object.keys(memberPublicKeys || {}).length) {
            throw new Error('کلید اعضا در دسترس نیست — دوباره وارد شوید');
        }

        const senderPubB64 = this.publicKeyToB64(myKeyPair.publicKey);
        const encrypted_keys = {};
        for (const [uid, pubB64] of Object.entries(memberPublicKeys)) {
            const theirPub = this.publicKeyFromB64(pubB64);
            const nonce = nacl.randomBytes(nacl.box.nonceLength);
            const boxed = nacl.box(rawAes, nonce, theirPub, myKeyPair.secretKey);
            encrypted_keys[uid] = {
                nonce: this.b64(nonce),
                box: this.b64(boxed),
                sender_pub: senderPubB64,
            };
        }
        return {
            blob: new Blob([ct], { type: 'application/octet-stream' }),
            iv: this.b64(iv),
            encrypted_keys,
            meta_enc,
            text, text_iv,
        };
    },

    unboxAesKey(ek, myKeyPair) {
        if (!ek || !ek.sender_pub) throw new Error('پیام قدیمی — sender_pub ندارد');
        const theirPub = this.publicKeyFromB64(ek.sender_pub);
        const theirNonce = new Uint8Array(this.unb64(ek.nonce));
        const boxed = new Uint8Array(this.unb64(ek.box));
        const rawAes = nacl.box.open(boxed, theirNonce, theirPub, myKeyPair.secretKey);
        if (!rawAes) throw new Error('box.open ناموفق');
        return crypto.subtle.importKey('raw', rawAes, 'AES-GCM', false, ['decrypt']);
    },

    async decryptFile(ctBuf, ivB64, ek, myKeyPair) {
        const aesKey = await this.unboxAesKey(ek, myKeyPair);
        return crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(this.unb64(ivB64)) },
            aesKey, ctBuf
        );
    },

    /* the tag block sealed beside an audio file, opened with the same file key */
    async openMeta(env, ek, myKeyPair) {
        const aesKey = await this.unboxAesKey(ek, myKeyPair);
        const pt = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(this.unb64(env.iv)) },
            aesKey, new Uint8Array(this.unb64(env.data))
        );
        return JSON.parse(this.dec.decode(pt));
    },
};