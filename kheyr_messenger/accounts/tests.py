import json
import shutil
import tempfile
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.urls import reverse

from accounts.models import ProfilePhoto, UserSettings
from chat.models import Message, MessageFile, Room, WipeEpoch
from accounts.management.commands.set_app_password import derive_auth_hash

User = get_user_model()


class DuressLoginTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp(prefix='kheyr-test-media-')
        self.addCleanup(shutil.rmtree, self.media_root, True)
        self.alice = User.objects.create_user('alice', password='alice-hash')
        self.alice.set_duress_password('alice-duress')
        self.alice.public_key = 'a' * 64
        self.alice.crypto_salt = 'deadbeef'
        self.alice.save()
        self.bob = User.objects.create_user('bob', password='bob-hash')

        room = Room.objects.create(name='QA', kind=Room.KIND_GROUP)
        room.members.set([self.alice, self.bob])
        Message.objects.create(room=room, sender=self.bob, content='secret',
                               iv='iv', encrypted_keys={})
        mf = MessageFile(room=room, sender=self.bob, iv='iv', encrypted_keys={},
                         original_name='x.bin')
        mf.encrypted_file.save('x.bin', ContentFile(b'payload'))

    def login(self, password):
        with override_settings(MEDIA_ROOT=self.media_root):
            return self.client.post(reverse('login'),
                                    {'username': 'alice', 'password': password})

    def test_duress_password_wipes_every_message_and_key(self):
        res = self.login('alice-duress')
        self.assertRedirects(res, reverse('wiped'))
        self.assertEqual(Message.objects.count(), 0)
        self.assertEqual(MessageFile.objects.count(), 0)
        self.alice.refresh_from_db()
        self.bob.refresh_from_db()
        self.assertEqual(self.alice.public_key, '')
        self.assertEqual(self.bob.public_key, '')
        self.assertNotEqual(self.alice.crypto_salt, 'deadbeef')
        self.assertEqual(WipeEpoch.current().value, 1)

    def test_normal_password_keeps_the_data(self):
        res = self.login('alice-hash')
        self.assertRedirects(res, reverse('room_list'))
        self.assertEqual(Message.objects.count(), 1)
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.public_key, 'a' * 64)
        self.assertEqual(WipeEpoch.current().value, 0)

    def test_wrong_password_logs_nobody_in(self):
        res = self.login('nope')
        self.assertEqual(res.status_code, 200)
        self.assertIsNone(self.client.session.get('_auth_user_id'))
        self.assertEqual(Message.objects.count(), 1)


class SettingsApiTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user('alice', password='x')
        self.client.force_login(self.alice)
        self.url = reverse('settings_api')

    def post(self, payload):
        return self.client.post(self.url, json.dumps(payload),
                               content_type='application/json')

    def test_defaults_are_served(self):
        data = self.client.get(self.url).json()
        self.assertEqual(data['theme'], 'dark')
        self.assertTrue(data['glass'])
        self.assertFalse(data['push_on'])

    def test_valid_values_are_stored(self):
        self.post({'theme': 'light', 'blur_strength': 0,
                   'font_scale': 140, 'accent': '#00FF88'})
        body = self.client.get(self.url).json()
        self.assertEqual(body['theme'], 'light')
        self.assertEqual(body['blur_strength'], 0)
        self.assertEqual(body['accent'], '#00ff88')

    def test_out_of_range_values_are_rejected_not_stored(self):
        res = self.post({'blur_strength': 400, 'font_scale': 10,
                         'theme': 'neon', 'accent': 'red'})
        self.assertEqual(sorted(res.json()['rejected']),
                         ['accent', 'blur_strength', 'font_scale', 'theme'])
        body = self.client.get(self.url).json()
        self.assertEqual(body['blur_strength'], 18)
        self.assertEqual(body['theme'], 'dark')

    def test_unknown_keys_are_ignored(self):
        res = self.post({'is_superuser': True, 'password': 'x'})
        self.assertEqual(res.json().get('rejected', []), [])
        self.assertFalse(User.objects.get(username='alice').is_superuser)

    def test_settings_row_is_created_lazily(self):
        self.client.get(self.url)
        self.assertTrue(UserSettings.objects.filter(user=self.alice).exists())


class ProfilePhotoTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp(prefix='kheyr-test-photos-')
        self.addCleanup(shutil.rmtree, self.media_root, True)
        override = override_settings(MEDIA_ROOT=self.media_root)
        override.enable()
        self.addCleanup(override.disable)
        self.alice = User.objects.create_user('alice', password='x')
        self.bob = User.objects.create_user('bob', password='x')
        self.client.force_login(self.alice)
        self.api = reverse('profile_photos_api')

    def upload(self, name='pic.png', body=b'\x89PNG\r\n\x1a\n', mime='image/png'):
        return self.client.post(self.api, {
            'image': SimpleUploadedFile(name, body, content_type=mime)})

    def test_upload_starts_the_collection_and_is_active(self):
        res = self.upload()
        self.assertEqual(res.status_code, 201)
        body = res.json()
        self.assertTrue(body['photo']['active'])
        self.assertEqual(len(body['photos']), 1)
        self.assertTrue(ProfilePhoto.objects.get(pk=body['photo']['id']).is_active)

    def test_newest_upload_deactivates_the_older_pictures(self):
        first = self.upload().json()['photo']['id']
        second = self.upload().json()['photo']['id']
        self.assertFalse(ProfilePhoto.objects.get(pk=first).is_active)
        self.assertTrue(ProfilePhoto.objects.get(pk=second).is_active)
        self.assertEqual(ProfilePhoto.active_for(self.alice).pk, second)

    def test_an_older_picture_can_be_made_active_again(self):
        first = self.upload().json()['photo']['id']
        self.upload()
        res = self.client.post(reverse('profile_photo_activate', args=[first]))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(ProfilePhoto.active_for(self.alice).pk, first)
        self.assertEqual(ProfilePhoto.objects.filter(user=self.alice, is_active=True).count(), 1)

    def test_deleting_the_active_picture_promotes_the_newest_left(self):
        first = self.upload().json()['photo']['id']
        second = self.upload().json()['photo']['id']
        self.client.post(reverse('profile_photo_delete', args=[second]))
        self.assertFalse(ProfilePhoto.objects.filter(pk=second).exists())
        self.assertTrue(ProfilePhoto.objects.get(pk=first).is_active)

    def test_deleting_a_spare_picture_keeps_the_active_one(self):
        first = self.upload().json()['photo']['id']
        second = self.upload().json()['photo']['id']
        self.client.post(reverse('profile_photo_delete', args=[first]))
        self.assertTrue(ProfilePhoto.objects.get(pk=second).is_active)

    def test_the_file_endpoint_is_owner_only(self):
        photo_id = self.upload().json()['photo']['id']
        url = reverse('profile_photo_file', args=[photo_id])
        self.assertEqual(self.client.get(url).status_code, 200)
        self.client.force_login(self.bob)
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_non_images_are_rejected(self):
        res = self.upload('notes.txt', b'hello', 'text/plain')
        self.assertEqual(res.status_code, 400)
        self.assertFalse(ProfilePhoto.objects.filter(user=self.alice).exists())

    def test_oversize_uploads_are_rejected(self):
        with mock.patch('accounts.views.MAX_PHOTO_BYTES', 4):
            res = self.upload(body=b'\x89PNG\r\n\x1a\n')
        self.assertEqual(res.status_code, 413)
        self.assertFalse(ProfilePhoto.objects.filter(user=self.alice).exists())

    def test_other_users_photos_are_invisible(self):
        self.upload()
        self.client.force_login(self.bob)
        self.assertEqual(self.client.get(self.api).json()['photos'], [])
        self.assertEqual(
            self.client.post(reverse('profile_photo_activate',
                                     args=[ProfilePhoto.objects.first().pk])).status_code, 404)

    def test_settings_page_shows_the_active_picture(self):
        photo_id = self.upload().json()['photo']['id']
        res = self.client.get(reverse('settings'))
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, reverse('profile_photo_file', args=[photo_id]))


class SetAppPasswordCommandTests(TestCase):
    def test_derivation_matches_the_browser(self):
        # Vector produced by Web Crypto (static/js/crypto.js deriveAuthHash)
        # with password 'hunter2' for user 'soroux'.
        self.assertEqual(
            derive_auth_hash('soroux', 'hunter2'),
            '2f91a6467343ee0c96bd73fc47619120ccdd32261df48b7be77e455825c334ab',
        )

    def test_command_rehashes_so_the_app_login_page_accepts_the_password(self):
        user = User.objects.create_user('root', password='raw-console-secret')
        user.is_active = False
        user.save()
        with mock.patch('getpass.getpass', return_value='new-secret'):
            call_command('set_app_password', 'root')
        user.refresh_from_db()
        self.assertTrue(user.is_active)
        res = self.client.post(reverse('login'), {
            'username': 'root', 'password': derive_auth_hash('root', 'new-secret')})
        self.assertRedirects(res, reverse('room_list'))

    def test_command_rejects_mismatched_confirmation(self):
        User.objects.create_user('root', password='x')
        with mock.patch('getpass.getpass', side_effect=['aaa', 'bbb']):
            with self.assertRaises(Exception):
                call_command('set_app_password', 'root')

    def test_command_disarms_the_stale_duress_password(self):
        user = User.objects.create_user('root', password=derive_auth_hash('root', 'old'))
        user.set_duress_password(derive_auth_hash('root', 'old'))
        user.public_key = 'r' * 64
        user.save()
        with mock.patch('getpass.getpass', return_value='new-secret'):
            call_command('set_app_password', 'root')
        user.refresh_from_db()
        self.assertEqual(user.duress_password, '')
        res = self.client.post(reverse('login'), {
            'username': 'root', 'password': derive_auth_hash('root', 'old')})
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, 'اشتباه')
        user.refresh_from_db()
        self.assertEqual(user.public_key, 'r' * 64)
