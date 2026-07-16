// Intuit webhook receiver — POST /webhooks/qbo (mounted at the app root,
// BEFORE express.json so the raw body is available for HMAC verification).
//
// Flow: verify intuit-signature (HMAC-SHA256, base64) → respond 200
// immediately → async: store the WebhookEvent, debounce 10s per realm, then
// run a 'webhook' sync for each affected company. Payloads carry entity IDs
// only, so the sync always re-fetches; events may be late or duplicated and
// the sync upsert is idempotent.

import express, { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { env } from '../env.js';
import { asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { getInstanceSettings } from '../services/instanceSettings.js';
import { syncCompany } from '../services/sync.js';

const DEBOUNCE_MS = 10_000;
/** Intuit payloads are tiny (entity ids only) — anything huge is not Intuit. */
const MAX_STORED_PAYLOAD_BYTES = 256 * 1024;

const debounceTimers = new Map<string, NodeJS.Timeout>(); // realmId → timer
const pendingEventIds = new Map<string, string[]>(); // realmId → stored WebhookEvent ids

function extractRealmIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const notifications = (payload as { eventNotifications?: unknown }).eventNotifications;
  if (!Array.isArray(notifications)) return [];
  const out = new Set<string>();
  for (const n of notifications) {
    if (typeof n === 'object' && n !== null) {
      const realmId = (n as { realmId?: unknown }).realmId;
      if (typeof realmId === 'string' && realmId !== '') out.add(realmId);
    }
  }
  return [...out];
}

function verifySignature(raw: Buffer, signature: string, token: string): boolean {
  const expected = createHmac('sha256', token).update(raw).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function runRealmSync(realmId: string): Promise<void> {
  const eventIds = pendingEventIds.get(realmId) ?? [];
  pendingEventIds.delete(realmId);
  try {
    const company = await prisma.company.findUnique({ where: { realmId } });
    if (company && company.disconnectedAt === null) {
      await syncCompany(company.id, 'webhook');
    } else {
      console.warn(`[webhooks] event for unknown/disconnected realm ${realmId} — skipped`);
    }
    if (eventIds.length > 0) {
      await prisma.webhookEvent.updateMany({
        where: { id: { in: eventIds } },
        data: { processed: true, processedAt: new Date() },
      });
    }
  } catch (err) {
    console.error(`[webhooks] sync failed for realm ${realmId}:`, err);
  }
}

async function processPayload(raw: Buffer): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    console.warn('[webhooks] discarding non-JSON webhook body');
    return;
  }
  // Cap what we persist: an oversized body is still processed (the sync
  // re-fetches everything anyway) but never stored.
  let event: { id: string } | null = null;
  if (raw.length <= MAX_STORED_PAYLOAD_BYTES) {
    event = await prisma.webhookEvent.create({ data: { payload: payload as Prisma.InputJsonValue } });
  } else {
    console.warn(`[webhooks] payload of ${raw.length} bytes exceeds ${MAX_STORED_PAYLOAD_BYTES} — not storing it`);
  }
  for (const realmId of extractRealmIds(payload)) {
    const ids = pendingEventIds.get(realmId) ?? [];
    if (event) ids.push(event.id);
    pendingEventIds.set(realmId, ids);

    // Debounce bursts: Intuit fires several events per user action.
    const existing = debounceTimers.get(realmId);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      realmId,
      setTimeout(() => {
        debounceTimers.delete(realmId);
        void runRealmSync(realmId);
      }, DEBOUNCE_MS),
    );
  }
}

export const webhooksRouter = Router();

webhooksRouter.post(
  '/',
  express.raw({ type: () => true, limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.header('intuit-signature') ?? '';

    const settings = await getInstanceSettings();
    if (settings.webhookVerifierToken === '') {
      // No verifier token = no way to authenticate the sender. Refuse.
      // QBO_MOCK (local-dev-only flag) is the sole exception: there is no
      // Intuit in local mock dev and nothing real to protect. Deployed
      // instances always enforce the token — demo companies never receive
      // webhooks anyway (no Intuit behind them).
      if (!env.QBO_MOCK) {
        console.warn('[webhooks] webhook rejected — no verifier token configured');
        res.status(401).json({ error: 'Webhook verifier token not configured' });
        return;
      }
    } else if (!verifySignature(raw, signature, settings.webhookVerifierToken)) {
      res.status(401).json({ error: 'Invalid intuit-signature' });
      return;
    }

    // Intuit requires a fast 200; everything else happens async.
    res.status(200).json({ ok: true });
    processPayload(raw).catch((err) => console.error('[webhooks] processing failed:', err));
  }),
);
