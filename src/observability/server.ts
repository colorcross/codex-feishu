import http from 'node:http';
import type { Logger } from '../logging.js';
import { MetricsRegistry } from './metrics.js';
import type { ServiceReadinessProbe } from './readiness.js';

export async function startMetricsServer(input: {
  host: string;
  port: number;
  serviceName: string;
  logger: Logger;
  metrics: MetricsRegistry;
  readiness?: ServiceReadinessProbe;
}): Promise<{
  address: {
    host: string;
    port: number;
  };
  close(): Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    if (!request.url) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }

    if (request.url === '/metrics') {
      if (input.readiness) {
        input.metrics.recordReadiness(input.readiness.snapshot());
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      response.end(input.metrics.renderPrometheus());
      return;
    }

    if (request.url === '/healthz' || request.url === '/readyz') {
      const readiness = input.readiness?.snapshot() ?? {
        ok: true,
        ready: true,
        service: input.serviceName,
        stage: 'ready',
        startupWarnings: 0,
        startupErrors: 0,
        timestamp: new Date().toISOString(),
      };
      response.statusCode = request.url === '/readyz' ? (readiness.ready ? 200 : 503) : (readiness.ok ? 200 : 503);
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(
        JSON.stringify({
          ...readiness,
          surface: 'metrics',
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
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : input.port;
      input.logger.info({ host: input.host, port }, 'Metrics server started');
      resolve();
    });
  });

  const address = server.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : input.port;

  return {
    address: {
      host: input.host,
      port: resolvedPort,
    },
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
