from django.db import models
from django.conf import settings


class WipeEpoch(models.Model):
    value = models.BigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def current(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    @classmethod
    def bump(cls):
        obj = cls.current()
        obj.value += 1
        obj.save(update_fields=['value', 'updated_at'])
        return obj.value


class CodeIntegrity(models.Model):
    file_path = models.CharField(max_length=200, unique=True)
    sha256 = models.CharField(max_length=64)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.file_path}: {self.sha256[:12]}…'


class Room(models.Model):
    name = models.CharField(max_length=100)
    is_group = models.BooleanField(default=True)
    members = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='chat_rooms')
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class Message(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    content = models.TextField()
    iv = models.TextField()
    encrypted_keys = models.JSONField(default=dict)
    file_name = models.CharField(max_length=255, blank=True)
    epoch = models.BigIntegerField(default=0)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['timestamp']


class MessageFile(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='files')
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='files', null=True, blank=True)
    encrypted_file = models.FileField(upload_to='encrypted_files/')
    iv = models.TextField()
    encrypted_keys = models.JSONField(default=dict)
    original_name = models.CharField(max_length=255)
    mime_type = models.CharField(max_length=100, blank=True)
    epoch = models.BigIntegerField(default=0)
    uploaded_at = models.DateTimeField(auto_now_add=True)


class CallSession(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='call_sessions')
    initiator = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    encrypted_keys = models.JSONField(default=dict)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']