import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { MongoServerError } from 'mongodb';
import { config } from './config.js';
import { getDb } from './db.js';
import { startReplyWorker, type Reply } from './replies.js';

const db = await getDb();
const inbound = db.collection<{
  workspace: string;
  eventId: string;
  messageId: string;
  contact: string;
  text: string;
  occurredAt: Date;
}>('inbound');
const replies = db.collection<Reply>('replies');
const claims = db.collection<{ workspace: string; contact: string; agent: string }>('claims');

await Promise.all([
  inbound.createIndex({ workspace: 1, eventId: 1 }, { unique: true }),
  inbound.createIndex({ workspace: 1, messageId: 1 }, { unique: true }),
  replies.createIndex({ workspace: 1, clientRef: 1 }, { unique: true }),
  replies.createIndex({ workspace: 1, status: 1, nextAttempt: 1 }),
  claims.createIndex({ workspace: 1, contact: 1 }, { unique: true }),
]);

const app = express();
const route = (handle: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handle(req, res, next)).catch(next);
};
const knownWorkspace = (value: unknown): value is string =>
  typeof value === 'string' && Object.hasOwn(config.pigeon.apiKeys, value);
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

async function ignoreDuplicate(write: Promise<unknown>) {
  try {
    await write;
  } catch (error) {
    if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
  }
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhooks/pigeon', express.raw({ type: () => true }), route(async (req, res) => {
  const signature = /^t=(\d+),v1=([a-f\d]{64})$/i.exec(req.get('x-pigeon-signature') ?? '');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!signature || Math.abs(Math.floor(Date.now() / 1000) - Number(signature[1])) > 300) {
    return res.sendStatus(401);
  }
  const expected = createHmac('sha256', config.pigeon.webhookSecret)
    .update(signature[1] + '.').update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature[2], 'hex'))) return res.sendStatus(401);

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return res.sendStatus(400);
  const { workspace, data } = event;
  if (!knownWorkspace(workspace)) return res.sendStatus(204);

  if (event.type === 'message.inbound') {
    const occurredAt = new Date(event.occurred_at);
    if (!nonempty(event.id) || !nonempty(data?.message_id) || !nonempty(data?.from)
      || typeof data.text !== 'string' || !nonempty(event.occurred_at) || !Number.isFinite(occurredAt.getTime())) {
      return res.sendStatus(400);
    }
    await ignoreDuplicate(inbound.insertOne({
      workspace, eventId: event.id, messageId: data.message_id,
      contact: data.from, text: data.text, occurredAt,
    }));
  }

  if (event.type === 'message.status') {
    const status = data?.status;
    if (!nonempty(data?.client_ref) || !nonempty(data?.message_id)
      || (status !== 'sent' && status !== 'delivered' && status !== 'failed')) {
      return res.sendStatus(400);
    }
    await replies.updateOne({
      workspace, clientRef: data.client_ref, attempts: { $gt: 0 },
      status: { $in: status === 'sent' ? ['queued'] : ['queued', 'sent'] },
      $or: [{ providerId: data.message_id }, { providerId: { $exists: false } }],
    }, { $set: { status, providerId: data.message_id } });
  }
  return res.sendStatus(204);
}));

const grader = express.Router();
app.use('/__grader', grader);
grader.use((req, res, next) => {
  if (!config.graderToken || req.get('x-grader-token') !== config.graderToken) {
    return res.sendStatus(401);
  }
  next();
});
grader.use(express.json());

grader.post('/reply', route(async (req, res) => {
  const { workspace, contact, text, client_ref: clientRef } = req.body ?? {};
  if (!knownWorkspace(workspace) || !nonempty(contact) || !nonempty(text) || !nonempty(clientRef)) {
    return res.sendStatus(400);
  }
  await ignoreDuplicate(replies.insertOne({
    workspace, contact, text, clientRef, status: 'queued', attempts: 0, nextAttempt: new Date(),
  }));
  return res.sendStatus(202);
}));

grader.post('/claim', route(async (req, res) => {
  const { workspace, contact, agent } = req.body ?? {};
  if (!knownWorkspace(workspace) || !nonempty(contact) || !nonempty(agent)) {
    return res.sendStatus(400);
  }
  const key = { workspace, contact };
  await ignoreDuplicate(claims.insertOne({ ...key, agent }));
  const claim = await claims.findOne(key);
  return res.sendStatus(claim?.agent === agent ? 200 : 409);
}));

grader.post('/reset', route(async (_req, res) => {
  await Promise.all([inbound.deleteMany(), replies.deleteMany(), claims.deleteMany()]);
  return res.sendStatus(200);
}));

grader.get('/inbox', route(async (req, res) => {
  const workspace = req.query.workspace;
  if (!knownWorkspace(workspace)) return res.sendStatus(400);

  const [received, sent] = await Promise.all([
    inbound.find({ workspace }).sort({ occurredAt: -1, messageId: -1 }).limit(200).toArray(),
    replies.find({ workspace }).sort({ _id: -1 }).limit(200).toArray(),
  ]);
  const messages = [
    ...received.map(message => ({
      id: message.messageId, contact: message.contact, text: message.text,
      time: message.occurredAt.toISOString(), direction: 'inbound',
    })),
    ...sent.map(message => ({
      id: message.clientRef, contact: message.contact, text: message.text,
      time: message._id.getTimestamp().toISOString(), direction: 'outbound', status: message.status,
    })),
  ];
  messages.sort((a, b) => a.time.localeCompare(b.time));
  res.json({ messages });
}));

grader.get('/snapshot', route(async (_req, res) => {
  type Contact = { inbound: string[]; assignee: string | null };
  const workspaces: Record<string, { contacts: Record<string, Contact>; outbound: Record<string, string> }> =
    Object.fromEntries(Object.keys(config.pigeon.apiKeys).map(workspace => [
      workspace, { contacts: Object.create(null), outbound: Object.create(null) },
    ]));
  const getContact = (workspace: string, contact: string) =>
    workspaces[workspace].contacts[contact] ??= { inbound: [], assignee: null };

  const [messages, outgoing, assignments] = await Promise.all([
    inbound.find().sort({ occurredAt: 1, messageId: 1 }).toArray(),
    replies.find().toArray(),
    claims.find().toArray(),
  ]);
  for (const message of messages) {
    getContact(message.workspace, message.contact).inbound.push(message.messageId);
  }
  for (const reply of outgoing) {
    getContact(reply.workspace, reply.contact);
    workspaces[reply.workspace].outbound[reply.clientRef] = reply.status;
  }
  for (const claim of assignments) getContact(claim.workspace, claim.contact).assignee = claim.agent;
  res.json({ workspaces });
}));

const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = error.status ?? 500;
  if (status >= 500) console.error(error);
  res.sendStatus(status);
};
app.use(handleError);

const server = createServer(app);
server.listen(config.port, () => {
  startReplyWorker(replies);
  console.log(`server on http://localhost:${config.port}`);
});
