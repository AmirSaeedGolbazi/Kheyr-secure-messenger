"""Minimal Web Push (RFC 8291 VAPID + RFC 8188 aes128gcm).

Implemented with `cryptography` and urllib only — the pywebpush stack
(its C-backed aiohttp wheel among others) was not installable here.
"""
import base64
import hashlib
import hmac
import json
import os
import struct
import time
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand


def _b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _hkdf_expand(prk, info, length):
    return HKDFExpand(algorithm=hashes.SHA256(), length=length, info=info).derive(prk)


def _pack_bits(peer_pub, salt, auth_secret, plaintext):
    x = int.from_bytes(peer_pub[1:33], 'big')
    y = int.from_bytes(peer_pub[33:65], 'big')
    ua_public = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()
    ephem = ec.generate_private_key(ec.SECP256R1())
    as_public = ephem.public_key().public_numbers()
    as_public_bytes = (b'\x04' + as_public.x.to_bytes(32, 'big')
                       + as_public.y.to_bytes(32, 'big'))
    shared = ephem.exchange(ec.ECDH(), ua_public)
    prk = hmac.new(auth_secret, shared, hashlib.sha256).digest()
    ikm = _hkdf_expand(prk, b'WebPush: info\x00' + peer_pub + as_public_bytes, 32)
    out = _hkdf_expand(ikm, salt + b'P-256' + struct.pack('>I', 1), 28)
    cek, iv = out[:16], out[16:28]
    ct = AESGCM(cek).encrypt(iv, plaintext, None)
    body = salt + bytes([len(as_public_bytes)]) + as_public_bytes + ct
    return body, _b64u(as_public_bytes)


def _vapid_auth_header(private_pem, public_b64, aud):
    private = serialization.load_pem_private_key(private_pem.encode(), password=None)
    header = _b64u(json.dumps({'alg': 'ES256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    claims = _b64u(json.dumps({
        'aud': aud,
        'exp': int(time.time()) + 12 * 3600,
        'sub': 'mailto:push@kheyr.app',
    }, separators=(',', ':')).encode())
    signing_input = f'{header}.{claims}'.encode()
    der = private.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der)
    sig = _b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))
    return f'vapid t={header}.{claims}.{sig}, k={public_b64}'


def send_push(subscription_endpoint, subscription_keys, payload_json,
              vapid_private_pem, vapid_public_b64, ttl=120):
    """Encrypt + POST a push message. Raises urllib.error.HTTPError on failure;
    status 404/410 means the subscription is dead and should be dropped."""
    keys = (subscription_keys or {}).get('keys') or subscription_keys or {}
    ua_pub = base64.urlsafe_b64decode(keys['p256dh'] + '=' * (-len(keys['p256dh']) % 4))
    auth = base64.urlsafe_b64decode(keys['auth'] + '=' * (-len(keys['auth']) % 4))
    salt = os.urandom(16)
    body, as_public_b64 = _pack_bits(ua_pub, salt, auth, payload_json.encode())
    aud = '/'.join(subscription_endpoint.split('/')[:3])
    req = urllib.request.Request(subscription_endpoint, data=body, method='POST')
    req.add_header('Content-Type', 'application/octet-stream')
    req.add_header('TTL', str(ttl))
    req.add_header('Urgency', 'normal')
    req.add_header('Crypto-Key', f'dh={as_public_b64}')
    req.add_header('Authorization', _vapid_auth_header(vapid_private_pem, vapid_public_b64, aud))
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status
