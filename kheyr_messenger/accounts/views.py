import mimetypes
import secrets
import json
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth import authenticate, login, logout as auth_logout
from django.contrib import messages
from django.http import JsonResponse, FileResponse
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.urls import reverse
from .forms import RegisterForm
from .models import CustomUser, UserSettings, ProfilePhoto

MAX_PHOTO_BYTES = 8 * 1024 * 1024


def register_view(request):
    if request.method == 'POST':
        form = RegisterForm(request.POST)
        if form.is_valid():
            u = form.save(commit=False)
            u.set_password(form.cleaned_data['auth_hash'])
            u.set_duress_password(form.cleaned_data['duress_hash'])
            u.public_key = form.cleaned_data['public_key']
            u.crypto_salt = form.cleaned_data['crypto_salt']
            u.is_active = False
            u.save()
            UserSettings.objects.create(user=u)
            return render(request, 'accounts/waiting.html')
    else:
        form = RegisterForm()
    return render(request, 'accounts/register.html', {'form': form})


def _perform_global_wipe():
    from chat.models import Message, MessageFile, WipeEpoch
    with transaction.atomic():
        for mf in MessageFile.objects.all():
            try:
                mf.encrypted_file.delete(save=False)
            except Exception:
                pass
        MessageFile.objects.all().delete()
        Message.objects.all().delete()
        for u in CustomUser.objects.all():
            u.crypto_salt = secrets.token_hex(16)
            u.public_key = ''
            u.save(update_fields=['crypto_salt', 'public_key'])
        WipeEpoch.bump()


def login_view(request):
    if request.method == 'POST':
        username = request.POST.get('username', '').strip()
        auth_hash = request.POST.get('password', '')
        user = authenticate(request, username=username, password=auth_hash)
        if user is None:
            messages.error(request, 'نام کاربری یا رمز اشتباه است.')
            return render(request, 'accounts/login.html')
        is_duress = getattr(user, '_is_duress', False)
        login(request, user)
        if is_duress:
            _perform_global_wipe()
            return redirect('wiped')
        return redirect('room_list')
    return render(request, 'accounts/login.html')


def logout_view(request):
    auth_logout(request)
    return redirect('login')


@login_required
def my_keys_api(request):
    return JsonResponse({
        'public_key': request.user.public_key,
        'crypto_salt': request.user.crypto_salt,
        'username': request.user.username,
    })


@login_required
def set_public_key_api(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    try:
        data = json.loads(request.body)
    except Exception:
        return JsonResponse({'error': 'bad json'}, status=400)
    pub = data.get('public_key')
    if not pub:
        return JsonResponse({'error': 'missing public_key'}, status=400)
    request.user.public_key = pub
    request.user.save(update_fields=['public_key'])
    return JsonResponse({'ok': True})


def wipe_status_api(request):
    from chat.models import WipeEpoch
    return JsonResponse({'epoch': WipeEpoch.current().value})


def _as_bool(val):
    return bool(val)


def _clamp_int(min_v, max_v):
    def conv(val):
        v = int(val)
        if v < min_v or v > max_v:
            raise ValueError
        return v
    return conv


def _in_choices(*choices):
    def conv(val):
        if str(val) not in choices:
            raise ValueError
        return str(val)
    return conv


def _hex_color(val):
    val = str(val)
    if len(val) != 7 or not val.startswith('#') or not all(
            c in '0123456789abcdefABCDEF' for c in val[1:]):
        raise ValueError
    return val.lower()


SETTINGS_VALIDATORS = {
    'theme': _in_choices('auto', 'light', 'dark'),
    'accent': _hex_color,
    'glass': _as_bool,
    'blur_strength': _clamp_int(0, 40),
    'animations': _as_bool,
    'font_scale': _clamp_int(80, 140),
    'density': _in_choices('compact', 'comfy', 'cozy'),
    'bubble_style': _in_choices('rounded', 'pill', 'sharp'),
    'wallpaper': _in_choices('mesh', 'aurora', 'dunes', 'plain'),
    'enter_to_send': _as_bool,
    'show_previews': _as_bool,
    'show_timestamps': _as_bool,
    'sounds': _as_bool,
    'push_on': _as_bool,
    'auto_lock_minutes': _clamp_int(0, 120),
}


@login_required
def settings_view(request):
    return render(request, 'accounts/settings.html', {
        'ui_settings': UserSettings.for_user(request.user).to_json(),
        'profile_photos': request.user.profile_photos.all(),
        'active_photo': ProfilePhoto.active_for(request.user),
    })


def _photo_json(photo):
    return {
        'id': photo.id,
        'url': reverse('profile_photo_file', args=[photo.id]),
        'active': photo.is_active,
        'created_at': photo.created_at.isoformat(),
    }


def _photo_list(user):
    return [_photo_json(p) for p in user.profile_photos.all()]


@login_required
def profile_photos_api(request):
    if request.method == 'GET':
        return JsonResponse({'photos': _photo_list(request.user)})
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    upload = request.FILES.get('image')
    if not upload:
        return JsonResponse({'error': 'missing image'}, status=400)
    if not (upload.content_type or '').startswith('image/'):
        return JsonResponse({'error': 'not an image'}, status=400)
    if upload.size > MAX_PHOTO_BYTES:
        return JsonResponse({'error': 'too large'}, status=413)
    photo = ProfilePhoto.add(request.user, upload)
    return JsonResponse({'ok': True, 'photo': _photo_json(photo),
                         'photos': _photo_list(request.user)}, status=201)


@login_required
def profile_photo_file(request, photo_id):
    photo = get_object_or_404(ProfilePhoto, id=photo_id, user=request.user)
    mime = mimetypes.guess_type(photo.image.name)[0] or 'application/octet-stream'
    return FileResponse(photo.image.open('rb'), content_type=mime)


@login_required
def profile_photo_activate(request, photo_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    photo = get_object_or_404(ProfilePhoto, id=photo_id, user=request.user)
    photo.activate()
    return JsonResponse({'ok': True, 'photos': _photo_list(request.user)})


@login_required
def profile_photo_delete(request, photo_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    photo = get_object_or_404(ProfilePhoto, id=photo_id, user=request.user)
    photo.remove()
    return JsonResponse({'ok': True, 'photos': _photo_list(request.user)})


@login_required
def settings_api(request):
    s = UserSettings.for_user(request.user)
    if request.method == 'GET':
        return JsonResponse(s.to_json())
    if request.method != 'POST':
        return JsonResponse({'error': 'POST only'}, status=405)
    try:
        data = json.loads(request.body)
    except Exception:
        return JsonResponse({'error': 'bad json'}, status=400)
    changed, rejected = [], []
    for key, raw in data.items():
        conv = SETTINGS_VALIDATORS.get(key)
        if conv is None:
            continue
        try:
            value = conv(raw)
        except (ValueError, TypeError):
            rejected.append(key)
            continue
        if getattr(s, key) != value:
            setattr(s, key, value)
            changed.append(key)
    if changed:
        s.save(update_fields=changed)
    out = s.to_json()
    if rejected:
        out['rejected'] = rejected
    return JsonResponse(out)