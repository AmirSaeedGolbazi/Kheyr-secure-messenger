import base64

from django.core.management.base import BaseCommand
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


class Command(BaseCommand):
    help = 'تولید کلیدهای VAPID برای اعلان‌های پوش (یک‌بار). با --force بازنویزی می‌کند.'

    def add_arguments(self, parser):
        parser.add_argument('--force', action='store_true')

    def handle(self, *args, **options):
        from chat.models import PushKeys
        obj = PushKeys.current()
        if obj.private_pem and not options['force']:
            self.stdout.write(self.style.WARNING('کلیدها از قبل وجود دارند. --force برای بازنویزی.'))
            return
        private = ec.generate_private_key(ec.SECP256R1())
        pem = private.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ).decode()
        nums = private.public_key().public_numbers()
        point = b'\x04' + nums.x.to_bytes(32, 'big') + nums.y.to_bytes(32, 'big')
        pub = base64.urlsafe_b64encode(point).rstrip(b'=').decode()
        obj.private_pem = pem
        obj.public_key = pub
        obj.save(update_fields=['private_pem', 'public_key'])
        self.stdout.write(self.style.SUCCESS(f'VAPID public key: {pub}'))
