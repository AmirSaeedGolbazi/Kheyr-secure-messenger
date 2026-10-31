from django.db import migrations

SAVED_ROOM_LABEL = 'پیام‌های ذخیره‌شده'


def rename_saved_rooms(apps, schema_editor):
    Room = apps.get_model('chat', 'Room')
    Room.objects.filter(kind='saved').update(name=SAVED_ROOM_LABEL)


def restore_saved_rooms(apps, schema_editor):
    Room = apps.get_model('chat', 'Room')
    Room.objects.filter(kind='saved').update(name='Saved Messages')


class Migration(migrations.Migration):
    dependencies = [
        ('chat', '0005_pushkeys_pushsubscription'),
    ]

    operations = [
        migrations.RunPython(rename_saved_rooms, restore_saved_rooms),
    ]
