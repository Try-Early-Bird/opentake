import { z } from 'zod';
import { proposalPayloadSchema } from './strategies';

// A take as a file: its title, its strategy (every committed version and any
// newer draft) and its visible conversation. It carries no investment, money,
// account or credential. Imported, the strategy arrives as draft revisions to
// review and commit, and the conversation is shown in full but given to the AI
// only as quoted reference (take-file.ts quoteImported).

export const TAKE_FILE_FORMAT = 'opentake-take-v1';
/** Files larger than this are refused before parsing. */
export const TAKE_FILE_MAX_BYTES = 5 * 1024 * 1024;

const timestamp = z.string().datetime({ offset: true });
export const takeFileSchema = z.object({
  format: z.literal(TAKE_FILE_FORMAT),
  exportedAt: timestamp,
  take: z.object({ title: z.string().trim().min(1).max(120) }).strict(),
  strategy: z.object({
    /** Committed versions, oldest first. */
    versions: z.array(z.object({ sequence: z.number().int().positive(), committedAt: timestamp, proposal: proposalPayloadSchema }).strict()).max(200),
    /** The draft when it differs from the newest committed version. */
    draft: proposalPayloadSchema.nullable(),
  }).strict().nullable(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(200_000),
    createdAt: timestamp,
    /** Images are not carried; the count is kept so the transcript says so. */
    images: z.number().int().min(0).max(50),
    /** Tool names the reply used, for the record. */
    tools: z.array(z.string().min(1).max(200)).max(200),
  }).strict()).max(5000),
}).strict();
export type TakeFile = z.infer<typeof takeFileSchema>;
