import json
import threading
import urllib.error


def fire_new_message_push(room, sender):
    """Spawn a background send for Web Push subscribers. Never blocks the chat path.

    Payload carries only room/sender metadata — message bodies are E2EE and
    the server cannot (and must not) read them.
    """
    t = threading.Thread(target=_send_all, args=(room.id, sender.id, sender.username),
                         daemon=True)
    t.start()


def _send_all(room_id, sender_id, sender_username):
    from .models import Room, PushKeys, PushSubscription, RoomPrefs
    try:
        keys = PushKeys.current()
        if not keys.private_pem or not keys.public_key:
            return
        room = Room.objects.get(id=room_id)
        subs = PushSubscription.objects.filter(
            user__in=room.members.exclude(id=sender_id)
        ).select_related('user')
        prefs = {p.user_id: p for p in RoomPrefs.objects.filter(room=room)}
        is_dm = not room.is_group and room.kind != Room.KIND_SAVED
        for sub in subs:
            pref = prefs.get(sub.user_id)
            if pref and pref.muted:
                continue
            settings_obj = getattr(sub.user, 'ui_settings', None)
            if not settings_obj or not settings_obj.push_on:
                continue
            payload = json.dumps({
                'title': sender_username if is_dm else room.name,
                'body': f'پیام جدید از {sender_username}',
                'room_id': room.id,
            })
            try:
                from .webpush_min import send_push
                send_push(sub.endpoint, sub.keys, payload,
                          keys.private_pem, keys.public_key)
            except urllib.error.HTTPError as exc:
                if exc.code in (404, 410):
                    sub.delete()
            except Exception:
                pass
    except Exception:
        pass
