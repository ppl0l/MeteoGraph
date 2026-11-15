import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import gql from 'graphql-tag';
import { db } from './db.js';

const typeDefs = gql`
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key", "@shareable", "@external", "@requires"])
  type AggregatePoint @shareable { timeBucket: String!, average: Float!, min: Float!, max: Float!, count: Int! }
  type CityComparison @shareable { cityId: ID!, currentTemp: Float, currentAqi: Int, comfortScore: Float, resilienceScore: Int }
  extend type City @key(fields: "id") { id: ID!, resilienceScore: Int!, annualMeanTemp: Float! }
  extend type WeatherReading @key(fields: "id") { id: ID!, temperature: Float! @external, anomalyScore: Float @requires(fields: "temperature") }
  type Query {
    aggregateMetrics(cityIds: [ID!], metric: String, groupBy: String): [AggregatePoint!]!
    compareCities(cityIds: [ID!]!): [CityComparison!]!
  }
`;

const resolvers = {
  City: {
    __resolveReference: (ref) => ({ id: ref.id }),
    resilienceScore: (p) => {
      const a = db.prepare('SELECT aqi_us FROM air_quality_readings WHERE city_id = ? ORDER BY timestamp DESC LIMIT 1').get(p.id);
      return Math.round(100 - (a?.aqi_us || 40) * 0.35);
    },
    annualMeanTemp: (p) => Number((db.prepare('SELECT AVG(temperature) as t FROM weather_readings WHERE city_id = ?').get(p.id)?.t || 15).toFixed(1))
  },
  WeatherReading: {
    __resolveReference: (ref) => ({ id: ref.id }),
    anomalyScore: (p) => Number(((p.temperature || 15) - 15.0).toFixed(2))
  },
  Query: {
    aggregateMetrics: (_, { cityIds, metric = 'temperature', groupBy = 'MONTH' }) => {
      const fmt = groupBy === 'DAY' ? '%Y-%m-%d' : '%Y-%m';
      const col = metric.toLowerCase() === 'humidity' ? 'humidity' : 'temperature';
      const ids = cityIds?.length ? cityIds : ['city-moscow', 'city-london', 'city-tokyo'];
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT strftime('${fmt}', timestamp) as bucket, AVG(${col}) as avgVal, MIN(${col}) as minVal, MAX(${col}) as maxVal, COUNT(*) as cnt
        FROM weather_readings WHERE city_id IN (${placeholders}) GROUP BY bucket ORDER BY bucket ASC LIMIT 30
      `).all(...ids);
      return rows.map(r => ({ timeBucket: r.bucket, average: Number(r.avgVal.toFixed(1)), min: Number(r.minVal.toFixed(1)), max: Number(r.maxVal.toFixed(1)), count: r.cnt }));
    },
    compareCities: (_, { cityIds }) => cityIds.map(id => {
      const w = db.prepare('SELECT temperature FROM weather_readings WHERE city_id = ? ORDER BY timestamp DESC LIMIT 1').get(id);
      const a = db.prepare('SELECT aqi_us FROM air_quality_readings WHERE city_id = ? ORDER BY timestamp DESC LIMIT 1').get(id);
      return { cityId: id, currentTemp: w?.temperature, currentAqi: a?.aqi_us, comfortScore: 78.5, resilienceScore: Math.round(100 - (a?.aqi_us || 40) * 0.3) };
    })
  }
};

export async function startAnalyticsSubgraph(port = 4003) {
  const server = new ApolloServer({ schema: buildSubgraphSchema([{ typeDefs, resolvers }]) });
  const { url } = await startStandaloneServer(server, { listen: { port } });
  return { server, url };
}
if (process.argv[1]?.endsWith('subgraph-analytics.js')) startAnalyticsSubgraph();
