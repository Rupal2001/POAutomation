"use client";

import { useId, useRef, useState } from "react";
import Icon from "./Icon";

interface Props {
  label: string;
  hint: string;
  required?: boolean;
  file: File | null;
  onChange: (file: File | null) => void;
  summary?: string;
  templateHref?: string;
  accept?: string;
  extensions?: string[];
  chooseLabel?: string;
}

export default function FileDrop({
  label,
  hint,
  required,
  file,
  onChange,
  summary,
  templateHref,
  accept = ".csv,text/csv",
  extensions = [".csv"],
  chooseLabel = "Choose file",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState("");

  function acceptFile(next: File | undefined) {
    if (!next) return;
    if (!extensions.some(extension => next.name.toLowerCase().endsWith(extension.toLowerCase()))) {
      setFileError(`Choose ${extensions.join(" or ").toUpperCase()} format.`);
      return;
    }
    setFileError("");
    onChange(next);
  }

  return <div className="file-control">
    <div className="file-control-label">
      <label htmlFor={inputId}>{label}{required && <span aria-label="required"> *</span>}</label>
      <div>
        {templateHref && <a href={templateHref}>Download example</a>}
        {file && <button type="button" onClick={() => { setFileError(""); onChange(null); if (inputRef.current) inputRef.current.value = ""; }}>Remove</button>}
      </div>
    </div>
    <input
      ref={inputRef}
      id={inputId}
      type="file"
      accept={accept}
      className="sr-only"
      required={required}
      aria-describedby={hintId}
      onChange={event => acceptFile(event.target.files?.[0])}
    />
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      onDragOver={event => { event.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={event => { event.preventDefault(); setDragOver(false); acceptFile(event.dataTransfer.files?.[0]); }}
      className={`file-drop-zone ${dragOver ? "drag-over" : ""} ${file ? "has-file" : ""}`}
      aria-label={`${label}: ${file ? `${file.name} selected` : chooseLabel.toLowerCase()}`}
      aria-describedby={hintId}
    >
      <span className="file-drop-icon"><Icon name={file ? "check" : "upload"}/></span>
      {file ? <span className="min-w-0"><strong>{file.name}</strong><small>{summary || formatFileSize(file.size)} · Ready to check</small></span> : <span><strong>{chooseLabel}</strong><small>or drag and drop it here</small></span>}
    </button>
    <p id={hintId} className={`file-control-hint ${fileError ? "field-error" : ""}`} aria-live="polite">{fileError || hint}</p>
  </div>;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
