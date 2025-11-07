import network
import urequests as requests
import ujson as json
from machine import Pin, ADC, Timer
import time

# WiFi Configuration
WIFI_SSID = "your_wifi_ssid"
WIFI_PASSWORD = "your_wifi_password"

# Server Configuration
SERVER_IP = "192.168.1.100"  # Change to your server IP
SERVER_PORT = "3000"
SERVER_BASE_URL = f"http://{SERVER_IP}:{SERVER_PORT}"

# Pin Configuration
RELAY_PIN = 4
SOIL_MOISTURE_PIN = 34  # Analog pin (GPIO34) for soil moisture sensor
LED_PIN = 2  # Built-in LED for status indicator

# Soil Moisture Sensor Calibration
# You need to calibrate these values for your specific soil and sensor
DRY_VALUE = 4095  # Value when sensor is dry (in air)
WET_VALUE = 1500  # Value when sensor is in water
SOIL_MOISTURE_MIN = 0  # Minimum moisture percentage
SOIL_MOISTURE_MAX = 100  # Maximum moisture percentage

# Global variables
relay_state = False
last_moisture = 0
wifi_connected = False

# Initialize components
relay = Pin(RELAY_PIN, Pin.OUT)
led = Pin(LED_PIN, Pin.OUT)
soil_moisture_sensor = ADC(Pin(SOIL_MOISTURE_PIN))
soil_moisture_sensor.atten(ADC.ATTN_11DB)  # Configure for 0-3.3V range
soil_moisture_sensor.width(ADC.WIDTH_12BIT)  # 12-bit resolution (0-4095)

def connect_wifi():
    global wifi_connected
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    
    if not wlan.isconnected():
        print('Connecting to WiFi...')
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        
        # Wait for connection
        timeout = 30
        while not wlan.isconnected() and timeout > 0:
            led.value(not led.value())  # Blink LED while connecting
            time.sleep(0.5)
            timeout -= 1
            print('.', end='')
        
        if wlan.isconnected():
            wifi_connected = True
            led.value(1)  # Solid LED when connected
            print('\nWiFi connected!')
            print('Network config:', wlan.ifconfig())
        else:
            wifi_connected = False
            led.value(0)
            print('\nFailed to connect to WiFi')
    
    return wifi_connected

def read_soil_moisture():
    global last_moisture
    try:
        # Read analog value (0-4095)
        raw_value = soil_moisture_sensor.read()
        
        # Convert to moisture percentage (inverted because higher reading = drier soil)
        # The sensor gives higher values in dry conditions, lower in wet conditions
        moisture_percentage = 100 - map_value(raw_value, DRY_VALUE, WET_VALUE, SOIL_MOISTURE_MIN, SOIL_MOISTURE_MAX)
        
        # Constrain between 0-100%
        moisture_percentage = max(0, min(100, moisture_percentage))
        
        last_moisture = int(moisture_percentage)
        print(f"Raw sensor value: {raw_value}, Moisture: {last_moisture}%")
        return last_moisture
        
    except Exception as e:
        print("Error reading soil moisture sensor:", e)
        return last_moisture

def map_value(value, in_min, in_max, out_min, out_max):
    """Map a value from one range to another"""
    return (value - in_min) * (out_max - out_min) / (in_max - in_min) + out_min

def send_sensor_data(moisture, relay_state):
    if not wifi_connected:
        print("WiFi not connected, cannot send data")
        return False
    
    try:
        url = f"{SERVER_BASE_URL}/sensor-data"
        data = {
            "humidity": moisture,  # Using 'humidity' field as required by your backend
            "relay_state": relay_state
        }
        
        print(f"Sending data - Soil Moisture: {moisture}%, Relay: {relay_state}")
        response = requests.post(
            url,
            json=data,
            headers={'Content-Type': 'application/json'}
        )
        
        if response.status_code == 200:
            response_data = response.json()
            print(f"Data sent successfully")
            
            # Update relay state from server response if needed
            if 'currentRelayState' in response_data:
                update_relay_state(response_data['currentRelayState'])
            
            response.close()
            return True
        else:
            print(f"Failed to send data. Status: {response.status_code}")
            response.close()
            return False
            
    except Exception as e:
        print("Error sending sensor data:", e)
        return False

def update_relay_state(new_state):
    global relay_state
    if relay_state != new_state:
        relay_state = new_state
        relay.value(1 if relay_state else 0)
        print(f"Relay state updated to: {'ON' if relay_state else 'OFF'}")
        return True
    return False

def get_relay_status():
    if not wifi_connected:
        return False
    
    try:
        url = f"{SERVER_BASE_URL}/relay/status"
        response = requests.get(url)
        
        if response.status_code == 200:
            data = response.json()
            response.close()
            return data.get('relayState', False)
        else:
            response.close()
            return False
            
    except Exception as e:
        print("Error getting relay status:", e)
        return False

def sensor_reading_task(timer):
    if wifi_connected:
        moisture = read_soil_moisture()
        success = send_sensor_data(moisture, relay_state)
        
        # Blink LED briefly to indicate data transmission
        if success:
            led.value(0)
            time.sleep(0.1)
            led.value(1)

def sync_relay_state(timer):
    if wifi_connected:
        server_state = get_relay_status()
        if server_state is not False and server_state != relay_state:
            print(f"Syncing relay state from server: {server_state}")
            update_relay_state(server_state)

def check_wifi_connection(timer):
    global wifi_connected
    wlan = network.WLAN(network.STA_IF)
    if not wlan.isconnected():
        print("WiFi disconnected. Attempting to reconnect...")
        wifi_connected = False
        led.value(0)  # Turn off LED when disconnected
        connect_wifi()

def calibrate_sensor():
    """Function to help calibrate the sensor - run this once to find dry/wet values"""
    print("=== Sensor Calibration Mode ===")
    print("Leave sensor in air for dry value...")
    time.sleep(5)
    dry_value = 0
    for i in range(10):
        dry_value += soil_moisture_sensor.read()
        time.sleep(1)
    dry_value = dry_value // 10
    print(f"Dry value (in air): {dry_value}")
    
    print("Now put sensor in water for wet value...")
    time.sleep(5)
    wet_value = 0
    for i in range(10):
        wet_value += soil_moisture_sensor.read()
        time.sleep(1)
    wet_value = wet_value // 10
    print(f"Wet value (in water): {wet_value}")
    
    print("Calibration complete!")
    print(f"DRY_VALUE = {dry_value}")
    print(f"WET_VALUE = {wet_value}")

def main():
    print("Initializing Soil Moisture Monitoring System...")
    print("MH-Sensor Series Soil Moisture + Relay Control")
    print("==============================================")
    
    # Uncomment the line below to run calibration (do this once)
    # calibrate_sensor()
    
    # Initial relay state
    update_relay_state(False)
    
    # Connect to WiFi
    if not connect_wifi():
        print("WiFi connection failed. Retrying in 10 seconds...")
        time.sleep(10)
        connect_wifi()
    
    # Set up timers for periodic tasks
    # Read sensors and send data every 30 seconds
    sensor_timer = Timer(0)
    sensor_timer.init(period=30000, mode=Timer.PERIODIC, callback=lambda t: sensor_reading_task(t))
    
    # Sync relay state from server every 10 seconds
    relay_timer = Timer(1)
    relay_timer.init(period=10000, mode=Timer.PERIODIC, callback=lambda t: sync_relay_state(t))
    
    # Check WiFi connection every 60 seconds
    wifi_timer = Timer(2)
    wifi_timer.init(period=60000, mode=Timer.PERIODIC, callback=lambda t: check_wifi_connection(t))
    
    print("System started!")
    print("Sending soil moisture data every 30 seconds")
    print("Syncing relay state every 10 seconds")
    
    # Main loop - just keep the program running
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Stopping system...")
        sensor_timer.deinit()
        relay_timer.deinit()
        wifi_timer.deinit()
        relay.value(0)  # Turn off relay when stopping
        led.value(0)

if __name__ == "__main__":
    main()