import { useEffect, useRef, useState, type FormEvent } from 'react';
import './inbox.css';

type Message = {
  id: string;
  contact: string;
  text: string;
  time: string;
  direction: 'inbound' | 'outbound';
  status?: 'queued' | 'sent' | 'delivered' | 'failed';
};

export function App() {
  const [token, setToken] = useState('');
  const [activeToken, setActiveToken] = useState('');
  const [workspace, setWorkspace] = useState('ws_acme');
  const [contact, setContact] = useState('');
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sendError, setSendError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [revision, setRevision] = useState(0);
  const pending = useRef<{ workspace: string; contact: string; text: string; clientRef: string } | null>(null);

  useEffect(() => {
    if (!activeToken) return;
    const controller = new AbortController();
    let timer: number;
    async function load() {
      try {
        const response = await fetch(`/__grader/inbox?workspace=${workspace}`, {
          headers: { 'x-grader-token': activeToken }, signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 401) setMessages(null);
          throw new Error(response.status === 401 ? 'Invalid grader token.' : 'Could not load the inbox.');
        }
        const result: { messages: Message[] } = await response.json();
        if (!controller.signal.aborted) {
          setMessages(result.messages);
          setLoadError('');
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : 'Could not load the inbox.');
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(load, 3000);
      }
    }
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [activeToken, workspace, revision]);

  const latest = new Map<string, Message>();
  for (const message of messages ?? []) latest.set(message.contact, message);
  const conversations = [...latest.values()].sort((a, b) => b.time.localeCompare(a.time));
  const selected = latest.has(contact) ? contact : conversations[0]?.contact;

  function clearComposer() {
    pending.current = null;
    setDraft('');
    setSendError('');
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selected || sending) return;
    const previous = pending.current;
    const reply = previous?.contact === selected && previous.workspace === workspace && previous.text === text
      ? previous
      : { workspace, contact: selected, text, clientRef: crypto.randomUUID() };
    pending.current = reply;
    setSending(true);
    setSendError('');
    try {
      const response = await fetch('/__grader/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-grader-token': activeToken },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ workspace, contact: selected, text, client_ref: reply.clientRef }),
      });
      if (!response.ok) throw new Error();
      clearComposer();
      setRevision(value => value + 1);
    } catch {
      setSendError('Could not confirm the reply. Send again to retry.');
    } finally {
      setSending(false);
    }
  }

  return (
    <main>
      <header className="top">
        <h1>Switchboard</h1>
        <form onSubmit={event => {
          event.preventDefault();
          setMessages(null);
          setLoadError('');
          setActiveToken(token);
          setRevision(value => value + 1);
        }}>
          <label htmlFor="token">Grader token</label>
          <input id="token" type="password" value={token} onChange={event => setToken(event.target.value)}
            autoComplete="off" required disabled={sending} />
          <button disabled={sending}>Connect</button>
        </form>
      </header>
      <div className="inbox">
        <aside aria-label="Conversations">
          <label htmlFor="workspace">Workspace</label>
          <select id="workspace" value={workspace} disabled={sending} onChange={event => {
            setWorkspace(event.target.value);
            setContact('');
            setMessages(null);
            setLoadError('');
            clearComposer();
          }}>
            <option value="ws_acme">Acme</option>
            <option value="ws_globex">Globex</option>
          </select>
          {conversations.map(message => (
            <button key={message.contact} className="conversation" aria-pressed={selected === message.contact}
              disabled={sending} onClick={() => {
                if (selected !== message.contact) clearComposer();
                setContact(message.contact);
              }}>
              <strong>{message.contact}</strong>
              <span>{message.text}</span>
            </button>
          ))}
        </aside>
        <section className="thread" aria-label="Message thread">
          {loadError && <p role="alert">{loadError}</p>}
          {!selected && !loadError &&
            <p>{!activeToken ? 'Enter your grader token to open the local inbox.' : messages ? 'No conversations yet.' : 'Loading messages…'}</p>}
          {selected && <>
            <h2>{selected}</h2>
            <ol className="messages">
              {messages?.filter(message => message.contact === selected).map(message => (
                <li key={`${message.direction}-${message.id}`} className={message.direction}>
                  <p>{message.text}</p>
                  <small>
                    {new Date(message.time).toLocaleString()}
                    {message.status && ` · ${message.status}`}
                  </small>
                </li>
              ))}
            </ol>
            <form className="composer" onSubmit={send}>
              <label htmlFor="reply">Reply</label>
              <textarea id="reply" value={draft} disabled={sending} onChange={event => setDraft(event.target.value)} rows={3} />
              <button disabled={sending || !draft.trim()}>{sending ? 'Sending…' : 'Send reply'}</button>
              {sendError && <p role="alert">{sendError}</p>}
            </form>
          </>}
        </section>
      </div>
    </main>
  );
}
