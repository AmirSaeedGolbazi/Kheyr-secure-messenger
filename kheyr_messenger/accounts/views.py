import secrets
import json
from django.shortcuts import render, redirect
from django.contrib.auth import authenticate, login, logout as auth_logout
from django.contrib import messages
from django.http import JsonResponse
from django.contrib.auth.decorators import login_required
from django.db import transaction
from .forms import RegisterForm
from .models import CustomUser


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