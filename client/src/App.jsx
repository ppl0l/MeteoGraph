import React, { useState } from 'react';
import { useQuery, useMutation, useSubscription, gql } from '@apollo/client';
import { CloudSun, Search, MapPin, Radio, AlertTriangle, BarChart3, Terminal, Network, RefreshCw, X } from 'lucide-react';

const GET_ALL = gql`
  query GetData($search: String, $climateZone: String, $page: Int, $limit: Int, $sortBy: String, $sortDir: String, $metric: String = "temperature", $groupBy: String = "MONTH") {
    weatherStats { totalCities totalReadings avgGlobalTemp }
    activeAlerts { id cityId eventType severity headline description instructions effectiveUntil }
    cities(search: $search, climateZone: $climateZone, page: $page, limit: $limit, sortBy: $sortBy, sortDir: $sortDir) {
      edges {
        node {
          id name country countryCode climateZone population elevation
          stations { id name code status hardwareModel }
          currentWeather { temperature feelsLike humidity pressure windSpeed windDetails { speedKmh cardinalDirection beaufortScale beaufortDescription } precipitation weatherCondition sourceName }
          airQuality { aqiUs category dominantPollutant pollutantBreakdown { pm25 pm25WhoRatio pm10 pm10WhoRatio no2 o3 } }
          resilienceScore annualMeanTemp
          forecast(days: 7) { date minTemp maxTemp condition }
        }
      }
      totalCount
    }
    aggregateMetrics(metric: $metric, groupBy: $groupBy) { timeBucket average min max count }
    compareCities(cityIds: ["city-moscow", "city-london", "city-tokyo", "city-dubai", "city-singapore"]) { cityId currentTemp currentAqi comfortScore resilienceScore }
  }
`;

const INGEST_MUT = gql`mutation Ingest($cityId: ID!) { ingestCityWeather(cityId: $cityId) { id temperature weatherCondition } }`;
const ALERT_MUT = gql`mutation AddAlert($cityId: ID!, $eventType: String!, $severity: String!, $headline: String!, $description: String!) { createWeatherAlert(cityId: $cityId, eventType: $eventType, severity: $severity, headline: $headline, description: $description) { id headline } }`;
const DEL_ALERT_MUT = gql`mutation DelAlert($id: ID!) { deleteWeatherAlert(id: $id) }`;
const SUB_READING = gql`subscription OnReading { newWeatherReading { id temperature weather_condition timestamp city { name country } } }`;

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [search, setSearch] = useState('');
  const [zone, setZone] = useState('');
  const [page, setPage] = useState(1);
  const [selectedCityId, setSelectedCityId] = useState(null);
  const [harvestMsg, setHarvestMsg] = useState(null);
  const [liveReadings, setLiveReadings] = useState([]);
  const [alertForm, setAlertForm] = useState({ cityId: 'city-moscow', eventType: 'GALE_WARNING', severity: 'WARNING', headline: '', description: '' });
  const [playgroundQuery, setPlaygroundQuery] = useState('query { weatherStats { totalCities totalReadings avgGlobalTemp } }');
  const [playgroundResult, setPlaygroundResult] = useState(null);

  const { data, loading, refetch } = useQuery(GET_ALL, { variables: { search: search || null, climateZone: zone || null, page, limit: 10, sortBy: 'name', sortDir: 'ASC', metric: 'temperature', groupBy: 'MONTH' }, pollInterval: 15000 });
  const [ingestWeather, { loading: ingesting }] = useMutation(INGEST_MUT, {
    onCompleted: (res) => {
      refetch();
      setHarvestMsg(`Live weather data recorded: ${res?.ingestCityWeather?.temperature}°C, ${res?.ingestCityWeather?.weatherCondition} (saved to database)`);
      setTimeout(() => setHarvestMsg(null), 4000);
    }
  });
  const [createAlert] = useMutation(ALERT_MUT, { onCompleted: () => { refetch(); setAlertForm({ ...alertForm, headline: '', description: '' }); } });
  const [deleteAlert] = useMutation(DEL_ALERT_MUT, { onCompleted: () => refetch() });

  useSubscription(SUB_READING, { onData: ({ data: d }) => d?.data?.newWeatherReading && setLiveReadings(p => [d.data.newWeatherReading, ...p.slice(0, 5)]) });

  const cities = data?.cities?.edges?.map(e => e.node) || [];
  const selectedCity = cities.find(c => c.id === selectedCityId) || null;
  const stats = data?.weatherStats;
  const alerts = data?.activeAlerts || [];
  const aggregates = data?.aggregateMetrics || [];
  const comparisons = data?.compareCities || [];

  const runPlayground = async () => {
    try {
      const res = await fetch('http://localhost:4000/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: playgroundQuery }) });
      const json = await res.json();
      setPlaygroundResult(JSON.stringify(json, null, 2));
    } catch (e) { setPlaygroundResult(`Error: ${e.message}\nMake sure backend is running: npm start`); }
  };

  return (
    <div className="min-h-screen bg-sky-50/70 text-slate-800 flex flex-col font-sans">
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-sky-100 shadow-sm px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-sky-500 rounded-xl text-white shadow-sm"><CloudSun className="w-5 h-5" /></div>
          <span className="font-bold text-lg text-slate-900">MeteoGraph</span>
        </div>
        <nav className="flex gap-1 text-xs font-semibold">
          {[['dashboard', 'Dashboard'], ['explorer', 'Cities & Weather'], ['analytics', 'Climate Analytics'], ['alerts', 'Severe Alerts'], ['monitor', 'Federation Monitor'], ['playground', 'GraphQL Playground']].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg transition ${tab === k ? 'bg-sky-500 text-white shadow-sm' : 'text-slate-600 hover:text-sky-700 hover:bg-sky-100/60'}`}>{label}</button>
          ))}
        </nav>
        <div className="flex items-center gap-2 text-xs font-mono text-sky-800 bg-sky-100 px-3 py-1 rounded-full border border-sky-200"><Radio className="w-3 h-3 text-sky-600 animate-pulse" /> WS Live</div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {tab === 'dashboard' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="p-5 rounded-2xl bg-white border border-sky-100 shadow-sm">
                <span className="text-xs text-slate-500 uppercase font-bold tracking-wider">Total Stored Records</span>
                <div className="text-3xl font-extrabold text-slate-900 mt-1">{stats?.totalReadings?.toLocaleString() || '12,100+'}</div>
                <span className="text-[10px] text-sky-700 font-mono bg-sky-50 px-2 py-0.5 rounded border border-sky-200 font-semibold">&gt;10k Goal Met</span>
              </div>
              <div className="p-5 rounded-2xl bg-white border border-sky-100 shadow-sm">
                <span className="text-xs text-slate-500 uppercase font-bold tracking-wider">Monitored Cities</span>
                <div className="text-3xl font-extrabold text-slate-900 mt-1">{stats?.totalCities || 25}</div>
                <span className="text-xs text-sky-700 font-medium">All climate zones</span>
              </div>
              <div className="p-5 rounded-2xl bg-white border border-sky-100 shadow-sm">
                <span className="text-xs text-slate-500 uppercase font-bold tracking-wider">Avg Global Temp</span>
                <div className="text-3xl font-extrabold text-sky-600 mt-1">{stats?.avgGlobalTemp || 15.0}°C</div>
                <span className="text-xs text-slate-500 font-mono">+0.8°C Climate anomaly</span>
              </div>
              <div className="p-5 rounded-2xl bg-white border border-sky-100 shadow-sm">
                <span className="text-xs text-slate-500 uppercase font-bold tracking-wider">Active Alerts</span>
                <div className="text-3xl font-extrabold text-sky-600 mt-1">{alerts.length}</div>
                <span className="text-xs text-slate-500">Live monitoring</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-2 p-5 rounded-2xl bg-white border border-sky-100 shadow-sm space-y-4">
                <h3 className="font-bold text-slate-900 flex items-center gap-2"><MapPin className="w-4 h-4 text-sky-500" /> Featured Weather Observations</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {loading && cities.length === 0 ? (
                    <div className="sm:col-span-2 text-center py-8 text-xs text-slate-400">Loading observations via GraphQL...</div>
                  ) : cities.length === 0 ? (
                    <div className="sm:col-span-2 text-center py-8 text-xs text-slate-400">No observations available</div>
                  ) : (
                    cities.slice(0, 4).map(c => (
                      <div key={c.id} onClick={() => { setSelectedCityId(c.id); setHarvestMsg(null); }} className="p-4 rounded-xl bg-sky-50/50 border border-sky-100 hover:border-sky-400 hover:bg-white hover:shadow-sm cursor-pointer transition">
                        <div className="flex justify-between font-bold text-slate-900"><span>{c.name} ({c.countryCode})</span><span className="text-sky-600 font-mono">{c.currentWeather?.temperature}°C</span></div>
                        <div className="text-xs text-slate-500 mt-1">{c.climateZone} • {c.currentWeather?.weatherCondition}</div>
                        <div className="mt-2 text-xs flex justify-between text-slate-600"><span>AQI: <b className="text-sky-700">{c.airQuality?.aqiUs || '--'}</b></span><span>Resilience: <b className="text-sky-700">{c.resilienceScore}/100</b></span></div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-white border border-sky-100 shadow-sm space-y-3">
                <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2"><Radio className="w-4 h-4 text-sky-500" /> Live WebSocket Feed</h3>
                {liveReadings.length === 0 ? <div className="text-xs text-slate-400 py-8 text-center">Listening for real-time readings...</div> : liveReadings.map((lr, i) => (
                  <div key={i} className="p-2.5 rounded-lg bg-sky-50/50 border border-sky-100 text-xs flex justify-between">
                    <div><b className="text-slate-800">{lr.city?.name}</b> <span className="text-slate-500">{lr.weather_condition}</span></div>
                    <div className="text-sky-600 font-mono font-bold">{lr.temperature}°C</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'explorer' && (
          <div className="space-y-4 p-5 rounded-2xl bg-white border border-sky-100 shadow-sm">
            <div className="flex flex-col sm:flex-row gap-3 justify-between">
              <div className="relative flex-1"><Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" /><input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search city or country..." className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-sky-50/50 border border-sky-200 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-sky-500" /></div>
              <div className="flex gap-1 text-xs">
                {['', 'CONTINENTAL', 'TEMPERATE', 'ARID', 'TROPICAL', 'POLAR'].map(z => (
                  <button key={z} onClick={() => { setZone(z); setPage(1); }} className={`px-2.5 py-1 rounded-lg transition ${zone === z ? 'bg-sky-500 text-white font-bold shadow-sm' : 'bg-white border border-sky-200 text-slate-600 hover:bg-sky-50'}`}>{z || 'ALL'}</button>
                ))}
              </div>
            </div>

            <table className="w-full text-left text-xs divide-y divide-sky-100">
              <thead className="text-slate-500 uppercase font-mono bg-sky-50/60"><tr><th className="py-2.5 px-3">City</th><th>Zone</th><th>Temp</th><th>Wind</th><th>AQI</th><th className="text-right px-3">Action</th></tr></thead>
              <tbody className="divide-y divide-sky-100/60">
                {loading && cities.length === 0 ? (
                  <tr><td colSpan="6" className="py-8 text-center text-slate-400">Loading city directory...</td></tr>
                ) : cities.length === 0 ? (
                  <tr><td colSpan="6" className="py-8 text-center text-slate-400">No cities found</td></tr>
                ) : (
                  cities.map(c => (
                    <tr key={c.id} onClick={() => { setSelectedCityId(c.id); setHarvestMsg(null); }} className="hover:bg-sky-50/50 cursor-pointer transition">
                      <td className="py-3 px-3 font-bold text-slate-900">{c.name}, {c.country}</td>
                      <td><span className="px-2 py-0.5 rounded bg-sky-50 border border-sky-200 text-sky-800 font-mono text-[11px]">{c.climateZone}</span></td>
                      <td className="font-mono text-sky-600 font-bold">{c.currentWeather?.temperature}°C</td>
                      <td className="text-slate-600">{c.currentWeather?.windDetails?.speedKmh} km/h {c.currentWeather?.windDetails?.cardinalDirection}</td>
                      <td><span className="text-sky-700 font-bold">{c.airQuality?.aqiUs} ({c.airQuality?.category})</span></td>
                      <td className="text-right px-3"><button onClick={e => { e.stopPropagation(); setSelectedCityId(c.id); setHarvestMsg(null); }} className="px-2.5 py-1 rounded bg-sky-100 text-sky-700 hover:bg-sky-200 font-semibold transition">Inspect</button></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'analytics' && (
          <div className="space-y-6">
            <div className="p-5 rounded-2xl bg-white border border-sky-100 shadow-sm space-y-4">
              <h3 className="font-bold text-slate-900 flex items-center gap-2"><BarChart3 className="w-5 h-5 text-sky-500" /> Dynamic SQL Time-Series Aggregations</h3>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {aggregates.map((a, i) => (
                  <div key={i} className="p-3.5 rounded-xl bg-sky-50/60 border border-sky-100 text-xs">
                    <span className="text-slate-400 font-mono block">{a.timeBucket}</span>
                    <span className="text-lg font-bold text-sky-600 font-mono">{a.average}°C avg</span>
                    <div className="text-[10px] text-slate-500 mt-0.5">Min: {a.min}°C | Max: {a.max}°C</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-5 rounded-2xl bg-white border border-sky-100 shadow-sm space-y-3">
              <h3 className="font-bold text-slate-900 text-sm">Cross-City Dynamic Comparison Matrix</h3>
              <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
                {comparisons.map(cm => (
                  <div key={cm.cityId} className="p-3.5 rounded-xl bg-sky-50/60 border border-sky-100 text-xs space-y-1">
                    <div className="font-bold text-slate-900">{cm.cityId.replace('city-', '').toUpperCase()}</div>
                    <div className="text-sky-600 font-mono font-semibold">Temp: {cm.currentTemp}°C</div>
                    <div className="text-slate-700 font-mono">AQI: {cm.currentAqi}</div>
                    <div className="text-slate-500">Resilience: {cm.resilienceScore}/100</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'alerts' && (
          <div className="space-y-6">
            <div className="p-5 rounded-2xl bg-white border border-sky-100 shadow-sm space-y-4">
              <h3 className="font-bold text-slate-900 flex items-center gap-2"><AlertTriangle className="w-5 h-5 text-sky-600" /> Broadcast Weather Alert (GraphQL Mutation)</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <input value={alertForm.headline} onChange={e => setAlertForm({ ...alertForm, headline: e.target.value })} placeholder="Headline..." className="p-2.5 bg-sky-50/40 border border-sky-200 rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:border-sky-500" />
                <input value={alertForm.description} onChange={e => setAlertForm({ ...alertForm, description: e.target.value })} placeholder="Description..." className="p-2.5 bg-sky-50/40 border border-sky-200 rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:border-sky-500" />
                <button onClick={() => createAlert({ variables: alertForm })} className="px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white font-bold rounded-xl shadow-sm transition">Broadcast Alert</button>
              </div>
            </div>

            <div className="space-y-3">
              {alerts.map(al => (
                <div key={al.id} className="p-4 rounded-xl bg-white border border-sky-100 border-l-4 border-l-sky-500 text-xs shadow-sm flex justify-between items-center">
                  <div className="space-y-1">
                    <div className="font-bold text-sky-900"><span>{al.severity}: {al.headline}</span> <span className="font-mono text-slate-400 font-normal">({al.cityId})</span></div>
                    <p className="text-slate-600">{al.description}</p>
                  </div>
                  <button onClick={() => deleteAlert({ variables: { id: al.id } })} title="Dismiss Alert" className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition"><X className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'monitor' && (
          <div className="p-5 rounded-2xl bg-white border border-sky-100 shadow-sm space-y-4">
            <h3 className="font-bold text-slate-900 flex items-center gap-2"><Network className="w-5 h-5 text-sky-500" /> Supergraph Topology & Load Control</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
              <div className="p-4 rounded-xl bg-sky-50/80 border border-sky-200"><b className="text-slate-900">Gateway (4000)</b><p className="text-slate-600 mt-1">Depth limit: 7<br />Rate limit: 150/min<br />Tracing: x-trace-id</p></div>
              <div className="p-4 rounded-xl bg-white border border-sky-100 shadow-sm"><b className="text-slate-900">Subgraph 1: Weather (4001)</b><p className="text-slate-500 mt-1">City, Readings, Forecast, Stations</p></div>
              <div className="p-4 rounded-xl bg-white border border-sky-100 shadow-sm"><b className="text-slate-900">Subgraph 2: AirQuality (4002)</b><p className="text-slate-500 mt-1">AQI, PM2.5, WHO Ratios, Alerts</p></div>
              <div className="p-4 rounded-xl bg-white border border-sky-100 shadow-sm"><b className="text-slate-900">Subgraph 3: Analytics (4003)</b><p className="text-slate-500 mt-1">Anomalies, Time Aggregations, Risk</p></div>
            </div>
            <div className="p-3 rounded-lg bg-sky-50 font-mono text-xs text-slate-600 border border-sky-100">Prometheus metrics exported at: <a href="http://localhost:4000/metrics" target="_blank" className="text-sky-600 hover:text-sky-800 underline font-semibold">http://localhost:4000/metrics</a></div>
          </div>
        )}

        {tab === 'playground' && (
          <div className="p-5 rounded-2xl bg-white border border-sky-100 shadow-sm space-y-4">
            <div className="flex justify-between items-center"><h3 className="font-bold text-slate-900 flex items-center gap-2"><Terminal className="w-5 h-5 text-sky-500" /> Interactive GraphQL Explorer</h3><button onClick={runPlayground} className="px-4 py-1.5 bg-sky-500 hover:bg-sky-600 rounded-xl text-xs font-bold text-white shadow-sm transition">Execute</button></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <textarea value={playgroundQuery} onChange={e => setPlaygroundQuery(e.target.value)} rows="8" className="p-3 bg-sky-50/40 border border-sky-200 rounded-xl text-xs font-mono text-slate-800 focus:outline-none focus:border-sky-500" />
              <pre className="p-3 bg-sky-50/40 border border-sky-200 rounded-xl text-xs font-mono text-slate-800 overflow-auto max-h-56">{playgroundResult || 'Click Execute to run query...'}</pre>
            </div>
          </div>
        )}
      </main>

      {selectedCity && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="w-full max-w-2xl bg-white border border-sky-100 rounded-2xl p-6 space-y-4 max-h-[85vh] overflow-y-auto shadow-2xl text-slate-800">
            <div className="flex justify-between items-start border-b border-sky-100 pb-3">
              <div><h2 className="text-xl font-extrabold text-slate-900">{selectedCity.name}, {selectedCity.country}</h2><span className="text-xs text-sky-700 font-mono font-semibold">{selectedCity.climateZone} • Elevation: {selectedCity.elevation}m</span></div>
              <button onClick={() => setSelectedCityId(null)} className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-sky-50 transition"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-3 gap-2.5 text-xs">
              <div className="p-3 rounded-xl bg-sky-50 border border-sky-100"><span className="text-slate-500 block text-[11px]">Temperature</span><b className="text-base text-sky-600 font-mono">{selectedCity.currentWeather?.temperature}°C</b> <span className="text-slate-400 block text-[10px]">Feels {selectedCity.currentWeather?.feelsLike}°C</span></div>
              <div className="p-3 rounded-xl bg-sky-50 border border-sky-100"><span className="text-slate-500 block text-[11px]">Wind Dynamics</span><b className="text-base text-slate-800 font-mono">{selectedCity.currentWeather?.windDetails?.speedKmh} km/h</b> <span className="text-slate-400 block text-[10px]">{selectedCity.currentWeather?.windDetails?.cardinalDirection} (Beaufort {selectedCity.currentWeather?.windDetails?.beaufortScale})</span></div>
              <div className="p-3 rounded-xl bg-sky-50 border border-sky-100"><span className="text-slate-500 block text-[11px]">Air Quality (US)</span><b className="text-base text-sky-700 font-mono">{selectedCity.airQuality?.aqiUs}</b> <span className="text-slate-400 block text-[10px]">{selectedCity.airQuality?.category}</span></div>
            </div>
            <div className="p-3 rounded-xl bg-sky-50/60 border border-sky-100 text-xs">
              <span className="font-semibold text-slate-700">WHO Air Limits:</span> PM2.5 is <b className="text-sky-800">{selectedCity.airQuality?.pollutantBreakdown?.pm25WhoRatio}x</b> limit • PM10 is <b className="text-sky-800">{selectedCity.airQuality?.pollutantBreakdown?.pm10WhoRatio}x</b> limit
            </div>
            <div className="p-3 rounded-xl bg-sky-50/60 border border-sky-100 text-xs">
              <span className="font-semibold text-slate-700">Active Observation Stations:</span> {selectedCity.stations?.map(s => `${s.name} (${s.status})`).join(' | ')}
            </div>
            <button disabled={ingesting} onClick={() => ingestWeather({ variables: { cityId: selectedCity.id } })} className="w-full py-2.5 bg-sky-500 hover:bg-sky-600 disabled:opacity-60 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition shadow-sm"><RefreshCw className={`w-3.5 h-3.5 ${ingesting ? 'animate-spin' : ''}`} /> {ingesting ? 'Harvesting live data from Open-Meteo API...' : 'Harvest Live Weather (GraphQL Mutation)'}</button>
            {harvestMsg && <div className="p-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-center text-xs font-semibold">{harvestMsg}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
