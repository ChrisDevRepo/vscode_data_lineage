/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        table: '#3b82f6',
        view: '#22c55e',
        sp: '#eab308',
        udf: '#f97316',
        external: '#6b7280',
      },
    },
  },
  plugins: [],
};
