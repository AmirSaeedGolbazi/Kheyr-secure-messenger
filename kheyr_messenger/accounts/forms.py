from django import forms
from .models import CustomUser


class RegisterForm(forms.ModelForm):
    password = forms.CharField(widget=forms.HiddenInput, required=False)
    duress_password = forms.CharField(widget=forms.HiddenInput, required=False)
    auth_hash = forms.CharField(widget=forms.HiddenInput, required=False)
    duress_hash = forms.CharField(widget=forms.HiddenInput, required=False)
    public_key = forms.CharField(widget=forms.HiddenInput, required=False)
    crypto_salt = forms.CharField(widget=forms.HiddenInput, required=False)

    class Meta:
        model = CustomUser
        fields = ('username',)
        labels = {'username': 'نام کاربری'}

    def clean(self):
        data = super().clean()
        if not data.get('auth_hash'):
            raise forms.ValidationError("خطای امنیتی: هش رمز تولید نشد.")
        if not data.get('duress_hash'):
            raise forms.ValidationError("خطای امنیتی: هش رمز دوم تولید نشد.")
        if not data.get('public_key'):
            raise forms.ValidationError("خطای امنیتی: کلید عمومی تولید نشد.")
        if not data.get('crypto_salt'):
            raise forms.ValidationError("خطای امنیتی: salt تولید نشد.")
        return data