/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafAmbient · version 0.1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Fonds animés canvas, « sans style » : la brique dessine MAIS ne touche PAS
 * au layout. Le host fournit un <canvas> (existant ou via sélecteur) et le
 * positionne/sizing lui-même ; la brique ne modifie que le backing store
 * (canvas.width/height) et le contenu dessiné — jamais de CSS sur l'élément.
 *
 * Zéro dépendance runtime, zéro CSS injecté (brique sans style).
 *
 * 3 modes :
 *   'waves'     — lignes sinusoïdales superposées avec clipping par bande,
 *                 color cycling fluide (style AiKore welcome : blend hex
 *                 progressif entre les couleurs de la palette).
 *   'particles' — particules dérivantes + liaisons légères optionnelles.
 *   'aurora'    — dégradés organiques flous animés (overlays lumineux).
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

    const VERSION = "0.1.0";

    // Palette par défaut (accents froids, style AiKore — 5 couleurs).
    const DEFAULT_COLORS = ["#3b82f6", "#22d3ee", "#a78bfa", "#f472b6", "#fbbf24"];

    // Durée d'une « étape » du cycle de couleur (toutes couleurs confondues).
    const CYCLE_STEP_MS = 3600;

    // ── Helpers couleur (blend hex fluide, comme AiKore welcome) ────────────
    function hexToRgb(hex) {
        const m = String(hex).replace(/^#/, "").match(/[\da-fA-F]{2}/g);
        if (!m || m.length < 3) return [128, 128, 128];
        return m.slice(0, 3).map((c) => parseInt(c, 16));
    }

    function rgbToHex(r, g, b) {
        return (
            "#" +
            [r, g, b]
                .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
                .join("")
        );
    }

    // Mélange progressif entre deux couleurs hex pour t ∈ [0, 1].
    function blendHex(a, b, t) {
        const ta = Math.max(0, Math.min(1, t));
        const [rA, gA, bA] = hexToRgb(a);
        const [rB, gB, bB] = hexToRgb(b);
        return rgbToHex(
            rA + (rB - rA) * ta,
            gA + (gB - gA) * ta,
            bA + (bB - bA) * ta
        );
    }

    // Couleur du cycle à un instant donné : on parcourt la palette en boucle,
    // en interpolant en continu (blend fluide) d'une couleur à la suivante.
    function cycleColor(palette, tMs) {
        if (!palette.length) return DEFAULT_COLORS[0];
        if (palette.length === 1) return palette[0];
        const step = CYCLE_STEP_MS;
        const pos = (tMs % (step * palette.length)) / step;
        const idx = Math.floor(pos) % palette.length;
        const next = palette[(idx + 1) % palette.length];
        return blendHex(palette[idx], next, pos - Math.floor(pos));
    }

    // ── Helpers math ────────────────────────────────────────────────────────
    function rand(min, max) {
        return min + Math.random() * (max - min);
    }

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    // ── La brique ──────────────────────────────────────────────────────────
    function create(opts) {
        if (!opts || !opts.target) {
            throw new Error("[HolafAmbient] create : l'option `target` est requise (canvas ou sélecteur).");
        }

        // Résolution du target (canvas existant OU sélecteur).
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

        // ── Configuration interne (défauts) ────────────────────────────────
        const defaults = {
            mode: "waves",
            colors: DEFAULT_COLORS.slice(),
            speed: 1,
            density: 10,
            opacity: 1,
            links: true, // particules : liaison légère entre proches
        };
        let config = { ...defaults };

        function normalizeConfig(partial) {
            const c = { ...config, ...(partial || {}) };
            if (c.mode !== "waves" && c.mode !== "particles" && c.mode !== "aurora") {
                throw new Error(
                    "[HolafAmbient] mode inconnu : '" + c.mode +
                    "' (attendu : waves | particles | aurora)."
                );
            }
            if (c.colors) c.colors = c.colors.filter((x) => x && typeof x === "string");
            if (!c.colors || !c.colors.length) c.colors = DEFAULT_COLORS.slice();
            c.speed = Number.isFinite(c.speed) && c.speed >= 0 ? Number(c.speed) : 1;
            c.opacity = clamp(Number.isFinite(c.opacity) ? Number(c.opacity) : 1, 0, 1);
            return c;
        }

        // ── État de la boucle ──────────────────────────────────────────────
        let destroyed = false;
        let paused = false;              // pause explicite utilisateur
        let reducedMotion = false;       // prefers-reduced-motion
        let animId = null;
        let cssW = 0;
        let cssH = 0;
        let dpr = 1;
        let particles = [];
        let startT = 0;                  // référentiel temps (la boucle repart proprement)
        let ro = null;

        // ── Helpers d'échelle ───────────────────────────────────────────────
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
            regenerate();
        }

        // ── Régénération des particules (dépend de mode/densité) ──────────
        function regenerate() {
            particles = [];
            if (cssW <= 0 || cssH <= 0) return;
            if (config.mode !== "particles") return;
            const n = Math.max(1, Math.floor(Number(config.density) || 60));
            for (let i = 0; i < n; i++) {
                particles.push({
                    x: rand(0, cssW),
                    y: rand(0, cssH),
                    vx: rand(-0.4, 0.4),
                    vy: rand(-0.3, 0.3),
                    r: rand(1, 3),
                });
            }
        }

        // =================================================================
        //  MODES DE RENDU
        // =================================================================

        // waves : lignes sinusoïdales superposées + clipping par bande.
        // Chaque bande est clipée puis on dessine une courbe dont la couleur
        // suit le cycle (offset de temps par bande → dégradé horizontal).
        function drawWaves(g, w, h, t, cfg) {
            const lines = Math.max(1, Math.floor(Number(cfg.density) || 10));
            const amplitude = Math.min(h / 3, 30 + w * 0.03);
            const base = h / (lines + 1);
            const speed = (cfg.speed || 1) * 0.6;
            g.globalAlpha = cfg.opacity;

            for (let i = 0; i < lines; i++) {
                const bandY = base * (i + 1);
                const phase = (i * 1.7) + t * speed;
                const wave =
                    amplitude * 0.6 * Math.sin(phase + i) +
                    amplitude * 0.4 * Math.sin(phase * 1.6 + i * 0.7);
                const lineY = bandY + wave;
                const bandH = base * 0.8;

                // Couleur du cycle, décalée dans le temps par bande.
                const col = cycleColor(cfg.colors, t * 1000 + i * 260);
                g.strokeStyle = col;
                g.lineWidth = 2;

                // Clipping de la bande horizontale autour de la ligne.
                g.save();
                g.beginPath();
                g.rect(0, clamp(lineY - bandH / 2, 0, h), w, bandH);
                g.clip();
                g.globalAlpha = cfg.opacity * 0.22;
                g.lineWidth = 40;
                g.beginPath();
                for (let x = 0; x <= w; x += 4) {
                    const y =
                        lineY +
                        amplitude * Math.sin((x / w) * Math.PI * 2 * 2 + phase);
                    if (x === 0) g.moveTo(x, y);
                    else g.lineTo(x, y);
                }
                g.stroke();
                g.restore();

                g.globalAlpha = cfg.opacity;
            }
            g.globalAlpha = 1;
        }

        // particles : particules dérivantes + liaisons légères optionnelles.
        function drawParticles(g, w, h, t, cfg) {
            const speed = (cfg.speed || 1) * 0.5;
            const linkDist = Math.max(80, w * 0.22);
            const col = cycleColor(cfg.colors, t * 1000);
            g.globalAlpha = cfg.opacity;

            // Mouvement (intégration, rebond sur les bords).
            for (const p of particles) {
                p.x += p.vx * speed * 0.02;
                p.y += p.vy * speed * 0.02;
                if (p.x < 0 || p.x > w) p.vx = -p.vx;
                if (p.y < 0 || p.y > h) p.vy = -p.vy;
                p.x = clamp(p.x, 0, w);
                p.y = clamp(p.y, 0, h);
            }

            // Liaisons légères entre particules proches (option `links`).
            if (cfg.links !== false) {
                g.lineWidth = 1;
                for (let i = 0; i < particles.length; i++) {
                    for (let j = i + 1; j < particles.length; j++) {
                        const a = particles[i];
                        const b = particles[j];
                        const dx = a.x - b.x;
                        const dy = a.y - b.y;
                        const d = dx * dx + dy * dy;
                        if (d < linkDist * linkDist && d > 0) {
                            const alpha = (1 - Math.sqrt(d) / linkDist) * 0.4 * cfg.opacity;
                            g.strokeStyle = col;
                            g.globalAlpha = alpha;
                            g.beginPath();
                            g.moveTo(a.x, a.y);
                            g.lineTo(b.x, b.y);
                            g.stroke();
                        }
                    }
                }
            }

            g.globalAlpha = cfg.opacity;
            g.fillStyle = col;
            for (const p of particles) {
                g.beginPath();
                g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                g.fill();
            }
            g.globalAlpha = 1;
        }

        // aurora : dégradés organiques flous animés en overlay lumineux.
        function drawAurora(g, w, h, t, cfg) {
            const blobs = Math.max(2, Math.floor(Number(cfg.density) || 4));
            const speed = (cfg.speed || 1) * 0.4;
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, cssW, cssH);
            // Fond sombre très léger pour faire ressortir les lueurs.
            g.fillStyle = "rgba(8,10,18,0.85)";
            g.fillRect(0, 0, w, h);
            g.globalCompositeOperation = "lighter";
            g.globalAlpha = cfg.opacity * 0.7;

            for (let i = 0; i < blobs; i++) {
                const cx = w * (0.2 + ((i * 0.27 + Math.sin(t * speed + i) * 0.18 + 1) % 1) * 0.6);
                const cy = h * (0.2 + ((i * 0.41 + Math.cos(t * speed * 1.3 + i) * 0.2 + 1) % 1) * 0.6);
                const rx = w * (0.3 + 0.25 * Math.sin(t * speed * 0.8 + i * 2));
                const ry = h * (0.25 + 0.2 * Math.cos(t * speed * 1.1 + i));
                const col = cycleColor(cfg.colors, t * 1000 + i * 620);
                const grad = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
                grad.addColorStop(0, col);
                grad.addColorStop(1, "rgba(0,0,0,0)");
                g.fillStyle = grad;
                g.beginPath();
                g.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
                g.fill();
            }
            g.globalCompositeOperation = "source-over";
            g.globalAlpha = 1;
        }

        // ── Rend une frame (t en secondes, référentiel propre) ────────────
        function draw(t) {
            const w = cssW;
            const h = cssH;
            if (w <= 0 || h <= 0) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            switch (config.mode) {
                case "particles":
                    drawParticles(ctx, w, h, t, config);
                    break;
                case "aurora":
                    drawAurora(ctx, w, h, t, config);
                    break;
                case "waves":
                default:
                    drawWaves(ctx, w, h, t, config);
                    break;
            }
        }

        // ── Boucle d'animation ─────────────────────────────────────────────
        function frame(ts) {
            if (shouldRun()) {
                // Référentiel stable : on repart de 0 à chaque (re)prise, sinon
                // la phase saute en cas de pause / visibilitychange.
                if (startT === 0) startT = ts;
                const t = (ts - startT) / 1000 * (config.speed || 1);
                draw(t);
            }
            if (shouldRun()) animId = requestAnimationFrame(frame);
        }

        function shouldRun() {
            if (destroyed) return false;
            if (paused) return false;
            if (reducedMotion) return false;
            if (typeof document !== "undefined" && document.hidden) return false;
            return true;
        }

        function startLoop() {
            if (animId !== null) return;
            animId = requestAnimationFrame(frame);
        }

        function stopLoop() {
            if (animId !== null) {
                cancelAnimationFrame(animId);
                animId = null;
                startT = 0;
            }
        }

        // Pause/resume explicites (l'utilisateur peut forcer malgré tout).
        function pause() {
            paused = true;
            stopLoop();
        }

        function resume() {
            paused = false;
            // Rendu statique ? → une seule frame.
            if (reducedMotion) {
                startT = 0;
                draw(0);
                return;
            }
            startLoop();
        }

        // ── API de l'instance ──────────────────────────────────────────────
        const instance = {
            VERSION,

            getConfig() {
                return { ...config };
            },

            setConfig(partial) {
                const next = normalizeConfig(partial);
                const modeChanged = next.mode !== config.mode;
                config = next;
                if (modeChanged) regenerate();
                // Repart le référentiel pour un rendu propre.
                startT = 0;
                if (!reducedMotion && !paused) {
                    draw(0);
                }
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
                canvas = null;
                particles = [];
            },
        };

        // ── Visibilitychange (pause auto quand l'onglet est caché) ────────
        function onVisibility() {
            if (document.hidden) {
                stopLoop();
            } else if (!paused && !destroyed) {
                if (reducedMotion) {
                    startT = 0;
                    draw(0);
                } else {
                    startLoop();
                }
            }
        }

        // ── prefers-reduced-motion : rendu statique (une frame) ───────────
        try {
            if (typeof window !== "undefined" && window.matchMedia) {
                reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            }
        } catch (e) {
            reducedMotion = false;
        }

        // ── Initialisation ─────────────────────────────────────────────────
        config = normalizeConfig(opts);
        measure();
        resizeBacking();

        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
            document.addEventListener("visibilitychange", onVisibility);
        }

        if (typeof ResizeObserver !== "undefined") {
            ro = new ResizeObserver(() => {
                if (destroyed) return;
                resizeBacking();
                if (!paused && !reducedMotion && document.hidden === false) {
                    startT = 0;
                    if (animId === null) startLoop();
                }
            });
            ro.observe(canvas);
        }

        if (reducedMotion) {
            draw(0); // une seule frame, pas de boucle
        } else {
            startLoop();
        }

        return instance;
    }

    return {
        version: VERSION,
        create,
    };
})();

// Exposition globale (scripts classiques de la page).
if (typeof window !== "undefined") {
    window.HolafAmbient = HolafAmbient;
}

// Export ESM (import { HolafAmbient } from "./holaf-ambient.js").
export { HolafAmbient };
