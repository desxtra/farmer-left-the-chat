import { Elysia, t } from "elysia";
import { cors } from '@elysiajs/cors';
import { Database } from "bun:sqlite";

const app = new Elysia();

// Enable CORS for all routes
app.use(cors({
  origin: true, // Allow all origins, or specify your frontend URL: 'http://localhost:5173'
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Initialize SQLite database
const db = new Database('sensor.db');

// Create table if it doesn't exist
db.run(`
  CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    humidity INTEGER NOT NULL,
    relay_state BOOLEAN NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Store current relay state in memory for quick access
let currentRelayState = false;
let relayToggleCountToday = 0;

// Helper function to get today's toggle count from database
function updateTodayToggleCount() {
  const today = new Date().toISOString().split('T')[0];
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM sensor_data 
    WHERE DATE(timestamp) = ? AND relay_state = true
  `);
  const result = stmt.get(today) as { count: number };
  relayToggleCountToday = result.count;
}

// Initialize today's count
updateTodayToggleCount();

// Helper function to insert sensor data
function insertSensorData(humidity: number, relayState: boolean) {
  const stmt = db.prepare(`
    INSERT INTO sensor_data (humidity, relay_state) VALUES (?, ?)
  `);
  stmt.run(humidity, relayState ? 1 : 0);
  
  // Update toggle count if relay was turned on
  if (relayState && !currentRelayState) {
    updateTodayToggleCount();
  }
  
  currentRelayState = relayState;
}

// Routes
app
  // Get current status
  .get("/", () => {
    return {
      message: "Humidity Monitoring System",
      currentRelayState,
      relayToggleCountToday
    };
  })
  
  // Submit sensor data
  .post("/sensor-data", 
    ({ body }) => {
      insertSensorData(body.humidity, body.relay_state);
      
      return {
        success: true,
        message: "Sensor data recorded",
        currentRelayState,
        relayToggleCountToday
      };
    },
    {
      body: t.Object({
        humidity: t.Number({ minimum: 0, maximum: 100 }),
        relay_state: t.Boolean()
      })
    }
  )
  
  // Manual relay control
  .post("/relay/toggle", 
    ({ body }) => {
      const newRelayState = body.action === 'on' ? true : 
                           body.action === 'off' ? false : 
                           !currentRelayState;
      
      // Record the relay state change with current humidity
      const placeholderHumidity = 50;
      
      insertSensorData(placeholderHumidity, newRelayState);
      
      return {
        success: true,
        message: `Relay turned ${newRelayState ? 'ON' : 'OFF'}`,
        relayState: newRelayState,
        relayToggleCountToday,
        timestamp: new Date().toISOString()
      };
    },
    {
      body: t.Object({
        action: t.Optional(t.Union([t.Literal('on'), t.Literal('off'), t.Literal('toggle')]))
      })
    }
  )
  
  // Get relay status
  .get("/relay/status", () => {
    return {
      relayState: currentRelayState,
      toggleCountToday: relayToggleCountToday,
      lastUpdated: new Date().toISOString()
    };
  })
  
  // Get historical data
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
  
  // Get today's statistics
  .get("/stats/today", () => {
    const today = new Date().toISOString().split('T')[0];
    
    // Average humidity today
    const avgHumidityStmt = db.prepare(`
      SELECT AVG(humidity) as avg_humidity FROM sensor_data 
      WHERE DATE(timestamp) = ?
    `);
    const avgHumidity = avgHumidityStmt.get(today) as { avg_humidity: number };
    
    // Relay toggle count today
    const toggleStmt = db.prepare(`
      SELECT COUNT(*) as toggle_count FROM sensor_data 
      WHERE DATE(timestamp) = ? AND relay_state = true
    `);
    const toggleCount = toggleStmt.get(today) as { toggle_count: number };
    
    return {
      date: today,
      averageHumidity: Math.round(avgHumidity.avg_humidity || 0),
      relayToggleCount: toggleCount.toggle_count,
      currentRelayState
    };
  })
  
  .listen(3000);

console.log(`Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

// Update toggle count at midnight
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    relayToggleCountToday = 0;
  }
}, 60000); // Check every minute