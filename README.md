# Kheyr Secure Messenger | پیام‌رسان امن خیر

**A web-based, end-to-end encrypted messenger built with Django, WebRTC, and LiveKit.**  
**یک پیام‌رسان تحت وب با رمزنگاری سرتاسری (End-to-End)، ساخته‌شده با Django، WebRTC و LiveKit.**

---

## English

### Overview

**Kheyr** is a self-hosted, privacy-first messenger. Messages, files, and voice/video calls are designed to be encrypted end-to-end in the browser. The server administrator or host should not be able to read message content, even with database access.

### Features

- End-to-end encryption for text messages (NaCl Box: X25519 + XSalsa20-Poly1305)
- Encrypted file sharing for images, videos, and documents
- Group voice/video calls with LiveKit and E2EE
- Group chats and private chats
- Registration with a username, primary password, and duress password
- Admin approval for new accounts
- **Duress password:** wipes messages and files for all users; the messenger and user accounts remain
- Automatic lock after 10 minutes of inactivity
- Automatic logout when the browser closes
- SHA-256 code-integrity check to detect tampering
- Progressive Web App (PWA) support / Add to Home Screen
- Automatic dark mode based on system settings
- Responsive layout for mobile and desktop

### Cryptography

| Data | Method |
|---|---|
| Primary / duress password | PBKDF2-SHA256 (120,000 iterations) |
| Private-key derivation | PBKDF2-SHA256 (200,000 iterations) from password + salt |
| User key pair | NaCl Box (X25519), derived deterministically from the password |
| Message / file encryption | AES-GCM 256 |
| AES key exchange | NaCl Box (X25519 + XSalsa20-Poly1305) |
| Voice / video calls | WebRTC (DTLS-SRTP) + LiveKit E2EE |

> **Important:** The user's private key is not stored on the server. It is derived from the password and kept in the browser's IndexedDB. The README describes it as being cleared when the browser closes or after 10 minutes of inactivity.

If a user forgets their primary password, previous messages become permanently unreadable. The administrator and host cannot recover them.

### Prerequisites

- Python 3.10+
- Git
- Optional: Docker or a LiveKit server for group calls

### Installation

#### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/kheyr.git
cd kheyr/kheyr_messenger
```

#### 2. Create and activate a virtual environment

```bash
python -m venv venv
```

**Windows (PowerShell):**

```powershell
venv\Scripts\activate
```

**macOS / Linux:**

```bash
source venv/bin/activate
```

#### 3. Install dependencies

```bash
pip install django channels daphne django-pwa pillow
```

#### 4. Download TweetNaCl

**Windows (PowerShell):**

```powershell
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js" -OutFile "static\js\tweetnacl.min.js"
```

**macOS / Linux:**

```bash
curl -o static/js/tweetnacl.min.js https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js
```

#### 5. Run migrations and create an admin user

```bash
python manage.py makemigrations accounts
python manage.py makemigrations chat
python manage.py migrate
python manage.py createsuperuser
python manage.py build_integrity
```

#### 6. (Optional) Set up LiveKit for group calls

Download the appropriate `livekit-server` release for your operating system from the [LiveKit GitHub Releases page](https://github.com/livekit/livekit/releases), then extract it into the `livekit/` directory.

**Start LiveKit:**

```bash
cd livekit
```

Windows:

```powershell
.\livekit-server.exe --dev
```

Linux / macOS:

```bash
./livekit-server --dev
```

By default, LiveKit listens on `http://127.0.0.1:7880`.

### Running the application

Run LiveKit in one terminal (if using group calls):

```bash
cd livekit
```

Windows:

```powershell
.\livekit-server.exe --dev
```

Linux / macOS:

```bash
./livekit-server --dev
```

Run Django in a second terminal from the `kheyr_messenger/` directory:

```bash
python manage.py runserver 3233
```

Open [http://127.0.0.1:3233/](http://127.0.0.1:3233/) in your browser.

### Usage

#### Registration

1. Go to `/accounts/register/`.
2. Enter a username, primary password, and duress password.
3. Wait for admin approval.

#### Admin approval

1. Sign in at `/admin/`.
2. Open **Accounts → Custom users**.
3. Select a user, enable **Active**, and save.
4. Alternatively, use **Action → Activate selected users** to approve multiple accounts.

Administrators cannot change users' passwords. This is intentional.

#### Chatting

- **Create a group:** Go to `/rooms/` and select **+ New group**.
- **Private chat:** Go to `/rooms/` and select a username.

#### Calling

1. Open a group page and click **Call**.
2. Online members receive an invitation and can join.
3. Calls support two or more participants.

#### Duress password

1. Go to `/accounts/login/`.
2. Enter the duress password instead of the primary password.
3. Messages and files belonging to all users are wiped; the messenger and user accounts remain.

### Security model

#### What is protected?

| Threat | Protection |
|---|---|
| Administrator inspects the database | The database contains ciphertext and public keys; private keys are not stored on the server. |
| Administrator resets a user's password | A new private key is generated, making previous messages unreadable. |
| Host has database access | Same protection as for an administrator with database access. |
| Someone gains physical access to a device | Automatic lock and logout when the browser closes. |
| Code tampering | SHA-256 integrity check. |

#### What is not protected?

| Threat | Limitation |
|---|---|
| Host with SSH access modifies the code | The application code is served by the host; a web app cannot fully prevent server-side code tampering. |
| MITM attack on HTTPS using a forged certificate | The original README identifies HSTS and certificate pinning as production considerations. |
| User discloses their password | The user is responsible for keeping credentials secret. |

A native Android/iOS app whose code is not served by the host could address some of the limitations above. This project is web-based, so server-delivered code remains an inherent limitation.

### Production deployment

Before deploying to a real host:

- Set `DEBUG = False` in `settings.py`.
- Set `ALLOWED_HOSTS` to your real domain.
- Enable HTTPS with Let's Encrypt using Caddy or Nginx.
- Use `channels_redis` instead of `InMemoryChannelLayer` if Daphne may run multiple processes.
- Load `SECRET_KEY` and `LIVEKIT_API_SECRET` from environment variables (for example, a `.env` file) rather than hard-coding them.
- Run the application under `systemd` or `supervisor` for reliability.

### Project structure

```text
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
```

### Credits

- [Django](https://www.djangoproject.com/)
- [Django Channels](https://channels.readthedocs.io/)
- [LiveKit](https://livekit.io/)
- [TweetNaCl.js](https://github.com/dchest/tweetnacl-js)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)

---

## فارسی

### معرفی

**خیر** یک پیام‌رسان خودمیزبان با تمرکز بر حریم خصوصی است. طبق طراحی پروژه، پیام‌ها، فایل‌ها و تماس‌های صوتی و تصویری در مرورگر به‌صورت سرتاسری (End-to-End) رمزنگاری می‌شوند. مدیر یا میزبان سرور نباید بتواند محتوای پیام‌ها را بخواند؛ حتی اگر به پایگاه داده دسترسی داشته باشد.

### امکانات

- رمزنگاری سرتاسری پیام‌های متنی (NaCl Box: X25519 + XSalsa20-Poly1305)
- اشتراک‌گذاری رمزنگاری‌شده‌ی فایل‌ها، از جمله عکس، ویدیو و سند
- تماس صوتی و تصویری گروهی با LiveKit و E2EE
- گفت‌وگوهای گروهی و خصوصی
- ثبت‌نام با نام کاربری، رمز اصلی و رمز اضطراری (Duress)
- تأیید حساب‌های جدید توسط مدیر
- **رمز اضطراری:** پاک‌کردن پیام‌ها و فایل‌های تمام کاربران؛ خود پیام‌رسان و حساب‌ها باقی می‌مانند
- قفل خودکار پس از ۱۰ دقیقه بی‌فعالیتی
- خروج خودکار هنگام بستن مرورگر
- بررسی یکپارچگی کد با SHA-256 برای تشخیص دست‌کاری
- پشتیبانی از PWA و افزودن به صفحه‌ی اصلی
- حالت تاریک خودکار بر اساس تنظیمات سیستم
- طراحی واکنش‌گرا برای موبایل و دسکتاپ

### رمزنگاری

| داده | روش |
|---|---|
| رمز اصلی / اضطراری | PBKDF2-SHA256 با ۱۲۰٬۰۰۰ تکرار |
| مشتق‌سازی کلید خصوصی | PBKDF2-SHA256 با ۲۰۰٬۰۰۰ تکرار از رمز و salt |
| جفت‌کلید کاربر | NaCl Box (X25519)، مشتق‌شده به‌صورت قطعی از رمز عبور |
| رمزنگاری پیام / فایل | AES-GCM 256 |
| تبادل کلید AES | NaCl Box (X25519 + XSalsa20-Poly1305) |
| تماس صوتی / تصویری | WebRTC (DTLS-SRTP) + LiveKit E2EE |

> **نکته‌ی مهم:** کلید خصوصی کاربر روی سرور ذخیره نمی‌شود؛ از رمز عبور مشتق شده و در IndexedDB مرورگر نگه‌داری می‌شود. طبق توضیح پروژه، این کلید با بستن مرورگر یا پس از ۱۰ دقیقه بی‌فعالیتی پاک می‌شود.

اگر کاربر رمز اصلی خود را فراموش کند، پیام‌های قبلی برای همیشه ناخوانا می‌شوند و مدیر یا میزبان نمی‌تواند آن‌ها را بازیابی کند.

### پیش‌نیازها

- Python نسخه‌ی 3.10 یا بالاتر
- Git
- اختیاری: Docker یا سرور LiveKit برای تماس‌های گروهی

### نصب

#### ۱. دریافت مخزن پروژه

```bash
git clone https://github.com/YOUR_USERNAME/kheyr.git
cd kheyr/kheyr_messenger
```

#### ۲. ساخت و فعال‌سازی محیط مجازی

```bash
python -m venv venv
```

**ویندوز (PowerShell):**

```powershell
venv\Scripts\activate
```

**لینوکس / macOS:**

```bash
source venv/bin/activate
```

#### ۳. نصب وابستگی‌ها

```bash
pip install django channels daphne django-pwa pillow
```

#### ۴. دریافت TweetNaCl

**ویندوز (PowerShell):**

```powershell
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js" -OutFile "static\js\tweetnacl.min.js"
```

**لینوکس / macOS:**

```bash
curl -o static/js/tweetnacl.min.js https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js
```

#### ۵. اجرای migrationها و ساخت حساب مدیر

```bash
python manage.py makemigrations accounts
python manage.py makemigrations chat
python manage.py migrate
python manage.py createsuperuser
python manage.py build_integrity
```

#### ۶. (اختیاری) راه‌اندازی LiveKit برای تماس گروهی

نسخه‌ی مناسب سیستم‌عامل خود را از [صفحه‌ی انتشارهای LiveKit در GitHub](https://github.com/livekit/livekit/releases) دریافت و در پوشه‌ی `livekit/` استخراج کنید.

**اجرای LiveKit:**

```bash
cd livekit
```

ویندوز:

```powershell
.\livekit-server.exe --dev
```

لینوکس / macOS:

```bash
./livekit-server --dev
```

به‌صورت پیش‌فرض، LiveKit روی نشانی `http://127.0.0.1:7880` گوش می‌دهد.

### اجرای برنامه

اگر از تماس گروهی استفاده می‌کنید، LiveKit را در یک ترمینال اجرا کنید:

```bash
cd livekit
```

ویندوز:

```powershell
.\livekit-server.exe --dev
```

لینوکس / macOS:

```bash
./livekit-server --dev
```

سپس در ترمینال دوم، از پوشه‌ی `kheyr_messenger/`، جنگو را اجرا کنید:

```bash
python manage.py runserver 3233
```

نشانی [http://127.0.0.1:3233/](http://127.0.0.1:3233/) را در مرورگر باز کنید.

### راهنمای استفاده

#### ثبت‌نام

۱. به مسیر `/accounts/register/` بروید.  
۲. نام کاربری، رمز اصلی و رمز اضطراری را وارد کنید.  
۳. منتظر تأیید مدیر بمانید.

#### تأیید حساب توسط مدیر

۱. با حساب مدیر وارد `/admin/` شوید.  
۲. بخش **Accounts → Custom users** را باز کنید.  
۳. کاربر را انتخاب کنید، گزینه‌ی **Active** را فعال کنید و ذخیره کنید.  
۴. برای تأیید چند حساب، از گزینه‌ی **Action → Activate selected users** استفاده کنید.

مدیر نمی‌تواند رمز عبور کاربران را تغییر دهد؛ این موضوع عمدی است.

#### گفت‌وگو

- **ساخت گروه:** به `/rooms/` بروید و گزینه‌ی **+ New group** را انتخاب کنید.
- **گفت‌وگوی خصوصی:** در `/rooms/` روی نام کاربر کلیک کنید.

#### تماس

۱. صفحه‌ی یک گروه را باز کنید و روی **Call** بزنید.  
۲. اعضای آنلاین دعوت‌نامه دریافت می‌کنند و می‌توانند وارد تماس شوند.  
۳. تماس از دو شرکت‌کننده به بالا پشتیبانی می‌کند.

#### رمز اضطراری (Duress)

۱. به مسیر `/accounts/login/` بروید.  
۲. به‌جای رمز اصلی، رمز اضطراری را وارد کنید.  
۳. پیام‌ها و فایل‌های تمام کاربران پاک می‌شوند؛ پیام‌رسان و حساب‌های کاربری باقی می‌مانند.

### مدل امنیتی

#### مواردی که محافظت می‌شوند

| تهدید | سازوکار محافظت |
|---|---|
| مشاهده‌ی پایگاه داده توسط مدیر | پایگاه داده شامل متن رمز‌شده و کلیدهای عمومی است؛ کلید خصوصی روی سرور ذخیره نمی‌شود. |
| بازنشانی رمز کاربر توسط مدیر | کلید خصوصی جدیدی ساخته می‌شود و پیام‌های قبلی ناخوانا می‌شوند. |
| دسترسی میزبان به پایگاه داده | همان محدودیت‌ها و محافظت‌های مربوط به دسترسی مدیر برقرار است. |
| دسترسی فیزیکی به دستگاه | قفل خودکار و خروج هنگام بسته‌شدن مرورگر. |
| دست‌کاری کد | بررسی یکپارچگی با SHA-256. |

#### مواردی که محافظت نمی‌شوند

| تهدید | محدودیت |
|---|---|
| تغییر کد توسط میزبان دارای دسترسی SSH | کد برنامه از سرور ارائه می‌شود؛ یک برنامه‌ی وب نمی‌تواند به‌طور کامل جلوی دست‌کاری کد در سمت سرور را بگیرد. |
| حمله‌ی MITM روی HTTPS با گواهی جعلی | در README اصلی، HSTS و Certificate Pinning به‌عنوان ملاحظات محیط عملیاتی مطرح شده‌اند. |
| افشای رمز عبور توسط کاربر | حفاظت از اطلاعات ورود بر عهده‌ی کاربر است. |

استفاده از برنامه‌ی بومی Android یا iOS که کد آن از سرور میزبان ارائه نشود، می‌تواند بخشی از محدودیت‌های بالا را کاهش دهد. چون این پروژه مبتنی بر وب است، ارائه‌ی کد از سمت سرور همچنان یک محدودیت ذاتی محسوب می‌شود.

### استقرار روی سرور عملیاتی (Production)

پیش از استقرار روی سرور واقعی:

- مقدار `DEBUG = False` را در `settings.py` تنظیم کنید.
- مقدار `ALLOWED_HOSTS` را با دامنه‌ی واقعی جایگزین کنید.
- HTTPS را با Let's Encrypt و از طریق Caddy یا Nginx فعال کنید.
- اگر Daphne ممکن است چند فرایند اجرا کند، به‌جای `InMemoryChannelLayer` از `channels_redis` استفاده کنید.
- مقادیر `SECRET_KEY` و `LIVEKIT_API_SECRET` را از متغیرهای محیطی (برای مثال فایل `.env`) بخوانید و مستقیماً در کد قرار ندهید.
- برای اجرای پایدار، از `systemd` یا `supervisor` استفاده کنید.

### ساختار پروژه

```text
kheyr/
├── kheyr_messenger/
│   ├── accounts/          # مدیریت کاربران و احراز هویت
│   ├── chat/              # پیام‌رسان، گروه‌ها، فایل‌ها و تماس‌ها
│   ├── kheyr_project/     # تنظیمات Django
│   ├── static/
│   │   ├── css/
│   │   └── js/            # crypto.js، chat.js، livekit_e2ee.js و ...
│   ├── templates/
│   └── manage.py
├── livekit/               # سرور LiveKit
└── .gitignore
```

### منابع و اعتبارها

- [Django](https://www.djangoproject.com/)
- [Django Channels](https://channels.readthedocs.io/)
- [LiveKit](https://livekit.io/)
- [TweetNaCl.js](https://github.com/dchest/tweetnacl-js)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
