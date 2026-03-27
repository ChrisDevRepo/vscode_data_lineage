import { memo } from 'react';
import { Tooltip } from './Tooltip';

type StatusType = 'error' | 'warning' | 'success' | 'info';

interface StatusMessageProps {
  text: string;
  type: StatusType;
}

const ICONS: Record<StatusType, string> = {
  error:   'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  warning: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  success: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  info:    'm11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z',
};

const FALLBACK_TITLES: Record<StatusType, string> = {
  error:   'Error',
  warning: 'Warning',
  success: 'Done',
  info:    'Info',
};

function extractTitle(text: string, type: StatusType): string {
  const t = text.toLowerCase();
  if (t.includes('failed') || t.includes('failure'))    return 'Connection failed';
  if (t.includes('timeout') || t.includes('timed out')) return 'Connection timeout';
  if (t.includes('unauthori') || t.includes('authent')) return 'Authentication error';
  if (t.includes('cancel'))                              return 'Cancelled';
  if (t.includes('not available') || t.includes('not found')) return 'Not available';
  if (t.includes('no longer available'))                 return 'File not found';
  if (t.includes('permission') || t.includes('access denied')) return 'Access denied';
  return FALLBACK_TITLES[type];
}

const MAX_BODY = 120;

export const StatusMessage = memo(function StatusMessage({ text, type }: StatusMessageProps) {
  const title = extractTitle(text, type);
  const body = text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '…' : text;
  const needsTooltip = text.length > MAX_BODY;

  const content = (
    <div className={`flex items-start gap-2 px-3 py-2 rounded ln-status-${type}`}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        className="w-4 h-4 flex-shrink-0 mt-0.5"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={ICONS[type]} />
      </svg>
      <div className="min-w-0">
        <div className="text-xs font-semibold">{title}</div>
        <div className="text-xs mt-0.5 break-words" style={{ color: 'var(--ln-fg-muted)', opacity: 0.9 }}>
          {body}
        </div>
      </div>
    </div>
  );

  if (!needsTooltip) return content;

  return (
    <Tooltip content={text} delay={300}>
      {content}
    </Tooltip>
  );
});
