from django.urls import path
from . import views

urlpatterns = [
    path('register/', views.register_view, name='register'),
    path('login/', views.login_view, name='login'),
    path('logout/', views.logout_view, name='logout'),
    path('api/my-keys/', views.my_keys_api, name='my_keys_api'),
    path('api/set-public-key/', views.set_public_key_api, name='set_public_key_api'),
    path('api/wipe-status/', views.wipe_status_api, name='wipe_status_api'),
]