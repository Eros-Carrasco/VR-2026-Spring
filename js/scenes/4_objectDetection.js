// Variables globales
let socket = null;
let latestDetections = [];
let hudCanvas = null;
let ctx = null;

// Constantes de tu servidor de Python (captura)
const SERVER_WIDTH = 1280;
const SERVER_HEIGHT = 720;

export const init = async (model) => {
    console.log("👁️ [Vision System] Iniciando HUD con Textura 2D...");

    // 1. Crear el Canvas 2D (Se mantiene oculto, solo sirve para dibujar)
    if (!hudCanvas) {
        hudCanvas = document.createElement('canvas');
        hudCanvas.width = SERVER_WIDTH;
        hudCanvas.height = SERVER_HEIGHT;
        ctx = hudCanvas.getContext('2d');
    }

    // 2. Conexión WebSocket
    if (!socket || socket.readyState === WebSocket.CLOSED) {
        socket = new WebSocket('ws://10.20.85.30:8000/ws');

        socket.onopen = () => console.log("✅ [Vision System] Conectado al servidor");

        socket.onmessage = (event) => {
            try {
                latestDetections = JSON.parse(event.data);
            } catch (e) { console.error("Error parseando datos de visión:", e); }
        };

        socket.onerror = (e) => console.error("❌ [Vision System] Error de conexión:", e);
    }

    // 3. Render Loop (3D)
    model.animate(() => {
        // A. Limpiar el canvas 2D en cada frame
        ctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);

        // B. Dibujar las cajas verdes exactas en el Canvas 2D
        if (latestDetections.length > 0) {
            latestDetections.forEach(obj => {
                const { label, bbox } = obj;
                const [x1, y1, x2, y2] = bbox;

                // Cajas
                ctx.strokeStyle = '#00FF00';
                ctx.lineWidth = 6;
                ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

                // Texto
                ctx.font = 'bold 36px Arial';
                ctx.fillStyle = '#00FF00';
                ctx.fillText(label.toUpperCase(), x1, y1 - 10);
            });
        }

        // C. Limpiar la escena 3D anterior
        while (model.nChildren()) {
            model.remove(0);
        }

        // D. Crear UN SOLO plano 3D y pegarle el canvas como textura
        if (latestDetections.length > 0) {
            model.add('square')
                .move(0, 0, -1.5)     // Centrado frente a tu vista, a 1.5 metros
                .scale(1.6, 0.9, 0)   // Proporción 16:9 (igual que 1280x720)
                .texture(hudCanvas)   // <-- Posible ajuste de sintaxis aquí
                .opacity(0.9);
        }
    });
};