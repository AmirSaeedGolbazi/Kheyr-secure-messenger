from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from django.core.exceptions import PermissionDenied
from .models import CustomUser


@admin.action(description='تأیید (فعال‌سازی) کاربران انتخاب‌شده')
def activate_users(modeladmin, request, queryset):
    updated = queryset.update(is_active=True)
    modeladmin.message_user(request, f'{updated} کاربر تأیید شد.')


@admin.action(description='لغو تأیید (غیرفعال‌سازی) کاربران انتخاب‌شده')
def deactivate_users(modeladmin, request, queryset):
    updated = queryset.update(is_active=False)
    modeladmin.message_user(request, f'{updated} کاربر غیرفعال شد.')


class NoPasswordChangeUserAdmin(UserAdmin):
    list_display = ('username', 'is_active', 'is_staff', 'has_duress', 'date_joined')
    list_filter = ('is_active', 'is_staff', 'is_superuser')
    search_fields = ('username',)
    actions = [activate_users, deactivate_users]

    fieldsets = (
        (None, {'fields': ('username',)}),
        ('اطلاعات شخصی', {'fields': ('first_name', 'last_name', 'email')}),
        ('دسترسی‌ها', {
            'fields': ('is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions'),
        }),
        ('تاریخ‌های مهم', {'fields': ('last_login', 'date_joined')}),
        ('امنیت پیشرفته', {'fields': ('duress_password', 'public_key', 'crypto_salt')}),
    )

    add_fieldsets = (
        (None, {
            'classes': ('wide',),
            'fields': ('username', 'is_active', 'is_staff'),
        }),
    )

    def get_readonly_fields(self, request, obj=None):
        ro = list(super().get_readonly_fields(request, obj))
        if 'password' not in ro:
            ro.append('password')
        return ro

    def get_form(self, request, obj=None, **kwargs):
        form = super().get_form(request, obj, **kwargs)
        if 'password' in form.base_fields:
            del form.base_fields['password']
        return form

    def user_change_password(self, request, id, form_url=''):
        raise PermissionDenied('تغییر پسورد کاربران فقط توسط خود آن‌ها امکان‌پذیر است.')

    def has_add_permission(self, request):
        return False

    def has_duress(self, obj):
        return bool(obj.duress_password)
    has_duress.boolean = True
    has_duress.short_description = 'رمز دوم تنظیم شده'


admin.site.register(CustomUser, NoPasswordChangeUserAdmin)