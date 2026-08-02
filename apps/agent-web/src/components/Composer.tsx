import { useRef, useState } from 'react';
import { ACCEPTED_EXTENSIONS, formatBytes, isDuplicate, stageFile } from '../files';
import type { StagedFile } from '../types';

type Props = {
  onSend: (text: string, files: File[]) => void;
};

export default function Composer({ onSend }: Props) {
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [text, setText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const ready = staged.filter((s) => s.status === 'ready');
  // Documents are required to send. The chat asks for them, and until chat-driven
  // corrections exist there is nothing a text-only message could accomplish.
  const canSend = ready.length > 0;

  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    setStaged((current) => {
      const next = [...current];
      for (const file of Array.from(incoming)) {
        if (isDuplicate(next, file)) continue;
        next.push(stageFile(file));
      }
      return next;
    });
  }

  function remove(id: string) {
    setStaged((current) => current.filter((s) => s.id !== id));
  }

  function send() {
    if (!canSend) return;
    onSend(
      text.trim(),
      ready.map((s) => s.file),
    );
    setStaged([]);
    setText('');
  }

  return (
    <div className="composer">
      <div
        className={`dropzone${isDragging ? ' dropzone-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(',')}
          onChange={(e) => {
            addFiles(e.target.files);
            // Allows re-picking a file that was removed from the list.
            e.target.value = '';
          }}
          className="visually-hidden"
          id="file-input"
        />
        <label htmlFor="file-input" className="dropzone-label">
          <strong>Choose documents</strong> or drag them here
          <span className="subtle">{ACCEPTED_EXTENSIONS.join(', ')} · up to 10 MB each</span>
        </label>
      </div>

      {staged.length > 0 && (
        <ul className="staged-list">
          {staged.map((s) => (
            <li key={s.id} className={`staged staged-${s.status}`}>
              <span className="staged-name">{s.file.name}</span>
              <span className="staged-status">
                {s.status === 'ready' ? formatBytes(s.file.size) : s.rejectionReason}
              </span>
              <button
                className="icon-button"
                onClick={() => remove(s.id)}
                aria-label={`Remove ${s.file.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add context — which table to use, whether figures are in thousands…"
        rows={2}
        aria-label="Additional context"
      />

      <div className="composer-actions">
        <button className="primary" onClick={send} disabled={!canSend}>
          Send
        </button>
      </div>
    </div>
  );
}
