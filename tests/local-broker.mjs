// Test-only MQTT-over-WebSocket broker on 127.0.0.1:9001 (the public WSS brokers on :8084/:8081 are not
// reachable from the test box's egress). Same MQTT 3.1.1 protocol as the public brokers.
import { createRequire } from 'module';
import http from 'http';
const require = createRequire('/tmp/pw/');
const { createBroker } = require('aedes');
const { WebSocketServer, createWebSocketStream } = require('ws');

export async function startBroker(port = 9001) {
  const aedes = await createBroker();
  const server = http.createServer();
  const wss = new WebSocketServer({ server, handleProtocols: (ps) => (ps.has('mqtt') ? 'mqtt' : false) });
  wss.on('connection', (ws) => aedes.handle(createWebSocketStream(ws)));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `ws://127.0.0.1:${port}`, close: () => new Promise((r) => { wss.close(); server.close(() => aedes.close(r)); }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const b = await startBroker();
  console.log('broker on', b.url);
}
