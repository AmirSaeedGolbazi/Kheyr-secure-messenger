import asyncio
import json
import urllib.error
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from accounts.models import UserSettings
from .models import (Message, MessageFile, PushKeys, PushSubscription,
                     Room, RoomPrefs, WipeEpoch)
from .notifications import _send_all
from .views import message_payload

User = get_user_model()


def make_room(*members, kind=Room.KIND_GROUP, name='QA'):
    room = Room.objects.create(name=name, kind=kind,
                               is_group=(kind != Room.KIND_PRIVATE))
    room.members.set(members)
    return room


def text_message(room, sender, iv='MSG_IV', **kw):
    return Message.objects.create(room=room, sender=sender, content='cipher',
                                  iv=iv, encrypted_keys={'1': {'box': 'x'}}, **kw)


class PayloadTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user('alice', password='x')
        self.room = make_room(self.alice)

    def test_text_message_exposes_envelope_iv_and_empty_file_iv(self):
        m = text_message(self.room, self.alice)
        p = message_payload(m)
        self.assertEqual(p['iv'], 'MSG_IV')
        self.assertEqual(p['file_iv'], '')
        self.assertEqual(p['encrypted_keys'], {'1': {'box': 'x'}})

    def test_attachment_carries_its_own_iv_and_keys(self):
        m = text_message(self.room, self.alice, iv='', kind='image')
        mf = MessageFile.objects.create(
            room=self.room, sender=self.alice, message=m, iv='FILE_IV',
            encrypted_keys={'1': {'box': 'y'}}, original_name='a.png',
            mime_type='image/png', kind='image',
            encrypted_file=SimpleUploadedFile('a.bin', b'blob'),
        )
        p = message_payload(m, mf)
        # The note message has no envelope IV; a client that read only `iv`
        # would fail to decrypt the blob.
        self.assertEqual(p['iv'], '')
        self.assertEqual(p['file_iv'], 'FILE_IV')
        self.assertEqual(p['encrypted_keys'], {'1': {'box': 'y'}})
        self.assertEqual(p['file_id'], mf.id)
        self.assertEqual(p['file_kind'], 'image')

    def test_deleted_message_blanks_all_secret_fields(self):
        m = text_message(self.room, self.alice)
        m.deleted_at = timezone.now()
        m.save()
        p = message_payload(m)
        self.assertEqual(p['kind'], 'deleted')
        for key in ('content', 'iv', 'file_iv', 'file_name'):
            self.assertEqual(p[key], '', key)
        self.assertEqual(p['encrypted_keys'], {})


class MessagesApiTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user('alice', password='x')
        self.outsider = User.objects.create_user('bob', password='x')
        self.room = make_room(self.alice)
        for _ in range(4):
            text_message(self.room, self.alice)
        self.client.force_login(self.alice)

    def test_returns_page_without_id_lookup_error(self):
        res = self.client.get(reverse('room_messages_api', args=[self.room.id]),
                              {'limit': 2})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(len(data['messages']), 2)
        self.assertTrue(data['has_more'])

    def test_non_member_is_rejected(self):
        self.client.force_login(self.outsider)
        res = self.client.get(reverse('room_messages_api', args=[self.room.id]))
        self.assertEqual(res.status_code, 403)


class UploadApiTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user('alice', password='x')
        self.room = make_room(self.alice)
        self.client.force_login(self.alice)

    def _post(self, mime='audio/mpeg', kind='voice', meta=None):
        data = {
            'file': SimpleUploadedFile('clip.mp3', b'\x00' * 32, content_type=mime),
            'iv': 'BLOB_IV',
            'encrypted_keys': json.dumps({'1': {'box': 'z'}}),
            'original_name': 'clip.mp3',
            'mime_type': mime,
            'kind': kind,
            'duration_ms': '1200',
        }
        if meta is not None:
            data['meta'] = meta if isinstance(meta, str) else json.dumps(meta)
        return self.client.post(reverse('upload_file_api', args=[self.room.id]), data)

    def test_note_message_has_blank_iv_and_file_keeps_its_own(self):
        res = self._post()
        self.assertEqual(res.status_code, 200)
        m = Message.objects.get(id=res.json()['message_id'])
        self.assertEqual(m.kind, 'voice')
        self.assertEqual(m.iv, '')
        p = message_payload(m)
        self.assertEqual(p['file_iv'], 'BLOB_IV')
        self.assertEqual(p['duration_ms'], 1200)

    def test_caption_rides_the_note_and_the_payload_keeps_both_ivs(self):
        res = self.client.post(
            reverse('upload_file_api', args=[self.room.id]),
            {
                'file': SimpleUploadedFile('shot.jpg', b'\x01' * 16, content_type='image/jpeg'),
                'iv': 'BLOB_IV',
                'encrypted_keys': json.dumps({'1': {'box': 'z'}}),
                'original_name': 'shot.jpg',
                'mime_type': 'image/jpeg',
                'kind': 'image',
                'content': 'CAPTION_CT',
                'text_iv': 'CAPTION_IV',
            },
        )
        self.assertEqual(res.status_code, 200)
        m = Message.objects.get(id=res.json()['message_id'])
        self.assertEqual((m.content, m.iv), ('CAPTION_CT', 'CAPTION_IV'))
        p = message_payload(m)
        # the caption opens with the file key but must never reuse the blob IV
        self.assertEqual(p['content'], 'CAPTION_CT')
        self.assertEqual(p['iv'], 'CAPTION_IV')
        self.assertEqual(p['file_iv'], 'BLOB_IV')

    def test_upload_without_a_caption_stays_empty(self):
        res = self._post(mime='image/png', kind='image')
        m = Message.objects.get(id=res.json()['message_id'])
        self.assertEqual((m.content, m.iv), ('', ''))

    def test_mime_type_decides_the_rendered_kind(self):
        res = self._post(mime='video/mp4', kind='file')
        self.assertEqual(Message.objects.get(id=res.json()['message_id']).kind, 'video')

    def test_upload_sealed_to_nobody_is_rejected(self):
        res = self.client.post(reverse('upload_file_api', args=[self.room.id]), {
            'file': SimpleUploadedFile('clip.mp3', b'\x00' * 32, content_type='audio/mpeg'),
            'iv': 'BLOB_IV', 'encrypted_keys': '{}', 'original_name': 'clip.mp3',
            'mime_type': 'audio/mpeg', 'kind': 'voice',
        })
        self.assertEqual(res.status_code, 400)
        self.assertEqual(MessageFile.objects.count(), 0)

    GOOD_META = {'v': 1, 'iv': 'AAA', 'data': 'Q292ZXJDYW5CTlNPbmx5VGhlUm9vbU1lbWJlcnNDYW5PcGVu'}

    def test_meta_envelope_is_stored_opaquely(self):
        res = self._post(kind='audio', meta=self.GOOD_META)
        mf = MessageFile.objects.get(id=res.json()['file_id'])
        self.assertEqual(mf.meta, self.GOOD_META)
        self.assertTrue(message_payload(mf.message)['has_meta'])

    def test_malformed_meta_envelopes_are_dropped(self):
        cases = ['not json', '{}',
                 json.dumps({'v': 2, 'iv': 'a', 'data': 'b'}),
                 json.dumps({'v': 1, 'iv': 'a', 'data': ''}),
                 json.dumps({'v': 1, 'data': 'b'}),
                 json.dumps({'v': 1, 'iv': 'a', 'data': 'x' * 400001})]
        for bad in cases:
            res = self._post(kind='audio', meta=bad)
            self.assertEqual(MessageFile.objects.get(id=res.json()['file_id']).meta, {}, bad[:30])

    def test_audio_without_meta_advertises_has_meta_false(self):
        res = self._post(kind='audio')
        self.assertFalse(message_payload(Message.objects.get(id=res.json()['message_id']))['has_meta'])

    def test_meta_endpoint_is_member_only(self):
        res = self._post(kind='audio', meta=self.GOOD_META)
        url = reverse('file_meta_api', args=[res.json()['file_id']])
        self.assertEqual(self.client.get(url).json()['meta'], self.GOOD_META)
        self.client.force_login(User.objects.create_user('eve', password='x'))
        self.assertEqual(self.client.get(url).status_code, 403)


class SendMessageApiTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user('alice', password='x')
        self.room = make_room(self.alice)
        self.saved = make_room(kind=Room.KIND_SAVED, name='Saved', *[self.alice])
        self.client.force_login(self.alice)

    def post(self, room, payload):
        return self.client.post(reverse('send_message_api', args=[room.id]),
                                json.dumps(payload), content_type='application/json')

    def test_ciphertext_envelope_is_stored_opaquely(self):
        res = self.post(self.saved, {'content': 'ct', 'iv': 'iv',
                                     'encrypted_keys': {'1': {'box': 'b'}}, 'kind': 'text'})
        self.assertEqual(res.status_code, 200)
        m = Message.objects.get(id=res.json()['id'])
        self.assertEqual((m.content, m.iv, m.kind), ('ct', 'iv', 'text'))
        self.assertEqual(m.room, self.saved)

    def test_missing_ciphertext_is_rejected(self):
        self.assertEqual(self.post(self.saved, {'content': '', 'iv': 'x'}).status_code, 400)

    def test_unknown_kind_falls_back_to_text(self):
        res = self.post(self.saved, {'content': 'ct', 'iv': 'iv', 'kind': 'exe',
                                     'encrypted_keys': {'1': {'box': 'b'}}})
        self.assertEqual(Message.objects.get(id=res.json()['id']).kind, 'text')

    def test_envelope_sealed_to_nobody_is_rejected(self):
        # A message with no member keys can never be opened, so it must not be stored.
        for payload in ({'content': 'ct', 'iv': 'iv'},
                        {'content': 'ct', 'iv': 'iv', 'encrypted_keys': {}},
                        {'content': 'ct', 'iv': 'iv', 'encrypted_keys': 'nope'}):
            self.assertEqual(self.post(self.saved, payload).status_code, 400)
        self.assertEqual(Message.objects.count(), 0)

    def test_non_member_cannot_send(self):
        other = User.objects.create_user('bob', password='x')
        self.client.force_login(other)
        self.assertEqual(self.post(self.saved, {'content': 'ct', 'iv': 'iv'}).status_code, 403)


class RoomFeatureTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user('alice', password='x')
        self.bob = User.objects.create_user('bob', password='x')
        self.room = make_room(self.alice, self.bob)
        self.client.force_login(self.alice)

    def test_saved_room_is_created_once_per_user(self):
        first = Room.ensure_saved_for(self.alice)
        second = Room.ensure_saved_for(self.alice)
        self.assertEqual(first.id, second.id)
        self.assertEqual(Room.objects.filter(kind=Room.KIND_SAVED).count(), 1)

    def test_contacts_page_lists_other_users(self):
        res = self.client.get(reverse('contacts'))
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, 'bob')

    def test_conversations_page_has_no_contacts_panel(self):
        res = self.client.get(reverse('room_list'))
        self.assertEqual(res.status_code, 200)
        self.assertNotContains(res, 'contact-row')
        self.assertNotContains(res, 'contacts-search')

    def test_new_group_form_ships_as_a_closed_modal(self):
        res = self.client.get(reverse('room_list'))
        self.assertContains(res, 'id="create-group-overlay"')
        self.assertContains(res, 'id="create-group-form"')
        self.assertNotContains(res, 'id="create-group-card"')
        self.assertNotContains(res, 'class="overlay show"')

    def test_new_group_deep_link_opens_the_modal(self):
        res = self.client.get(reverse('create_group') + '?new=1')
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, 'class="overlay show"')

    def test_group_creation_from_the_modal_creates_the_room(self):
        res = self.client.post(reverse('create_group'),
                               {'name': 'Family', 'members': [self.bob.id]})
        room = Room.objects.get(name='Family', is_group=True)
        self.assertRedirects(res, reverse('room_detail', args=[room.id]))
        self.assertEqual(set(room.members.values_list('id', flat=True)),
                         {self.alice.id, self.bob.id})

    def test_saved_room_api_creates_on_demand_for_saving(self):
        res = self.client.get(reverse('saved_room_api'))
        self.assertEqual(res.status_code, 200)
        room = Room.objects.get(id=res.json()['id'])
        self.assertEqual(room.kind, Room.KIND_SAVED)
        self.assertEqual(list(room.members.all()), [self.alice])
        self.assertEqual(self.client.get(reverse('saved_room_api')).json()['id'], room.id)

    def test_pin_then_unpin(self):
        m = text_message(self.room, self.alice)
        url = reverse('message_pin_api', args=[m.id])
        self.client.post(url, json.dumps({'pinned': True}), content_type='application/json')
        m.refresh_from_db()
        self.assertIsNotNone(m.pinned_at)
        self.assertEqual(m.pinned_by, self.alice)
        self.client.post(url, json.dumps({'pinned': False}), content_type='application/json')
        m.refresh_from_db()
        self.assertIsNone(m.pinned_at)

    def test_pin_by_non_member_is_forbidden(self):
        m = text_message(self.room, self.alice)
        self.client.force_login(User.objects.create_user('carol', password='x'))
        res = self.client.post(reverse('message_pin_api', args=[m.id]),
                               json.dumps({'pinned': True}), content_type='application/json')
        self.assertEqual(res.status_code, 403)

    def test_reaction_toggles_per_user(self):
        m = text_message(self.room, self.alice)
        url = reverse('message_react_api', args=[m.id])
        body = json.dumps({'emoji': '❤️'})
        self.client.post(url, body, content_type='application/json')
        self.client.force_login(self.bob)
        res = self.client.post(url, body, content_type='application/json')
        self.assertEqual(len(res.json()['reactions']['❤️']), 2)
        res = self.client.post(url, body, content_type='application/json')
        self.assertEqual(len(res.json()['reactions']['❤️']), 1)

    def test_room_mute_persists_per_user(self):
        url = reverse('room_prefs_api', args=[self.room.id])
        self.client.post(url, json.dumps({'muted': True}), content_type='application/json')
        self.assertTrue(RoomPrefs.objects.get(room=self.room, user=self.alice).muted)
        self.assertFalse(RoomPrefs.objects.filter(room=self.room, user=self.bob,
                                                  muted=True).exists())


class PrivateRoomTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user('alice', password='x')
        self.bob = User.objects.create_user('bob', password='x')
        self.client.force_login(self.alice)

    def test_start_private_creates_one_room_and_reuses_it(self):
        url = reverse('start_private', args=['bob'])
        first = self.client.get(url)['Location']
        second = self.client.get(url)['Location']
        self.assertEqual(first, second)
        self.assertEqual(Room.objects.filter(members=self.alice).count(), 1)

    def test_legacy_room_is_reused_instead_of_duplicated(self):
        legacy = Room.objects.create(name='alice__bob', is_group=False, kind=Room.KIND_GROUP)
        legacy.members.add(self.alice, self.bob)
        room = Room.private_between(self.alice, self.bob)
        self.assertEqual(room.id, legacy.id)
        self.assertEqual(room.kind, Room.KIND_PRIVATE)
        self.assertEqual(Room.objects.count(), 1)

    def test_private_between_ignores_groups_that_happen_to_contain_the_pair(self):
        Room.objects.create(name='wide group', is_group=True, kind=Room.KIND_GROUP)
        room = Room.private_between(self.alice, self.bob)
        self.assertFalse(room.is_group)
        self.assertEqual(room.members.count(), 2)

    def test_title_for_uses_the_peer_username(self):
        room = Room.private_between(self.alice, self.bob)
        self.assertEqual(room.title_for(self.alice), 'bob')
        self.assertEqual(room.title_for(self.bob), 'alice')

    def test_group_and_saved_rooms_keep_their_own_names(self):
        group = make_room(self.alice, self.bob, name='QA Lab')
        self.assertEqual(group.title_for(self.alice), 'QA Lab')
        saved = Room.ensure_saved_for(self.alice)
        self.assertEqual(saved.title_for(self.alice), saved.name)

    def test_chat_list_labels_a_dm_with_the_peer_name(self):
        room = Room.private_between(self.alice, self.bob)
        res = self.client.get(reverse('room_list'))
        self.assertContains(res, '<span class="name truncate">bob</span>', html=True)
        self.assertNotContains(res, 'alice__bob')
        summary = self.client.get(reverse('rooms_summary_api')).json()['rooms']
        self.assertEqual([r['name'] for r in summary if r['id'] == room.id], ['bob'])

    def test_room_page_never_shows_the_internal_dm_key(self):
        room = Room.private_between(self.alice, self.bob)
        res = self.client.get(reverse('room_detail', args=[room.id]))
        self.assertNotContains(res, 'alice__bob')


class NotificationDispatchTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user('alice', password='x')
        self.bob = User.objects.create_user('bob', password='x')
        self.room = make_room(self.alice, self.bob)
        keys = PushKeys.current()
        keys.public_key, keys.private_pem = 'PUB', 'PEM'
        keys.save()
        self.sub = PushSubscription.objects.create(
            user=self.bob, endpoint='https://push.example/abc',
            keys={'keys': {'p256dh': 'AAA', 'auth': 'BBB'}})
        self.prefs = UserSettings.for_user(self.bob)
        self.prefs.push_on = True
        self.prefs.save()

    def send_push(self, **kw):
        with mock.patch('chat.webpush_min.send_push', **kw) as m:
            _send_all(self.room.id, self.alice.id, 'alice')
        return m

    def test_recipient_subscribed_gets_one_push(self):
        sent = self.send_push()
        sent.assert_called_once()
        self.assertNotIn('cipher', sent.call_args.args[2])

    def test_sender_never_notifies_themselves(self):
        with mock.patch('chat.webpush_min.send_push') as m:
            _send_all(self.room.id, self.bob.id, 'bob')
        m.assert_not_called()

    def test_muted_room_suppresses_push(self):
        RoomPrefs.objects.create(room=self.room, user=self.bob, muted=True)
        self.send_push().assert_not_called()

    def test_global_toggle_off_suppresses_push(self):
        self.prefs.push_on = False
        self.prefs.save()
        self.send_push().assert_not_called()

    def test_gone_subscription_is_dropped(self):
        err = urllib.error.HTTPError('https://push.example/abc', 410, 'Gone', {}, None)
        self.send_push(side_effect=err)
        self.assertFalse(PushSubscription.objects.filter(pk=self.sub.pk).exists())

    def test_other_push_errors_keep_the_subscription(self):
        err = urllib.error.HTTPError('https://push.example/abc', 500, 'Boo', {}, None)
        self.send_push(side_effect=err)
        self.assertTrue(PushSubscription.objects.filter(pk=self.sub.pk).exists())

    def test_missing_vapid_keys_sends_nothing(self):
        keys = PushKeys.current()
        keys.public_key = ''
        keys.save()
        self.send_push().assert_not_called()


class WipeEpochTests(TestCase):
    def test_old_epoch_messages_are_hidden_from_the_api(self):
        alice = User.objects.create_user('alice', password='x')
        room = make_room(alice)
        old = text_message(room, alice)
        WipeEpoch.bump()
        self.client.force_login(alice)
        res = self.client.get(reverse('room_messages_api', args=[room.id]))
        self.assertEqual([m['id'] for m in res.json()['messages']], [])
        summary = self.client.get(reverse('rooms_summary_api')).json()['rooms']
        self.assertIsNone(summary[0]['last'])


class TypingRelayTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user('alice', password='x')
        self.bob = User.objects.create_user('bob', password='x')

    def consumer(self):
        from .consumers import ChatConsumer

        class Relay(ChatConsumer):
            def __init__(self, user):
                self.user = user
                self.sent = []

            async def send(self, text_data=None, bytes_data=None):
                self.sent.append(text_data)

        return Relay(self.alice)

    def test_a_member_never_gets_their_own_typing_event(self):
        c = self.consumer()
        asyncio.run(c.broadcast_typing({'from': self.alice.id, 'from_username': 'alice'}))
        self.assertEqual(c.sent, [])

    def test_other_members_do_get_it(self):
        c = self.consumer()
        asyncio.run(c.broadcast_typing({'from': self.bob.id, 'from_username': 'bob'}))
        self.assertEqual(json.loads(c.sent[0])['from_username'], 'bob')
