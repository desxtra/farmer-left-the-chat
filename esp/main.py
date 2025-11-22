import network
import urequests as requests
from machine import Pin, ADC, Timer
import time

# Config
WIFI_SSID = "your wifi ssid"
WIFI_PASSWORD = "your wifi password"
SERVER_URL = "http://192.168.1.3:3000/sensor-data"

# Hardware
relay = Pin(4, Pin.OUT)
sensor = ADC(Pin(34))
sensor.atten(ADC.ATTN_11DB)

relay_state = False

def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        while not wlan.isconnected():
            time.sleep(0.5)
    print('WiFi connected:', wlan.ifconfig()[0])
    return True

def read_moisture():
    raw = sensor.read()
    moisture = 100 - int((raw - 1500) * 100 / (4095 - 1500))
    moisture = max(0, min(100, moisture))
    print('Moisture:', moisture, '%')
    return moisture

def send_data():
    try:
        moisture = read_moisture()
        data = {"humidity": moisture, "relay_state": relay_state}
        response = requests.post(SERVER_URL, json=data, timeout=10)
        print('Send status:', response.status_code)
        response.close()
        return True
    except Exception as e:
        print('Send error:', e)
        return False

def main():
    connect_wifi()
    
    def reading_task(t):
        send_data()
    
    timer = Timer(0)
    timer.init(period=z30000, mode=Timer.PERIODIC, callback=reading_task)
    
    try:
        while True:
            time.sleep(1)
    except:
        timer.deinit()
        relay.value(0)

main()