import time
import json
import hmac
import hashlib
import base64
import os
from django.http import JsonResponse
from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404
from django.utils import timezone
from .models import Room, CallSession


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _make_jwt(api_key, api_secret, identity, room_name, ttl_seconds=3600):
    header = {'alg': 'HS256', 'typ': 'JWT'}
    now = int(time.time())
    payload = {
        'exp': now + ttl_seconds, 'iss': api_key, 'nbf': now - 5,
        'sub': identity, 'name': identity,
        'video': {
            'room': room_name, 'roomJoin': True,
            'canPublish': True, 'canSubscribe': True, 'canPublishData': True,
        },
    }
    h = _b64url(json.dumps(header, separators=(',', ':')).encode())
    p = _b64url(json.dumps(payload, separators=(',', ':')).encode())
    sig = hmac.new(api_secret.encode(), f'{h}.{p}'.encode(), hashlib.sha256).digest()
    return f'{h}.{p}.{_b64url(sig)}'


@login_required
def create_call_session_api(request, room_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    try:
        body = json.loads(request.body)
    except Exception:
        return JsonResponse({'error': 'bad json'}, status=400)
    encrypted_keys = body.get('encrypted_keys', {})
    if not encrypted_keys:
        return JsonResponse({'error': 'missing'}, status=400)
    CallSession.objects.filter(room=room, is_active=True).update(
        is_active=False, ended_at=timezone.now()
    )
    session = CallSession.objects.create(
        room=room, initiator=request.user,
        encrypted_keys=encrypted_keys, is_active=True,
    )
    return JsonResponse({'call_session_id': session.id})


@login_required
def livekit_token_api(request, room_id, session_id):
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    session = get_object_or_404(CallSession, id=session_id, room=room, is_active=True)
    my_enc_key = session.encrypted_keys.get(str(request.user.id))
    if not my_enc_key:
        return JsonResponse({'error': 'no key for you'}, status=403)

    api_key = os.environ.get('LIVEKIT_API_KEY', 'devkey')
    api_secret = os.environ.get('LIVEKIT_API_SECRET', 'secret')
    lk_url = os.environ.get('LIVEKIT_URL', 'ws://127.0.0.1:7880')

    livekit_room = f'room_{room.id}_call_{session.id}'
    token = _make_jwt(api_key, api_secret,
                      identity=f'user_{request.user.id}_{request.user.username}',
                      room_name=livekit_room)
    return JsonResponse({
        'token': token, 'url': lk_url, 'room': livekit_room,
        'call_session_id': session.id,
        'encrypted_aes_key_for_me': my_enc_key,
    })


@login_required
def end_call_session_api(request, room_id, session_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    session = get_object_or_404(CallSession, id=session_id, room=room)
    session.is_active = False
    session.ended_at = timezone.now()
    session.save(update_fields=['is_active', 'ended_at'])
    return JsonResponse({'ok': True})