import type { DoctorFinding } from '../config/doctor.js';

export type ServiceReadinessStage = 'starting' | 'ready' | 'degraded' | 'stopping' | 'stopped';

export interface ServiceReadinessSnapshot {
  ok: boolean;
  ready: boolean;
  service: string;
  transport?: string;
  stage: ServiceReadinessStage;
  startupWarnings: number;
  startupErrors: number;
  lastError?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export class ServiceReadinessProbe {
  private stage: ServiceReadinessStage = 'starting';
  private transport?: string;
  private startupWarnings = 0;
  private startupErrors = 0;
  private lastError?: string;
  private details?: Record<string, unknown>;

  public constructor(private readonly serviceName: string) {}

  public recordDoctorFindings(findings: DoctorFinding[]): void {
    this.startupWarnings = findings.filter((finding) => finding.level === 'warn').length;
    this.startupErrors = findings.filter((finding) => finding.level === 'error').length;
  }

  public markStarting(transport?: string, details?: Record<string, unknown>): void {
    this.stage = 'starting';
    this.transport = transport;
    this.lastError = undefined;
    this.details = details;
  }

  public markReady(details?: Record<string, unknown>): void {
    this.stage = 'ready';
    this.lastError = undefined;
    this.details = details;
  }

  public markDegraded(error: string, details?: Record<string, unknown>): void {
    this.stage = 'degraded';
    this.lastError = error;
    this.details = details;
  }

  public markStopping(details?: Record<string, unknown>): void {
    this.stage = 'stopping';
    this.details = details;
  }

  public markStopped(details?: Record<string, unknown>): void {
    this.stage = 'stopped';
    this.details = details;
  }

  public snapshot(): ServiceReadinessSnapshot {
    const ready = this.stage === 'ready' && this.startupErrors === 0;
    const ok = this.stage !== 'degraded' && this.stage !== 'stopped';
    return {
      ok,
      ready,
      service: this.serviceName,
      ...(this.transport ? { transport: this.transport } : {}),
      stage: this.stage,
      startupWarnings: this.startupWarnings,
      startupErrors: this.startupErrors,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.details ? { details: this.details } : {}),
      timestamp: new Date().toISOString(),
    };
  }
}
