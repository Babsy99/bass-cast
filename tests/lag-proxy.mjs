// Test-only TCP "bad network" proxy (stand-in for tc/netem, which this kernel lacks).
// Each direction: every chunk is held `delayMs`; with probability `loss` a chunk is treated as a lost
// segment and held an extra `rtoMs` (TCP retransmit). Order is preserved (TCP head-of-line blocking).
import net from 'node:net';

export function startLagProxy(listenPort, targetPort) {
  const cfg = { delayMs: 0, loss: 0, rtoMs: 200, lostChunks: 0, chunks: 0 };
  const pipe = (src, dst) => {
    let last = 0;
    src.on('data', (buf) => {
      cfg.chunks++;
      let t = Date.now() + cfg.delayMs;
      if (cfg.loss && Math.random() < cfg.loss) { t += cfg.rtoMs; cfg.lostChunks++; }
      last = Math.max(last, t);
      setTimeout(() => { if (!dst.destroyed) dst.write(buf); }, last - Date.now());
    });
    src.on('close', () => setTimeout(() => dst.destroy(), cfg.delayMs + 5));
    src.on('error', () => dst.destroy());
  };
  const server = net.createServer((c) => {
    const u = net.connect(targetPort, '127.0.0.1');
    pipe(c, u); pipe(u, c);
  });
  return new Promise((res) => server.listen(listenPort, '127.0.0.1', () => res({ cfg, close: () => new Promise((r) => server.close(r)) })));
}
