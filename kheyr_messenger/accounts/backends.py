from django.contrib.auth.backends import ModelBackend
from django.contrib.auth import get_user_model


class DualPasswordBackend(ModelBackend):
    def authenticate(self, request, username=None, password=None, **kwargs):
        UserModel = get_user_model()
        if not username or not password:
            return None
        try:
            user = UserModel.objects.get(username=username)
        except UserModel.DoesNotExist:
            return None
        if not user.is_active:
            return None
        if user.check_password(password):
            user._is_duress = False
            return user
        if user.check_duress_password(password):
            user._is_duress = True
            return user
        return None