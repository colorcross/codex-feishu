import http from 'node:http';
import type { Logger } from '../logging.js';
import { MetricsRegistry } from './metrics.js';

export async function startMetricsServer(input: {
  host: string;
  port: number;
  serviceName: string;
  logger: Logger;
  metrics: MetricsRegistry;
}): Promise<{
  close(): Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    if (!request.url) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }

    if (request.url === '/metrics') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      response.end(input.metrics.renderPrometheus());
      return;
    }

    if (request.url === '/healthz' || request.url === '/readyz') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(
        JSON.stringify({
          ok: true,
          ready: request.url === '/readyz',
          surface: 'metrics',
          service: input.serviceName,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port, input.host, () => {
      input.logger.info({ host: input.host, port: input.port }, 'Metrics server started');
      resolve();
    });
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      input.logger.info({ host: input.host, port: input.port }, 'Metrics server stopped');
    },
  };
}
