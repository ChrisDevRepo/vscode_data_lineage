import { memo, ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'icon' | 'default';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: React.ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'px-4 py-2 text-sm ln-btn-primary',
  secondary: 'px-4 py-2 text-sm ln-btn-secondary',
  ghost: 'px-3 py-1.5 text-sm ln-btn-ghost',
  icon: 'w-9 h-9 ln-btn-icon',
  default: '',
};

export const Button = memo(function Button({
  variant = 'secondary',
  children,
  className = '',
  disabled = false,
  style,
  ...props
}: ButtonProps) {
  const combinedStyles = `inline-flex items-center justify-center font-semibold rounded transition-colors focus:outline-none disabled:cursor-not-allowed ln-btn-disabled ${variantClasses[variant]} ${className}`;

  return (
    <button
      className={combinedStyles}
      disabled={disabled}
      style={style}
      {...props}
    >
      {children}
    </button>
  );
});
