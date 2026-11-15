import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import gql from 'graphql-tag';
import { db, fetchWeatherSource, pubsub } from './db.js';

const typeDefs = gql`
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key", "@shareable"])
  type WindDetails @shareable { speedKmh: Float!, cardinalDirection: String!, beaufortScale: Int!, beaufortDescription: String! }
  type ForecastDay @shareable { date: String!, minTemp: Float!, maxTemp: Float!, condition: String! }
  type WeatherStation @shareable { id: ID!, name: String!, code: String!, status: String!, hardwareModel: String! }
  type WeatherReading @key(fields: "id") { id: ID!, cityId: ID!, timestamp: String!, temperature: Float!, feelsLike: Float, humidity: Int!, pressure: Float!, windSpeed: Float!, windDirection: Int!, precipitation: Float!, weatherCondition: String!, windDetails: WindDetails!, sourceName: String! }
  type City @key(fields: "id") {
    id: ID!, name: String!, country: String!, countryCode: String!, latitude: Float!, longitude: Float!, elevation: Float, population: Int, climateZone: String!
    stations: [WeatherStation!]!, currentWeather: WeatherReading, forecast(days: Int): [ForecastDay!]!
  }
  type CityEdge { cursor: String!, node: City! }
  type CityConnection { edges: [CityEdge!]!, totalCount: Int! }
  type Query {
    cities(search: String, climateZone: String, page: Int, limit: Int, sortBy: String, sortDir: String): CityConnection!
    city(id: ID!): City
    weatherStats: WeatherStats!
  }
  type WeatherStats @shareable { totalCities: Int!, totalReadings: Int!, avgGlobalTemp: Float! }
  type Mutation {
    ingestCityWeather(cityId: ID!): WeatherReading!
    updateStationStatus(stationId: ID!, status: String!): WeatherStation!
  }
`;

function getWind(speed, deg) {
  const cards = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const bScale = speed < 5 ? 1 : (speed < 20 ? 3 : (speed < 40 ? 5 : 7));
  return { speedKmh: speed, cardinalDirection: cards[Math.round(deg / 45) % 8], beaufortScale: bScale, beaufortDescription: bScale <= 2 ? 'Light Breeze' : (bScale <= 5 ? 'Fresh Breeze' : 'Near Gale') };
}

const mapR = (r) => r ? ({ id: r.id, cityId: r.city_id, timestamp: r.timestamp, temperature: r.temperature, feelsLike: r.feels_like, humidity: r.humidity, pressure: r.pressure, windSpeed: r.wind_speed, windDirection: r.wind_direction, precipitation: r.precipitation, weatherCondition: r.weather_condition, sourceName: r.source_name, windDetails: getWind(r.wind_speed, r.wind_direction) }) : null;
const mapC = (c) => ({ id: c.id, name: c.name, country: c.country, countryCode: c.country_code, latitude: c.latitude, longitude: c.longitude, elevation: c.elevation, population: c.population, climateZone: c.climate_zone });

const resolvers = {
  City: {
    __resolveReference: (ref) => mapC(db.prepare('SELECT * FROM cities WHERE id = ?').get(ref.id)),
    stations: (p) => db.prepare('SELECT * FROM weather_stations WHERE city_id = ?').all(p.id).map(s => ({ id: s.id, name: s.name, code: s.code, status: s.status, hardwareModel: s.hardware_model })),
    currentWeather: (p) => mapR(db.prepare('SELECT * FROM weather_readings WHERE city_id = ? ORDER BY timestamp DESC LIMIT 1').get(p.id)),
    forecast: (p, { days = 7 }) => Array.from({ length: Math.min(days, 14) }).map((_, i) => ({
      date: new Date(Date.now() + i * 86400000).toISOString().split('T')[0],
      minTemp: p.climateZone === 'POLAR' ? -8 : 12 + i % 3,
      maxTemp: p.climateZone === 'POLAR' ? 0 : 22 + i % 4,
      condition: i % 3 === 0 ? 'RAIN' : 'CLEAR'
    }))
  },
  WeatherReading: { __resolveReference: (ref) => mapR(db.prepare('SELECT * FROM weather_readings WHERE id = ?').get(ref.id)) },
  Query: {
    cities: (_, { search, climateZone, page = 1, limit = 10, sortBy = 'name', sortDir = 'ASC' }) => {
      let q = 'SELECT * FROM cities WHERE 1=1', params = [];
      if (search) { q += ' AND (name LIKE ? OR country LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
      if (climateZone) { q += ' AND climate_zone = ?'; params.push(climateZone); }
      const total = db.prepare(q.replace('*', 'COUNT(*) as c')).get(...params).c;
      const validCols = ['name', 'country', 'population', 'elevation'];
      const col = validCols.includes(sortBy) ? sortBy : 'name';
      const rows = db.prepare(`${q} ORDER BY ${col} ${sortDir === 'DESC' ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
      return { edges: rows.map(r => ({ cursor: Buffer.from(r.id).toString('base64'), node: mapC(r) })), totalCount: total };
    },
    city: (_, { id }) => mapC(db.prepare('SELECT * FROM cities WHERE id = ?').get(id)),
    weatherStats: () => ({
      totalCities: db.prepare('SELECT COUNT(*) as c FROM cities').get().c,
      totalReadings: db.prepare('SELECT COUNT(*) as c FROM weather_readings').get().c,
      avgGlobalTemp: Number(db.prepare('SELECT AVG(temperature) as a FROM weather_readings').get().a.toFixed(1))
    })
  },
  Mutation: {
    ingestCityWeather: async (_, { cityId }) => {
      const c = db.prepare('SELECT * FROM cities WHERE id = ?').get(cityId);
      const w = await fetchWeatherSource(c);
      db.prepare('INSERT INTO weather_readings (id, city_id, station_id, timestamp, temperature, feels_like, humidity, pressure, wind_speed, wind_direction, precipitation, weather_condition, source_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(w.id, w.city_id, w.station_id, w.timestamp, w.temperature, w.feels_like, w.humidity, w.pressure, w.wind_speed, w.wind_direction, w.precipitation, w.weather_condition, w.source_name);
      pubsub.emit('NEW_READING', { ...w, city: c });
      return mapR(w);
    },
    updateStationStatus: (_, { stationId, status }) => {
      db.prepare('UPDATE weather_stations SET status = ? WHERE id = ?').run(status, stationId);
      const s = db.prepare('SELECT * FROM weather_stations WHERE id = ?').get(stationId);
      return { id: s.id, name: s.name, code: s.code, status: s.status, hardwareModel: s.hardware_model };
    }
  }
};

export async function startWeatherSubgraph(port = 4001) {
  const server = new ApolloServer({ schema: buildSubgraphSchema([{ typeDefs, resolvers }]) });
  const { url } = await startStandaloneServer(server, { listen: { port } });
  return { server, url };
}
if (process.argv[1]?.endsWith('subgraph-weather.js')) startWeatherSubgraph();
