from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = 'L1CTM_D4uRpzLlL-5tIntUI__4gCs0GU2HnSC4G0eTXItUptoXUVi9qddRPytxwzoEA'
DEBUG = True
ALLOWED_HOSTS = ['*']

INSTALLED_APPS = [
    "daphne",
    "channels",
    "pwa",
    "accounts",
    "chat",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'kheyr_project.urls'

TEMPLATES = [{
    'BACKEND': 'django.template.backends.django.DjangoTemplates',
    'DIRS': [BASE_DIR / 'templates'],
    'APP_DIRS': True,
    'OPTIONS': {
        'context_processors': [
            'django.template.context_processors.request',
            'django.contrib.auth.context_processors.auth',
            'django.contrib.messages.context_processors.messages',
        ],
    },
}]

WSGI_APPLICATION = 'kheyr_project.wsgi.application'
ASGI_APPLICATION = 'kheyr_project.asgi.application'

CHANNEL_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}
}

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    }
}

AUTH_USER_MODEL = 'accounts.CustomUser'
AUTHENTICATION_BACKENDS = ['accounts.backends.DualPasswordBackend']
AUTH_PASSWORD_VALIDATORS = []

LANGUAGE_CODE = 'fa'
TIME_ZONE = 'Asia/Tehran'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
STATICFILES_DIRS = [BASE_DIR / 'static']
STATIC_ROOT = BASE_DIR / 'staticfiles'
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

LOGIN_URL = '/accounts/login/'
LOGIN_REDIRECT_URL = '/rooms/'
LOGOUT_REDIRECT_URL = '/accounts/login/'

SESSION_EXPIRE_AT_BROWSER_CLOSE = True

CCSRF_TRUSTED_ORIGINS = [
    'http://localhost', 'http://127.0.0.1',
    'http://localhost:8080', 'http://127.0.0.1:8080',
    'http://localhost:3233', 'http://127.0.0.1:3233',
]

PWA_APP_NAME = 'پیام‌رسان خیر'
PWA_APP_DESCRIPTION = "پیام‌رسان ساده، امن و گروهی"
PWA_APP_THEME_COLOR = '#c0392b'
PWA_APP_BACKGROUND_COLOR = '#ffffff'
PWA_APP_DISPLAY = 'standalone'
PWA_APP_SCOPE = '/'
PWA_APP_ORIENTATION = 'portrait'
PWA_APP_START_URL = '/rooms/'
PWA_APP_STATUS_BAR_COLOR = 'default'
PWA_APP_ICONS = [
    {'src': '/static/icons/icon-192.png', 'sizes': '192x192'},
    {'src': '/static/icons/icon-512.png', 'sizes': '512x512'},
]
PWA_APP_ICONS_APPLE = [
    {'src': '/static/icons/icon-192.png', 'sizes': '192x192'},
]
PWA_APP_DIR = 'rtl'
PWA_APP_LANG = 'fa'

LIVEKIT_API_KEY = 'devkey'
LIVEKIT_API_SECRET = 'wWfMcq-NM0zQuvQPEnLdY6Pc_YXyfguzjyqkTqNuw0I'
LIVEKIT_URL = 'ws://127.0.0.1:7880'