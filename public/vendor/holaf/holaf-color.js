/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafColor · version 0.1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Utilitaires couleur en PUR JS, SANS DOM et SANS CSS.
 * Brique « sans style » (comme viewport) : elle ne touche à aucun DOM, ne pose
 * aucune variable CSS ni feuille de style. C'est une boîte à outils pure,
 * réutilisable par n'importe quelle autre brique (dont HolafTokens, qui
 * RÉIMPLÉMENTE une version minimale de mix/contrast sans dépendre de nous).
 *
 * API :
 *   hexToRgb(hex)   → [r, g, b]            (0-255, entiers)
 *   rgbToHex(r,g,b) → "#rrggbb"            (accepte [r,g,b] ou {r,g,b})
 *   hexToHsl(hex)   → [h, s, l]            (h 0-360, s/l 0-100)
 *   hslToHex(h,s,l) → "#rrggbb"
 *   rgbToHsl(r,g,b) → [h, s, l]
 *   hslToRgb(h,s,l) → [r, g, b]
 *   mix(a, b, ratio)            → "#rrggbb"   ratio 0..1 = part de b
 *   lighten(hex, amount)        → "#rrggbb"   mélange vers blanc
 *   darken(hex, amount)         → "#rrggbb"   mélange vers noir
 *   contrastRatio(a, b)         → nombre      WCAG 2.1 (1..21, luminance relative)
 *   readableText(bg, dark?, light?)                            → "#rrggbb"
 *   generateTheme(accent, options?)                            → objet palette
 *
 * Contraite de contraste : textes ≥ 4.5:1 (WCAG AA) — voir contrastRatio /
 * readableText / generateTheme.
 *
 * Les entrées sont VALIDÉES : un hex invalide lève une Error claire
 * (« hex invalide : … »). Les autres arguments (ratio hors bornes, etc.)
 * sont bornés/coercés proprement plutôt que de lever.
 *
 * Fichier DUAL : module ES (export) + global window.HolafColor — se charge
 * via <script type="module"> ou `import { HolafColor }`.
 * ═════════════════════════════════════════════════════════════════════════ */

const HolafColor = (function () {
    "use strict";

    const VERSION = "0.1.0";

    // ─── Validation / parsing d'un hex ─────────────────────────────────────
    // Accepte "#rgb" ou "#rrggbb" (le '#' est facultatif). Lève une Error
    // claire si le format est invalide.
    function parseHex(hex) {
        if (typeof hex !== "string") {
            throw new Error("[HolafColor] hex invalide : " + String(hex) + " (chaîne attendue).");
        }
        let h = hex.trim();
        if (h.charAt(0) === "#") h = h.slice(1);
        if (h.length === 3) {
            h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        }
        if (!/^[0-9a-fA-F]{6}$/.test(h)) {
            throw new Error('[HolafColor] hex invalide : "' + hex + '" (attendu "#rgb" ou "#rrggbb").');
        }
        return [
            parseInt(h.slice(0, 2), 16),
            parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16),
        ];
    }

    // ─── Conversion rgb ↔ hex ──────────────────────────────────────────────
    function clamp255(v) {
        return Math.max(0, Math.min(255, Math.round(v)));
    }

    // rgbToHex accepte (r,g,b), [r,g,b] ou {r,g,b}.
    function rgbToHex(r, g, b) {
        if (Array.isArray(r)) { b = r[2]; g = r[1]; r = r[0]; }
        else if (r && typeof r === "object") { const o = r; r = o.r; g = o.g; b = o.b; }
        const to2 = (n) => clamp255(n).toString(16).toUpperCase().padStart(2, "0");
        return "#" + to2(r) + to2(g) + to2(b);
    }

    function hexToRgb(hex) {
        return parseHex(hex);
    }

    // ─── RGB ↔ HSL ─────────────────────────────────────────────────────────
    // s/l renvoyés en pourcent (0-100), h en degrés (0-360).
    function rgbToHsl(r, g, b) {
        if (Array.isArray(r)) { b = r[2]; g = r[1]; r = r[0]; }
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h = 0, s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                default: h = (r - g) / d + 4; break;
            }
            h *= 60;
        }
        return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
    }

    function hslToRgb(h, s, l) {
        if (Array.isArray(h)) { l = h[2]; s = h[1]; h = h[0]; }
        h = ((h % 360) + 360) % 360;
        s = Math.max(0, Math.min(100, s)) / 100;
        l = Math.max(0, Math.min(100, l)) / 100;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c / 2;
        let r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; }
        else if (h < 120) { r = x; g = c; }
        else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; }
        else if (h < 300) { r = x; b = c; }
        else { r = c; b = x; }
        return [
            Math.round((r + m) * 255),
            Math.round((g + m) * 255),
            Math.round((b + m) * 255),
        ];
    }

    function hexToHsl(hex) {
        const [r, g, b] = parseHex(hex);
        return rgbToHsl(r, g, b);
    }

    function hslToHex(h, s, l) {
        return rgbToHex(hslToRgb(h, s, l));
    }

    // ─── Mélanges ──────────────────────────────────────────────────────────
    // mix(a, b, ratio) : ratio 0..1 = part de b dans le résultat. Accepte
    // hex ou [r,g,b]. Retourne un hex.
    function normalizeInput(v) {
        if (Array.isArray(v)) return rgbToHex(v);
        if (v && typeof v === "object") return rgbToHex(v);
        return v;
    }

    function mix(a, b, ratio) {
        let r = ratio;
        if (typeof r !== "number" || Number.isNaN(r)) r = 0.5;
        r = Math.max(0, Math.min(1, r));
        const ca = parseHex(normalizeInput(a));
        const cb = parseHex(normalizeInput(b));
        return rgbToHex(
            ca[0] + (cb[0] - ca[0]) * r,
            ca[1] + (cb[1] - ca[1]) * r,
            ca[2] + (cb[2] - ca[2]) * r
        );
    }

    function lighten(hex, amount) {
        const a = typeof amount === "number" && !Number.isNaN(amount)
            ? Math.max(0, Math.min(1, amount))
            : 0;
        return mix(hex, "#ffffff", a);
    }

    function darken(hex, amount) {
        const a = typeof amount === "number" && !Number.isNaN(amount)
            ? Math.max(0, Math.min(1, amount))
            : 0;
        return mix(hex, "#000000", a);
    }

    // ─── Contraste WCAG 2.1 (luminance relative) ──────────────────────────
    function channelLuminance(c) {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    function relativeLuminance(hex) {
        const [r, g, b] = parseHex(hex);
        return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
    }

    function contrastRatio(a, b) {
        const la = relativeLuminance(a);
        const lb = relativeLuminance(b);
        const lighter = Math.max(la, lb);
        const darker = Math.min(la, lb);
        return (lighter + 0.05) / (darker + 0.05);
    }

    // Retourne la couleur la plus lisible entre `dark` et `light` sur `bg` :
    // on préfère celle atteignant au moins 4.5:1 ; sinon la plus contrastée.
    function readableText(bg, dark, light) {
        const d = dark === undefined || dark === null ? "#000000" : dark;
        const l = light === undefined || light === null ? "#ffffff" : light;
        const rDark = contrastRatio(bg, d);
        const rLight = contrastRatio(bg, l);
        const darkOk = rDark >= 4.5;
        const lightOk = rLight >= 4.5;
        if (darkOk && !lightOk) return d;
        if (lightOk && !darkOk) return l;
        if (darkOk && lightOk) return rDark >= rLight ? d : l; // le plus contrasté
        return rDark >= rLight ? d : l; // aucun ne passe → le moins mauvais
    }

    // ─── Génération de palette depuis un accent ────────────────────────────
    // Retourne un objet de tokens COULEUR calculés (accent-hover = mix
    // accent/fond ~15 %, borders = mix ~20-30 %, surtaces dérivées, textes
    // lisibles ≥ 4.5:1). C'est un pur calcul : la brique ne pose rien.
    // Options : background, surface, text, danger, accentText, radius, shadow,
    //           hoverRatio (défaut 0.15), borderRatio (défaut 0.22).
    function generateTheme(accent, options) {
        const opts = options || {};
        const background = opts.background || "#ffffff";
        const surface = opts.surface || mix(background, parseHex(accent), 0.04);
        const hoverRatio = typeof opts.hoverRatio === "number" ? opts.hoverRatio : 0.15;
        const borderRatio = typeof opts.borderRatio === "number" ? opts.borderRatio : 0.22;

        const danger = opts.danger || "#dc2626";
        const baseText = opts.text || readableText(background, "#18181b", "#f4f4f5");

        return {
            accent: normalizeInput(accent),
            accentHover: mix(accent, surface, hoverRatio),
            accentText: opts.accentText || readableText(accent, "#000000", "#ffffff"),
            border: opts.border || mix(background, accent, borderRatio),
            borderSubtle: mix(background, accent, borderRatio * 0.5),
            surface: normalizeInput(surface),
            surfaceHover: mix(surface, accent, hoverRatio),
            background: normalizeInput(background),
            text: normalizeInput(baseText),
            textMuted: mix(baseText, background, 0.42),
            danger: normalizeInput(danger),
            dangerHover: mix(danger, surface, hoverRatio),
            dangerText: opts.dangerText || readableText(danger, "#000000", "#ffffff"),
            radius: opts.radius || "12px",
            shadow: opts.shadow || "0 4px 16px rgba(0, 0, 0, 0.12)",
        };
    }

    return {
        VERSION,
        hexToRgb,
        rgbToHex,
        hexToHsl,
        hslToHex,
        rgbToHsl,
        hslToRgb,
        mix,
        lighten,
        darken,
        contrastRatio,
        readableText,
        generateTheme,
    };
})();

// Exposition globale (scripts classiques de la page) — pattern IIFE du kit.
if (typeof window !== "undefined") {
    window.HolafColor = HolafColor;
}

// Export ESM (import { HolafColor } from "./holaf-color.js").
export { HolafColor };
