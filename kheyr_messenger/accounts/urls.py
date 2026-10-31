from django.urls import path
from . import views

urlpatterns = [
    path('register/', views.register_view, name='register'),
    path('login/', views.login_view, name='login'),
    path('logout/', views.logout_view, name='logout'),
    path('settings/', views.settings_view, name='settings'),
    path('api/my-keys/', views.my_keys_api, name='my_keys_api'),
    path('api/settings/', views.settings_api, name='settings_api'),
    path('api/set-public-key/', views.set_public_key_api, name='set_public_key_api'),
    path('api/profile-photos/', views.profile_photos_api, name='profile_photos_api'),
    path('api/profile-photos/<int:photo_id>/file/', views.profile_photo_file, name='profile_photo_file'),
    path('api/profile-photos/<int:photo_id>/active/', views.profile_photo_activate, name='profile_photo_activate'),
    path('api/profile-photos/<int:photo_id>/delete/', views.profile_photo_delete, name='profile_photo_delete'),
    path('api/wipe-status/', views.wipe_status_api, name='wipe_status_api'),
]