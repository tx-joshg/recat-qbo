import { useRef, useState } from 'react';

const ACCEPTED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/tiff',
]);

export interface ReceiptDropzoneProps {
  disabled?: boolean;
  disabledLabel?: string;
  onFiles(files: File[]): void;
}

export default function ReceiptDropzone({
  disabled = false,
  disabledLabel = 'Uploading receipts…',
  onFiles,
}: ReceiptDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = (files: FileList | File[]) => {
    const values = [...files];
    if (values.length < 1 || values.length > 20) {
      setError('Choose between 1 and 20 files.');
      return;
    }
    if (values.some((file) => !ACCEPTED.has(file.type))) {
      setError('Use PDF, JPEG, PNG, GIF, or TIFF files.');
      return;
    }
    setError(null);
    onFiles(values);
  };

  return (
    <div>
      <label
        className={`receipt-dropzone${dragging ? ' is-dragging' : ''}${disabled ? ' is-disabled' : ''}`}
        aria-label="Drop receipt files"
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled) accept(event.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          className="receipt-file-input"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.gif,.tif,.tiff"
          disabled={disabled}
          onChange={(event) => {
            if (event.target.files) accept(event.target.files);
            event.target.value = '';
          }}
        />
        {disabled ? disabledLabel : 'Choose receipt files or drop them here'}
      </label>
      {error && (
        <div role="alert" className="receipt-dropzone-error">
          {error}
        </div>
      )}
    </div>
  );
}
