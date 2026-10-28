import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import Room, Message, WipeEpoch


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
        data = json.loads(text_data)
        t = data.get('type')

        if t == 'chat_message':
            content = data.get('content')
            iv = data.get('iv')
            encrypted_keys = data.get('encrypted_keys', {})
            file_name = data.get('file_name', '')
            if not content or not iv:
                return
            msg = await self.save_message(content, iv, encrypted_keys, file_name)
            await self.channel_layer.group_send(self.group_name, {
                'type': 'broadcast',
                'id': msg.id, 'content': content, 'iv': iv,
                'encrypted_keys': encrypted_keys, 'file_name': file_name,
                'file_id': None,
                'sender_id': self.user.id, 'sender_username': self.user.username,
                'timestamp': msg.timestamp.isoformat(),
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
        await self.send(text_data=json.dumps({
            'type': 'chat_message',
            'id': event.get('id'),
            'content': event.get('content', ''),
            'iv': event.get('iv', ''),
            'encrypted_keys': event.get('encrypted_keys', {}),
            'file_name': event.get('file_name', ''),
            'file_id': event.get('file_id'),
            'sender_id': event.get('sender_id'),
            'sender_username': event.get('sender_username'),
            'timestamp': event.get('timestamp', ''),
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
    def save_message(self, content, iv, encrypted_keys, file_name):
        return Message.objects.create(
            room=self.room, sender=self.user,
            content=content, iv=iv,
            encrypted_keys=encrypted_keys, file_name=file_name,
            epoch=WipeEpoch.current().value,
        )