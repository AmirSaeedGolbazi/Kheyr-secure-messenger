from django.urls import path
from . import views
from . import livekit_views

urlpatterns = [
    path('', views.room_list, name='room_list'),
    path('rooms/', views.room_list, name='rooms'),
    path('rooms/new-group/', views.create_group, name='create_group'),
    path('rooms/<int:room_id>/', views.room_detail, name='room_detail'),
    path('pm/<str:username>/', views.start_private, name='start_private'),
    path('api/room/<int:room_id>/messages/', views.room_messages_api, name='room_messages_api'),
    path('api/room/<int:room_id>/members-public-keys/', views.members_public_keys_api, name='members_public_keys_api'),
    path('api/room/<int:room_id>/members/', views.members_list_api, name='members_list_api'),
    path('api/room/<int:room_id>/upload-file/', views.upload_file_api, name='upload_file_api'),
    path('api/file/<int:file_id>/download/', views.download_file_api, name='download_file_api'),
    path('api/code-integrity/', views.code_integrity_api, name='code_integrity_api'),
    path('api/room/<int:room_id>/create-call-session/', livekit_views.create_call_session_api, name='create_call_session_api'),
    path('api/room/<int:room_id>/livekit-token/<int:session_id>/', livekit_views.livekit_token_api, name='livekit_token_api'),
    path('api/room/<int:room_id>/end-call-session/<int:session_id>/', livekit_views.end_call_session_api, name='end_call_session_api'),
    path('wiped/', views.wiped, name='wiped'),
]