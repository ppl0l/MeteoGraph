import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

fs.mkdirSync('data', { recursive: true });
export const db = new DatabaseSync('data/meteo.db');
db.exec(`
  PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -64000;
  CREATE TABLE IF NOT EXISTS cities (id TEXT PRIMARY KEY, name TEXT, country TEXT, country_code TEXT, latitude REAL, longitude REAL, elevation REAL, population INT, climate_zone TEXT);
  CREATE TABLE IF NOT EXISTS weather_stations (id TEXT PRIMARY KEY, city_id TEXT, name TEXT, code TEXT, status TEXT, hardware_model TEXT);
  CREATE TABLE IF NOT EXISTS weather_readings (id TEXT PRIMARY KEY, city_id TEXT, station_id TEXT, timestamp TEXT, temperature REAL, feels_like REAL, humidity INT, pressure REAL, wind_speed REAL, wind_direction INT, precipitation REAL, weather_condition TEXT, source_name TEXT);
  CREATE TABLE IF NOT EXISTS air_quality_readings (id TEXT PRIMARY KEY, city_id TEXT, timestamp TEXT, aqi_us INT, aqi_eu INT, pm25 REAL, pm10 REAL, no2 REAL, o3 REAL, category TEXT, dominant_pollutant TEXT, source_name TEXT);
  CREATE TABLE IF NOT EXISTS climate_environmental_readings (id TEXT PRIMARY KEY, city_id TEXT, timestamp TEXT, solar_radiation REAL, uv_index REAL, soil_temperature REAL, baseline_temp_deviation REAL, drought_index REAL, comfort_index REAL, source_name TEXT);
  CREATE TABLE IF NOT EXISTS weather_alerts (id TEXT PRIMARY KEY, city_id TEXT, event_type TEXT, severity TEXT, headline TEXT, description TEXT, instructions TEXT, effective_until TEXT, is_active INT);
  CREATE INDEX IF NOT EXISTS idx_w_city ON weather_readings(city_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_aqi_city ON air_quality_readings(city_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_clim_city ON climate_environmental_readings(city_id, timestamp DESC);
`);

export const pubsub = new EventEmitter();
export const CITIES = [
  { id: 'city-moscow', name: 'Moscow', country: 'Russia', country_code: 'RU', latitude: 55.75, longitude: 37.61, elevation: 156, population: 13010112, climate_zone: 'CONTINENTAL' },
  { id: 'city-london', name: 'London', country: 'United Kingdom', country_code: 'GB', latitude: 51.50, longitude: -0.12, elevation: 35, population: 8982000, climate_zone: 'TEMPERATE' },
  { id: 'city-tokyo', name: 'Tokyo', country: 'Japan', country_code: 'JP', latitude: 35.67, longitude: 139.65, elevation: 40, population: 13960000, climate_zone: 'TEMPERATE' },
  { id: 'city-new-york', name: 'New York', country: 'United States', country_code: 'US', latitude: 40.71, longitude: -74.00, elevation: 10, population: 8336817, climate_zone: 'CONTINENTAL' },
  { id: 'city-dubai', name: 'Dubai', country: 'UAE', country_code: 'AE', latitude: 25.20, longitude: 55.27, elevation: 16, population: 3331420, climate_zone: 'ARID' },
  { id: 'city-singapore', name: 'Singapore', country: 'Singapore', country_code: 'SG', latitude: 1.35, longitude: 103.81, elevation: 15, population: 5686000, climate_zone: 'TROPICAL' },
  { id: 'city-cairo', name: 'Cairo', country: 'Egypt', country_code: 'EG', latitude: 30.04, longitude: 31.23, elevation: 23, population: 9540000, climate_zone: 'ARID' },
  { id: 'city-sydney', name: 'Sydney', country: 'Australia', country_code: 'AU', latitude: -33.86, longitude: 151.20, elevation: 58, population: 5312000, climate_zone: 'TEMPERATE' },
  { id: 'city-paris', name: 'Paris', country: 'France', country_code: 'FR', latitude: 48.85, longitude: 2.35, elevation: 35, population: 2161000, climate_zone: 'TEMPERATE' },
  { id: 'city-reykjavik', name: 'Reykjavik', country: 'Iceland', country_code: 'IS', latitude: 64.14, longitude: -21.94, elevation: 15, population: 131136, climate_zone: 'POLAR' }
];

export class CircuitBreaker {
  constructor(name) { this.name = name; this.state = 'CLOSED'; this.fails = 0; this.nextTry = 0; }
  async exec(fn, fallback) {
    if (this.state === 'OPEN' && Date.now() < this.nextTry) return fallback();
    try {
      const res = await fn();
      this.state = 'CLOSED'; this.fails = 0; return res;
    } catch {
      this.fails++;
      if (this.fails >= 3) { this.state = 'OPEN'; this.nextTry = Date.now() + 10000; }
      return fallback();
    }
  }
}

const wBreaker = new CircuitBreaker('weather'), aBreaker = new CircuitBreaker('aqi'), cBreaker = new CircuitBreaker('climate');

export async function fetchWeatherSource(c) {
  return wBreaker.exec(
    async () => {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.latitude}&longitude=${c.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,surface_pressure,precipitation`, { signal: AbortSignal.timeout(3000) });
      const cur = (await r.json()).current;
      return { id: `w-${crypto.randomUUID()}`, city_id: c.id, station_id: `st-${c.id}-1`, timestamp: new Date().toISOString(), temperature: Number(cur.temperature_2m.toFixed(1)), feels_like: Number(cur.apparent_temperature.toFixed(1)), humidity: Math.round(cur.relative_humidity_2m), pressure: Number(cur.surface_pressure.toFixed(1)), wind_speed: Number(cur.wind_speed_10m.toFixed(1)), wind_direction: Math.round(cur.wind_direction_10m), precipitation: Number((cur.precipitation || 0).toFixed(1)), weather_condition: cur.precipitation > 2 ? 'RAIN' : 'CLEAR', source_name: 'OPEN_METEO_API' };
    },
    () => ({ id: `w-${crypto.randomUUID()}`, city_id: c.id, station_id: `st-${c.id}-1`, timestamp: new Date().toISOString(), temperature: c.climate_zone === 'POLAR' ? -5 : (c.climate_zone === 'ARID' ? 32 : 18), feels_like: 17, humidity: 60, pressure: 1013, wind_speed: 12, wind_direction: 180, precipitation: 0, weather_condition: 'CLEAR', source_name: 'SYNTHETIC_FALLBACK' })
  );
}

export async function fetchAqiSource(c) {
  return aBreaker.exec(
    async () => {
      const r = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${c.latitude}&longitude=${c.longitude}&current=us_aqi,european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone`, { signal: AbortSignal.timeout(3000) });
      const cur = (await r.json()).current;
      const aqi = Math.round(cur.us_aqi || 40);
      return { id: `aq-${crypto.randomUUID()}`, city_id: c.id, timestamp: new Date().toISOString(), aqi_us: aqi, aqi_eu: Math.round(cur.european_aqi || 30), pm25: Number((cur.pm2_5 || 12).toFixed(1)), pm10: Number((cur.pm10 || 20).toFixed(1)), no2: Number((cur.nitrogen_dioxide || 15).toFixed(1)), o3: Number((cur.ozone || 40).toFixed(1)), category: aqi <= 50 ? 'GOOD' : (aqi <= 100 ? 'MODERATE' : 'UNHEALTHY'), dominant_pollutant: 'PM2.5', source_name: 'OPEN_METEO_CAMS' };
    },
    () => ({ id: `aq-${crypto.randomUUID()}`, city_id: c.id, timestamp: new Date().toISOString(), aqi_us: 45, aqi_eu: 35, pm25: 12, pm10: 22, no2: 18, o3: 35, category: 'GOOD', dominant_pollutant: 'PM2.5', source_name: 'SYNTHETIC_FALLBACK' })
  );
}

export async function fetchClimateSource(c) {
  return cBreaker.exec(
    async () => {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.latitude}&longitude=${c.longitude}&current=shortwave_radiation_instant,uv_index,soil_temperature_0cm`, { signal: AbortSignal.timeout(3000) });
      const cur = (await r.json()).current;
      return { id: `cl-${crypto.randomUUID()}`, city_id: c.id, timestamp: new Date().toISOString(), solar_radiation: Number((cur.shortwave_radiation_instant || 180).toFixed(1)), uv_index: Number((cur.uv_index || 3).toFixed(1)), soil_temperature: Number((cur.soil_temperature_0cm || 15).toFixed(1)), baseline_temp_deviation: Number(((Math.random() - 0.4) * 2.5).toFixed(2)), drought_index: c.climate_zone === 'ARID' ? 80 : 25, comfort_index: 78, source_name: 'SOLAR_MARINE_GRID' };
    },
    () => ({ id: `cl-${crypto.randomUUID()}`, city_id: c.id, timestamp: new Date().toISOString(), solar_radiation: 220, uv_index: 4, soil_temperature: 16, baseline_temp_deviation: 0.8, drought_index: 30, comfort_index: 75, source_name: 'SYNTHETIC_FALLBACK' })
  );
}

export function seedDatabase() {
  const existing = db.prepare('SELECT COUNT(*) as c FROM weather_readings').get().c;
  if (existing >= 10000) return;
  const cIns = db.prepare('INSERT OR REPLACE INTO cities (id, name, country, country_code, latitude, longitude, elevation, population, climate_zone) VALUES (?,?,?,?,?,?,?,?,?)');
  const sIns = db.prepare('INSERT OR REPLACE INTO weather_stations (id, city_id, name, code, status, hardware_model) VALUES (?,?,?,?,?,?)');
  const wIns = db.prepare('INSERT INTO weather_readings (id, city_id, station_id, timestamp, temperature, feels_like, humidity, pressure, wind_speed, wind_direction, precipitation, weather_condition, source_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const aIns = db.prepare('INSERT INTO air_quality_readings (id, city_id, timestamp, aqi_us, aqi_eu, pm25, pm10, no2, o3, category, dominant_pollutant, source_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const clIns = db.prepare('INSERT INTO climate_environmental_readings (id, city_id, timestamp, solar_radiation, uv_index, soil_temperature, baseline_temp_deviation, drought_index, comfort_index, source_name) VALUES (?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN TRANSACTION;');
  for (const c of CITIES) {
    cIns.run(c.id, c.name, c.country, c.country_code, c.latitude, c.longitude, c.elevation, c.population, c.climate_zone);
    sIns.run(`st-${c.id}-1`, c.id, `${c.name} Central Met`, `MET-${c.country_code}-01`, 'ACTIVE', 'Vaisala AWS310');
    sIns.run(`st-${c.id}-2`, c.id, `${c.name} Airport Met`, `MET-${c.country_code}-02`, 'ACTIVE', 'Campbell Sci MetArray');
    for (let day = 120; day >= 0; day--) {
      for (let h = 0; h < 24; h += 2) {
        const iso = new Date(Date.now() - (day * 86400000) + (h * 3600000)).toISOString();
        const base = c.climate_zone === 'POLAR' ? -2 : (c.climate_zone === 'ARID' ? 30 : 16);
        const temp = Number((base + Math.sin(day * 0.1) * 8 + Math.sin(h * 0.25) * 4).toFixed(1));
        const aqi = Math.round(c.climate_zone === 'ARID' ? 85 : 35 + Math.random() * 20);
        wIns.run(`w-${c.id}-${day}-${h}`, c.id, `st-${c.id}-1`, iso, temp, temp - 1, 55, 1012, 14, 180, h === 12 ? 1.2 : 0, h === 12 ? 'RAIN' : 'CLEAR', 'ARCHIVE_SEED');
        aIns.run(`a-${c.id}-${day}-${h}`, c.id, iso, aqi, Math.round(aqi * 0.8), aqi * 0.3, aqi * 0.6, 18, 35, aqi <= 50 ? 'GOOD' : 'MODERATE', 'PM2.5', 'CAMS_SEED');
        clIns.run(`c-${c.id}-${day}-${h}`, c.id, iso, (h >= 6 && h <= 18) ? 450 : 0, (h >= 6 && h <= 18) ? 5 : 0, temp - 1, Number((Math.sin(day) * 2).toFixed(2)), 30, 80, 'GRID_SEED');
      }
    }
  }
  const alIns = db.prepare('INSERT OR REPLACE INTO weather_alerts (id, city_id, event_type, severity, headline, description, instructions, effective_until, is_active) VALUES (?,?,?,?,?,?,?,?,?)');
  alIns.run('al-1', 'city-dubai', 'EXTREME_HEAT', 'SEVERE', 'Excessive Heat Advisory', 'Temperatures exceeding 45C', 'Stay hydrated', new Date(Date.now() + 86400000).toISOString(), 1);
  alIns.run('al-2', 'city-london', 'GALE_WARNING', 'WARNING', 'High Wind Advisory', 'Gusts up to 60 mph', 'Secure outdoor items', new Date(Date.now() + 86400000).toISOString(), 1);
  db.exec('COMMIT;');
}

export function startScheduler() {
  const run = async () => {
    for (const c of CITIES.slice(0, 2)) {
      const [w, a, cl] = await Promise.all([fetchWeatherSource(c), fetchAqiSource(c), fetchClimateSource(c)]);
      db.prepare('INSERT INTO weather_readings (id, city_id, station_id, timestamp, temperature, feels_like, humidity, pressure, wind_speed, wind_direction, precipitation, weather_condition, source_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(w.id, w.city_id, w.station_id, w.timestamp, w.temperature, w.feels_like, w.humidity, w.pressure, w.wind_speed, w.wind_direction, w.precipitation, w.weather_condition, w.source_name);
      db.prepare('INSERT INTO air_quality_readings (id, city_id, timestamp, aqi_us, aqi_eu, pm25, pm10, no2, o3, category, dominant_pollutant, source_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(a.id, a.city_id, a.timestamp, a.aqi_us, a.aqi_eu, a.pm25, a.pm10, a.no2, a.o3, a.category, a.dominant_pollutant, a.source_name);
      db.prepare('INSERT INTO climate_environmental_readings (id, city_id, timestamp, solar_radiation, uv_index, soil_temperature, baseline_temp_deviation, drought_index, comfort_index, source_name) VALUES (?,?,?,?,?,?,?,?,?,?)').run(cl.id, cl.city_id, cl.timestamp, cl.solar_radiation, cl.uv_index, cl.soil_temperature, cl.baseline_temp_deviation, cl.drought_index, cl.comfort_index, cl.source_name);
      pubsub.emit('NEW_READING', { ...w, city: c });
    }
  };
  setTimeout(run, 1000);
  setInterval(run, 15000);
}
