markdown
# Kheyr Secure Messenger | پیام‌رسان امن خیر

**A web-based End-to-End encrypted messenger built with Django, WebRTC, and LiveKit.**
**یک پیام‌رسان تحت وب با رمزنگاری End-to-End، ساخته‌شده با Django، WebRTC و LiveKit.**

---

## English

### Overview

**Kheyr** is a self-hosted, privacy-first messenger. Every message, file, and voice/video call is **End-to-End encrypted in the browser**. The server (admin or host) can never read the content — even with full database access.

### Features

- End-to-End encryption for text messages (NaCl Box: X25519 + XSalsa20-Poly1305)
- Encrypted file sharing (images, videos, documents)
- Group voice/video calls with LiveKit + E2EE
- Groups and private chats
- Registration with username + primary password + duress password
- Admin approval for new accounts
- Duress password: entering it wipes all messages and files for everyone (the messenger itself survives)
- Auto-lock after 10 minutes of inactivity
- Auto-logout when the browser closes
- Code integrity check (SHA-256) to detect tampering
- PWA (Add to Home Screen)
- Automatic dark mode based on system settings
- Responsive design (mobile + desktop)

### Cryptography

| Data | Method |
|---|---|
| Primary/duress password | PBKDF2-SHA256 (120,000 iterations) |
| Private key derivation | PBKDF2-SHA256 (200,000 iterations) from password + salt |
| User keypair | NaCl Box (X25519) — deterministic from password |
| Message/file encryption | AES-GCM 256 |
| AES key exchange | NaCl Box (X25519 + XSalsa20-Poly1305) |
| Voice/video calls | WebRTC (DTLS-SRTP) + LiveKit E2EE |

**Critical:** the user's private key is never stored on the server. It's derived from the password and kept only in the browser's IndexedDB. Closing the browser or 10 minutes of inactivity wipes it.

> **If a user forgets their primary password, previous messages become permanently unreadable.** No one — not the admin, not the host — can recover them.

### Prerequisites

- Python 3.10+
- Git
- (Optional) Docker or LiveKit Server for group calls

### Installation

#### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/kheyr.git
cd kheyr/kheyr_messenger
2. Create a virtual environment
bash
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate
3. Install dependencies
bash
pip install django channels daphne django-pwa pillow
4. Download tweetnacl
bash
# Windows PowerShell:
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js" -OutFile "static\js\tweetnacl.min.js"

# macOS/Linux:
curl -o static/js/tweetnacl.min.js https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js
5. Migrations and admin user
bash
python manage.py makemigrations accounts
python manage.py makemigrations chat
python manage.py migrate
python manage.py createsuperuser
python manage.py build_integrity
6. (Optional) Install LiveKit for group calls
Download livekit-server-windows-amd64.zip (or Linux/macOS) from the LiveKit GitHub Releases page and extract it into the livekit/ folder.

bash
cd livekit
./livekit-server.exe --dev    # Windows
# ./livekit-server --dev      # Linux/macOS
Listens on http://127.0.0.1:7880 by default.

Running
Terminal 1 — LiveKit:

bash
cd livekit
.\livekit-server.exe --dev
Terminal 2 — Django:

bash
cd kheyr_messenger
python manage.py runserver 3233
Then open http://127.0.0.1:3233/ in your browser.

Usage
Registration
Go to /accounts/register/.

Enter a username, primary password, and duress password.

Wait for admin approval.

Admin approval
Log in at /admin/.

Navigate to Accounts → Custom users.

Click a user → check Active → Save.

Or use Action → Activate selected users for bulk approval.

Admins cannot change users' passwords. This is intentional.

Chatting
New group: /rooms/ → "+ New group".

Private chat: /rooms/ → click a username.

Calling
In a group page, click the Call button.

All online members receive an invite and can join.

Works for any number of participants (2+).

Duress password
Go to /accounts/login/.

Instead of the primary password, enter the duress password.

All messages and files for all users are wiped (the messenger and user accounts survive).

Security Model
What is protected
Threat	Protection
Admin inspects the database	Only ciphertext and public keys. No private key on the server.
Admin resets a user's password	A new private key is generated. Previous messages become unreadable.
Host with DB access	Same as admin.
Physical device access	Auto-lock + logout on browser close.
Code tampering	SHA-256 integrity check.
What is NOT protected
Threat	Why
Host with SSH access modifies the code	The code is served from the server; server-side tampering cannot be prevented in a web app.
MITM on HTTPS with a forged certificate	Requires HSTS + Certificate Pinning in production.
User leaks their password	User responsibility.
The only way to fully close these gaps is a native app (Android/iOS) whose code is not served from the server. This project is web-based, so this limitation is inherent.

Production Deployment
Before deploying to a real host, you must:

Set DEBUG = False in settings.py.

Set ALLOWED_HOSTS to your real domain.

Enable HTTPS with Let's Encrypt (Caddy or Nginx).

Use channels_redis instead of InMemoryChannelLayer (Daphne may run multiple processes).

Move SECRET_KEY and LIVEKIT_API_SECRET to .env.

Run under systemd or supervisor for reliability.

Project Structure
text
kheyr/
├── kheyr_messenger/
│   ├── accounts/          # User management and authentication
│   ├── chat/              # Messenger, groups, files, calls
│   ├── kheyr_project/     # Django settings
│   ├── static/
│   │   ├── css/
│   │   └── js/            # crypto.js, chat.js, livekit_e2ee.js, ...
│   ├── templates/
│   └── manage.py
├── livekit/               # LiveKit server
└── .gitignore
Credits
Django: https://www.djangoproject.com/

Django Channels: https://channels.readthedocs.io/

LiveKit: https://livekit.io/

tweetnacl-js: https://github.com/dchest/tweetnacl-js

Web Crypto API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API

فارسی
معرفی
خیر یک پیام‌رسان خودمیزبان با اولویت حریم خصوصی است. تمام پیام‌ها، فایل‌ها و تماس‌های صوتی/تصویری در مرورگر به‌صورت End-to-End رمزنگاری می‌شوند. سرور (ادمین یا هاستر) هرگز نمی‌تواند محتوا را بخواند — حتی با دسترسی کامل به دیتابیس.

امکانات
رمزنگاری End-to-End پیام‌های متنی (NaCl Box: X25519 + XSalsa20-Poly1305)

ارسال فایل رمزنگاری‌شده (عکس، ویدیو، سند)

تماس صوتی/تصویری گروهی با LiveKit + E2EE

گروه و چت خصوصی

ثبت‌نام با نام کاربری + رمز اصلی + رمز دوم

تأیید حساب توسط ادمین

رمز دوم (Duress): با ورود آن، همه‌ی پیام‌ها و فایل‌های همه‌ی کاربران پاک می‌شوند (خود پیام‌رسان و حساب‌ها باقی می‌مانند)

قفل خودکار بعد از ۱۰ دقیقه بی‌فعالیتی

خروج خودکار با بستن مرورگر

تشخیص دست‌کاری کد (SHA-256)

PWA (افزودن به صفحه اصلی)

دارک مود خودکار بر اساس تنظیمات سیستم

طراحی واکنش‌گرا (موبایل و دسکتاپ)

رمزنگاری
داده	روش
رمز اصلی/دوم	PBKDF2-SHA256 (۱۲۰٬۰۰۰ تکرار)
مشتق کلید خصوصی	PBKDF2-SHA256 (۲۰۰٬۰۰۰ تکرار) از رمز + salt
جفت‌کلید کاربر	NaCl Box (X25519) — deterministic از پسورد
رمزنگاری پیام/فایل	AES-GCM 256
تبادل کلید AES	NaCl Box (X25519 + XSalsa20-Poly1305)
تماس صوتی/تصویری	WebRTC (DTLS-SRTP) + LiveKit E2EE
نکته‌ی مهم: کلید خصوصی کاربر هیچ‌جای سرور ذخیره نمی‌شود. از پسورد کاربر مشتق می‌شود و فقط در حافظه‌ی مرورگر (IndexedDB) نگه داشته می‌شود. با بستن مرورگر یا ۱۰ دقیقه بی‌فعالیتی، پاک می‌شود.

اگر کاربر رمز اصلی خود را فراموش کند، پیام‌های قبلی برای همیشه ناخوانا می‌شوند. هیچ‌کس — نه ادمین، نه هاستر — نمی‌تواند بازیابی کند.

پیش‌نیازها
Python 3.10+

Git

(اختیاری) Docker یا LiveKit Server برای تماس گروهی

نصب
۱. Clone کردن پروژه
bash
git clone https://github.com/YOUR_USERNAME/kheyr.git
cd kheyr/kheyr_messenger
۲. ساخت محیط مجازی
bash
python -m venv venv
# ویندوز:
venv\Scripts\activate
# مک/لینوکس:
source venv/bin/activate
۳. نصب وابستگی‌ها
bash
pip install django channels daphne django-pwa pillow
۴. دانلود tweetnacl
powershell
# ویندوز PowerShell:
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js" -OutFile "static\js\tweetnacl.min.js"
bash
# مک/لینوکس:
curl -o static/js/tweetnacl.min.js https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js
۵. Migration و ساخت ادمین
bash
python manage.py makemigrations accounts
python manage.py makemigrations chat
python manage.py migrate
python manage.py createsuperuser
python manage.py build_integrity
۶. (اختیاری) نصب LiveKit برای تماس گروهی
از صفحه‌ی Releases مخزن LiveKit در GitHub فایل livekit-server-windows-amd64.zip (یا لینوکس/مک) را دانلود کنید و در پوشه‌ی livekit/ استخراج کنید.

bash
cd livekit
.\livekit-server.exe --dev    # ویندوز
# ./livekit-server --dev      # مک/لینوکس
پیش‌فرض روی http://127.0.0.1:7880 گوش می‌دهد.

اجرا
ترمینال ۱ — LiveKit:

bash
cd livekit
.\livekit-server.exe --dev
ترمینال ۲ — Django:

bash
cd kheyr_messenger
python manage.py runserver 3233
سپس در مرورگر: http://127.0.0.1:3233/

استفاده
ثبت‌نام
۱. به /accounts/register/ بروید.
۲. نام کاربری، رمز اصلی و رمز دوم وارد کنید.
۳. منتظر تأیید ادمین بمانید.

تأیید ادمین
۱. با ادمین به /admin/ بروید.
۲. بخش Accounts → Custom users.
۳. روی کاربر کلیک کنید → تیک Active → Save.
۴. یا از Action → تأیید (فعال‌سازی) برای چند کاربر.

ادمین نمی‌تواند پسورد کاربران را عوض کند. این عمدی است.

شروع چت
گروه جدید: در /rooms/ → «+ گروه جدید».

چت خصوصی: در /rooms/ → روی نام کاربر کلیک کنید.

تماس
در صفحه‌ی گروه، روی دکمه‌ی تماس کلیک کنید.

همه‌ی اعضای آنلاین پیام دعوت می‌بینند و می‌توانند وارد شوند.

برای هر تعداد نفر (۲ به بالا) کار می‌کند.

رمز دوم (Duress)
به /accounts/login/ بروید.

به‌جای رمز اصلی، رمز دوم را وارد کنید.

همه‌ی پیام‌ها و فایل‌های همه‌ی کاربران پاک می‌شوند (پیام‌رسان و کاربران باقی می‌مانند).

مدل امنیتی
چه چیزی محافظت شده
تهدید	محافظت
ادمین دیتابیس را می‌بیند	فقط ciphertext و کلید عمومی. هیچ کلید خصوصی در سرور نیست.
ادمین پسورد کاربر را reset می‌کند	کلید خصوصی جدید ساخته می‌شود. پیام‌های قبلی ناخوانا می‌شوند.
هاستر به دیتابیس دسترسی دارد	مثل ادمین.
دسترسی فیزیکی به دستگاه	قفل خودکار + خروج با بستن مرورگر.
دست‌کاری کد	هش SHA-256 بررسی می‌شود.
چه چیزی محافظت نشده
تهدید	چرا
هاستر با دسترسی SSH کد را عوض می‌کند	کد از سرور می‌آید، نمی‌شود جلوی دست‌کاری سمت سرور را گرفت.
MITM روی HTTPS با گواهی جعلی	نیاز به HSTS + Certificate Pinning در محیط production.
کاربر رمز را لو می‌دهد	مسئولیت کاربر.
تنها راه بستن کامل: اپلیکیشن بومی (Android/iOS) که کد آن از سرور نیاید. این پروژه وب است، پس این محدودیت را دارد.

دیپلوی روی هاست (تولید)
قبل از دیپلوی روی هاست، این‌ها لازم است:

DEBUG = False در settings.py

ALLOWED_HOSTS با دامنه‌ی واقعی

HTTPS با Let's Encrypt (Caddy یا Nginx)

channels_redis به جای InMemoryChannelLayer (چون Daphne ممکن است چند پروسه داشته باشد)

SECRET_KEY و LIVEKIT_API_SECRET از .env (نه در کد)

systemd یا supervisor برای اجرای پایدار

ساختار پروژه
text
kheyr/
├── kheyr_messenger/
│   ├── accounts/          # مدیریت کاربران و احراز هویت
│   ├── chat/              # پیام‌رسان، گروه‌ها، فایل‌ها، تماس
│   ├── kheyr_project/     # تنظیمات Django
│   ├── static/
│   │   ├── css/
│   │   └── js/            # crypto.js, chat.js, livekit_e2ee.js, ...
│   ├── templates/
│   └── manage.py
├── livekit/               # سرور LiveKit
└── .gitignore
اعتبارها
Django: https://www.djangoproject.com/

Django Channels: https://channels.readthedocs.io/

LiveKit: https://livekit.io/

tweetnacl-js: https://github.com/dchest/tweetnacl-js

Web Crypto API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API