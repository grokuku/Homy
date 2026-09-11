/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafAmbient · version 0.2.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Fonds animés canvas, « sans style » : la brique dessine MAIS ne touche PAS
 * au layout. Le host fournit un <canvas> (existant ou via sélecteur) et le
 * positionne/size lui-même ; la brique ne modifie que le backing store
 * (canvas.width/height) et le contenu dessiné — jamais de CSS sur l'élément.
 *
 * Zéro dépendance runtime, zéro CSS injecté, fond TRANSPARENT (le fond de page
 * du host reste visible).
 *
 * 3 modes :
 *   'waves'     — rubans liquides : bande remplie (halo diffus + corps à
 *                 dégradé vertical + ligne de crête) qui suit 2 sinusoïdes.
 *   'particles' — halos en profondeur (parallaxe) + liaisons douces optionnelles.
 *   'aurora'    — nappes lumineuses sur trajectoires Lissajous continues.
 *
 * ─── Changements 0.1.0 → 0.2.0 (refonte du rendu + corrections) ─────────────
 *  1. `speed` appliqué UNE fois : la 0.1.0 multipliait le temps déjà scalé par
 *     `speed` (waves/aurora) → vitesse au carré (`speed: 2` = 4× plus rapide).
 *  2. Animation indépendante du framerate : horloge dt (bornée à 50 ms).
 *  3. `density` (1..100) = curseur d'INTENSITÉ commun aux 3 modes, avec un
 *     nombre d'éléments sensé pour chacun (0.1.0 : 10 par défaut donnait 10
 *     particules invisibles et 10 nappes géantes en aurora).
 *  4. Palette étalée sur tout le cycle : chaque élément a sa teinte au lieu de
 *     quasi toutes identiques (décalages de 260 ms pour un cycle de 3,6 s).
 *  5. waves : plus de `clip()` par bande (produisait des rayures horizontales
 *     répétées) ni de trait de 2 px jamais tracé (code mort).
 *  6. particles : vitesses en px/s (0.1.0 : ~0,5 px/s = quasi immobiles),
 *     halos pré-rendus (sprites en cache), profondeur, wrap, liaisons colorées.
 *  7. aurora : plus de plaque de fond opaque `rgba(8,10,18,.85)` (contraire au
 *     contrat « sans style »), trajectoires sans `% 1` (les taches sautaient
 *     d'un bord à l'autre), énergie normalisée selon le nombre de nappes.
 *  8. Nouvelle option `blur` (0..40 px) : flou gaussien global du rendu (canvas
 *     hors-écran recomposé via ctx.filter — aucun CSS sur l'élément).
 *  9. Redimensionnement : le backing store est redessiné immédiatement (0.1.0 :
 *     un resize pendant une pause / en reduced-motion laissait le fond VIDE).
 * 10. Anti-banding : passe de bruit `source-atop` très légère (désactivée si
 *     `blur >= 2`, sur très grand canvas, ou si le contexte ne la supporte pas).
 *
 * PERFORMANCE OBLIGATOIRE :
 *   - requestAnimationFrame (une seule boucle par instance).
 *   - devicePixelRatio respecté (backing store = css × dpr).
 *   - pause automatique sur document.visibilitychange ('hidden').
 *   - prefers-reduced-motion : rendu STATIQUE (une seule frame, pas de boucle).
 *   - ResizeObserver sur le target : re-dimensionnement + regénération.
 *   - destroy() = cancelAnimationFrame + disconnect observer + listeners retirés
 *     (aucune fuite).
 *
 * Fichier DUAL : module ES (export) + global window.HolafAmbient — se charge
 * via <script type="module"> ou `import { HolafAmbient }`.
 * ═════════════════════════════════════════════════════════════════════════ */

const HolafAmbient = (function () {
    "use strict";

    const VERSION = "0.2.0";
    const TAU = Math.PI * 2;
    const DEFAULT_COLORS = ["#3b82f6", "#22d3ee", "#a78bfa", "#f472b6", "#fbbf24"];

    // Durée d'un palette-step du cycle de couleur (secondes d'effet).
    const CYCLE_STEP_S = 3.6;
    // Grain anti-banding (source-atop sur le contenu déjà dessiné).
    const GRAIN_ALPHA = 0.022;

    // ── Helpers couleur ────────────────────────────────────────────────────
    function hexToRgb(hex) {
        const m = String(hex).replace(/^#/, "").match(/[\da-fA-F]{2}/g);
        if (!m || m.length < 3) return [128, 128, 128];
        return m.slice(0, 3).map((c) => parseInt(c, 16));
    }

    function blendRgb(a, b, t) {
        const f = t < 0 ? 0 : t > 1 ? 1 : t;
        return [
            a[0] + (b[0] - a[0]) * f,
            a[1] + (b[1] - a[1]) * f,
            a[2] + (b[2] - a[2]) * f,
        ];
    }

    function rgba(rgb, alpha) {
        return (
            "rgba(" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0) + "," + alpha + ")"
        );
    }

    // Couleur du cycle à l'instant tSec (secondes d'effet), en interpolant en
    // continu d'une couleur de la palette à la suivante.
    function cycleColor(pal, tSec) {
        if (!pal.length) return [128, 128, 128];
        if (pal.length === 1) return pal[0];
        const n = pal.length;
        const pos = ((tSec / CYCLE_STEP_S) % n + n) % n;
        const i0 = Math.floor(pos);
        return blendRgb(pal[i0], pal[(i0 + 1) % n], pos - i0);
    }

    // Décalage pour étaler N éléments sur TOUT le cycle (pas 260 ms).
    function spread(pal, index, count) {
        return (index * pal.length * CYCLE_STEP_S) / Math.max(1, count);
    }

    // ── Helpers math ───────────────────────────────────────────────────────
    function rand(min, max) {
        return min + Math.random() * (max - min);
    }

    function clamp(v, lo, hi) {
        return v < lo ? lo : v > hi ? hi : v;
    }

    // Curseur d'intensité 1..100 → nombre d'éléments par mode.
    function elementCount(mode, density) {
        const d = clamp(Number(density) || 10, 1, 100);
        if (mode === "particles") return Math.round(clamp(d * 6, 20, 220));
        if (mode === "aurora") return Math.round(clamp(d * 0.6, 3, 10));
        return Math.round(clamp(d * 0.5, 2, 10)); // waves : rubans
    }

    // ── Sprites / textures mis en cache ────────────────────────────────────
    // Halo radial pré-rendu (1 par couleur de palette) : dessiner 200
    // particules = 200 drawImage, pas 200 createRadialGradient par frame.
    // Renvoie null si les canvas hors-écran ne sont pas disponibles → l'appelant
    // retombe sur un simple disque (dégradation, aucun plantage).
    function makeGlowSprite(rgb, px) {
        let c = null;
        let g = null;
        try {
            c = document.createElement("canvas");
            c.width = px;
            c.height = px;
            g = c.getContext && c.getContext("2d");
        } catch (e) {
            return null;
        }
        if (!g || typeof g.createRadialGradient !== "function") return null;
        const r = px / 2;
        const grad = g.createRadialGradient(r, r, 0, r, r, r);
        grad.addColorStop(0, rgba(rgb, 1));
        grad.addColorStop(0.22, rgba(rgb, 0.78));
        grad.addColorStop(0.5, rgba(rgb, 0.28));
        grad.addColorStop(1, rgba(rgb, 0));
        g.fillStyle = grad;
        g.fillRect(0, 0, px, px);
        return c;
    }

    // Texture de bruit (anti-banding). Renvoie null si le contexte ne permet pas
    // de la fabriquer (createImageData / createPattern absents) → grain sauté.
    function makeNoisePattern(ctx) {
        if (
            typeof ctx.createPattern !== "function" ||
            typeof ctx.createImageData !== "function" ||
            typeof ctx.putImageData !== "function"
        ) {
            return null;
        }
        const N = 128;
        let g = null;
        let c = null;
        try {
            c = document.createElement("canvas");
            c.width = N;
            c.height = N;
            g = c.getContext && c.getContext("2d");
        } catch (e) {
            return null;
        }
        if (!g) return null;
        const img = g.createImageData(N, N);
        const data = img.data;
        for (let i = 0; i < data.length; i += 4) {
            const v = 180 + ((Math.random() * 76) | 0);
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        return ctx.createPattern(c, "repeat");
    }

    // `ctx.filter` (flou) manque aux CanvasRenderingContext2D de Safari < 18 :
    // dans ce cas le flou global est simplement ignoré (l'effet reste net) au
    // lieu de faire payer un canvas hors-écran pour rien.
    function supportsFilter(ctx) {
        if (typeof ctx.filter !== "undefined") return true;
        return (
            typeof CanvasRenderingContext2D !== "undefined" &&
            "filter" in CanvasRenderingContext2D.prototype
        );
    }

    // ── create() ───────────────────────────────────────────────────────────
    function create(opts) {
        if (!opts || !opts.target) {
            throw new Error("[HolafAmbient] create : l'option `target` est requise (canvas ou sélecteur).");
        }

        let canvas;
        if (typeof opts.target === "string") {
            canvas = document.querySelector(opts.target);
            if (!canvas) {
                throw new Error("[HolafAmbient] create : aucun élément trouvé pour le sélecteur '" + opts.target + "'.");
            }
        } else {
            canvas = opts.target;
        }
        if (!canvas || canvas.nodeType !== 1 || canvas.tagName !== "CANVAS") {
            throw new Error("[HolafAmbient] create : le target doit être un élément <canvas>.");
        }
        const ctx = canvas.getContext && canvas.getContext("2d");
        if (!ctx) {
            throw new Error("[HolafAmbient] create : impossible d'obtenir un contexte 2D sur ce canvas (non supporté ?).");
        }

        const defaults = {
            mode: "waves",
            colors: DEFAULT_COLORS.slice(),
            speed: 1,
            density: 10,
            opacity: 1,
            links: true,
            blur: 0,
            grain: GRAIN_ALPHA,
        };
        let config = { ...defaults };

        function normalizeConfig(partial) {
            const c = { ...config, ...(partial || {}) };
            if (c.mode !== "waves" && c.mode !== "particles" && c.mode !== "aurora") {
                throw new Error(
                    "[HolafAmbient] mode inconnu : '" + c.mode + "' (attendu : waves | particles | aurora)."
                );
            }
            if (Array.isArray(c.colors)) {
                c.colors = c.colors.filter((x) => x && typeof x === "string");
            }
            if (!c.colors || !c.colors.length) c.colors = DEFAULT_COLORS.slice();
            c.speed = Number.isFinite(Number(c.speed)) && Number(c.speed) >= 0 ? Number(c.speed) : 1;
            c.opacity = clamp(Number.isFinite(Number(c.opacity)) ? Number(c.opacity) : 1, 0, 1);
            c.density = clamp(Number.isFinite(Number(c.density)) ? Number(c.density) : 10, 1, 100);
            // Flou global du rendu, en px CSS (0 = net). Plafonné à 40 px :
            // au-delà l'effet n'est plus qu'une tache.
            c.blur = clamp(Number.isFinite(Number(c.blur)) ? Number(c.blur) : 0, 0, 40);
            c.grain = clamp(Number.isFinite(Number(c.grain)) ? Number(c.grain) : GRAIN_ALPHA, 0, 0.2);
            return c;
        }

        // ── État ───────────────────────────────────────────────────────────
        let destroyed = false;
        let paused = false;
        let reducedMotion = false;
        let animId = null;
        let lastTs = 0;
        let cssW = 0;
        let cssH = 0;
        let dpr = 1;
        let ro = null;

        // Horloge d'effet (secondes, déjà multipliée par speed).
        let effectT = 0;

        const st = {
            pal: [],
            sprites: null, // Map hex → canvas
            noise: null,
            buf: null, // canvas hors-écran utilisé quand blur > 0
            particles: [],
            particlesKey: "",
        };

        function invalidatePalette() {
            st.pal = config.colors.map(hexToRgb);
            st.sprites = null;
        }

        function sprites() {
            if (!st.sprites) {
                const sp = new Map();
                for (const hex of config.colors) sp.set(hex, makeGlowSprite(hexToRgb(hex), 128));
                st.sprites = sp;
            }
            return st.sprites;
        }
        // ── Mesure / backing store ─────────────────────────────────────────
        function measure() {
            dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
            cssW = canvas.clientWidth || canvas.width || 0;
            cssH = canvas.clientHeight || canvas.height || 0;
        }

        function resizeBacking() {
            measure();
            const cw = Math.max(1, Math.floor(cssW * dpr));
            const ch = Math.max(1, Math.floor(cssH * dpr));
            if (canvas.width !== cw) canvas.width = cw;
            if (canvas.height !== ch) canvas.height = ch;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            buildParticles(true);
            // Redimensionner le backing store EFFACE le canvas : on redessine
            // immédiatement (sinon une frame vide reste à l'écran quand la
            // boucle est en pause, en reduced-motion ou throttlée).
            if (!destroyed) draw(effectT, 0);
        }

        // ── Particules (profondeur + vitesses en px/s) ─────────────────────
        function buildParticles(force) {
            if (config.mode !== "particles" || cssW <= 0 || cssH <= 0) {
                st.particles = [];
                return;
            }
            const n = elementCount("particles", config.density);
            const key = n + "x" + Math.round(cssW) + "x" + Math.round(cssH);
            if (!force && key === st.particlesKey) return;
            st.particlesKey = key;
            st.particles = [];
            for (let i = 0; i < n; i++) {
                const z = Math.pow(Math.random(), 0.7); // 0 = loin, 1 = proche
                st.particles.push({
                    x: rand(0, cssW),
                    y: rand(0, cssH),
                    // px/s : ~4 px/s (loin) à ~22 px/s (proche)
                    vx: rand(-1, 1) * (4 + 18 * z),
                    vy: rand(-1, 1) * (4 + 18 * z),
                    z,
                    seed: Math.random() * 100,
                    r: 1.0 + z * 2.4,
                    a: 0.55 + z * 0.45,
                    ci: i % Math.max(1, st.pal.length || config.colors.length),
                });
            }
        }

        // =================================================================
        //  MODES
        // =================================================================

        // waves — rubans liquides : chaque ruban est une bande remplie dont le
        // tracé suit 2 sinusoïdes superposées ; plus de clip() en bandes
        // horizontales répétées (v1), le fondu se fait par dégradé vertical.
        function drawWaves(g, w, h, T, cfg) {
            const n = elementCount("waves", cfg.density);
            const pal = st.pal;
            g.save();
            g.globalCompositeOperation = "lighter";
            const step = Math.max(2, w / 180);

            for (let i = 0; i < n; i++) {
                const depth = n > 1 ? i / (n - 1) : 0.5; // 0 = loin (haut), 1 = proche
                const cy = h * (0.10 + 0.80 * depth) + Math.sin(T * 0.13 + i * 1.3) * h * 0.035;
                const amp = h * (0.045 + 0.075 * depth);
                const thick = h * (0.055 + 0.115 * depth);
                const k1 = 1.05 + (i % 3) * 0.42;
                const sp = 0.10 + 0.14 * (1 - depth); // les lointains défilent plus lentement
                const col = cycleColor(pal, T + spread(pal, i, n));
                const baseA = cfg.opacity * (0.055 + 0.085 * depth);

                const edge = (x, sign, fat) =>
                    cy +
                    sign * thick * fat * 0.5 * (1 + 0.35 * Math.sin((x / w) * TAU * 1.7 + T * 0.5 + i)) +
                    amp * Math.sin((x / w) * TAU * k1 + T * sp * TAU * 0.35 + i * 1.7) +
                    amp * 0.34 * Math.sin((x / w) * TAU * (k1 * 2.13) - T * sp * TAU * 0.5 + i * 0.6);

                // 1. halo (ruban large, très diffus)
                g.fillStyle = rgba(col, baseA * 0.34);
                g.beginPath();
                for (let x = 0; x <= w + step; x += step) g.lineTo(x, edge(x, -1, 2.1));
                for (let x = w; x >= -step; x -= step) g.lineTo(x, edge(x, 1, 2.1));
                g.closePath();
                g.fill();

                // 2. corps du ruban (fondu vertical par dégradé)
                const grad = g.createLinearGradient(0, cy - thick, 0, cy + thick);
                grad.addColorStop(0, rgba(col, 0));
                grad.addColorStop(0.5, rgba(col, baseA));
                grad.addColorStop(1, rgba(col, 0));
                g.fillStyle = grad;
                g.beginPath();
                for (let x = 0; x <= w + step; x += step) g.lineTo(x, edge(x, -1, 1));
                for (let x = w; x >= -step; x -= step) g.lineTo(x, edge(x, 1, 1));
                g.closePath();
                g.fill();

                // 3. cœur lumineux (fine ligne crête → donne du « corps »)
                g.strokeStyle = rgba(col, baseA * 1.15);
                g.lineWidth = 1.4;
                g.beginPath();
                for (let x = 0; x <= w + step; x += step) {
                    const y = edge(x, 0, 1);
                    if (x === 0) g.moveTo(x, y);
                    else g.lineTo(x, y);
                }
                g.stroke();
            }
            g.restore();
        }

        // particles — halos en profondeur + liaisons douces entre voisins.
        function drawParticles(g, w, h, T, cfg, dt) {
            const ps = st.particles;
            if (!ps.length) return;
            const spritesMap = sprites();
            const hexes = cfg.colors;
            const motion = dt * cfg.speed;
            const pad = 24;
            g.save();
            g.globalCompositeOperation = "lighter";

            // Intégration (px/s → px) + wrap (évite les paquets dans les coins).
            for (const p of ps) {
                p.x += p.vx * motion;
                p.y += p.vy * motion;
                // dérive douce : évite les trajectoires rectilignes
                p.x += Math.sin(T * 0.35 + p.seed) * 6 * motion;
                p.y += Math.cos(T * 0.29 + p.seed * 1.3) * 6 * motion;
                if (p.x < -pad) p.x = w + pad;
                else if (p.x > w + pad) p.x = -pad;
                if (p.y < -pad) p.y = h + pad;
                else if (p.y > h + pad) p.y = -pad;
            }

            // Liaisons (naïf O(n²) plafonné : count ≤ 200 → ≤ 19 900 paires).
            if (cfg.links !== false) {
                const linkDist = clamp(Math.min(w, h) * 0.18, 70, 190);
                const d2max = linkDist * linkDist;
                g.lineWidth = 1;
                for (let i = 0; i < ps.length; i++) {
                    const a = ps[i];
                    for (let j = i + 1; j < ps.length; j++) {
                        const b = ps[j];
                        const dx = a.x - b.x;
                        const dy = a.y - b.y;
                        const d2 = dx * dx + dy * dy;
                        if (d2 >= d2max) continue;
                        const f = 1 - Math.sqrt(d2) / linkDist;
                        const alpha = f * f * 0.30 * cfg.opacity * Math.min(a.a, b.a);
                        const rgb = blendRgb(st.pal[a.ci % st.pal.length], st.pal[b.ci % st.pal.length], 0.5);
                        g.strokeStyle = rgba(rgb, alpha);
                        g.beginPath();
                        g.moveTo(a.x, a.y);
                        g.lineTo(b.x, b.y);
                        g.stroke();
                    }
                }
            }

            // Halos (sprites) — taille ∝ profondeur. Si les sprites ne sont pas
            // disponibles (pas de canvas hors-écran), on dessine un disque simple.
            for (const p of ps) {
                const hex = hexes[p.ci % hexes.length];
                const sprite = hex ? spritesMap.get(hex) : null;
                const rgb = st.pal[p.ci % st.pal.length] || [128, 128, 128];
                const R = p.r * 8.5;
                g.globalAlpha = cfg.opacity * p.a;
                if (sprite) {
                    g.drawImage(sprite, p.x - R, p.y - R, R * 2, R * 2);
                } else {
                    g.fillStyle = rgba(rgb, 1);
                    g.beginPath();
                    g.arc(p.x, p.y, p.r, 0, TAU);
                    g.fill();
                }
            }
            g.globalAlpha = 1;
            g.restore();
        }

        // aurora — nappes lumineuses sur trajectoires Lissajous continues
        // (aucun modulo → aucune téléportation), fond transparent, énergie
        // normalisée selon le nombre de nappes.
        function drawAurora(g, w, h, T, cfg) {
            const n = elementCount("aurora", cfg.density);
            const pal = st.pal;
            const diag = Math.hypot(w, h);
            const energy = clamp(2.0 / n, 0.20, 0.60);
            g.save();
            g.globalCompositeOperation = "lighter";

            for (let i = 0; i < n; i++) {
                const ph = i * 2.39996; // angle d'or : répartition stable
                const w1 = 0.052 + 0.017 * (i % 3);
                const w2 = 0.043 + 0.015 * ((i + 1) % 3);
                const cx = w * (0.5 + 0.34 * Math.sin(T * w1 + ph));
                const cy = h * (0.5 + 0.31 * Math.cos(T * w2 + ph * 1.7));
                const rr = diag * (0.26 + 0.10 * Math.sin(T * 0.075 + ph));
                const rx = Math.max(2, rr * (0.85 + 0.22 * Math.sin(T * 0.05 + i)));
                const ry = Math.max(2, rr * (0.58 + 0.18 * Math.cos(T * 0.06 + i * 2)));
                const col = cycleColor(pal, T + spread(pal, i, n));
                const a0 = cfg.opacity * energy;

                const grad = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
                grad.addColorStop(0, rgba(col, 0.85 * a0));
                grad.addColorStop(0.32, rgba(col, 0.42 * a0));
                grad.addColorStop(0.62, rgba(col, 0.14 * a0));
                grad.addColorStop(1, rgba(col, 0));
                g.fillStyle = grad;
                g.beginPath();
                g.ellipse(cx, cy, rx, ry, 0, 0, TAU);
                g.fill();
            }
            g.globalAlpha = 1;
            g.restore();
        }

        // ── Grain anti-banding (n'agit que sur le contenu déjà dessiné) ────
        // Coût = 1 fillRect plein écran : on le saute sur les très grands
        // canvas (4K + DPR 2) où il coûterait plus qu'il n'apporte, et dès
        // qu'un flou global est demandé (le flou masque déjà le banding).
        function drawGrain(g, w, h, cfg) {
            if (!(cfg.grain > 0)) return;
            if (cfg.blur >= 2) return;
            if (w * h > 2600000) return;
            if (!st.noise) st.noise = makeNoisePattern(g) || false;
            if (!st.noise) return;
            g.save();
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.globalCompositeOperation = "source-atop";
            g.globalAlpha = cfg.grain;
            g.fillStyle = st.noise;
            g.fillRect(0, 0, w, h);
            g.restore();
        }

        // ── Tampon hors-écran (uniquement si blur > 0) ─────────────────────
        // Tampon hors-écran utilisé uniquement quand `blur > 0`. Si les canvas
        // hors-écran ne sont pas utilisables, on renvoie null et le flou est
        // simplement ignoré (dessin direct, aucun plantage).
        function ensureBuf(cw, ch) {
            if (!st.buf || st.buf.w !== cw || st.buf.h !== ch) {
                let c = null;
                let g = null;
                try {
                    c = document.createElement("canvas");
                    c.width = cw;
                    c.height = ch;
                    g = c.getContext && c.getContext("2d");
                } catch (e) {
                    return null;
                }
                if (!g) return null;
                st.buf = { canvas: c, ctx: g, w: cw, h: ch };
            }
            return st.buf;
        }

        // ── Frame ──────────────────────────────────────────────────────────
        function draw(T, dt) {
            const w = cssW;
            const h = cssH;
            if (w <= 0 || h <= 0) return;
            const cw = canvas.width;
            const ch = canvas.height;
            const blurred = config.blur > 0 && supportsFilter(ctx);
            const buf = blurred ? ensureBuf(cw, ch) : null;
            const g = buf ? buf.ctx : ctx;

            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.globalCompositeOperation = "source-over";
            g.globalAlpha = 1;
            g.filter = "none";
            g.clearRect(0, 0, w, h);

            switch (config.mode) {
                case "particles":
                    drawParticles(g, w, h, T, config, dt);
                    break;
                case "aurora":
                    drawAurora(g, w, h, T, config);
                    break;
                case "waves":
                default:
                    drawWaves(g, w, h, T, config);
                    break;
            }

            if (blurred && buf) {
                // Recompose le tampon sur le canvas visible, flouté d'un coup.
                // Le léger sur-échantillonnage (pad = rayon) évite que le flou
                // ne « décroche » du bord (fondu transparent sur les bords).
                const pad = config.blur * dpr;
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalCompositeOperation = "source-over";
                ctx.globalAlpha = 1;
                ctx.clearRect(0, 0, cw, ch);
                ctx.filter = "blur(" + pad + "px)";
                ctx.drawImage(buf.canvas, -pad, -pad, cw + pad * 2, ch + pad * 2);
                ctx.filter = "none";
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }

            drawGrain(ctx, w, h, config);
        }

        // ── Boucle ─────────────────────────────────────────────────────────
        function frame(ts) {
            if (!shouldRun()) return;
            if (!lastTs) lastTs = ts;
            const rawDt = Math.min(0.05, Math.max(0, (ts - lastTs) / 1000));
            lastTs = ts;
            // `effectT` avance à la vitesse demandée (phases, couleurs) ; les
            // modes reçoivent le dt RÉEL et appliquent `speed` eux-mêmes une
            // seule fois (sinon la vitesse serait au carré : bug 0.1.0).
            effectT += rawDt * (config.speed || 0);
            draw(effectT, rawDt);
            if (shouldRun()) animId = requestAnimationFrame(frame);
        }

        function shouldRun() {
            if (destroyed || paused || reducedMotion) return false;
            if (typeof document !== "undefined" && document.hidden) return false;
            return true;
        }

        function startLoop() {
            if (animId !== null) return;
            lastTs = 0;
            animId = requestAnimationFrame(frame);
        }

        function stopLoop() {
            if (animId !== null) {
                cancelAnimationFrame(animId);
                animId = null;
            }
            lastTs = 0;
        }

        function pause() {
            paused = true;
            stopLoop();
        }

        function resume() {
            paused = false;
            if (reducedMotion) {
                draw(effectT, 0);
                return;
            }
            startLoop();
        }

        // ── API ────────────────────────────────────────────────────────────
        const instance = {
            VERSION,

            getConfig() {
                return { ...config };
            },

            setConfig(partial) {
                const prev = config;
                const next = normalizeConfig(partial);
                const colorsChanged = next.colors.join(",") !== (prev.colors || []).join(",");
                const modeChanged = next.mode !== prev.mode;
                const densityChanged = next.density !== prev.density;
                config = next;
                if (colorsChanged) invalidatePalette();
                if (modeChanged || densityChanged) buildParticles(true);
                if (next.speed !== prev.speed) lastTs = 0; // pas de saut d'horloge
                if (!reducedMotion && !paused) draw(effectT, 0);
            },

            pause,
            resume,

            destroy() {
                if (destroyed) return;
                destroyed = true;
                stopLoop();
                if (ro) {
                    ro.disconnect();
                    ro = null;
                }
                if (typeof document !== "undefined") {
                    document.removeEventListener("visibilitychange", onVisibility);
                }
                st.particles = [];
                st.sprites = null;
                st.noise = null;
                st.buf = null;
                canvas = null;
            },
        };

        // ── visibility / reduced-motion ────────────────────────────────────
        function onVisibility() {
            if (document.hidden) {
                stopLoop();
            } else if (!paused && !destroyed) {
                if (reducedMotion) draw(effectT, 0);
                else startLoop();
            }
        }

        try {
            if (typeof window !== "undefined" && window.matchMedia) {
                reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            }
        } catch (e) {
            reducedMotion = false;
        }

        // ── Init ───────────────────────────────────────────────────────────
        config = normalizeConfig(opts);
        invalidatePalette();
        measure();
        // resizeBacking() dessine une première frame (il redimensionne le
        // backing store, ce qui efface le canvas → il le repeint aussitôt).
        // Cela couvre déjà le cas reduced-motion (une seule frame, pas de boucle).
        resizeBacking();

        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
            document.addEventListener("visibilitychange", onVisibility);
        }

        if (typeof ResizeObserver !== "undefined") {
            ro = new ResizeObserver(() => {
                if (destroyed) return;
                resizeBacking();
                if (!paused && !reducedMotion && document.hidden === false) {
                    if (animId === null) startLoop();
                }
            });
            ro.observe(canvas);
        }

        if (!reducedMotion) startLoop();

        return instance;
    }

    // `elementCount` est exposé pour que les hôtes (UI de réglages) puissent
    // afficher « ≈ N rubans / N particules / N nappes » selon la densité.
    return { version: VERSION, create, elementCount };
})();

if (typeof window !== "undefined") {
    window.HolafAmbient = HolafAmbient;
}

export { HolafAmbient };
