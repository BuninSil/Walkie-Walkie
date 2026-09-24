package ru.radio.station;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/*
 * Пакет звука живого эфира — байт в байт как у рации (radio-walkie/web/js/crypto.js):
 *   открытый     [0][0][PCM Int16 LE…]
 *   шифрованный  [1][0][номер ключа 8 байт][IV 12 байт][шифротекст + тег 16 байт]
 * Ключ канала — фраза в верхнем регистре (как SCR у рации): PBKDF2-SHA256, соль radio-air/v1,
 * 200 000 итераций, 40 байт: 32 — ключ AES-GCM, 8 — номер ключа.
 */
public final class AirPacket {

    public static final int RATE = 16000;  // Гц, как LIVE_RATE
    public static final int CHUNK = 640;   // сэмплов в пакете — 40 мс, как LIVE_CHUNK

    private static final byte[] SALT = "radio-air/v1".getBytes(StandardCharsets.UTF_8);
    private static final int ITERATIONS = 200000;
    private static final int SEALED_HEAD = 22;
    private static final SecureRandom random = new SecureRandom();

    public static final class Key {
        final SecretKeySpec aes;
        final byte[] id;

        Key(SecretKeySpec aes, byte[] id) {
            this.aes = aes;
            this.id = id;
        }
    }

    private AirPacket() {}

    // Считается ~1 с — не на главном потоке
    public static Key deriveKey(String phrase) throws GeneralSecurityException {
        byte[] password = phrase.trim().toUpperCase(java.util.Locale.ROOT).getBytes(StandardCharsets.UTF_8);
        byte[] bits = pbkdf2(password, 40);
        return new Key(new SecretKeySpec(Arrays.copyOfRange(bits, 0, 32), "AES"), Arrays.copyOfRange(bits, 32, 40));
    }

    // PBKDF2-HMAC-SHA256 по байтам UTF-8, как WebCrypto (у разных Android по-разному кодируют char[] пароля)
    private static byte[] pbkdf2(byte[] password, int length) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(password.length > 0 ? password : new byte[1], "HmacSHA256"));
        if (password.length == 0) throw new GeneralSecurityException("пустой ключ");
        byte[] out = new byte[length];
        for (int block = 1, done = 0; done < length; block++) {
            mac.update(SALT);
            mac.update(new byte[] { (byte) (block >>> 24), (byte) (block >>> 16), (byte) (block >>> 8), (byte) block });
            byte[] u = mac.doFinal();
            byte[] t = u.clone();
            for (int i = 1; i < ITERATIONS; i++) {
                u = mac.doFinal(u);
                for (int j = 0; j < t.length; j++) t[j] ^= u[j];
            }
            int n = Math.min(t.length, length - done);
            System.arraycopy(t, 0, out, done, n);
            done += n;
        }
        return out;
    }

    public static byte[] pcmBytes(short[] pcm) {
        ByteBuffer b = ByteBuffer.allocate(pcm.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        b.asShortBuffer().put(pcm);
        return b.array();
    }

    public static byte[] open(short[] pcm) {
        byte[] body = pcmBytes(pcm);
        byte[] out = new byte[2 + body.length];
        System.arraycopy(body, 0, out, 2, body.length);
        return out; // out[0] = 0 — открытый, out[1] = 0 — запас
    }

    public static byte[] seal(Key key, short[] pcm) throws GeneralSecurityException {
        byte[] head = new byte[SEALED_HEAD];
        head[0] = 1;
        System.arraycopy(key.id, 0, head, 2, 8);
        byte[] iv = new byte[12];
        random.nextBytes(iv);
        System.arraycopy(iv, 0, head, 10, 12);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key.aes, new GCMParameterSpec(128, iv));
        c.updateAAD(head, 0, 10);
        byte[] sealed = c.doFinal(pcmBytes(pcm)); // шифротекст + тег, как у WebCrypto
        byte[] out = new byte[SEALED_HEAD + sealed.length];
        System.arraycopy(head, 0, out, 0, SEALED_HEAD);
        System.arraycopy(sealed, 0, out, SEALED_HEAD, sealed.length);
        return out;
    }

    // Адрес от человека → адрес WebSocket, как AirLink.serverUrl в link.js
    public static String serverUrl(String address) {
        String text = address == null ? "" : address.trim();
        if (text.isEmpty()) return null;
        try {
            String lower = text.toLowerCase(java.util.Locale.ROOT);
            if (lower.startsWith("ws://") || lower.startsWith("wss://")) {
                java.net.URI u = new java.net.URI(text);
                String path = u.getRawPath() == null || u.getRawPath().length() <= 1 ? "/ws" : u.getRawPath();
                return u.getScheme().toLowerCase(java.util.Locale.ROOT) + "://" + u.getRawAuthority() + path;
            }
            if (lower.startsWith("http://") || lower.startsWith("https://")) {
                java.net.URI u = new java.net.URI(text);
                return (lower.startsWith("https") ? "wss" : "ws") + "://" + u.getRawAuthority() + "/ws";
            }
            java.net.URI u = new java.net.URI("http://" + text);
            String host = u.getHost();
            if (host == null) return null;
            boolean plain = u.getPort() != -1 || host.matches("[\\d.]+") || host.equals("localhost");
            return plain ? "ws://" + host + ":" + (u.getPort() != -1 ? u.getPort() : 8765) + "/ws" : "wss://" + u.getRawAuthority() + "/ws";
        } catch (Exception e) {
            return null;
        }
    }
}
