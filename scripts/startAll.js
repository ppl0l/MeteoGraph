import { seedDatabase, startScheduler } from '../services/db.js';
import { startWeatherSubgraph } from '../services/subgraph-weather.js';
import { startAirQualitySubgraph } from '../services/subgraph-airquality.js';
import { startAnalyticsSubgraph } from '../services/subgraph-analytics.js';
import { startGateway } from '../services/gateway.js';

async function main() {
  console.log('[MeteoGraph] Seeding database...');
  seedDatabase();
  console.log('[MeteoGraph] Launching 3 Federation Subgraphs...');
  await startWeatherSubgraph(4001);
  await startAirQualitySubgraph(4002);
  await startAnalyticsSubgraph(4003);
  await new Promise(r => setTimeout(r, 1000));
  console.log('[MeteoGraph] Launching Apollo Federation Gateway...');
  await startGateway(4000);
  startScheduler();
  console.log('>>> MeteoGraph Online! Gateway: http://localhost:4000/graphql | Health: http://localhost:4000/health | Metrics: http://localhost:4000/metrics');
}

main().catch(console.error);
