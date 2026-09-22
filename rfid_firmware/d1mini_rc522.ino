// ============================================================================
// 訂餐通 RFID 讀卡機韌體（D1 Mini + RC522）
// - 感應卡片 → POST 到後端（等同掃碼核銷）
// - 內建 WiFi 設定頁：連不上 WiFi 或開機按住「設定鈕」時，會開啟
//   「OrderingRFID-Setup」熱點，手機連上後開 http://192.168.4.1 即可設定
// ============================================================================
// 依賴函式庫：MFRC522（by GithubCommunity）
// 其餘（ESP8266WiFi / ESP8266WebServer / DNSServer / ESP8266HTTPClient /
//       WiFiClientSecure / SPI / EEPROM）皆隨 ESP8266 開發板套件內建。
// 開發板請選：WeMos D1 R2 & mini（或 NodeMCU 1.0）
// ============================================================================

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include <EEPROM.h>

// ================= 預設值（首次開機；之後可用設定頁修改並存於 EEPROM）=================
const char* DEFAULT_SSID     = "Iphone 1 pro max";
const char* DEFAULT_PASSWORD = "88888888";
const char* DEFAULT_SERVER   = "https://ordering-master-pro.vercel.app";
const char* DEFAULT_SECRET   = "MJE7T4RP29YE3ZUD";
const char* DEFAULT_STATION  = "demo";
// ======================================================================================

// ====== RC522 接腳（GPIO 編號；新版 ESP8266 core 已移除 D0~D8 巨集）======
// SDA->GPIO15(D8), SCK->GPIO14(D5), MOSI->GPIO13(D7), MISO->GPIO12(D6), RST->GPIO0(D3)
constexpr uint8_t SS_PIN   = 15;  // SDA
constexpr uint8_t RST_PIN  = 0;   // RST
constexpr int    BUZZER_PIN = -1; // 蜂鳴器（選用，未接保持 -1；接了建議 GPIO5/D1）
constexpr uint8_t LED_PIN = 2;    // 內建藍色 LED（低電位點亮）

// 設定鈕：開機時按住 GPIO5(D1) 接 GND → 強制進入設定模式；改成 -1 停用
constexpr int CONFIG_PIN = 5;

// ====== 設定儲存（EEPROM）======
struct Config {
  char magic[4];   // "RF1" 表示已設定
  char ssid[33];
  char pass[65];
  char server[80];
  char secret[33];
  char station[24];
};
Config cfg;

void loadConfig() {
  EEPROM.begin(512);
  EEPROM.get(0, cfg);
  EEPROM.end();
  if (memcmp(cfg.magic, "RF1", 3) != 0) {
    memset(&cfg, 0, sizeof(cfg));
    strncpy(cfg.magic, "RF1", 4);
    strncpy(cfg.ssid, DEFAULT_SSID, 32);
    strncpy(cfg.pass, DEFAULT_PASSWORD, 64);
    strncpy(cfg.server, DEFAULT_SERVER, 79);
    strncpy(cfg.secret, DEFAULT_SECRET, 32);
    strncpy(cfg.station, DEFAULT_STATION, 23);
  }
}

void saveConfig() {
  EEPROM.begin(512);
  EEPROM.put(0, cfg);
  EEPROM.commit();
  EEPROM.end();
}

MFRC522 rfid(SS_PIN, RST_PIN);

String lastUid = "";                 // 上一次上報的 UID
bool cardReported = false;           // 目前這張卡是否已上報（卡未移走不重複）
unsigned long lastHeartbeatMs = 0;
unsigned long lastScanMs = 0;

// ====== Web 設定頁（AP 模式）======
ESP8266WebServer server(80);
DNSServer dnsServer;

String configPage() {
  String h = "<!DOCTYPE html><html><head><meta charset='utf-8'>";
  h += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  h += "<title>RFID 讀卡機設定</title></head>";
  h += "<body style='font-family:sans-serif;max-width:480px;margin:auto;padding:16px'>";
  h += "<h2>訂餐通 RFID 讀卡機設定</h2>";
  h += "<form action='/save' method='post'>";
  h += "<p>WiFi SSID<br><input name='ssid' value='" + String(cfg.ssid) + "' style='width:100%;padding:8px;box-sizing:border-box'></p>";
  h += "<p>WiFi 密碼<br><input name='pass' value='" + String(cfg.pass) + "' style='width:100%;padding:8px;box-sizing:border-box'></p>";
  h += "<p>伺服器網址（Vercel）<br><input name='server' value='" + String(cfg.server) + "' style='width:100%;padding:8px;box-sizing:border-box'></p>";
  h += "<p>裝置密鑰（後台 RFID 分頁複製）<br><input name='secret' value='" + String(cfg.secret) + "' style='width:100%;padding:8px;box-sizing:border-box'></p>";
  h += "<p>站台（班級）ID<br><input name='station' value='" + String(cfg.station) + "' style='width:100%;padding:8px;box-sizing:border-box'></p>";
  h += "<button style='width:100%;padding:12px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:16px'>儲存並重啟</button>";
  h += "</form></body></html>";
  return h;
}

void startSetupAP() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP("OrderingRFID-Setup", "88888888");
  dnsServer.start(53, "*", WiFi.softAPIP());
  server.on("/", []() { server.send(200, "text/html", configPage()); });
  server.on("/save", []() {
    strncpy(cfg.ssid, server.arg("ssid").c_str(), 32);
    strncpy(cfg.pass, server.arg("pass").c_str(), 64);
    strncpy(cfg.server, server.arg("server").c_str(), 79);
    strncpy(cfg.secret, server.arg("secret").c_str(), 32);
    strncpy(cfg.station, server.arg("station").c_str(), 23);
    saveConfig();
    server.send(200, "text/html", "<meta charset='utf-8'><body style='font-family:sans-serif;text-align:center;padding:40px'><h2>已儲存</h2><p>讀卡機將重新開機並連線。</p></body>");
    delay(800);
    ESP.restart();
  });
  server.onNotFound([]() { server.send(200, "text/html", configPage()); });
  server.begin();
  Serial.println("[SETUP] AP 模式：OrderingRFID-Setup / 88888888，開 http://192.168.4.1");
}

void beep(int times, int delayMs = 120) {
  if (BUZZER_PIN < 0) return;
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(delayMs);
    digitalWrite(BUZZER_PIN, LOW);
    delay(delayMs);
  }
}

void blinkLed(int times, int delayMs = 150) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, LOW);   // 點亮
    delay(delayMs);
    digitalWrite(LED_PIN, HIGH);  // 熄滅
    delay(delayMs);
  }
}

String readUidHex() {
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  return uid;
}

// 把動作 POST 到後端，回傳伺服器回應字串（失敗回傳空字串）
String postAction(const String& action, const String& uid) {
  if (WiFi.status() != WL_CONNECTED) return "";

  WiFiClientSecure client;
  client.setInsecure();          // 略過憑證驗證（簡單可靠）
  client.setTimeout(10000);

  HTTPClient http;
  if (!http.begin(client, String(cfg.server) + "/api/gas")) return "";
  http.addHeader("Content-Type", "application/json");

  String body = "{\"action\":\"" + action + "\",\"data\":{";
  body += "\"uid\":\"" + uid + "\",";
  body += "\"stationId\":\"" + String(cfg.station) + "\",";
  body += "\"secret\":\"" + String(cfg.secret) + "\"";
  body += "}}";

  int code = http.POST(body);
  String resp = http.getString();
  http.end();

  return (code == 200) ? resp : "";
}

// 每 30 秒送一次心跳（僅在閒置時，避免干擾感應）
void heartbeatTick() {
  if (millis() - lastScanMs < 10000) return;
  if (millis() - lastHeartbeatMs < 30000) return;
  lastHeartbeatMs = millis();
  postAction("rfidHeartbeat", "");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);
  if (BUZZER_PIN >= 0) pinMode(BUZZER_PIN, OUTPUT);

  loadConfig();

  // 設定鈕：開機按住 → 強制進入設定模式
  bool forceAp = false;
  if (CONFIG_PIN >= 0) {
    pinMode(CONFIG_PIN, INPUT_PULLUP);
    forceAp = (digitalRead(CONFIG_PIN) == LOW);
  }
  if (forceAp) { startSetupAP(); return; }

  // 嘗試連線
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfg.ssid, cfg.pass);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.println("[RFID] WiFi 已連線，IP: " + WiFi.localIP().toString());
    SPI.begin();
    rfid.PCD_Init();
    rfid.PCD_SetAntennaGain(rfid.RxGain_max);
    beep(1, 80);
  } else {
    Serial.println();
    Serial.println("[RFID] WiFi 連線失敗，進入設定模式。");
    startSetupAP();
  }
}

void loop() {
  // 設定（AP）模式：只處理 DNS 與網頁
  if (WiFi.getMode() == WIFI_AP) {
    dnsServer.processNextRequest();
    server.handleClient();
    return;
  }

  // 若 WiFi 斷線，嘗試重連
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(3000);
    return;
  }

  // 沒有偵測到卡片 → 重設旗標，閒置時送心跳
  if (!rfid.PICC_IsNewCardPresent()) {
    cardReported = false;
    heartbeatTick();
    delay(40);
    return;
  }

  if (!rfid.PICC_ReadCardSerial()) { delay(40); return; }

  String uid = readUidHex();
  if (uid != lastUid) { lastUid = uid; cardReported = false; }

  // 同一張卡尚未移走 → 只上報一次（去抖）
  // 注意：不呼叫 PICC_HaltA()，否則卡會「暫時隱形」被誤判成已移走而重複上報。
  if (!cardReported) {
    cardReported = true;
    lastScanMs = millis();
    Serial.println("[RFID] 感應到卡片 UID: " + uid);
    blinkLed(1, 60); // 立即回饋「已讀到」

    String resp = postAction("rfidScan", uid);
    if (resp.length() == 0) {
      Serial.println("[RFID] 伺服器連線失敗，請檢查網路或 SERVER_URL。");
      blinkLed(3, 120);
      beep(1, 400);
    } else {
      Serial.println("[RFID] 回應: " + resp);
      if (resp.indexOf("\"registered\"") >= 0) {
        blinkLed(2, 100);        // 註冊成功：閃 2 下
        beep(2, 100);
      } else if (resp.indexOf("\"scanned\"") >= 0) {
        blinkLed(1, 150);        // 掃描成功：閃 1 下
        beep(1, 150);
      } else if (resp.indexOf("\"duplicate\"") >= 0) {
        // 後端去抖：卡未移走，不提示
      } else {
        blinkLed(3, 120);        // 錯誤（未綁定/密鑰錯誤）：閃 3 下
        beep(1, 400);
      }
    }
  }

  delay(60);
}
