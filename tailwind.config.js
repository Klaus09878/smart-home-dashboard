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
      // ============ Design-Tokens (Plan6, hallmark "Instrument") ============
      // Die bestehenden slate-/teal-/white-Klassen in Markup UND JS-Templates
      // werden auf CSS-Tokens umgelenkt (Definition: tailwind.input.css :root
      // bzw. html.light). Dadurch gilt: EIN Token-Satz fuer hell+dunkel, die
      // fruehere html.light-Remap-Schicht entfaellt fuer diese Farben. Neue
      // Farbwerte NIE inline erfinden — Token ergaenzen (design.md).
      colors: {
        white: 'oklch(var(--sh-ink) / <alpha-value>)',
        slate: {
          100: 'oklch(var(--sh-ink) / <alpha-value>)',
          200: 'oklch(var(--sh-ink) / <alpha-value>)',
          300: 'oklch(var(--sh-ink-2) / <alpha-value>)',
          400: 'oklch(var(--sh-ink-3) / <alpha-value>)',
          500: 'oklch(var(--sh-ink-4) / <alpha-value>)',
          600: 'oklch(var(--sh-ink-5) / <alpha-value>)',
          700: 'oklch(var(--sh-rule-2) / <alpha-value>)',
          800: 'oklch(var(--sh-rule) / <alpha-value>)',
          850: 'oklch(var(--sh-surface) / <alpha-value>)',
          900: 'oklch(var(--sh-surface) / <alpha-value>)',
          950: 'oklch(var(--sh-paper) / <alpha-value>)',
        },
        teal: {
          200: 'oklch(var(--sh-accent-soft) / <alpha-value>)',
          300: 'oklch(var(--sh-accent-soft) / <alpha-value>)',
          400: 'oklch(var(--sh-accent) / <alpha-value>)',
          500: 'oklch(var(--sh-accent-strong) / <alpha-value>)',
          600: 'oklch(var(--sh-accent-strong) / <alpha-value>)',
        },
        // Text AUF Akzentfuellungen (Pill-CTAs): dunkel auf hellem Teal (dark
        // mode) bzw. hell auf tiefem Teal (light mode) — nie remapped-white.
        'accent-ink': 'oklch(var(--sh-accent-ink) / <alpha-value>)',
        // Semantik-/Datenfarben (Plan6-6): 100-300 = soft, 400 = Basis,
        // 500 = Fuellung/Rand — hell/dunkel per Token-Flip.
        emerald: {
          300: 'oklch(var(--sh-ok-soft) / <alpha-value>)',
          400: 'oklch(var(--sh-ok) / <alpha-value>)',
          500: 'oklch(var(--sh-ok-strong) / <alpha-value>)',
        },
        amber: {
          200: 'oklch(var(--sh-warn-soft) / <alpha-value>)',
          300: 'oklch(var(--sh-warn-soft) / <alpha-value>)',
          400: 'oklch(var(--sh-warn) / <alpha-value>)',
          500: 'oklch(var(--sh-warn-strong) / <alpha-value>)',
        },
        red: {
          100: 'oklch(var(--sh-alert-soft) / <alpha-value>)',
          200: 'oklch(var(--sh-alert-soft) / <alpha-value>)',
          300: 'oklch(var(--sh-alert-soft) / <alpha-value>)',
          400: 'oklch(var(--sh-alert) / <alpha-value>)',
          500: 'oklch(var(--sh-alert-strong) / <alpha-value>)',
        },
        orange: {
          200: 'oklch(var(--sh-data-warm-soft) / <alpha-value>)',
          300: 'oklch(var(--sh-data-warm-soft) / <alpha-value>)',
          400: 'oklch(var(--sh-data-warm) / <alpha-value>)',
          500: 'oklch(var(--sh-data-warm-strong) / <alpha-value>)',
        },
        blue: {
          300: 'oklch(var(--sh-data-cool-soft) / <alpha-value>)',
          400: 'oklch(var(--sh-data-cool) / <alpha-value>)',
          500: 'oklch(var(--sh-data-cool-strong) / <alpha-value>)',
        },
        sky: {
          300: 'oklch(var(--sh-data-sky-soft) / <alpha-value>)',
          400: 'oklch(var(--sh-data-sky) / <alpha-value>)',
          500: 'oklch(var(--sh-data-sky-strong) / <alpha-value>)',
        },
      },
      // Straffere, benannte Radien (hallmark: Einheits-Blob-Radius ist ein Tell).
      // rounded-2xl = Karten, rounded-xl/-lg = Controls; rounded-full bleibt.
      borderRadius: {
        lg: 'var(--sh-radius-control)',
        xl: 'var(--sh-radius-control)',
        '2xl': 'var(--sh-radius-card)',
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
