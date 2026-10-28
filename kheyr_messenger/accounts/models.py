from django.contrib.auth.models import AbstractUser
from django.contrib.auth.hashers import make_password, check_password
from django.db import models


class CustomUser(AbstractUser):
    duress_password = models.CharField(max_length=128, blank=True)
    public_key = models.CharField(max_length=64, blank=True)
    crypto_salt = models.CharField(max_length=64, blank=True)

    def set_duress_password(self, raw):
        self.duress_password = make_password(raw)

    def check_duress_password(self, raw):
        return bool(self.duress_password) and check_password(raw, self.duress_password)