async function checkCodeIntegrity() {
    try {
        const res = await fetch('/api/code-integrity/');
        if (!res.ok) {
            console.warn('integrity api failed:', res.status);
            return { ok: true };
        }
        const data = await res.json();
        const expected = data.hashes || {};

        if (Object.keys(expected).length === 0) {
            console.warn('integrity: no hashes in DB yet. Run: python manage.py build_integrity');
            return { ok: true };
        }

        const mismatches = [];
        for (const [path, expectedHash] of Object.entries(expected)) {
            try {
                // مسیر مطلق: با '/' در ابتدا
                const url = '/' + path.replace(/^\/+/, '') + '?v=' + Date.now();
                const r = await fetch(url, { cache: 'no-store' });
                if (!r.ok) {
                    console.warn('integrity fetch failed:', url, r.status);
                    continue;
                }
                const buf = await r.arrayBuffer();
                const hashBuf = await crypto.subtle.digest('SHA-256', buf);
                const actualHash = Array.from(new Uint8Array(hashBuf))
                    .map(b => b.toString(16).padStart(2, '0')).join('');
                if (actualHash !== expectedHash) {
                    mismatches.push({ path, expectedHash, actualHash });
                    console.error(`INTEGRITY MISMATCH: ${path}`);
                }
            } catch (e) {
                console.warn('integrity check failed for', path, e);
            }
        }

        if (mismatches.length > 0) {
            const msg = '⚠️ هشدار امنیتی:\n\n' +
                'کد پیام‌رسان تغییر کرده و با اثر انگشت مورد انتظار مطابقت ندارد.\n' +
                'این ممکن است نشانه‌ی دست‌کاری سرور باشد.\n\n' +
                'برای امنیت شما، تمام کلیدها و داده‌های محلی پاک می‌شوند ' +
                'و به صفحه ورود منتقل می‌شوید.\n\n' +
                'مشکوک به: ' + mismatches.map(m => m.path).join(', ');
            alert(msg);
            try { await KeyDB.clear(); } catch (e) {}
            for (const k of Object.keys(sessionStorage)) {
                if (k.startsWith('chat_')) sessionStorage.removeItem(k);
            }
            for (const k of Object.keys(localStorage)) {
                if (k.startsWith('chat_')) localStorage.removeItem(k);
            }
            window.location.href = '/accounts/login/?integrity=failed';
            return { ok: false, mismatches };
        }

        return { ok: true };
    } catch (e) {
        console.warn('integrity check exception:', e);
        return { ok: true };
    }
}

window.checkCodeIntegrity = checkCodeIntegrity;