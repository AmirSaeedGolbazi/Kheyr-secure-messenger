from django.contrib import admin
from .models import Room, Message, MessageFile, WipeEpoch, CallSession, CodeIntegrity


@admin.register(Room)
class RoomAdmin(admin.ModelAdmin):
    list_display = ('name', 'is_group', 'created_at')
    filter_horizontal = ('members',)


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ('room', 'sender', 'file_name', 'timestamp')
    readonly_fields = ('content', 'iv', 'encrypted_keys', 'timestamp')


@admin.register(MessageFile)
class MessageFileAdmin(admin.ModelAdmin):
    list_display = ('original_name', 'room', 'sender', 'uploaded_at')


@admin.register(WipeEpoch)
class WipeEpochAdmin(admin.ModelAdmin):
    list_display = ('value', 'updated_at')


@admin.register(CallSession)
class CallSessionAdmin(admin.ModelAdmin):
    list_display = ('id', 'room', 'initiator', 'is_active', 'created_at', 'ended_at')


@admin.register(CodeIntegrity)
class CodeIntegrityAdmin(admin.ModelAdmin):
    list_display = ('file_path', 'sha256', 'updated_at')
    readonly_fields = ('file_path', 'sha256', 'updated_at')