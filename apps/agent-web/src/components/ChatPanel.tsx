import { useEffect, useRef } from 'react';
import { formatBytes } from '../files';
import type { ChatMessage } from '../types';

type Props = {
  messages: ChatMessage[];
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
          className={`message message-${message.author}${message.variant === 'error' ? ' message-error' : ''}`}
        >
          <div className="message-author">
            {message.author === 'agent' ? 'Agent' : 'You'}
            {message.fixture && <span className="tag">recorded</span>}
          </div>
          {message.text && <p className="message-text">{message.text}</p>}
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
