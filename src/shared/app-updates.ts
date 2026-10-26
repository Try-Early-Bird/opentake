export interface AppVersion {
  version: string;
  build: string;
  packaged: boolean;
  platform: string;
  arch: string;
}

export type UpdateCheck =
  | { status: 'available'; version: string }
  | { status: 'current' | 'unpublished' }
  | { status: 'error'; message: string };

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'current' | 'unpublished' | 'downloading' | 'ready' | 'installing' | 'error';
  native: boolean;
  preview: boolean;
  version?: string;
  percent?: number;
  message?: string;
}
