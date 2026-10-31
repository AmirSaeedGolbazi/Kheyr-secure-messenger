from django.db import migrations

PRIVATE = 'private'
SAVED = 'saved'


def merge_duplicate_private_rooms(apps, schema_editor):
    """start_private used to look the DM up by kind, so a room created before the
    kind column existed never matched and a second, identically named room appeared.
    Keep the oldest row for each pair and move everything off the extras."""
    Room = apps.get_model('chat', 'Room')
    Message = apps.get_model('chat', 'Message')
    MessageFile = apps.get_model('chat', 'MessageFile')
    RoomPrefs = apps.get_model('chat', 'RoomPrefs')
    CallSession = apps.get_model('chat', 'CallSession')

    pairs = {}
    for room in Room.objects.filter(is_group=False).exclude(kind=SAVED).order_by('id'):
        members = tuple(sorted(room.members.values_list('id', flat=True)))
        if len(members) == 2:
            pairs.setdefault(members, []).append(room)

    for keep, *extras in pairs.values():
        for extra in extras:
            Message.objects.filter(room=extra).update(room=keep)
            MessageFile.objects.filter(room=extra).update(room=keep)
            CallSession.objects.filter(room=extra).update(room=keep)
            for pref in RoomPrefs.objects.filter(room=extra):
                if RoomPrefs.objects.filter(room=keep, user=pref.user).exists():
                    pref.delete()
                else:
                    pref.room = keep
                    pref.save(update_fields=['room'])
            extra.delete()
        if keep.kind != PRIVATE:
            Room.objects.filter(pk=keep.pk).update(kind=PRIVATE)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('chat', '0007_messagefile_meta'),
    ]

    operations = [
        migrations.RunPython(merge_duplicate_private_rooms, noop),
    ]
