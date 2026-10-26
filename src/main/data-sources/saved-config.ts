import { z } from 'zod';
import { sourceConfigSchema, type StoredSource } from './config';
import { websocketSourceConfig, type WebsocketSource } from './websocket/adapter';

// Existing HTTP revisions remain valid without a transport discriminator.
export const savedSourceConfig = z.union([sourceConfigSchema, websocketSourceConfig]);
export type SavedSource = StoredSource | WebsocketSource;
export function isWebsocketSource(source: SavedSource): source is WebsocketSource {
  return 'transport' in source.config && source.config.transport === 'websocket';
}
