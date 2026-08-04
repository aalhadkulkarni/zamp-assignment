import { useEffect, useRef } from 'react';
import { formatBytes } from '../files';
import type { StoredMessage } from '../api';
import { readable } from '../format';


type Props = {
  messages: StoredMessage[];
};

export default function ChatPanel({ messages }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  return (
    <div className="chat-log" role="log" aria-label="Conversation">
      {messages.map((message) => (
        <article
          key={message.id}
          className={`message message-${message.author}${message.variant ? ` message-${message.variant}` : ''}`}
        >
          <div className="message-author">
            {message.author === 'agent' ? 'Agent' : 'You'}
            {message.fixture && <span className="tag">recorded</span>}
          </div>
          {message.text && <p className="message-text">{message.text}</p>}
          {/* What the analyst actually changed, next to the explanation of why.
              Without this the agent's reasoning sat above nothing — the
              corrections were only ever drawn from browser state before they
              were submitted, so sending them made them disappear. */}
          {message.corrections && message.corrections.length > 0 && (
            <ul className="message-corrections">
              {message.corrections.map((correction) => (
                <li key={correction.fieldKey}>
                  <span className="correction-field">{correction.fieldKey}</span>
                  <span className="correction-change">
                    {readable(correction.from)} → {readable(correction.to)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {message.attachments && message.attachments.length > 0 && (
            <ul className="message-attachments">
              {message.attachments.map((attachment) => (
                <li key={attachment.name}>
                  {attachment.name}
                  <span className="subtle"> · {formatBytes(attachment.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
      <div ref={endRef} />
    </div>
  );
}
