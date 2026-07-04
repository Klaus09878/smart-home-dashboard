/** Tailwind-Konfiguration für den statischen CSS-Build.
 *  Neu bauen nach Klassen-Änderungen:  npm run build:css
 *  (oder: npx -y tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify)
 */
module.exports = {
  darkMode: 'class',
  // Wichtig: auch JS-Dateien scannen — viele Klassen stehen in Template-Strings
  content: ['./index.html', './gpx.html', './app.js', './shared.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.4s ease-out forwards',
        'slide-up': 'slideUp 0.5s ease-out forwards',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
