import getpass
import hashlib

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError


def derive_auth_hash(username, password):
    # Mirrors CryptoHelpers.deriveAuthHash in static/js/crypto.js
    digest = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        (username + ':auth').encode('utf-8'),
        120000,
        dklen=32,
    )
    return digest.hex()


class Command(BaseCommand):
    help = (
        'Set a user\'s app-login password by re-hashing it with the same '
        'client-side PBKDF2 scheme the browser uses, so accounts created '
        'with createsuperuser can sign in on the app login page.'
    )

    def add_arguments(self, parser):
        parser.add_argument('username')

    def handle(self, *args, **options):
        username = options['username']
        UserModel = get_user_model()
        try:
            user = UserModel.objects.get(username=username)
        except UserModel.DoesNotExist:
            raise CommandError(f'User {username!r} does not exist.')

        password = getpass.getpass('New app password: ')
        confirm = getpass.getpass('Repeat it: ')
        if password != confirm:
            raise CommandError('Passwords do not match.')
        if not password:
            raise CommandError('Password must not be empty.')

        user.set_password(derive_auth_hash(username, password))
        # Rotating only the main password leaves the previous one live as a
        # duress key, and a duress login deletes every message in the database.
        user.duress_password = ''
        user.is_active = True
        user.save(update_fields=['password', 'duress_password', 'is_active'])
        self.stdout.write(self.style.SUCCESS(
            f'Password updated for {username}. Sign in on the app login page '
            'with it; /admin/ raw-password login no longer works, but staff '
            'users can open /admin/ from their active app session.'
        ))
        self.stdout.write(self.style.WARNING(
            f'Duress password for {username} cleared. Re-register it if you '
            'still want the panic-wipe, and never reuse the main password.'
        ))
