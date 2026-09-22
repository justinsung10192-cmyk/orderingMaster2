// ============================================================================
// 訂餐通 RFID 讀卡機韌體
// 硬體：D1 Mini (ESP8266) + RC522 (MFRC522, 13.56MHz)
// 功能：感應到卡片後，把卡片 UID POST 到訂餐通後端（等同掃碼核銷）。
// ============================================================================
// 依賴函式庫（Arduino IDE 函式庫管理員安裝）：
//   - MFRC522（by GithubCommunity）
//   - ESP8266WiFi / ESP8266HTTPClient（隨 ESP8266 開發板套件內建）
// 開發板請選：WeMos D1 R2 & mini（或 NodeMCU 1.0）
// ============================================================================

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>

// ======================= 請修改這裡 =======================
const char* WIFI_SSID     = "Iphone 1 pro max";  // 你的 WiFi SSID
const char* WIFI_PASSWORD = "88888888";  // 你的 WiFi 密碼

// 你的 Vercel 網址（例如 https://orderingmaster2.vercel.app）
const char* SERVER_URL    = "https://ordering-master-pro.vercel.app";

// 裝置密鑰：登入管理後台 → 「RFID」分頁 → 複製「裝置密鑰」貼到這裡
const char* SECRET        = "MJE7T4RP29YE3ZUD";

// 站台（班級）識別碼：預設為 demo（對應資料庫 classes.class_id）
const char* STATION_ID    = "demo";
// ==========================================================

// ====== RC522 接腳（使用 GPIO 編號；新版 ESP8266 core 已移除 D0~D8 巨集）======
// 常見接法：SDA->GPIO15(D8), SCK->GPIO14(D5), MOSI->GPIO13(D7), MISO->GPIO12(D6), RST->GPIO0(D3)
constexpr uint8_t SS_PIN   = 15;  // SDA  (D8)
constexpr uint8_t RST_PIN  = 0;   // RST  (D3)
// 蜂鳴器（選用，未接就保持 -1；接了建議用 GPIO5 / D1）
constexpr int    BUZZER_PIN = -1; // 改成 GPIO 編號可啟用

// 內建 LED（D1 Mini 板上藍色 LED，GPIO2 低電位點亮）
constexpr uint8_t LED_PIN = 2;    // = LED_BUILTIN

MFRC522 rfid(SS_PIN, RST_PIN);

// 去抖與心跳狀態
String lastUid = "";            // 上一次上報的 UID
bool cardReported = false;       // 目前這張卡是否已上報（卡未移走不重複）
unsigned long lastHeartbeatMs = 0;

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
  if (!http.begin(client, String(SERVER_URL) + "/api/gas")) return "";
  http.addHeader("Content-Type", "application/json");

  String body = "{\"action\":\"" + action + "\",\"data\":{";
  body += "\"uid\":\"" + uid + "\",";
  body += "\"stationId\":\"" + String(STATION_ID) + "\",";
  body += "\"secret\":\"" + String(SECRET) + "\"";
  body += "}}";

  int code = http.POST(body);
  String resp = http.getString();
  http.end();

  return (code == 200) ? resp : "";
}

// 每 20 秒送一次心跳，讓後台知道讀卡機仍在線
void heartbeatTick() {
  if (millis() - lastHeartbeatMs < 20000) return;
  lastHeartbeatMs = millis();
  postAction("rfidHeartbeat", "");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH); // 內建 LED 預設熄滅
  if (BUZZER_PIN >= 0) pinMode(BUZZER_PIN, OUTPUT);

  SPI.begin();
  rfid.PCD_Init();
  rfid.PCD_SetAntennaGain(rfid.RxGain_max); // 提高讀取靈敏度

  Serial.println();
  Serial.println("[RFID] 初始化完成，連接 WiFi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(300);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.println("[RFID] WiFi 已連線，IP: " + WiFi.localIP().toString());
    beep(1, 80);
  } else {
    Serial.println();
    Serial.println("[RFID] WiFi 連線失敗，將持續重試。");
  }
}

void loop() {
  // 若 WiFi 斷線，嘗試重連
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(3000);
    return;
  }

  // 沒有偵測到卡片 → 重設「已上報」旗標，並每 20 秒送一次心跳
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
  if (!cardReported) {
    cardReported = true;
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

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(60); // 微去抖（已用旗標避免重複，不需長延遲）
}
