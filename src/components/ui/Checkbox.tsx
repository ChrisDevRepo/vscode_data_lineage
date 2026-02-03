import { memo } from 'react';

interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  label: string;
}

export const Checkbox = memo(function Checkbox({ checked, onChange, label }: CheckboxProps) {
  return (
    <label className="flex items-center gap-2 cursor-pointer group">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="w-4 h-4 rounded border cursor-pointer ln-checkbox"
      />
      <span className="text-sm select-none group-hover:opacity-80 transition-opacity ln-text">
        {label}
      </span>
    </label>
  );
});
