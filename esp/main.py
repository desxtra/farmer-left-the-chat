import network
import urequests as requests
import ujson as json
from machine import Pin, ADC, Timer
import time
import sys

# WiFi Configuration
WIFI_SSID = "Lab Telkom"
WIFI_PASSWORD = ""

# Server Configuration - FIX: Use correct server IP
SERVER_IP = "192.168.1.100"  # CHANGE THIS to your computer's IP on the same network
SERVER_PORT = "3000"
SERVER_BASE_URL = f"http://{SERVER_IP}:{SERVER_PORT}"

# Pin Configuration
RELAY_PIN = 4
SOIL_MOISTURE_PIN = 34
LED_PIN = 2

# Soil Moisture Sensor Calibration - ADJUST THESE VALUES
DRY_VALUE = 4095
WET_VALUE = 1500

# Global variables
relay_state = False
last_moisture = 0
wifi_connected = False
server_available = False

# Initialize components
relay = Pin(RELAY_PIN, Pin.OUT)
led = Pin(LED_PIN, Pin.OUT)
soil_moisture_sensor = ADC(Pin(SOIL_MOISTURE_PIN))
soil_moisture_sensor.atten(ADC.ATTN_11DB)
soil_moisture_sensor.width(ADC.WIDTH_12BIT)

def connect_wifi():
    global wifi_connected
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    
    if not wlan.isconnected():
        print('Connecting to WiFi...')
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        
        timeout = 20
        while not wlan.isconnected() and timeout > 0:
            led.value(not led.value())
            time.sleep(0.5)
            timeout -= 1
            print('.', end='')
        
        if wlan.isconnected():
            wifi_connected = True
            led.value(1)
            print('\n✅ WiFi connected!')
            print('📶 Network config:', wlan.ifconfig())
            return True
        else:
            wifi_connected = False
            led.value(0)
            print('\n❌ Failed to connect to WiFi')
            return False
    return True

def read_soil_moisture():
    global last_moisture
    try:
        # Take multiple readings for stability
        readings = []
        for _ in range(5):
            readings.append(soil_moisture_sensor.read())
            time.sleep(0.1)
        
        raw_value = sum(readings) // len(readings)
        
        # Convert to moisture percentage
        if raw_value <= WET_VALUE:
            moisture_percentage = 100
        elif raw_value >= DRY_VALUE:
            moisture_percentage = 0
        else:
            moisture_percentage = 100 - int((raw_value - WET_VALUE) * 100 / (DRY_VALUE - WET_VALUE))
        
        moisture_percentage = max(0, min(100, moisture_percentage))
        last_moisture = moisture_percentage
        
        print(f"💧 Sensor - Raw: {raw_value}, Moisture: {last_moisture}%")
        return last_moisture
        
    except Exception as e:
        print("❌ Error reading soil moisture:", e)
        return last_moisture

def check_server_connection():
    global server_available
    if not wifi_connected:
        return False
    
    try:
        response = requests.get(f"{SERVER_BASE_URL}/health", timeout=5)
        if response.status_code == 200:
            server_available = True
            response.close()
            return True
        response.close()
    except Exception as e:
        print(f"❌ Server connection failed: {e}")
    
    server_available = False
    return False

def send_sensor_data(moisture, relay_state):
    if not wifi_connected or not server_available:
        print("📡 Skipping data send - no connection")
        return False
    
    try:
        url = f"{SERVER_BASE_URL}/sensor-data"
        data = {
            "humidity": moisture,
            "relay_state": relay_state
        }
        
        print(f"📤 Sending - Moisture: {moisture}%, Relay: {relay_state}")
        response = requests.post(
            url,
            json=data,
            headers={'Content-Type': 'application/json'},
            timeout=10
        )
        
        if response.status_code == 200:
            response_data = response.json()
            print("✅ Data sent successfully")
            
            # Update relay state from server if different
            if 'currentRelayState' in response_data:
                update_relay_state(response_data['currentRelayState'])
            
            response.close()
            return True
        else:
            print(f"❌ Send failed. Status: {response.status_code}")
            response.close()
            return False
            
    except Exception as e:
        print("❌ Error sending sensor data:", e)
        server_available = False
        return False

def update_relay_state(new_state):
    global relay_state
    if relay_state != new_state:
        relay_state = new_state
        relay.value(1 if relay_state else 0)
        print(f"🔌 Relay {'ACTIVATED' if relay_state else 'DEACTIVATED'}")
        
        # Also send the state change to server
        if wifi_connected and server_available:
            try:
                moisture = read_soil_moisture()
                url = f"{SERVER_BASE_URL}/relay/set"
                data = {
                    "state": relay_state,
                    "humidity": moisture
                }
                response = requests.post(url, json=data, timeout=5)
                response.close()
            except Exception as e:
                print("Note: Could not notify server of relay change:", e)
        
        return True
    return False

def get_relay_status():
    if not wifi_connected:
        return None
    
    try:
        url = f"{SERVER_BASE_URL}/relay/status"
        response = requests.get(url, timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            response.close()
            return data.get('relayState', False)
        response.close()
    except Exception as e:
        print("❌ Error getting relay status:", e)
    
    return None

def sensor_reading_task(timer):
    if wifi_connected and server_available:
        moisture = read_soil_moisture()
        send_sensor_data(moisture, relay_state)
        
        # Quick blink to indicate activity
        if not relay_state:
            led.value(0)
            time.sleep(0.05)
            led.value(1)

def sync_relay_state(timer):
    if wifi_connected and server_available:
        server_state = get_relay_status()
        if server_state is not None and server_state != relay_state:
            print(f"🔄 Syncing relay state from server: {server_state}")
            update_relay_state(server_state)

def check_connections(timer):
    global wifi_connected, server_available
    wlan = network.WLAN(network.STA_IF)
    
    if not wlan.isconnected():
        print("📡 WiFi disconnected, reconnecting...")
        wifi_connected = False
        server_available = False
        led.value(0)
        connect_wifi()
    elif wifi_connected and not server_available:
        print("🔄 Checking server connection...")
        check_server_connection()

def calibrate_sensor():
    """Run this once to calibrate your sensor"""
    print("🔧 === Sensor Calibration Mode ===")
    print("Leave sensor in air for dry value...")
    time.sleep(3)
    
    dry_readings = []
    for i in range(10):
        dry_readings.append(soil_moisture_sensor.read())
        print(f"Dry reading {i+1}: {dry_readings[-1]}")
        time.sleep(1)
    dry_value = sum(dry_readings) // len(dry_readings)
    
    print("\nNow put sensor in water for wet value...")
    time.sleep(5)
    
    wet_readings = []
    for i in range(10):
        wet_readings.append(soil_moisture_sensor.read())
        print(f"Wet reading {i+1}: {wet_readings[-1]}")
        time.sleep(1)
    wet_value = sum(wet_readings) // len(wet_readings)
    
    print("\n✅ Calibration complete!")
    print(f"DRY_VALUE = {dry_value}")
    print(f"WET_VALUE = {wet_value}")
    print("Update these values in your code")

def main():
    print("🌱 Initializing Auto Plant Watering System...")
    print("==============================================")
    
    # Uncomment to calibrate sensor (run once)
    # calibrate_sensor()
    
    # Initial relay state
    update_relay_state(False)
    
    # Connect to WiFi
    if connect_wifi():
        check_server_connection()
    
    # Set up timers
    # Sensor reading every 30 seconds
    sensor_timer = Timer(0)
    sensor_timer.init(period=30000, mode=Timer.PERIODIC, callback=lambda t: sensor_reading_task(t))
    
    # Relay sync every 15 seconds
    relay_timer = Timer(1)
    relay_timer.init(period=15000, mode=Timer.PERIODIC, callback=lambda t: sync_relay_state(t))
    
    # Connection check every 60 seconds
    connection_timer = Timer(2)
    connection_timer.init(period=60000, mode=Timer.PERIODIC, callback=lambda t: check_connections(t))
    
    print("✅ System started!")
    print("⏰ Sensor data every 30s, Relay sync every 15s")
    
    try:
        while True:
            time.sleep(10)
            # Heartbeat blink
            if wifi_connected and server_available:
                led.value(not led.value())
                time.sleep(0.1)
                led.value(1)
    except KeyboardInterrupt:
        print("🛑 Stopping system...")
        sensor_timer.deinit()
        relay_timer.deinit()
        connection_timer.deinit()
        relay.value(0)
        led.value(0)

if __name__ == "__main__":
    main()