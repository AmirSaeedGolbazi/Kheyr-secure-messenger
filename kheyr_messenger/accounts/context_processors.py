from .models import UserSettings


def ui_prefs(request):
    if not getattr(request, 'user', None) or not request.user.is_authenticated:
        return {}
    return {'ui_prefs': UserSettings.for_user(request.user).to_json()}
