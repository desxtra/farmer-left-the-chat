# WiFi Configuration
WIFI_SSID = "Your_WiFi_SSID"
WIFI_PASSWORD = "Your_WiFi_Password"

# Server Configuration
SERVER_IP = "192.168.1.100"
SERVER_PORT = "3000"

# Sensor Configuration
SENSOR_READ_INTERVAL = 30000  # 30 seconds
RELAY_SYNC_INTERVAL = 10000   # 10 seconds

# Pin Configuration
RELAY_PIN = 4
SOIL_MOISTURE_PIN = 34  # Analog pin GPIO34
LED_PIN = 2

# Soil Moisture Calibration - YOU MUST CALIBRATE THESE VALUES
DRY_VALUE = 4095    # Value when sensor is dry (in air) - calibrate this
WET_VALUE = 1500    # Value when sensor is wet (in water) - calibrate this