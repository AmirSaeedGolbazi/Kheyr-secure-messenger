import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import Room, Message, WipeEpoch, MESSAGE_KINDS


class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope['user']
        if not self.user.is_authenticated:
            await self.close(); return
        self.room_id = self.scope['url_route']['kwargs']['room_id']
        self.room = await self.get_room()
        if not self.room or not await self.is_member():
            await self.close(); return
        self.group_name = f'chat_{self.room_id}'
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
        except Exception:
            return
        t = data.get('type')

        if t == 'chat_message':
            content = data.get('content')
            iv = data.get('iv')
            encrypted_keys = data.get('encrypted_keys', {})
            file_name = data.get('file_name', '')
            kind = data.get('kind', 'text')
            if kind not in MESSAGE_KINDS:
                kind = 'text'
            if not content or not iv:
                return
            if not isinstance(encrypted_keys, dict) or not encrypted_keys:
                return    # an envelope sealed to nobody is unreadable by everyone
            parent_id = data.get('parent_id')
            msg = await self.save_message(content, iv, encrypted_keys, file_name, kind, parent_id)
            if msg is None:
                return
            await self.channel_layer.group_send(self.group_name, {
                'type': 'broadcast', 'payload': await self.serialize(msg),
            })
            from .notifications import fire_new_message_push
            fire_new_message_push(self.room, self.user)
            return

        if t == 'typing':
            await self.channel_layer.group_send(self.group_name, {
                'type': 'broadcast_typing',
                'from': self.user.id, 'from_username': self.user.username,
            })
            return

        if t == 'call_group_invite':
            session_id = data.get('call_session_id')
            if not session_id:
                return
            await self.channel_layer.group_send(self.group_name, {
                'type': 'broadcast_call_invite',
                'from': self.user.id,
                'from_username': self.user.username,
                'room_id': int(self.room_id),
                'call_session_id': session_id,
            })
            return

    async def broadcast(self, event):
        payload = dict(event.get('payload') or {})
        payload['type'] = 'chat_message'
        await self.send(text_data=json.dumps(payload))

    async def broadcast_message_update(self, event):
        payload = dict(event.get('payload') or {})
        payload['type'] = 'message_update'
        payload['update_type'] = event.get('update_type')
        await self.send(text_data=json.dumps(payload))

    async def broadcast_typing(self, event):
        if event['from'] == self.user.id:
            return    # nobody should see their own typing bubble
        await self.send(text_data=json.dumps({
            'type': 'typing', 'from': event['from'], 'from_username': event['from_username'],
        }))

    async def broadcast_call_invite(self, event):
        await self.send(text_data=json.dumps({
            'type': 'call_group_invite',
            'from': event['from'],
            'from_username': event['from_username'],
            'room_id': event['room_id'],
            'call_session_id': event['call_session_id'],
        }))

    @database_sync_to_async
    def get_room(self):
        try:
            return Room.objects.get(id=self.room_id)
        except Room.DoesNotExist:
            return None

    @database_sync_to_async
    def is_member(self):
        return self.room.members.filter(id=self.user.id).exists()

    @database_sync_to_async
    def save_message(self, content, iv, encrypted_keys, file_name, kind, parent_id):
        parent = None
        if parent_id:
            parent = Message.objects.filter(id=parent_id, room_id=self.room.id).first()
        return Message.objects.create(
            room=self.room, sender=self.user,
            content=content, iv=iv,
            encrypted_keys=encrypted_keys, file_name=file_name,
            kind=kind, parent=parent,
            epoch=WipeEpoch.current().value,
        )

    @database_sync_to_async
    def serialize(self, msg):
        from .views import message_payload
        return message_payload(msg)
