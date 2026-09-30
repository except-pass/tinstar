import { messageNeedsAttention, type OutboxMessage } from './types'

export function MessageFeed({ messages, retry }: { messages: OutboxMessage[]; retry: (message: OutboxMessage) => void }) {
  if (!messages.length) return null
  return <div className="cockpit-messages">{messages.map(message => <article key={message.requestId}>
    <div className="cockpit-message-top"><strong>{message.kind === 'answer' ? 'Answer' : 'Message'} · {message.taskId ?? 'First Mate backlog'}</strong><span>{message.state === 'acknowledged' ? 'First Mate has it' : message.state === 'unknown' ? 'status unknown' : message.state}</span></div>
    <p>{message.text}</p>
    {message.state === 'saved' && message.canReceive === false && <small role="status">Saved, not yet read. First Mate will read it when it wakes.</small>}
    {messageNeedsAttention(message) && <button type="button" onClick={() => retry(message)}>{message.state === 'sending' ? 'Retry sending' : 'Retry waking First Mate'}</button>}
    {message.reply && <blockquote><strong>First Mate replied</strong><p>{message.reply}</p></blockquote>}
  </article>)}</div>
}

export function MessagesPanel({ messages, error, retry }: { messages: OutboxMessage[]; error: string | null; retry: (message: OutboxMessage) => void }) {
  return <>
    {error && <p className="cockpit-attention-empty" role="alert">{error}</p>}
    <div className="cockpit-rail-messages" aria-label="Messages">
      {messages.length ? <MessageFeed messages={messages} retry={retry} /> : !error && <p className="cockpit-attention-empty">No messages yet.</p>}
    </div>
  </>
}
