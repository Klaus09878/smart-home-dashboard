/** Tailwind-Konfiguration für den statischen CSS-Build.
 *  Neu bauen nach Klassen-Änderungen:  npm run build:css
 *  (oder: npx -y tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify)
 */
module.exports = {
  darkMode: 'class',
  // Wichtig: auch JS-Dateien scannen — viele Klassen stehen in Template-Strings.
  // (Plan5-5: Liste aktualisiert — './app.js' war seit dem Plan2-9-Split in
  // app-*.js verwaist, gpx.js/settings-sync.js fehlten; login.html/login.js neu.)
  content: ['./index.html', './gpx.html', './login.html', './app-*.js', './gpx.js', './shared.js', './settings-sync.js', './login.js'],
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
