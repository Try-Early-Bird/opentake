export interface ActivityJob {
  id: string;
  kind: string;
  state: 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'needs_attention' | 'cancelled';
  attempts: number;
  reason: string;
  errorCode: string | null;
  updatedAt: string;
  nextRunAt: string;
  execution?: {
    strategyId: string; strategyTitle: string; symbol: string; side: 'buy' | 'sell';
    status: 'filled' | 'failed' | 'cancelled';
  };
}
export interface JobEvent {
  id: string;
  state: ActivityJob['state'];
  attempts: number;
  errorCode: string | null;
  occurredAt: string;
  nextRunAt: string;
}
export interface JobDetails {
  job: ActivityJob & { createdAt: string };
  events: JobEvent[];
  truncated: boolean;
}
export interface JobHistoryCursor { updatedAt: string; id: string }
export interface JobHistoryPage { jobs: ActivityJob[]; nextCursor: JobHistoryCursor | null }
export interface HostStatus { pid: number; build: string; protocol: 1 }
export interface ActivityAPI {
  list(): Promise<ActivityJob[]>;
  history(cursor?: JobHistoryCursor): Promise<JobHistoryPage>;
  details(id: string): Promise<JobDetails | null>;
  retry(id: string): Promise<void>;
  hostStatus(): Promise<HostStatus>;
  quitCompletely(): Promise<void>;
}
