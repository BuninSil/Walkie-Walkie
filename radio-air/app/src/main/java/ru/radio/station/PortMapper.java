package ru.radio.station;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/*
 * UPnP: просим роутер открыть порт и узнаём внешний IP — как upnp.js в ПК-программе.
 * Работает, если телефон в Wi-Fi роутера и в роутере включён UPnP (у многих включён по умолчанию).
 *   1. Ищем роутер в сети (SSDP, групповой запрос на 239.255.255.250:1900).
 *   2. Читаем его описание и находим службу WANIPConnection / WANPPPConnection.
 *   3. Вызываем её методы: GetExternalIPAddress, AddPortMapping, DeletePortMapping.
 */
final class PortMapper {

    private static final String[] GATEWAY_TYPES = {
        "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
        "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
    };
    private static final String[] SERVICE_TYPES = {
        "urn:schemas-upnp-org:service:WANIPConnection:2",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
        "urn:schemas-upnp-org:service:WANPPPConnection:1",
    };

    private String serviceType, controlUrl, localAddress;
    private int mapped = 0;
    private boolean leased;

    /* ───────── Адреса ───────── */

    // Адреса телефона в домашней сети (Wi-Fi, точка доступа, USB). Мобильный интернет и VPN
    // пропускаем: у них тоже бывают «домашние» 10.x, но достучаться до них нельзя.
    static List<String> lanAddresses() {
        List<String> wifi = new ArrayList<>(), other = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback() || ni.isVirtual()) continue;
                String name = ni.getName().toLowerCase(Locale.ROOT);
                if (name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("pdp") ||
                    name.startsWith("v4-") || name.startsWith("tun") || name.startsWith("ppp") ||
                    name.startsWith("dummy") || name.startsWith("clat")) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    (name.startsWith("wlan") ? wifi : other).add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) {
            // нет сетей — пустой список
        }
        wifi.addAll(other);
        return wifi;
    }

    // Внешний адрес из «серых» диапазонов значит, что снаружи до телефона не достучаться
    static boolean isPublicIp(String ip) {
        String[] p = ip == null ? new String[0] : ip.split("\\.");
        if (p.length != 4) return false;
        int a, b;
        try {
            a = Integer.parseInt(p[0]);
            b = Integer.parseInt(p[1]);
        } catch (NumberFormatException e) {
            return false;
        }
        if (a == 10 || a == 127 || a == 0) return false;
        if (a == 100 && b >= 64 && b <= 127) return false; // CGNAT провайдера
        if (a == 172 && b >= 16 && b <= 31) return false;
        if (a == 192 && b == 168) return false;
        return !(a == 169 && b == 254);
    }

    /* ───────── Роутер ───────── */

    private void connect() throws Exception {
        if (controlUrl != null) return;
        List<String> lan = lanAddresses();
        if (lan.isEmpty()) throw new Exception("телефон не подключён к Wi-Fi");
        String local = lan.get(0);
        String location = discover(local);
        if (location == null) throw new Exception("роутер не ответил по UPnP — возможно, UPnP в нём выключен");
        String body = http(location, "GET", null, null);
        String base = tag(body, "URLBase");
        for (String type : SERVICE_TYPES) {
            for (String block : body.split("(?i)<service>")) {
                if (!block.contains(type)) continue;
                String control = tag(block, "controlURL");
                if (control == null) continue;
                serviceType = type;
                controlUrl = new URL(new URL(base != null && !base.isEmpty() ? base : location), control).toString();
                localAddress = local;
                return;
            }
        }
        throw new Exception("роутер не умеет открывать порты по UPnP");
    }

    private static String discover(String local) {
        try (DatagramSocket socket = new DatagramSocket(new InetSocketAddress(InetAddress.getByName(local), 0))) {
            socket.setSoTimeout(3000);
            InetAddress group = InetAddress.getByName("239.255.255.250");
            for (String st : GATEWAY_TYPES) {
                byte[] q = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: " + st + "\r\n\r\n")
                    .getBytes(StandardCharsets.US_ASCII);
                socket.send(new DatagramPacket(q, q.length, group, 1900));
            }
            long until = System.currentTimeMillis() + 3000;
            byte[] buf = new byte[4096];
            while (System.currentTimeMillis() < until) {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try {
                    socket.receive(p);
                } catch (SocketTimeoutException e) {
                    return null;
                }
                String text = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                Matcher m = Pattern.compile("(?im)^location:\\s*(\\S+)").matcher(text);
                if (!m.find()) continue;
                for (String t : GATEWAY_TYPES) if (text.contains(t)) return m.group(1);
            }
        } catch (Exception ignored) {
            // нет сети
        }
        return null;
    }

    private String soap(String action, String args) throws Exception {
        String body = "<?xml version=\"1.0\"?>" +
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
            "<s:Body><u:" + action + " xmlns:u=\"" + serviceType + "\">" + args + "</u:" + action + "></s:Body></s:Envelope>";
        return http(controlUrl, "POST", body, "\"" + serviceType + "#" + action + "\"");
    }

    private static String http(String url, String method, String body, String soapAction) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(5000);
        c.setRequestMethod(method);
        if (body != null) {
            byte[] data = body.getBytes(StandardCharsets.UTF_8);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"");
            c.setRequestProperty("SOAPAction", soapAction);
            c.setFixedLengthStreamingMode(data.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(data);
            }
        }
        int status = c.getResponseCode();
        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        if (in != null) {
            try (InputStream s = in) {
                byte[] b = new byte[4096];
                for (int n; (n = s.read(b)) > 0; ) buf.write(b, 0, n);
            }
        }
        String text = buf.toString("UTF-8");
        c.disconnect();
        if (status != 200) {
            if (body == null) throw new Exception("роутер не ответил");
            String code = tag(text, "errorCode"), desc = tag(text, "errorDescription");
            throw new Exception("роутер отказал" + (code != null ? " (" + code + (desc != null ? " " + desc : "") + ")" : ""));
        }
        return text;
    }

    private static String tag(String xml, String name) {
        Matcher m = Pattern.compile("<(?:\\w+:)?" + name + ">([^<]*)</(?:\\w+:)?" + name + ">").matcher(xml);
        return m.find() ? m.group(1).trim() : null;
    }

    /* ───────── Снаружи ───────── */

    // Долгие вызовы — не с главного потока
    String externalIp() throws Exception {
        connect();
        return tag(soap("GetExternalIPAddress", ""), "NewExternalIPAddress");
    }

    void open(int port) throws Exception {
        connect();
        String mapping = "<NewRemoteHost></NewRemoteHost><NewExternalPort>" + port + "</NewExternalPort>" +
            "<NewProtocol>TCP</NewProtocol><NewInternalPort>" + port + "</NewInternalPort>" +
            "<NewInternalClient>" + localAddress + "</NewInternalClient><NewEnabled>1</NewEnabled>" +
            "<NewPortMappingDescription>Radio station</NewPortMappingDescription>";
        // Бессрочно, а если роутер так не умеет — на два часа (продлевает renew())
        try {
            soap("AddPortMapping", mapping + "<NewLeaseDuration>0</NewLeaseDuration>");
            leased = false;
        } catch (Exception e) {
            soap("AddPortMapping", mapping + "<NewLeaseDuration>7200</NewLeaseDuration>");
            leased = true;
        }
        mapped = port;
        lastMapping = mapping;
    }

    private String lastMapping;

    // Раз в час, пока открыт порт на время
    void renew() {
        if (!leased || mapped == 0 || lastMapping == null) return;
        try {
            soap("AddPortMapping", lastMapping + "<NewLeaseDuration>7200</NewLeaseDuration>");
        } catch (Exception ignored) {
            // роутер перезагрузили — попробуем через час
        }
    }

    void close() {
        if (mapped == 0 || controlUrl == null) return;
        int port = mapped;
        mapped = 0;
        try {
            soap("DeletePortMapping", "<NewRemoteHost></NewRemoteHost><NewExternalPort>" + port +
                "</NewExternalPort><NewProtocol>TCP</NewProtocol>");
        } catch (Exception ignored) {
            // не вышло — роутер сам забудет
        }
    }
}
