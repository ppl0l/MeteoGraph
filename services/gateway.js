import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } from '@apollo/gateway';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import depthLimit from 'graphql-depth-limit';
import rateLimit from 'express-rate-limit';
import client from 'prom-client';
import express from 'express';
import http from 'node:http';
import cors from 'cors';
import crypto from 'node:crypto';
import gql from 'graphql-tag';
import { db, pubsub } from './db.js';

export const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'meteo_' });
const reqCounter = new client.Counter({ name: 'meteo_requests_total', help: 'Total GraphQL requests', registers: [register] });

class TracedDataSource extends RemoteGraphQLDataSource {
  willSendRequest({ request, context }) {
    if (context?.traceId) request.http.headers.set('x-trace-id', context.traceId);
  }
}

const subTypeDefs = gql`
  type CityRef { id: ID!, name: String!, country: String! }
  type LiveReading { id: ID!, temperature: Float!, weather_condition: String!, timestamp: String!, city: CityRef }
  type LiveAlert { id: ID!, cityId: ID!, eventType: String!, severity: String!, headline: String! }
  type Query { _health: String }
  type Subscription { newWeatherReading: LiveReading!, weatherAlertBroadcast: LiveAlert! }
`;

const subResolvers = {
  Query: { _health: () => 'OK' },
  Subscription: {
    newWeatherReading: {
      subscribe: async function* () {
        const queue = [];
        let push = null;
        const cb = (val) => { push ? (push({ value: { newWeatherReading: val }, done: false }), push = null) : queue.push(val); };
        pubsub.on('NEW_READING', cb);
        try {
          while (true) {
            if (queue.length) yield { newWeatherReading: queue.shift() };
            else await new Promise(r => push = r);
          }
        } finally { pubsub.off('NEW_READING', cb); }
      }
    },
    weatherAlertBroadcast: {
      subscribe: async function* () {
        const queue = [];
        let push = null;
        const cb = (val) => { push ? (push({ value: { weatherAlertBroadcast: val }, done: false }), push = null) : queue.push(val); };
        pubsub.on('ALERT', cb);
        try {
          while (true) {
            if (queue.length) yield { weatherAlertBroadcast: queue.shift() };
            else await new Promise(r => push = r);
          }
        } finally { pubsub.off('ALERT', cb); }
      }
    }
  }
};

export async function startGateway(port = 4000) {
  const app = express();
  const httpServer = http.createServer(app);

  const gateway = new ApolloGateway({
    supergraphSdl: new IntrospectAndCompose({
      subgraphs: [
        { name: 'weather', url: 'http://localhost:4001/graphql' },
        { name: 'airquality', url: 'http://localhost:4002/graphql' },
        { name: 'analytics', url: 'http://localhost:4003/graphql' }
      ]
    }),
    buildService: ({ url }) => new TracedDataSource({ url })
  });

  const server = new ApolloServer({
    gateway,
    validationRules: [depthLimit(7)]
  });
  await server.start();

  app.use(cors());
  app.use(rateLimit({ windowMs: 60000, max: 150, standardHeaders: true }));
  app.use('/graphql', express.json(), expressMiddleware(server, {
    context: async ({ req, res }) => {
      reqCounter.inc();
      const traceId = req.headers['x-trace-id'] || crypto.randomUUID();
      res.setHeader('x-trace-id', traceId);
      return { traceId };
    }
  }));

  app.get('/metrics', async (_, res) => { res.setHeader('Content-Type', register.contentType); res.send(await register.metrics()); });
  app.get('/health', (_, res) => res.json({ status: 'HEALTHY', subgraphs: ['weather:4001', 'airquality:4002', 'analytics:4003'], records: db.prepare('SELECT COUNT(*) as c FROM weather_readings').get().c }));

  useServer({ schema: makeExecutableSchema({ typeDefs: subTypeDefs, resolvers: subResolvers }) }, new WebSocketServer({ server: httpServer, path: '/graphql' }));

  return new Promise(r => httpServer.listen(port, () => r(httpServer)));
}
if (process.argv[1]?.endsWith('gateway.js')) startGateway();
