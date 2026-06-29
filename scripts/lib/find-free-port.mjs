/**
 * Find first TCP port that can be bound on host (for advisor-ui / local servers).
 */
import net from 'net';

/**
 * @param {number} startPort
 * @param {string} [host='127.0.0.1']
 * @param {number} [maxAttempts=30]
 * @returns {Promise<number>}
 */
export async function findFirstFreePort(startPort, host = '127.0.0.1', maxAttempts = 30) {
  const end = startPort + maxAttempts;
  for (let p = startPort; p < end; p++) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, host, () => {
        s.close(() => resolve(true));
      });
    });
    if (ok) return p;
  }
  throw new Error(`No free port in range ${startPort}–${end - 1} on ${host}`);
}
