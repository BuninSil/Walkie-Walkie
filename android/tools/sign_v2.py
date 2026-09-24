"""APK Signature Scheme v2 — подпись готового (выровненного) APK ключом из PKCS#12.
По спецификации https://source.android.com/docs/security/features/apksigning/v2"""
import hashlib, struct, sys
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import pkcs12

RSA_PKCS1_SHA256 = 0x0103
V2_ID = 0x7109871a
CHUNK = 1024 * 1024

def lp(b):  # length-prefixed
    return struct.pack('<I', len(b)) + b

def find_eocd(apk):
    for i in range(len(apk) - 22, max(-1, len(apk) - 22 - 65536), -1):
        if apk[i:i + 4] == b'PK\x05\x06':
            return i
    raise SystemExit('EOCD not found')

def digest(sections):
    chunks = []
    for s in sections:
        for off in range(0, len(s), CHUNK):
            part = s[off:off + CHUNK]
            chunks.append(hashlib.sha256(b'\xa5' + struct.pack('<I', len(part)) + part).digest())
    return hashlib.sha256(b'\x5a' + struct.pack('<I', len(chunks)) + b''.join(chunks)).digest()

def main(src, dst, p12, password):
    apk = open(src, 'rb').read()
    eocd_off = find_eocd(apk)
    cd_off, = struct.unpack('<I', apk[eocd_off + 16:eocd_off + 20])
    if apk[cd_off - 16:cd_off] == b'APK Sig Block 42':
        raise SystemExit('already signed')
    entries, cd, eocd = apk[:cd_off], apk[cd_off:eocd_off], bytearray(apk[eocd_off:])

    key, cert, _ = pkcs12.load_key_and_certificates(open(p12, 'rb').read(), password.encode())
    cert_der = cert.public_bytes(serialization.Encoding.DER)
    pub_der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)

    # Хэш считается по EOCD, где смещение каталога указывает на начало блока подписи (= старое cd_off)
    d = digest([entries, cd, bytes(eocd)])
    signed_data = (lp(lp(struct.pack('<I', RSA_PKCS1_SHA256) + lp(d)))  # digests
                   + lp(lp(cert_der))                                    # certificates
                   + lp(b''))                                            # additional attributes
    sig = key.sign(signed_data, padding.PKCS1v15(), hashes.SHA256())
    signer = lp(signed_data) + lp(lp(struct.pack('<I', RSA_PKCS1_SHA256) + lp(sig))) + lp(pub_der)
    value = lp(lp(signer))

    pair = struct.pack('<Q', 4 + len(value)) + struct.pack('<I', V2_ID) + value
    size = len(pair) + 8 + 16
    block = struct.pack('<Q', size) + pair + struct.pack('<Q', size) + b'APK Sig Block 42'

    struct.pack_into('<I', eocd, 16, cd_off + len(block))
    open(dst, 'wb').write(entries + block + cd + bytes(eocd))
    print('signed', dst, 'cert sha256', hashlib.sha256(cert_der).hexdigest())

if __name__ == '__main__':
    main(*sys.argv[1:5])
