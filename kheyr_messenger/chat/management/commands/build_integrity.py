import hashlib
from pathlib import Path
from django.core.management.base import BaseCommand
from django.conf import settings
from chat.models import CodeIntegrity


FILES = [
    'static/js/tweetnacl.min.js',
    'static/js/crypto.js',
    'static/js/keydb.js',
    'static/js/auth.js',
    'static/js/integrity.js',
    'static/js/livekit_e2ee.js',
    'static/js/chat.js',
    'static/sw.js',
]


class Command(BaseCommand):
    help = 'ساخت/به‌روزرسانی اثر انگشت SHA-256 فایل‌های JS.'

    def handle(self, *args, **options):
        base = Path(settings.BASE_DIR)
        count = 0
        for rel in FILES:
            p = base / rel
            if not p.exists():
                self.stdout.write(self.style.WARNING(f'  skip (missing): {rel}'))
                continue
            sha = hashlib.sha256(p.read_bytes()).hexdigest()
            obj, created = CodeIntegrity.objects.update_or_create(
                file_path=rel,
                defaults={'sha256': sha},
            )
            action = 'created' if created else 'updated'
            self.stdout.write(f'  {action}: {rel}  →  {sha[:16]}…')
            count += 1
        self.stdout.write(self.style.SUCCESS(f'Done. {count} files.'))