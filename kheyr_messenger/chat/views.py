import os
import json
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse, FileResponse
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from .models import Room, Message, MessageFile, WipeEpoch, CodeIntegrity


@login_required
def room_list(request):
    rooms = request.user.chat_rooms.all().order_by('-created_at')
    User = get_user_model()
    others = User.objects.filter(is_active=True).exclude(id=request.user.id)
    return render(request, 'chat/room_list.html', {'rooms': rooms, 'others': others})


@login_required
def room_detail(request, room_id):
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return redirect('room_list')
    return render(request, 'chat/room.html', {
        'room': room,
        'room_json': {'id': room.id, 'name': room.name, 'is_group': room.is_group},
    })


@login_required
def create_group(request):
    if request.method == 'POST':
        name = request.POST.get('name', '').strip()
        member_ids = request.POST.getlist('members')
        if name and member_ids:
            room = Room.objects.create(name=name, is_group=True)
            room.members.add(request.user.id)
            for uid in member_ids:
                if uid != str(request.user.id):
                    room.members.add(uid)
            return redirect('room_detail', room_id=room.id)
    User = get_user_model()
    return render(request, 'chat/room_list.html', {
        'rooms': request.user.chat_rooms.all(),
        'others': User.objects.filter(is_active=True).exclude(id=request.user.id),
        'show_create': True,
    })


@login_required
def start_private(request, username):
    User = get_user_model()
    other = get_object_or_404(User, username=username, is_active=True)
    if other == request.user:
        return redirect('room_list')
    existing = Room.objects.filter(is_group=False, members=request.user).filter(members=other).first()
    if existing:
        return redirect('room_detail', room_id=existing.id)
    name = f"{min(request.user.username, other.username)}__{max(request.user.username, other.username)}"
    room = Room.objects.create(name=name, is_group=False)
    room.members.add(request.user, other)
    return redirect('room_detail', room_id=room.id)


@login_required
def room_messages_api(request, room_id):
    room = get_object_or_404(Room, id=room_id)
    if not room.members.filter(id=request.user.id).exists():
        return JsonResponse({'error': 'forbidden'}, status=403)
    current = WipeEpoch.current().value
    msgs = room.messages.filter(epoch=current).order_by('timestamp')[:1000]
    out = []
    for m in msgs:
        mf = m.files.first() if m.files.exists() else None
        if mf:
            out.append({
                'id': m.id, 'content': '', 'iv': mf.iv,
                'encrypted_keys': mf.encrypted_keys,
                'file_name': mf.original_name, 'file_id': mf.id, 'mime_type': mf.mime_type,
                'sender_id': m.sender.id, 'sender_username': m.sender.username,
                'timestamp': m.timestamp.isoformat(),
            })
        else:
            out.append({
                'id': m.id, 'content': m.content, 'iv': m.iv,
                'encrypted_keys': m.encrypted_keys, 'file_name': '', 'file_id': None,
                'sender_id': m.sender.id, 'sender_username': m.sender.username,
                'timestamp': m.timestamp.isoformat(),
            })
    return JsonResponse({'messages': out, 'epoch': current})


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
    encrypted_keys_raw = request.POST.get('encrypted_keys', '{}')
    original_name = request.POST.get('original_name', 'file')
    mime_type = request.POST.get('mime_type', '')
    try:
        encrypted_keys = json.loads(encrypted_keys_raw)
    except Exception:
        encrypted_keys = {}
    if not iv or not encrypted_keys:
        return JsonResponse({'error': 'missing'}, status=400)
    note = Message.objects.create(
        room=room, sender=request.user,
        content='', iv='', encrypted_keys=encrypted_keys,
        file_name=original_name, epoch=WipeEpoch.current().value,
    )
    mf = MessageFile(
        room=room, sender=request.user, message=note,
        iv=iv, encrypted_keys=encrypted_keys,
        original_name=original_name, mime_type=mime_type,
        epoch=WipeEpoch.current().value,
    )
    mf.encrypted_file.save(uploaded.name, ContentFile(uploaded.read()), save=True)
    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(f'chat_{room.id}', {
        'type': 'broadcast',
        'id': note.id, 'content': '', 'iv': iv,
        'encrypted_keys': encrypted_keys, 'file_name': original_name, 'file_id': mf.id,
        'sender_id': request.user.id, 'sender_username': request.user.username,
        'timestamp': note.timestamp.isoformat(),
    })
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
def code_integrity_api(request):
    data = {ci.file_path: ci.sha256 for ci in CodeIntegrity.objects.all()}
    return JsonResponse({'hashes': data})


def wiped(request):
    return render(request, 'chat/wiped.html')