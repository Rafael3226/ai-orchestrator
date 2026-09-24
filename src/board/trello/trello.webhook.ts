import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { BoardEvent } from '../board.types.js';

import { mapAction, type RawAction } from './trello.mapper.js';

/** The header Trello signs every delivery with. */
export const SIGNATURE_HEADER = 'x-trello-webhook';

/**
 * Non-strict on purpose: Trello adds fields to action payloads freely, and a
 * strict shape would start rejecting real deliveries the day they do.
 */
const payloadSchema = z.object({
  action: z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    date: z.string().min(1),
    idMemberCreator: z.string().min(1),
    data: z.looseObject({}),
  }),
  model: z.object({ id: z.string().min(1) }).optional(),
});

export interface ParsedWebhook {
  readonly action: RawAction;
  /** The board the delivery claims to be about; verified against the project. */
  readonly modelId: string | null;
}

/**
 * base64(HMAC-SHA1(apiSecret, rawBody + callbackURL)).
 *
 * Two things here are easy to get wrong and both fail only in production:
 *
 * - `apiSecret` is the OAuth/API *secret* that belongs to the API key. It is
 *   neither the API key nor the user token.
 * - `callbackURL` must be the exact string registered with Trello, not one
 *   rebuilt from request headers. Behind a tunnel the scheme, host and
 *   sometimes the path differ from what Trello signed.
 */
export function trelloSignature(rawBody: string, callbackURL: string, apiSecret: string): string {
  return createHmac('sha1', apiSecret)
    .update(rawBody + callbackURL, 'utf8')
    .digest('base64');
}

/** Never throws: a missing, malformed or wrong-length header is just `false`. */
export function verifyTrelloSignature(
  rawBody: string,
  callbackURL: string,
  apiSecret: string,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const expected = Buffer.from(trelloSignature(rawBody, callbackURL, apiSecret), 'base64');
  const actual = Buffer.from(header, 'base64');
  // timingSafeEqual throws on a length mismatch, which would turn a bad
  // signature into a 500 and a crash-looped handler.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Returns null for anything that is not a well-formed Trello action delivery. */
export function parseTrelloWebhook(body: unknown): ParsedWebhook | null {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) return null;
  const { action, model } = parsed.data;
  return { action: action as RawAction, modelId: model?.id ?? null };
}

/**
 * Payload → BoardEvent through the *same* `mapAction` the poller uses. That is
 * deliberate and load-bearing: both paths therefore produce the identical
 * `trello:<actionId>` event id, so `markEventSeen` dedupes a webhook delivery
 * against the poll that later reports the same action, with no extra state.
 */
export function mapWebhookPayload(body: unknown, boardId: string): BoardEvent | null {
  const parsed = parseTrelloWebhook(body);
  if (!parsed) return null;
  return mapAction(parsed.action, boardId);
}
