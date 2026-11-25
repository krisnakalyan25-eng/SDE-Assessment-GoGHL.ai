import { createHash } from 'node:crypto';
import type { Collection, WithId } from 'mongodb';
import { config } from './config.js';

export type Reply = {
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  attempts: number;
  nextAttempt: Date;
  providerId?: string;
};

export function startReplyWorker(replies: Collection<Reply>) {
  // One polling loop per workspace. Persist the next attempt before sending so
  // the poll can keep moving while requests time out or return out of order.
  for (const [workspace, apiKey] of Object.entries(config.pigeon.apiKeys)) {
    let pausedUntil = 0;
    const active = new Set<string>();

    async function send(reply: WithId<Reply>) {
      const filter = { _id: reply._id, status: 'queued' as const };
      const idempotencyKey = createHash('sha256')
        .update(JSON.stringify([reply.workspace, reply.clientRef])).digest('hex');
      try {
        const response = await fetch(new URL('/v1/messages', config.pigeon.url), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({ to: reply.contact, text: reply.text, client_ref: reply.clientRef }),
          signal: AbortSignal.timeout(2500),
          redirect: 'error',
        });

        if (response.ok) {
          const { id } = await response.json();
          await replies.updateOne(filter, { $set: { status: 'sent', providerId: id } });
          return;
        }

        if (response.status === 429 || response.status === 503) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const delay = response.status === 429 && retryAfter > 0 ? retryAfter * 1000 : 1000;
          pausedUntil = Math.max(pausedUntil, Date.now() + delay);
          await response.body?.cancel();
          return;
        }

        await response.body?.cancel();
        if (response.status >= 400 && response.status < 500) {
          await replies.updateOne(filter, { $set: { status: 'failed' } });
        }
      } catch (error) {
        // Timeouts can happen after Pigeon accepted the send. Retry with the same key.
        if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
      }
    }

    async function poll() {
      try {
        if (Date.now() < pausedUntil || active.size >= 10) return;
        const reply = await replies.findOne({
          workspace, status: 'queued', nextAttempt: { $lte: new Date() },
        }, { sort: { nextAttempt: 1 } });
        if (!reply) return;

        const delay = Math.min(15_000, 3000 * 2 ** Math.min(reply.attempts, 3));
        const reserved = await replies.updateOne({
          _id: reply._id, status: 'queued', nextAttempt: reply.nextAttempt,
        }, {
          $inc: { attempts: 1 },
          $set: { nextAttempt: new Date(Date.now() + delay) },
        });
        if (!reserved.modifiedCount) return;

        const key = reply._id.toHexString();
        active.add(key);
        void send(reply).catch(console.error).finally(() => active.delete(key));
      } catch (error) {
        console.error(error);
      } finally {
        setTimeout(poll, 250);
      }
    }

    void poll();
  }
}

