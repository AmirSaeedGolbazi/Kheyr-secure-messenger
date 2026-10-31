from django.db import models
from django.conf import settings


SAVED_ROOM_LABEL = 'پیام‌های ذخیره‌شده'


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
    KIND_GROUP = 'group'
    KIND_PRIVATE = 'private'
    KIND_SAVED = 'saved'
    KIND_CHOICES = [(KIND_GROUP, 'group'), (KIND_PRIVATE, 'private'), (KIND_SAVED, 'saved')]

    name = models.CharField(max_length=100)
    is_group = models.BooleanField(default=True)
    kind = models.CharField(max_length=8, choices=KIND_CHOICES, default=KIND_GROUP)
    topic = models.TextField(blank=True)
    avatar_color = models.CharField(max_length=9, blank=True)
    members = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='chat_rooms')
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

    def prefs_for(self, user):
        pref, _ = RoomPrefs.objects.get_or_create(user=user, room=self)
        return pref

    def title_for(self, user):
        """A DM is labelled with the peer's name — the stored 'A__B' key is an
        internal id, not something a member recognises in the chat list."""
        if self.is_group:
            return self.name
        for member in self.members.all():
            if member.id != user.id:
                return member.username
        return self.name

    @classmethod
    def private_between(cls, user, other):
        """The one DM row for this pair, whatever kind the older rows carry."""
        candidates = (cls.objects.filter(is_group=False)
                      .filter(members=user).filter(members=other).order_by('id'))
        for room in candidates:
            if room.members.count() != 2:
                continue    # a bigger room that merely contains the pair
            if room.kind != cls.KIND_PRIVATE:
                cls.objects.filter(pk=room.pk).update(kind=cls.KIND_PRIVATE)
                room.kind = cls.KIND_PRIVATE
            return room
        name = f"{min(user.username, other.username)}__{max(user.username, other.username)}"
        room = cls.objects.create(name=name, is_group=False, kind=cls.KIND_PRIVATE)
        room.members.add(user, other)
        return room

    @classmethod
    def ensure_saved_for(cls, user):
        room = cls.objects.filter(kind=cls.KIND_SAVED, members=user).first()
        if not room:
            room = cls.objects.create(name=SAVED_ROOM_LABEL, is_group=False,
                                      kind=cls.KIND_SAVED, avatar_color='#7c5cff')
            room.members.add(user)
        return room


class Message(models.Model):
    KIND_TEXT = 'text'
    KIND_POLL = 'poll'
    KIND_POLL_VOTE = 'poll_vote'
    KIND_IMAGE = 'image'
    KIND_VIDEO = 'video'
    KIND_AUDIO = 'audio'
    KIND_VOICE = 'voice'
    KIND_FILE = 'file'
    KIND_SYSTEM = 'system'
    KIND_CHOICES = [
        (KIND_TEXT, 'text'), (KIND_POLL, 'poll'), (KIND_POLL_VOTE, 'poll_vote'),
        (KIND_IMAGE, 'image'), (KIND_VIDEO, 'video'), (KIND_AUDIO, 'audio'),
        (KIND_VOICE, 'voice'), (KIND_FILE, 'file'), (KIND_SYSTEM, 'system'),
    ]

    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    content = models.TextField()
    iv = models.TextField()
    encrypted_keys = models.JSONField(default=dict)
    file_name = models.CharField(max_length=255, blank=True)
    kind = models.CharField(max_length=12, choices=KIND_CHOICES, default=KIND_TEXT)
    parent = models.ForeignKey(
        'self', on_delete=models.SET_NULL, null=True, blank=True, related_name='replies'
    )
    reactions = models.JSONField(default=dict)
    pinned_at = models.DateTimeField(null=True, blank=True)
    pinned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='+',
    )
    edited_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    epoch = models.BigIntegerField(default=0)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['id']
        indexes = [models.Index(fields=['room', 'id'])]

    @property
    def is_pinned(self):
        return self.pinned_at is not None

    @property
    def is_deleted(self):
        return self.deleted_at is not None


MESSAGE_KINDS = {code for code, _ in Message.KIND_CHOICES}


class MessageFile(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='files')
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    message = models.ForeignKey(
        Message, on_delete=models.CASCADE, related_name='attachments', null=True, blank=True
    )
    encrypted_file = models.FileField(upload_to='encrypted_files/')
    iv = models.TextField()
    encrypted_keys = models.JSONField(default=dict)
    original_name = models.CharField(max_length=255)
    mime_type = models.CharField(max_length=100, blank=True)
    kind = models.CharField(max_length=12, choices=Message.KIND_CHOICES, default=Message.KIND_FILE)
    # Opaque AES-GCM envelope of the sender's audio tags ({v, iv, data}); the
    # server never sees the plaintext, so it is stored and served as-is.
    meta = models.JSONField(default=dict, blank=True)
    duration_ms = models.BigIntegerField(null=True, blank=True)
    width = models.IntegerField(null=True, blank=True)
    height = models.IntegerField(null=True, blank=True)
    size_bytes = models.BigIntegerField(default=0)
    epoch = models.BigIntegerField(default=0)
    uploaded_at = models.DateTimeField(auto_now_add=True)


class RoomPrefs(models.Model):
    """Per-user, per-room UI state (mute, chat-list pin/archive, read position)."""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='room_prefs')
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='user_prefs')
    muted = models.BooleanField(default=False)
    pinned = models.BooleanField(default=False)
    archived = models.BooleanField(default=False)
    last_read_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('user', 'room')


class CallSession(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name='call_sessions')
    initiator = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    encrypted_keys = models.JSONField(default=dict)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']


class PushKeys(models.Model):
    """Singleton holding VAPID keys for Web Push."""
    private_pem = models.TextField(blank=True)
    public_key = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @classmethod
    def current(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class PushSubscription(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                             related_name='push_subscriptions')
    endpoint = models.TextField(unique=True)
    keys = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
