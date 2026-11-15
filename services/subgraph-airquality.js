import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import gql from 'graphql-tag';
import crypto from 'node:crypto';
import { db, pubsub } from './db.js';

const typeDefs = gql`
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key", "@shareable"])
  type PollutantBreakdown @shareable { pm25: Float!, pm25WhoRatio: Float!, pm10: Float!, pm10WhoRatio: Float!, no2: Float!, o3: Float! }
  type AirQualityReading @key(fields: "id") { id: ID!, cityId: ID!, timestamp: String!, aqiUs: Int!, aqiEu: Int!, category: String!, dominantPollutant: String!, pollutantBreakdown: PollutantBreakdown!, sourceName: String! }
  type WeatherAlert @key(fields: "id") { id: ID!, cityId: ID!, eventType: String!, severity: String!, headline: String!, description: String!, instructions: String, effectiveUntil: String!, isActive: Boolean! }
  extend type City @key(fields: "id") { id: ID!, airQuality: AirQualityReading, healthSafetyScore: Int!, alerts: [WeatherAlert!]! }
  type Query { activeAlerts: [WeatherAlert!]! }
  type Mutation {
    createWeatherAlert(cityId: ID!, eventType: String!, severity: String!, headline: String!, description: String!, instructions: String): WeatherAlert!
    deleteWeatherAlert(id: ID!): Boolean!
  }
`;

const mapAQ = (a) => a ? ({ id: a.id, cityId: a.city_id, timestamp: a.timestamp, aqiUs: a.aqi_us, aqiEu: a.aqi_eu, category: a.category, dominantPollutant: a.dominant_pollutant, sourceName: a.source_name, pollutantBreakdown: { pm25: a.pm25, pm25WhoRatio: Number((a.pm25 / 15).toFixed(2)), pm10: a.pm10, pm10WhoRatio: Number((a.pm10 / 45).toFixed(2)), no2: a.no2, o3: a.o3 } }) : null;
const mapAL = (al) => al ? ({ id: al.id, cityId: al.city_id, eventType: al.event_type, severity: al.severity, headline: al.headline, description: al.description, instructions: al.instructions, effectiveUntil: al.effective_until, isActive: Boolean(al.is_active) }) : null;

const resolvers = {
  City: {
    __resolveReference: (ref) => ({ id: ref.id }),
    airQuality: (p) => mapAQ(db.prepare('SELECT * FROM air_quality_readings WHERE city_id = ? ORDER BY timestamp DESC LIMIT 1').get(p.id)),
    healthSafetyScore: (p) => {
      const a = db.prepare('SELECT aqi_us FROM air_quality_readings WHERE city_id = ? ORDER BY timestamp DESC LIMIT 1').get(p.id);
      return Math.max(10, Math.min(100, Math.round(100 - (a?.aqi_us || 30) * 0.4)));
    },
    alerts: (p) => db.prepare('SELECT * FROM weather_alerts WHERE city_id = ? AND is_active = 1').all(p.id).map(mapAL)
  },
  AirQualityReading: { __resolveReference: (ref) => mapAQ(db.prepare('SELECT * FROM air_quality_readings WHERE id = ?').get(ref.id)) },
  WeatherAlert: { __resolveReference: (ref) => mapAL(db.prepare('SELECT * FROM weather_alerts WHERE id = ?').get(ref.id)) },
  Query: {
    activeAlerts: () => db.prepare('SELECT * FROM weather_alerts WHERE is_active = 1').all().map(mapAL)
  },
  Mutation: {
    createWeatherAlert: (_, args) => {
      const id = `al-${crypto.randomUUID()}`;
      const until = new Date(Date.now() + 86400000).toISOString();
      db.prepare('INSERT INTO weather_alerts (id, city_id, event_type, severity, headline, description, instructions, effective_until, is_active) VALUES (?,?,?,?,?,?,?,?,1)').run(id, args.cityId, args.eventType, args.severity, args.headline, args.description, args.instructions || '', until);
      const alert = { id, cityId: args.cityId, eventType: args.eventType, severity: args.severity, headline: args.headline, description: args.description, instructions: args.instructions, effectiveUntil: until, isActive: true };
      pubsub.emit('ALERT', alert);
      return alert;
    },
    deleteWeatherAlert: (_, { id }) => {
      db.prepare('DELETE FROM weather_alerts WHERE id = ?').run(id);
      return true;
    }
  }
};

export async function startAirQualitySubgraph(port = 4002) {
  const server = new ApolloServer({ schema: buildSubgraphSchema([{ typeDefs, resolvers }]) });
  const { url } = await startStandaloneServer(server, { listen: { port } });
  return { server, url };
}
if (process.argv[1]?.endsWith('subgraph-airquality.js')) startAirQualitySubgraph();
