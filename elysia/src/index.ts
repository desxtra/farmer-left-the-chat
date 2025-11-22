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

// Helper function to log system events
function logSystemEvent(message: string, type: string = 'info') {
  const stmt = db.prepare(`
    INSERT INTO system_logs (message, type) VALUES (?, ?)
  `);
  stmt.run(message, type);
  console.log(`[${type.toUpperCase()}] ${message}`);
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
  
  // Log state changes
  if (relayState !== currentRelayState) {
    logSystemEvent(`Relay state changed to: ${relayState ? 'ON' : 'OFF'}`, 'relay');
    lastRelayChange = new Date().toISOString();
  }
  
  currentRelayState = relayState;
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
      todayToggleCount: getTodayToggleCount()
    };
  })
  
  // Get current status
  .get("/", () => {
    return {
      message: "Humidity Monitoring System",
      currentRelayState,
      relayToggleCountToday: getTodayToggleCount(),
      lastRelayChange
    };
  })
  
  // Submit sensor data from ESP32
  .post("/sensor-data", 
    ({ body }) => {
      insertSensorData(body.humidity, body.relay_state);
      
      logSystemEvent(`Sensor data received - Humidity: ${body.humidity}%, Relay: ${body.relay_state}`, 'sensor');
      
      return {
        success: true,
        message: "Sensor data recorded",
        currentRelayState,
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
      
      // Record the relay state change with current humidity (placeholder)
      const placeholderHumidity = 50; // You might want to get the latest humidity
      
      insertSensorData(placeholderHumidity, newRelayState);
      
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
    ({ body }) => {
      insertSensorData(body.humidity || 50, body.state);
      
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
  .get("/relay/status", () => {
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
    
    // Latest humidity
    const latestHumidityStmt = db.prepare(`
      SELECT humidity FROM sensor_data 
      WHERE DATE(timestamp) = ?
      ORDER BY timestamp DESC 
      LIMIT 1
    `);
    const latestHumidity = latestHumidityStmt.get(today) as { humidity: number };
    
    // Relay toggle count today
    const toggleStmt = db.prepare(`
      SELECT COUNT(*) as toggle_count FROM sensor_data 
      WHERE DATE(timestamp) = ? AND relay_state = true
    `);
    const toggleCount = toggleStmt.get(today) as { toggle_count: number };
    
    return {
      date: today,
      averageHumidity: Math.round(avgHumidity.avg_humidity || 0),
      currentHumidity: latestHumidity?.humidity || 0,
      relayToggleCount: toggleCount.toggle_count,
      currentRelayState
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
  );

// Start server
app.listen({
  hostname: "0.0.0.0",
  port: 3000
});

console.log(`Elysia is running at http://0.0.0.0:3000`);
console.log(`Health check: http://0.0.0.0:3000/health`);
console.log(`System ready for plant watering automation`);