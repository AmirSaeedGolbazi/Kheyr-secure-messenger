from django.contrib.auth.models import AbstractUser
from django.contrib.auth.hashers import make_password, check_password
from django.db import models, transaction


class CustomUser(AbstractUser):
    duress_password = models.CharField(max_length=128, blank=True)
    public_key = models.CharField(max_length=64, blank=True)
    crypto_salt = models.CharField(max_length=64, blank=True)

    def set_duress_password(self, raw):
        self.duress_password = make_password(raw)

    def check_duress_password(self, raw):
        return bool(self.duress_password) and check_password(raw, self.duress_password)


class UserSettings(models.Model):
    THEME_CHOICES = [('auto', 'auto'), ('light', 'light'), ('dark', 'dark')]
    BUBBLE_CHOICES = [('rounded', 'rounded'), ('pill', 'pill'), ('sharp', 'sharp')]
    WALLPAPER_CHOICES = [
        ('mesh', 'mesh'), ('aurora', 'aurora'), ('dunes', 'dunes'), ('plain', 'plain'),
    ]

    user = models.OneToOneField(
        CustomUser, on_delete=models.CASCADE, related_name='ui_settings', primary_key=True
    )
    theme = models.CharField(max_length=6, choices=THEME_CHOICES, default='dark')
    accent = models.CharField(max_length=9, default='#c0392b')
    glass = models.BooleanField(default=True)
    blur_strength = models.IntegerField(default=18)
    animations = models.BooleanField(default=True)
    font_scale = models.IntegerField(default=100)
    density = models.CharField(max_length=4, default='comfy')
    bubble_style = models.CharField(max_length=8, choices=BUBBLE_CHOICES, default='pill')
    wallpaper = models.CharField(max_length=8, choices=WALLPAPER_CHOICES, default='mesh')
    enter_to_send = models.BooleanField(default=True)
    show_previews = models.BooleanField(default=True)
    show_timestamps = models.BooleanField(default=True)
    sounds = models.BooleanField(default=True)
    push_on = models.BooleanField(default=False)
    auto_lock_minutes = models.IntegerField(default=10)

    JSON_KEYS = (
        'theme', 'accent', 'glass', 'blur_strength', 'animations', 'font_scale',
        'density', 'bubble_style', 'wallpaper', 'enter_to_send', 'show_previews',
        'show_timestamps', 'sounds', 'push_on', 'auto_lock_minutes',
    )

    def to_json(self):
        return {key: getattr(self, key) for key in self.JSON_KEYS}

    @classmethod
    def for_user(cls, user):
        obj, _ = cls.objects.get_or_create(user=user)
        return obj


class ProfilePhoto(models.Model):
    """A user's picture collection; exactly one row is the active avatar."""
    user = models.ForeignKey(CustomUser, on_delete=models.CASCADE, related_name='profile_photos')
    image = models.FileField(upload_to='profile_photos/')
    is_active = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    @classmethod
    def add(cls, user, uploaded):
        """The newest upload becomes the active picture."""
        with transaction.atomic():
            cls.objects.filter(user=user).update(is_active=False)
            return cls.objects.create(user=user, image=uploaded, is_active=True)

    @classmethod
    def active_for(cls, user):
        return cls.objects.filter(user=user).order_by('-is_active', '-created_at').first()

    def activate(self):
        with transaction.atomic():
            ProfilePhoto.objects.filter(user_id=self.user_id).exclude(pk=self.pk) \
                .update(is_active=False)
            if not self.is_active:
                self.is_active = True
                self.save(update_fields=['is_active'])

    def remove(self):
        """Drop the row and its file; losing the active one promotes the newest left."""
        was_active = self.is_active
        user_id = self.user_id
        self.image.delete(save=False)
        self.delete()
        if was_active:
            nxt = ProfilePhoto.objects.filter(user_id=user_id).order_by('-created_at').first()
            if nxt:
                nxt.activate()
