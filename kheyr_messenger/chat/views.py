import os
import json
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse, FileResponse
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.db.models import Count, Q
from django.utils import timezone
from .models import (Room, Message, MessageFile, WipeEpoch, CodeIntegrity,
                     RoomPrefs, MESSAGE_KINDS)
from accounts.models import UserSettings


def _ui_settings(request):
    return UserSettings.for_user(request.user).to_json()


def _name_rooms(user, rooms):
    for room in rooms:
        room.display_title = room.title_for(user)
    return rooms


def _json_body(request):
    try:
        return json.loads(request.body)
    except Exception:
        return {}


def _broadcast(room, payload):
    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer
    async_to_sync(get_channel_layer().group_send)(f'chat_{room.id}', payload)


def _mf_of(m):
    return m.attachments.first() if not m.deleted_at else None


def _parent_ref(m):
    if not m.parent:
        return None
    p = m.parent
    return {
        'id': p.id, 'kind': p.kind if not p.deleted_at else 'deleted',
        'sender_username': p.sender.username,
        'content': '' if p.deleted_at else p.content,
        'iv': '' if p.deleted_at else p.iv,
        'encrypted_keys': {} if p.deleted_at else p.encrypted_keys,
        'file_name': '' if p.deleted_at else p.file_name,
    }


def message_payload(m, mf=None):
    if mf is None:
        mf = _mf_of(m)
    return {
        'id': m.id, 'room_id': m.room_id,
        'content': '' if m.deleted_at else m.content,
        # Message envelope IV; the attachment blob has its own (file_iv).
        'iv': '' if m.deleted_at else m.iv,
        'file_iv': '' if (m.deleted_at or not mf) else mf.iv,
        'encrypted_keys': {} if m.deleted_at else (mf.encrypted_keys if mf else m.encrypted_keys),
        'file_name': '' if m.deleted_at else m.file_name,
        'file_id': mf.id if mf else None,
        'mime_type': mf.mime_type if mf else '',
        'file_kind': mf.kind if mf else m.kind,
        'has_meta': bool(mf and (mf.meta or {}).get('data')),
        'duration_ms': mf.duration_ms if mf else None,
        'width': mf.width if mf else None,
        'height': mf.height if mf else None,
        'size_bytes': (mf.size_bytes or (mf.encrypted_file.size if mf else 0)) if mf else 0,
        'kind': 'deleted' if m.deleted_at else m.kind,
        'parent': _parent_ref(m),
        'reactions': m.reactions or {},
        'pinned_at': m.pinned_at.isoformat() if m.pinned_at else None,
        'deleted_at': m.deleted_at.isoformat() if m.deleted_at else None,
        'sender_id': m.sender_id, 'sender_username': m.sender.username,
        'timestamp': m.timestamp.isoformat(),
    }


@login_required
def room_list(request):
    User = get_user_model()
    saved = Room.ensure_saved_for(request.user)
    rooms = request.user.chat_rooms.exclude(kind=Room.KIND_SAVED) \
        .prefetch_related('members').order_by('-created_at')
    prefs = {p.room_id: p for p in RoomPrefs.objects.filter(user=request.user)}
    others = User.objects.filter(is_active=True).exclude(id=request.user.id)
    _name_rooms(request.user, [saved, *rooms])
    return render(request, 'chat/room_list.html', {
        'rooms': rooms, 'others': others, 'prefs': prefs, 'saved': saved,
        'ui_settings': _ui_settings(request),
    })


@login_required
def room_detail(request, room_id):
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return redirect('room_list')
    pref = room.prefs_for(request.user)
    _name_rooms(request.user, [room])
    return render(request, 'chat/room.html', {
        'room': room,
        'room_json': {
            'id': room.id, 'name': room.display_title, 'is_group': room.is_group,
            'kind': room.kind, 'topic': room.topic, 'avatar_color': room.avatar_color,
            'member_count': room.members.count(),
            'prefs': {'muted': pref.muted, 'pinned': pref.pinned, 'archived': pref.archived},
        },
        'ui_settings': _ui_settings(request),
    })


@login_required
def contacts(request):
    User = get_user_model()
    others = User.objects.filter(is_active=True).exclude(id=request.user.id).order_by('username')
    return render(request, 'chat/contacts.html', {
        'others': others, 'ui_settings': _ui_settings(request),
    })


@login_required
def saved_room_api(request):
    return JsonResponse({'id': Room.ensure_saved_for(request.user).id})


@login_required
def create_group(request):
    User = get_user_model()
    if request.method == 'POST':
        name = request.POST.get('name', '').strip()
        member_ids = request.POST.getlist('members')
        if name and member_ids:
            room = Room.objects.create(
                name=name, is_group=True, kind=Room.KIND_GROUP,
                avatar_color=request.POST.get('avatar_color', '').strip(),
                topic=request.POST.get('topic', '').strip(),
            )
            room.members.add(request.user.id)
            for uid in member_ids:
                if uid != str(request.user.id):
                    room.members.add(uid)
            return redirect('room_detail', room_id=room.id)
    if not request.GET.get('new'):
        return redirect('room_list')
    saved = Room.ensure_saved_for(request.user)
    rooms = request.user.chat_rooms.exclude(kind=Room.KIND_SAVED) \
        .prefetch_related('members').order_by('-created_at')
    _name_rooms(request.user, [saved, *rooms])
    return render(request, 'chat/room_list.html', {
        'rooms': rooms, 'saved': saved,
        'others': User.objects.filter(is_active=True).exclude(id=request.user.id),
        'prefs': {p.room_id: p for p in RoomPrefs.objects.filter(user=request.user)},
        'show_create': True,
        'ui_settings': _ui_settings(request),
    })


@login_required
def start_private(request, username):
    User = get_user_model()
    other = get_object_or_404(User, username=username, is_active=True)
    if other == request.user:
        return redirect('room_list')
    room = Room.private_between(request.user, other)
    return redirect('room_detail', room_id=room.id)


@login_required
def room_messages_api(request, room_id):
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    current = WipeEpoch.current().value
    limit = min(int(request.GET.get('limit', 50)), 100)
    before = request.GET.get('before')
    qs = room.messages.filter(epoch=current)
    if before:
        qs = qs.filter(id__lt=int(before))
    ids = list(qs.order_by('-id').values_list('id', flat=True)[:limit + 1])
    has_more = len(ids) > limit
    page = sorted(ids[:limit])
    msgs = list(Message.objects.filter(id__in=page)
                .select_related('sender', 'room', 'parent', 'parent__sender')
                .prefetch_related('attachments'))
    return JsonResponse({
        'messages': [message_payload(m) for m in msgs],
        'epoch': current, 'has_more': has_more,
    })


@login_required
def rooms_summary_api(request):
    current = WipeEpoch.current().value
    prefs = {p.room_id: p for p in RoomPrefs.objects.filter(user=request.user)}
    out = []
    for room in request.user.chat_rooms.prefetch_related('members'):
        pref = prefs.get(room.id)
        last = room.messages.filter(epoch=current).select_related('sender') \
            .prefetch_related('attachments').order_by('-id').first()
        read_at = pref.last_read_at if pref and pref.last_read_at else None
        unread_qs = room.messages.filter(epoch=current).exclude(sender=request.user)
        if read_at:
            unread_qs = unread_qs.filter(timestamp__gt=read_at)
        out.append({
            'id': room.id, 'name': room.title_for(request.user), 'kind': room.kind,
            'is_group': room.is_group, 'topic': room.topic,
            'avatar_color': room.avatar_color,
            'member_count': room.members.count(),
            'muted': bool(pref and pref.muted), 'pinned': bool(pref and pref.pinned),
            'archived': bool(pref and pref.archived),
            'unread': unread_qs.count(),
            'last': message_payload(last) if last else None,
        })
    out.sort(key=lambda r: (not r['pinned'], r['archived'],
                            -(int(r['last']['id']) if r['last'] else 0)))
    return JsonResponse({'rooms': out})


@login_required
def room_media_api(request, room_id):
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    current = WipeEpoch.current().value
    kind = request.GET.get('kind', '')
    qs = MessageFile.objects.filter(room=room, epoch=current).exclude(message__deleted_at__isnull=False)
    if kind == 'image':
        qs = qs.filter(kind__in=['image'])
    elif kind in ('video', 'audio', 'voice'):
        qs = qs.filter(kind=kind)
    out = [{
        'file_id': mf.id, 'message_id': mf.message_id, 'kind': mf.kind,
        'mime_type': mf.mime_type, 'original_name': mf.original_name,
        'duration_ms': mf.duration_ms, 'width': mf.width, 'height': mf.height,
        'size_bytes': mf.size_bytes, 'iv': mf.iv,
        'encrypted_keys': mf.encrypted_keys,
        'sender_username': mf.sender.username, 'timestamp': mf.uploaded_at.isoformat(),
    } for mf in qs.order_by('-id')[:500]]
    return JsonResponse({'files': out})


@login_required
def room_pins_api(request, room_id):
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    msgs = room.messages.filter(epoch=WipeEpoch.current().value,
                                pinned_at__isnull=False).order_by('-pinned_at')
    return JsonResponse({'pins': [message_payload(m) for m in msgs]})


def _get_message_for_user(request, message_id):
    m = get_object_or_404(Message, id=message_id)
    if not m.room.members.filter(id=request.user.id).exists():
        return None, JsonResponse({'error': 'forbidden'}, status=403)
    return m, None


@login_required
def message_pin_api(request, message_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    m, err = _get_message_for_user(request, message_id)
    if err:
        return err
    body = _json_body(request)
    pin = bool(body.get('pinned', True))
    m.pinned_at = timezone.now() if pin else None
    m.pinned_by = request.user if pin else None
    m.save(update_fields=['pinned_at', 'pinned_by'])
    _broadcast(m.room, {'type': 'broadcast_message_update', 'update_type': 'pin',
                        'payload': message_payload(m)})
    return JsonResponse({'ok': True, 'pinned': pin})


@login_required
def message_react_api(request, message_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    m, err = _get_message_for_user(request, message_id)
    if err:
        return err
    emoji = str(_json_body(request).get('emoji', ''))[:8]
    if not emoji:
        return JsonResponse({'error': 'no emoji'}, status=400)
    reactions = dict(m.reactions or {})
    users = set(reactions.get(emoji, []))
    if request.user.id in users:
        users.discard(request.user.id)
    else:
        users.add(request.user.id)
    if users:
        reactions[emoji] = sorted(users)
    else:
        reactions.pop(emoji, None)
    m.reactions = reactions
    m.save(update_fields=['reactions'])
    _broadcast(m.room, {'type': 'broadcast_message_update', 'update_type': 'react',
                        'payload': message_payload(m)})
    return JsonResponse({'ok': True, 'reactions': reactions})


@login_required
def message_delete_api(request, message_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    m, err = _get_message_for_user(request, message_id)
    if err:
        return err
    if m.sender_id != request.user.id:
        return JsonResponse({'error': 'not yours'}, status=403)
    m.deleted_at = timezone.now()
    m.pinned_at = None
    m.save(update_fields=['deleted_at', 'pinned_at'])
    _broadcast(m.room, {'type': 'broadcast_message_update', 'update_type': 'delete',
                        'payload': message_payload(m)})
    return JsonResponse({'ok': True})


@login_required
def send_message_api(request, room_id):
    """HTTP twin of the websocket chat_message frame, for cross-room actions
    (saving a message) where the page holds no socket to the target room."""
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    body = _json_body(request)
    content = str(body.get('content', ''))[:200000]
    iv = str(body.get('iv', ''))[:64]
    encrypted_keys = body.get('encrypted_keys')
    if not isinstance(encrypted_keys, dict):
        encrypted_keys = {}
    kind = body.get('kind', 'text')
    if kind not in MESSAGE_KINDS:
        kind = 'text'
    if not content or not iv:
        return JsonResponse({'error': 'empty'}, status=400)
    if not encrypted_keys:
        return JsonResponse({'error': 'no member key sealed'}, status=400)
    m = Message.objects.create(
        room=room, sender=request.user, content=content, iv=iv,
        encrypted_keys=encrypted_keys, kind=kind,
        file_name=str(body.get('file_name', ''))[:255],
        epoch=WipeEpoch.current().value,
    )
    _broadcast(room, {'type': 'broadcast', 'payload': message_payload(m)})
    return JsonResponse({'ok': True, 'id': m.id})


@login_required
def room_read_api(request, room_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    pref = room.prefs_for(request.user)
    pref.last_read_at = timezone.now()
    pref.save(update_fields=['last_read_at'])
    return JsonResponse({'ok': True})


@login_required
def room_prefs_api(request, room_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    body = _json_body(request)
    pref = room.prefs_for(request.user)
    fields = []
    for key in ('muted', 'pinned', 'archived'):
        if key in body:
            setattr(pref, key, bool(body[key]))
            fields.append(key)
    if fields:
        pref.save(update_fields=fields)
    return JsonResponse({'ok': True, 'prefs': {
        'muted': pref.muted, 'pinned': pref.pinned, 'archived': pref.archived}})


@login_required
def members_public_keys_api(request, room_id):
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    data = {}
    for u in room.members.all():
        data[str(u.id)] = u.public_key
    return JsonResponse({'keys': data, 'me': request.user.id})


@login_required
def members_list_api(request, room_id):
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    members = [{'id': u.id, 'username': u.username} for u in room.members.all()]
    return JsonResponse({'members': members, 'me': request.user.id})


FILE_KINDS = {'image', 'video', 'audio', 'voice', 'file'}

# The tag envelope is opaque here; only its shape and size are policed.
MAX_META_CHARS = 400_000


def _clean_meta(raw):
    try:
        env = json.loads(raw) if raw else {}
    except Exception:
        return {}
    if not isinstance(env, dict) or env.get('v') != 1:
        return {}
    iv, data = env.get('iv'), env.get('data')
    if not isinstance(iv, str) or not isinstance(data, str) or not data:
        return {}
    if len(iv) > 64 or len(data) > MAX_META_CHARS:
        return {}
    return {'v': 1, 'iv': iv, 'data': data}


@login_required
def upload_file_api(request, room_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    uploaded = request.FILES.get('file')
    if not uploaded:
        return JsonResponse({'error': 'no file'}, status=400)
    iv = request.POST.get('iv', '')
    try:
        encrypted_keys = json.loads(request.POST.get('encrypted_keys', '{}'))
    except Exception:
        encrypted_keys = {}
    if not isinstance(encrypted_keys, dict) or not encrypted_keys:
        return JsonResponse({'error': 'no member key sealed'}, status=400)
    original_name = request.POST.get('original_name', 'file')
    mime_type = request.POST.get('mime_type', '')
    kind = request.POST.get('kind', '')
    if kind not in FILE_KINDS:
        kind = 'file'
    if mime_type.startswith('image/'):
        kind = 'image'
    elif mime_type.startswith('video/'):
        kind = 'video'
    elif mime_type.startswith('audio/'):
        kind = 'voice' if kind == 'voice' else 'audio'

    def _int(name):
        v = request.POST.get(name, '')
        try:
            return int(v) if v else None
        except ValueError:
            return None

    epoch = WipeEpoch.current().value
    # A caption rides the note's own columns; the attachment blob keeps its IV on
    # MessageFile, so both open with the same per-file key but never share an IV.
    note = Message.objects.create(
        room=room, sender=request.user,
        content=str(request.POST.get('content', ''))[:200000],
        iv=str(request.POST.get('text_iv', ''))[:128],
        encrypted_keys=encrypted_keys,
        file_name=original_name, kind=kind, epoch=epoch,
    )
    mf = MessageFile(
        room=room, sender=request.user, message=note,
        iv=iv, encrypted_keys=encrypted_keys,
        original_name=original_name, mime_type=mime_type, kind=kind,
        meta=_clean_meta(request.POST.get('meta', '')),
        duration_ms=_int('duration_ms'), width=_int('width'), height=_int('height'),
        size_bytes=uploaded.size or 0, epoch=epoch,
    )
    mf.encrypted_file.save(uploaded.name, ContentFile(uploaded.read()), save=True)
    _broadcast(room, {'type': 'broadcast', 'payload': message_payload(note, mf)})
    from .notifications import fire_new_message_push
    fire_new_message_push(room, request.user)
    return JsonResponse({'ok': True, 'message_id': note.id, 'file_id': mf.id})


@login_required
def download_file_api(request, file_id):
    mf = get_object_or_404(MessageFile, id=file_id)
    if not mf.room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    if not mf.encrypted_file:
        return JsonResponse({'error': 'missing'}, status=404)
    resp = FileResponse(mf.encrypted_file.open('rb'), content_type='application/octet-stream')
    resp['Content-Disposition'] = f'attachment; filename="{os.path.basename(mf.encrypted_file.name)}"'
    return resp


@login_required
def file_meta_api(request, file_id):
    """The encrypted tag envelope of an attachment, for members only."""
    mf = get_object_or_404(MessageFile, id=file_id)
    if not mf.room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    return JsonResponse({'meta': mf.meta or {}})


@login_required
def code_integrity_api(request):
    data = {ci.file_path: ci.sha256 for ci in CodeIntegrity.objects.all()}
    return JsonResponse({'hashes': data})


@login_required
def push_public_key_api(request):
    from .models import PushKeys
    return JsonResponse({'key': PushKeys.current().public_key})


@login_required
def push_subscribe_api(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    from .models import PushSubscription
    body = _json_body(request)
    endpoint = str(body.get('endpoint', ''))[:2000]
    keys = body.get('keys') or {}
    if not endpoint or not keys.get('p256dh') or not keys.get('auth'):
        return JsonResponse({'error': 'bad subscription'}, status=400)
    sub, _ = PushSubscription.objects.update_or_create(
        endpoint=endpoint, defaults={'user': request.user, 'keys': {'keys': keys}}
    )
    return JsonResponse({'ok': True, 'id': sub.id})


@login_required
def push_unsubscribe_api(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    from .models import PushSubscription
    endpoint = str(_json_body(request).get('endpoint', ''))
    PushSubscription.objects.filter(user=request.user, endpoint=endpoint).delete()
    return JsonResponse({'ok': True})


def wiped(request):
    return render(request, 'chat/wiped.html')
