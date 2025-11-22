import { Elysia, t } from "elysia";
import { cors } from '@elysiajs/cors';
import { Database } from "bun:sqlite";

const app = new Elysia();

// Enable CORS for all routes
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Initialize SQLite database
const db = new Database('sensor.db');

// Create tables if they don't exist
db.run(`
  CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    humidity INTEGER NOT NULL,
    relay_state BOOLEAN NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    type TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Store current relay state in memory for quick access
let currentRelayState = false;
let lastRelayChange = new Date().toISOString();

// Auto watering settings
let AUTO_WATERING_SETTINGS = {
  threshold: 40,      // Trigger when humidity < 40%
  duration: 5,        // Water for 5 seconds
  minInterval: 300,   // Minimum 5 minutes between auto waterings
  enabled: true       // Auto watering enabled
};

// Helper function to log system events
function logSystemEvent(message: string, type: string = 'info') {
  const stmt = db.prepare(`
    INSERT INTO system_logs (message, type) VALUES (?, ?)
  `);
  stmt.run(message, type);
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
}

// Helper function to get today's toggle count from database
function getTodayToggleCount(): number {
  const today = new Date().toISOString().split('T')[0];
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM sensor_data 
    WHERE DATE(timestamp) = ? AND relay_state = true
  `);
  const result = stmt.get(today) as { count: number };
  return result.count;
}

// Helper function to insert sensor data
function insertSensorData(humidity: number, relayState: boolean) {
  const stmt = db.prepare(`
    INSERT INTO sensor_data (humidity, relay_state) VALUES (?, ?)
  `);
  stmt.run(humidity, relayState ? 1 : 0);

  // Log state changes - ONLY when state actually changes
  if (relayState !== currentRelayState) {
    logSystemEvent(`Relay state changed to: ${relayState ? 'ON' : 'OFF'}`, 'relay');
    lastRelayChange = new Date().toISOString();
    currentRelayState = relayState;  // Only update when changed
  }
}

// Function to check for auto watering
function checkAutoWatering(humidity: number) {
  if (!AUTO_WATERING_SETTINGS.enabled) return false;
  
  if (humidity < AUTO_WATERING_SETTINGS.threshold && !currentRelayState) {
    // Check last watering time from logs
    const lastWateringStmt = db.prepare(`
      SELECT timestamp FROM system_logs 
      WHERE message LIKE '%Auto watering triggered%' 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);
    const lastWatering = lastWateringStmt.get() as { timestamp: string };
    
    const now = new Date();
    const lastWateringTime = lastWatering ? new Date(lastWatering.timestamp) : new Date(0);
    const timeSinceLastWatering = (now.getTime() - lastWateringTime.getTime()) / 1000;
    
    if (timeSinceLastWatering >= AUTO_WATERING_SETTINGS.minInterval) {
      logSystemEvent(`Auto watering triggered! Humidity: ${humidity}%`, 'auto');
      
      // Turn on relay
      insertSensorData(humidity, true);
      
      // Schedule turn off after watering duration
      setTimeout(() => {
        if (currentRelayState) { // Only turn off if still on
          const currentHumidityStmt = db.prepare(`
            SELECT humidity FROM sensor_data 
            ORDER BY timestamp DESC 
            LIMIT 1
          `);
          const currentHumidity = currentHumidityStmt.get() as { humidity: number };
          
          insertSensorData(currentHumidity?.humidity || humidity, false);
          logSystemEvent(`Auto watering completed after ${AUTO_WATERING_SETTINGS.duration} seconds`, 'auto');
        }
      }, AUTO_WATERING_SETTINGS.duration * 1000);
      
      return true;
    }
  }
  return false;
}

// Initialize system log
logSystemEvent('System started', 'system');

// Routes
app
  // Health check endpoint
  .get("/health", () => {
    return {
      status: "healthy",
      timestamp: new Date().toISOString(),
      currentRelayState,
      todayToggleCount: getTodayToggleCount(),
      autoWatering: AUTO_WATERING_SETTINGS
    };
  })

  // Get current status
  .get("/", () => {
    return {
      message: "Humidity Monitoring System",
      currentRelayState,
      relayToggleCountToday: getTodayToggleCount(),
      lastRelayChange,
      autoWatering: AUTO_WATERING_SETTINGS
    };
  })

  // Submit sensor data from ESP32
  .post("/sensor-data",
    ({ body, request }) => {
      const clientIP = request.headers.get('x-forwarded-for') ||
        request.headers.get('x-real-ip') ||
        'unknown';

      logSystemEvent(`ESP32 data - Humidity: ${body.humidity}%, Relay: ${body.relay_state}`, 'sensor');

      // Insert sensor data but DON'T update currentRelayState from ESP32
      const stmt = db.prepare(`
        INSERT INTO sensor_data (humidity, relay_state) VALUES (?, ?)
      `);
      stmt.run(body.humidity, body.relay_state ? 1 : 0);

      // Check for auto watering conditions
      checkAutoWatering(body.humidity);

      return {
        success: true,
        message: "Sensor data recorded",
        currentRelayState, // Always return current backend state
        relayToggleCountToday: getTodayToggleCount(),
        timestamp: new Date().toISOString()
      };
    },
    {
      body: t.Object({
        humidity: t.Number({ minimum: 0, maximum: 100 }),
        relay_state: t.Boolean()
      })
    }
  )

  // Manual relay control from frontend
  .post("/relay/toggle",
    ({ body }) => {
      const newRelayState = body.action === 'on' ? true :
        body.action === 'off' ? false :
          !currentRelayState;

      // Get the latest humidity from database instead of using placeholder
      const latestHumidityStmt = db.prepare(`
        SELECT humidity FROM sensor_data 
        ORDER BY timestamp DESC 
        LIMIT 1
      `);
      const latestHumidity = latestHumidityStmt.get() as { humidity: number };

      // Use latest humidity or default to 0 if none exists
      const humidity = latestHumidity?.humidity || 0;

      insertSensorData(humidity, newRelayState);

      logSystemEvent(`Manual relay toggle - New state: ${newRelayState ? 'ON' : 'OFF'}`, 'manual');

      return {
        success: true,
        message: `Relay turned ${newRelayState ? 'ON' : 'OFF'}`,
        relayState: newRelayState,
        relayToggleCountToday: getTodayToggleCount(),
        timestamp: new Date().toISOString()
      };
    },
    {
      body: t.Object({
        action: t.Optional(t.Union([t.Literal('on'), t.Literal('off'), t.Literal('toggle')]))
      })
    }
  )

  // Set relay state explicitly (for ESP32 sync)
  .post("/relay/set",
    ({ body, request }) => {
      const clientIP = request.headers.get('x-forwarded-for') ||
        request.headers.get('x-real-ip') ||
        'unknown';

      insertSensorData(body.humidity || 50, body.state);

      logSystemEvent(`ESP32 relay set from ${clientIP} - State: ${body.state ? 'ON' : 'OFF'}`, 'relay');

      return {
        success: true,
        message: `Relay set to ${body.state ? 'ON' : 'OFF'}`,
        relayState: body.state,
        timestamp: new Date().toISOString()
      };
    },
    {
      body: t.Object({
        state: t.Boolean(),
        humidity: t.Optional(t.Number({ minimum: 0, maximum: 100 }))
      })
    }
  )

  // Get relay status
  .get("/relay/status", ({ request }) => {
    const clientIP = request.headers.get('x-forwarded-for') ||
      request.headers.get('x-real-ip') ||
      'unknown';

    logSystemEvent(`ESP32 status check from ${clientIP}`, 'network');

    return {
      relayState: currentRelayState,
      toggleCountToday: getTodayToggleCount(),
      lastUpdated: lastRelayChange
    };
  })

  // Get historical sensor data
  .get("/history",
    ({ query }) => {
      const limit = query.limit || 100;
      const stmt = db.prepare(`
        SELECT * FROM sensor_data 
        ORDER BY timestamp DESC 
        LIMIT ?
      `);
      const data = stmt.all(limit) as any[];

      return {
        data: data.map(row => ({
          ...row,
          relay_state: Boolean(row.relay_state)
        }))
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.Number({ minimum: 1, maximum: 1000 }))
      })
    }
  )

  // Get system logs
  .get("/logs",
    ({ query }) => {
      const limit = query.limit || 100;
      const stmt = db.prepare(`
        SELECT * FROM system_logs 
        ORDER BY timestamp DESC 
        LIMIT ?
      `);
      const data = stmt.all(limit) as any[];

      return {
        data
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.Number({ minimum: 1, maximum: 1000 }))
      })
    }
  )

  // Get today's statistics
  .get("/stats/today", () => {
    const today = new Date().toISOString().split('T')[0];

    // Average humidity today
    const avgHumidityStmt = db.prepare(`
      SELECT AVG(humidity) as avg_humidity FROM sensor_data 
      WHERE DATE(timestamp) = ?
    `);
    const avgHumidity = avgHumidityStmt.get(today) as { avg_humidity: number };

    // Latest humidity (most recent reading)
    const latestHumidityStmt = db.prepare(`
      SELECT humidity FROM sensor_data 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);
    const latestHumidity = latestHumidityStmt.get() as { humidity: number };

    // Relay toggle count today - only count actual state changes
    const toggleStmt = db.prepare(`
      SELECT COUNT(DISTINCT id) as toggle_count FROM sensor_data 
      WHERE DATE(timestamp) = ? AND relay_state = true
      AND id IN (
        SELECT s1.id FROM sensor_data s1
        LEFT JOIN sensor_data s2 ON s1.id = s2.id + 1
        WHERE (s2.relay_state IS NULL OR s1.relay_state != s2.relay_state)
      )
    `);
    const toggleCount = toggleStmt.get(today) as { toggle_count: number };

    return {
      date: today,
      averageHumidity: Math.round(avgHumidity.avg_humidity || 0),
      currentHumidity: latestHumidity?.humidity || 0,
      relayToggleCount: toggleCount.toggle_count,
      currentRelayState,
      autoWatering: AUTO_WATERING_SETTINGS
    };
  })

  // Get detailed analytics
  .get("/analytics",
    ({ query }) => {
      const days = query.days || 7;

      const stmt = db.prepare(`
        SELECT 
          DATE(timestamp) as date,
          AVG(humidity) as avg_humidity,
          MAX(humidity) as max_humidity,
          MIN(humidity) as min_humidity,
          COUNT(CASE WHEN relay_state = true THEN 1 END) as pump_activations
        FROM sensor_data 
        WHERE timestamp >= date('now', ?)
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
      `);
      const data = stmt.all(`-${days} days`) as any[];

      return {
        period: `${days} days`,
        data
      };
    },
    {
      query: t.Object({
        days: t.Optional(t.Number({ minimum: 1, maximum: 30 }))
      })
    }
  )

  // Get auto watering settings
  .get("/auto-watering/settings", () => {
    return AUTO_WATERING_SETTINGS;
  })

  // Update auto watering settings
  .post("/auto-watering/settings",
    ({ body }) => {
      if (body.threshold !== undefined) {
        AUTO_WATERING_SETTINGS.threshold = body.threshold;
      }
      if (body.duration !== undefined) {
        AUTO_WATERING_SETTINGS.duration = body.duration;
      }
      if (body.minInterval !== undefined) {
        AUTO_WATERING_SETTINGS.minInterval = body.minInterval;
      }
      if (body.enabled !== undefined) {
        AUTO_WATERING_SETTINGS.enabled = body.enabled;
      }
      
      logSystemEvent(`Auto watering settings updated: ${JSON.stringify(AUTO_WATERING_SETTINGS)}`, 'system');
      
      return {
        success: true,
        message: "Auto watering settings updated",
        settings: AUTO_WATERING_SETTINGS
      };
    },
    {
      body: t.Object({
        threshold: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
        duration: t.Optional(t.Number({ minimum: 1, maximum: 60 })),
        minInterval: t.Optional(t.Number({ minimum: 60, maximum: 3600 })),
        enabled: t.Optional(t.Boolean())
      })
    }
  );

// Start server
app.listen({
  hostname: "0.0.0.0",
  port: 3000
});

console.log(`🚀 Elysia is running at http://0.0.0.0:3000`);
console.log(`❤️  Health check: http://localhost:3000/health`);
console.log(`💧 Auto watering: ${AUTO_WATERING_SETTINGS.enabled ? 'ENABLED' : 'DISABLED'} (threshold: ${AUTO_WATERING_SETTINGS.threshold}%)`);
console.log(`📡 Waiting for ESP32 connections...`);