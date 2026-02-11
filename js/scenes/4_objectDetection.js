// Variables globales
let socket = null;
let hudCanvas = null;
let ctx = null;
let latestDetections = [];

// --- INIT: Arranca el sistema de visión ---
export const init = async (model) => {
    console.log("👁️ [Vision System] Iniciando escena...");

    // 1. Crear HUD (Heads-Up Display)
    hudCanvas = document.getElementById('vision-hud'); // Cambio de nombre de ID
    if (!hudCanvas) {
        hudCanvas = document.createElement('canvas');
        hudCanvas.id = 'vision-hud';
        hudCanvas.style.position = 'absolute';
        hudCanvas.style.top = '0';
        hudCanvas.style.left = '0';
        hudCanvas.style.width = '100%';
        hudCanvas.style.height = '100%';
        hudCanvas.style.pointerEvents = 'none'; 
        hudCanvas.style.zIndex = '1000'; 
        document.body.appendChild(hudCanvas);
    }
    ctx = hudCanvas.getContext('2d');

    const resizeHud = () => {
        hudCanvas.width = window.innerWidth;
        hudCanvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resizeHud);
    resizeHud();

    // 2. Conexión WebSocket
    if (!socket || socket.readyState === WebSocket.CLOSED) {
        // Conecta al nuevo servidor vision_server.py
        socket = new WebSocket('ws://localhost:8000/ws');

        socket.onopen = () => console.log("✅ [Vision System] Conectado al servidor RT-DETR");
        
        socket.onmessage = (event) => {
            try {
                latestDetections = JSON.parse(event.data);
            } catch (e) { console.error("Error parseando datos de visión:", e); }
        };

        socket.onerror = (e) => console.error("❌ [Vision System] Error de conexión:", e);
    }

    // 3. Render Loop
    model.animate(() => {
        if (ctx) ctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
        if (latestDetections.length === 0) return;

        // Ajustar escala (Asumiendo servidor 1280x720)
        const SERVER_WIDTH = 1280;
        const SERVER_HEIGHT = 720;
        const scaleX = hudCanvas.width / SERVER_WIDTH;
        const scaleY = hudCanvas.height / SERVER_HEIGHT;

        latestDetections.forEach(obj => {
            const { label, bbox } = obj;
            const [x1, y1, x2, y2] = bbox;

            const sx = x1 * scaleX;
            const sy = y1 * scaleY;
            const sw = (x2 - x1) * scaleX;
            const sh = (y2 - y1) * scaleY;

            // Estilo visual "Cyberpunk" limpio
            ctx.strokeStyle = '#00FF00';
            ctx.lineWidth = 2;
            ctx.strokeRect(sx, sy, sw, sh);

            ctx.font = 'bold 16px Arial';
            const textW = ctx.measureText(label).width;
            
            ctx.fillStyle = '#00FF00';
            ctx.fillRect(sx, sy - 22, textW + 8, 22);
            
            ctx.fillStyle = 'black';
            ctx.fillText(label.toUpperCase(), sx + 4, sy - 5);
        });
    });
};