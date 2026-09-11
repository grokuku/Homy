/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafTokens · version 0.1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * BRIQUE « FONDATION » — les tokens CSS de PAGE.
 *
 * ▸ PRIVILÈGE (par CONTRAT EXPLICITE) ───────────────────────────────────────
 *   HolafTokens est la SEULE brique du kit autorisée à poser des variables
 *   CSS sur `:root` (document.documentElement), sous le préfixe RÉSERVÉ
 *   --holaf-*. C'est l'exception à la règle du kit (« chaque brique scope son
 *   CSS sous ses propres classes, jamais sur :root »). Installer cette brique,
 *   c'est savoir (opt-in) qu'on installe un THÈME GLOBAL de page : elle prend
 *   le contrôle de la palette (surface, texte, accent, danger…).
 *
 * ▸ SANS RENDU ──────────────────────────────────────────────────────────────
 *   La brique ne rend AUCUN élément : elle ne fait que poser/retirer des
 *   variables CSS sur :root. Le CSS auto-injecté est donc minimal (un commentaire
 *   de repère, injecté une seule fois) — rien de scopé n'est nécessaire.
 *
 * ▸ CONTRAT DE SURFACE ───────────────────────────────────────────────────────
 *   Tokens posés (préfixe --holaf-*) :
 *     surface, surface-elev, surface-raised, border, text, text-muted,
 *     accent, accent-hover, accent-text, danger, danger-hover, danger-text,
 *     radius, shadow, font-size.
 *   Mapping hôte (ex. Homy — ses 11 vars actuelles) :
 *     --bg         → var(--holaf-surface)
 *     --bg-elev    → var(--holaf-surface-elev)
 *     --bg-elev-2  → var(--holaf-surface-raised)
 *     --border     → var(--holaf-border)
 *     --text       → var(--holaf-text)
 *     --text-muted → var(--holaf-text-muted)
 *     --accent         → var(--holaf-accent)
 *     --accent-hover   → var(--holaf-accent-hover)
 *     --danger     → var(--holaf-danger)
 *     --radius     → var(--holaf-radius)
 *     --shadow     → var(--holaf-shadow)
 *   Voir js/README-holaf-tokens.md pour le mapping complet.
 *
 * ▸ PRESETS ─────────────────────────────────────────────────────────────────
 *   dark / light / midnight / slate — COHÉRENTS avec les presets de HolafModal
 *   (mêmes noms, valeurs alignées, contraste des textes ≥ 4.5:1 sur les
 *   surfaces). Si l'hôte n'a fait AUCUN choix, le brique applique au chargement
 *   le preset initial issu de `prefers-color-scheme` (dark/light).
 *
 * ▸ API ──────────────────────────────────────────────────────────────────────
 *   HolafTokens.setTokens({ name?, values })      — pose des tokens (--holaf-*)
 *   HolafTokens.setTheme(presetName)              — applique un preset
 *   HolafTokens.getTheme()                        → { name, vars } | null
 *   HolafTokens.applyPalette(accentHex, opts?)    — palette calculée (mix/contrast internes)
 *   HolafTokens.reset()                           — retire TOUTES les vars --holaf-*
 *   HolafTokens.VERSION
 *   Événement : document.dispatchEvent(new CustomEvent("holaf-tokens-changed",
 *               { detail : { theme } })) à CHAQUE changement (setTokens /
 *               setTheme / applyPalette / reset / initial).
 *
 * Autonome : la brique RÉIMPLÉMENTE une version minimale de mix/contrast (pas
 * de dépendance inter-briques vers HolafColor).
 *
 * Fichier DUAL : module ES (export) + global window.HolafTokens — se charge
 * via <script type="module"> ou `import { HolafTokens }`.
 * ═════════════════════════════════════════════════════════════════════════ */

const HolafTokens = (function () {
    "use strict";

    const VERSION = "0.1.0";

    // Préfixe RÉSERVÉ : toutes les variables posées sont sous --holaf-*.
    const PREFIX = "--holaf-";
    const EVENT_NAME = "holaf-tokens-changed";

    // ─── État interne ──────────────────────────────────────────────────────
    let currentName = null;      // nom du preset en cours (ou null si custom)
    let appliedVars = null;      // dernières variables posées (clés --holaf-*)
    let initialized = false;     // le preset initial par défaut a-t-il été posé ?
    let explicitChoice = false;  // l'hôte a-t-il choisi lui-même ?

    // ─── Utilitaires internes (pas dépendance inter-briques) ──────────────
    function parseHex(hex) {
        if (typeof hex !== "string") {
            throw new Error("[HolafTokens] hex invalide : " + String(hex) + " (chaîne attendue).");
        }
        let h = hex.trim();
        if (h.charAt(0) === "#") h = h.slice(1);
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (!/^[0-9a-fA-F]{6}$/.test(h)) {
            throw new Error('[HolafTokens] hex invalide : "' + hex + '" (attendu "#rgb" ou "#rrggbb").');
        }
        return [
            parseInt(h.slice(0, 2), 16),
            parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16),
        ];
    }
    function toHex(r, g, b) {
        const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).toUpperCase().padStart(2, "0");
        return "#" + c(r) + c(g) + c(b);
    }
    // mix(a, b, ratio) : ratio 0..1 = part de b.
    function mix(a, b, ratio) {
        const ca = parseHex(a);
        const cb = parseHex(b);
        return toHex(
            ca[0] + (cb[0] - ca[0]) * ratio,
            ca[1] + (cb[1] - ca[1]) * ratio,
            ca[2] + (cb[2] - ca[2]) * ratio
        );
    }
    // Contrast ratio WCAG 2.1 minimal (luminance relative) — pour les accents.
    function lumChannel(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function contrastRatio(a, b) {
        const la = [0.2126, 0.7152, 0.0722].reduce((acc, w, i) => acc + w * lumChannel(parseHex(a)[i]), 0);
        const lb = [0.2126, 0.7152, 0.0722].reduce((acc, w, i) => acc + w * lumChannel(parseHex(b)[i]), 0);
        const hi = Math.max(la, lb), lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    }

    // ─── Presets (cohérents avec HolafModal — contraste textes ≥ 4.5:1) ────
    // Les clés internes sont « surface / surface-elev / surface-raised / … »
    // (sans préfixe) ; elles sont préfixées au moment de la pose.
    const PRESETS = {
        dark: {
            surface: "#1e1e1e", "surface-elev": "#27272a", "surface-raised": "#1a1a1a",
            border: "#3f3f46", text: "#e4e4e7", "text-muted": "#a1a1aa",
            accent: "#6366f1", "accent-hover": "#818cf8", "accent-text": "#ffffff",
            danger: "#ef4444", "danger-text": "#ffffff",
            radius: "12px", shadow: "0 18px 50px rgba(0, 0, 0, 0.55)", "font-size": "14px",
        },
        light: {
            surface: "#ffffff", "surface-elev": "#f4f4f5", "surface-raised": "#fafafa",
            border: "#d4d4d8", text: "#18181b", "text-muted": "#52525b",
            accent: "#4f46e5", "accent-hover": "#6366f1", "accent-text": "#ffffff",
            danger: "#dc2626", "danger-text": "#ffffff",
            radius: "12px", shadow: "0 18px 50px rgba(24, 24, 27, 0.18)", "font-size": "14px",
        },
        midnight: {
            surface: "#10111d", "surface-elev": "#181a2c", "surface-raised": "#0c0d17",
            border: "#272a44", text: "#e2e4f0", "text-muted": "#9aa0c3",
            accent: "#818cf8", "accent-hover": "#a5b4fc", "accent-text": "#10111d",
            danger: "#ef4444", "danger-text": "#ffffff",
            radius: "12px", shadow: "0 18px 50px rgba(0, 0, 0, 0.6)", "font-size": "14px",
        },
        slate: {
            surface: "#1f232b", "surface-elev": "#292e38", "surface-raised": "#191d24",
            border: "#3a4150", text: "#e6e9ee", "text-muted": "#9aa3b2",
            accent: "#94a3b8", "accent-hover": "#b6c2d4", "accent-text": "#1f232b",
            danger: "#ef4444", "danger-text": "#ffffff",
            radius: "12px", shadow: "0 18px 50px rgba(0, 0, 0, 0.5)", "font-size": "14px",
        },
    };

    // ─── Application DOM ────────────────────────────────────────────────────
    function root() {
        return typeof document !== "undefined" ? document.documentElement : null;
    }

    // Préfixe une clé de token : passé tel quel si déjà "--", sinon --holaf-*.
    function prefixKey(key) {
        return key.indexOf("--") === 0 ? key : PREFIX + key;
    }

    // Prend un objet { key: value } (clés sans préfixe ou avec) → objet de
    // variables --holaf-* prêtes pour la pose.
    function tokenVars(values) {
        const vars = {};
        Object.keys(values).forEach((k) => {
            if (values[k] === undefined || values[k] === null) return;
            vars[prefixKey(k)] = String(values[k]);
        });
        return vars;
    }

    function dispatch(theme) {
        if (typeof document === "undefined") return;
        document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { theme } }));
    }

    // Pose des variables --holaf-* sur :root et met à jour l'état interne.
    // `name` = nom de preset (ou null si palette custom). `explicit` distingue
    // la pose volontaire de l'hôte du preset initial automatique.
    function applyTokens(values, name, explicit) {
        const el = root();
        const vars = tokenVars(values);
        if (el) {
            Object.keys(vars).forEach((k) => el.style.setProperty(k, vars[k]));
        }
        currentName = name || null;
        appliedVars = vars;
        if (explicit) explicitChoice = true;
        initialized = true;
        dispatch(name || { vars: Object.assign({}, vars) });
    }

    // ─── Preset initial par défaut (prefers-color-scheme, si AUCUN choix) ──
    // Posé au chargement de la brique, UNIQUEMENT si l'hôte n'a pas déjà fait
    // un choix explicite (donc jamais après un setTheme/setTokens/applyPalette).
    function ensureInitial() {
        if (initialized || explicitChoice) return;
        let preset = "light";
        if (typeof window !== "undefined" && window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: dark)").matches) {
            preset = "dark";
        }
        applyTokens(PRESETS[preset], preset, false);
    }

    // ─── API publique ───────────────────────────────────────────────────────
    // setTokens({ name?, values }) — pose des tokens --holaf-* sur :root.
    function setTokens(spec) {
        if (!spec || typeof spec !== "object" || !spec.values || typeof spec.values !== "object") {
            throw new Error("[HolafTokens] setTokens : attendu { name?, values }.");
        }
        applyTokens(spec.values, spec.name || null, true);
        return getTheme();
    }

    // setTheme(presetName) — applique un des 4 presets (dark/light/midnight/slate).
    function setTheme(presetName) {
        const preset = PRESETS[presetName];
        if (!preset) {
            throw new Error(
                '[HolafTokens] setTheme : preset inconnu "' + presetName + '" — disponibles : ' +
                Object.keys(PRESETS).join(", ") + "."
            );
        }
        applyTokens(preset, presetName, true);
        return getTheme();
    }

    function listPresets() {
        return Object.keys(PRESETS);
    }

    // getTheme() → { name, vars } (copie) avec les variables actuellement posées,
    // ou les valeurs du dernier preset/tokens appliqué ; null si reset() fait.
    function getTheme() {
        if (!initialized || !appliedVars) {
            return currentName ? { name: currentName, vars: Object.assign({}, PRESETS[currentName] || {}) } : null;
        }
        return { name: currentName, vars: Object.assign({}, appliedVars) };
    }

    // applyPalette(accentHex, opts?) — calcule la palette via les calculs
    // internes (mix/contrast) et la pose. Base = preset en cours (sinon dark).
    function applyPalette(accentHex, opts) {
        const options = opts || {};
        // Base : les surfaces du preset en cours, sinon dark.
        const baseName = (currentName && PRESETS[currentName]) ? currentName : "dark";
        const base = PRESETS[baseName];
        const accent = options.accent || accentHex;
        // Validation de l'accent (throw clair) avant tout calcul.
        parseHex(accent);
        const hoverRatio = typeof options.hoverRatio === "number" ? options.hoverRatio : 0.15;
        const borderRatio = typeof options.borderRatio === "number" ? options.borderRatio : 0.22;
        const danger = options.danger || base.danger;
        const accentText = options.accentText
            || (contrastRatio(accent, "#000000") >= contrastRatio(accent, "#ffffff") ? "#000000" : "#ffffff");

        const palette = {
            surface: options.surface || base.surface,
            "surface-elev": options.surfaceElev || base["surface-elev"],
            "surface-raised": options.surfaceRaised || base["surface-raised"],
            border: options.border || mix(base.surface, accent, borderRatio),
            text: options.text || base.text,
            "text-muted": options.textMuted || mix(base.text, base.surface, 0.42),
            accent: toHex.apply(null, parseHex(accent)),
            "accent-hover": options.accentHover || mix(accent, base.surface, hoverRatio),
            "accent-text": accentText,
            danger: toHex.apply(null, parseHex(danger)),
            "danger-text": options.dangerText || base["danger-text"],
            radius: options.radius || base.radius,
            shadow: options.shadow || base.shadow,
            "font-size": options.fontSize || base["font-size"],
        };
        // danger-hover dérivé.
        palette["danger-hover"] = mix(danger, base.surface, hoverRatio);
        applyTokens(palette, null, true);
        return getTheme();
    }

    // reset() — retire TOUTES les variables --holaf-* posées par la brique.
    function reset() {
        const el = root();
        if (el && appliedVars) {
            Object.keys(appliedVars).forEach((k) => el.style.removeProperty(k));
        }
        currentName = null;
        appliedVars = null;
        // Ne réarme PAS le presets initial automatique : après reset, on est
        // « sans thème » jusqu'au prochain choix de l'hôte.
        dispatch(null);
    }

    // ─── Injection CSS minimale (une seule fois) ────────────────────────────
    // La brique ne rend rien : le CSS injecté est un simple repère documentant
    // que les variables proviennent du JS, rien de scopé. Guard idempotent.
    const CSS_ID = "holaf-tokens-style";
    function ensureCss() {
        if (typeof document === "undefined") return;
        if (document.getElementById(CSS_ID)) return;
        const style = document.createElement("style");
        style.id = CSS_ID;
        style.textContent =
            "/* HolafTokens (FONDATION) : les variables --holaf-* sont posées " +
            "sur :root par cette brique (JS), aucune règle scopée nécessaire " +
            "— la brique est sans rendu. */";
        const head = document.head || document.documentElement;
        if (head) head.appendChild(style);
    }

    // ─── Initialisation au chargement ───────────────────────────────────────
    ensureCss();
    ensureInitial();

    return {
        VERSION,
        setTokens,
        setTheme,
        getTheme,
        applyPalette,
        reset,
        listPresets,
        PREFIX,
        PRESETS: (function () { const c = {}; Object.keys(PRESETS).forEach((k) => { c[k] = Object.assign({}, PRESETS[k]); }); return c; })(),
    };
})();

// Exposition globale (scripts classiques de la page).
if (typeof window !== "undefined") {
    window.HolafTokens = HolafTokens;
}

// Export ESM (import { HolafTokens } from "./holaf-tokens.js").
export { HolafTokens };
