const { spawn, exec } = require('child_process');

// Colores para que la terminal se vea pro
const COL_PYTHON = '\x1b[36m'; // Cyan
const COL_WEB = '\x1b[32m';    // Verde
const COL_RESET = '\x1b[0m';

console.log("🚀 Iniciando Sistema VR Completo...");

// --- 1. ARRANCAR PYTHON (VISION) ---
// Entra a la carpeta 'python' y corre uvicorn
const pythonProcess = spawn('uvicorn', ['vision_server:app', '--host', '0.0.0.0', '--port', '8000'], {
    cwd: './python', 
    shell: true
});

pythonProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg.includes("Application startup complete")) {
        console.log(`${COL_PYTHON}[IA VISION] ✅ Cerebro cargado y listo.${COL_RESET}`);
    } else if (msg.includes("ERROR")) {
        console.log(`${COL_PYTHON}[IA VISION] ${msg}${COL_RESET}`);
    }
});

pythonProcess.stderr.on('data', (data) => {
    console.error(`${COL_PYTHON}[IA ERROR] ${data}${COL_RESET}`);
});

// --- 2. ARRANCAR SERVIDOR WEB ---
const webProcess = spawn('./startserver', [], {
    shell: true
});

webProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    // Cuando el servidor web diga que está listo...
    if (msg.includes("Listening")) {
        console.log(`${COL_WEB}[WEB SERVER] ✅ Servidor web corriendo.${COL_RESET}`);
        
        // --- 3. ABRIR CHROME AUTOMÁTICAMENTE ---
        console.log("🌍 Abriendo navegador...");
        exec('open "http://localhost:2026"'); 
    }
});

webProcess.stderr.on('data', (data) => {
    console.error(`${COL_WEB}[WEB ERROR] ${data}${COL_RESET}`);
});

// --- 4. LIMPIEZA AL SALIR ---
process.on('SIGINT', () => {
    console.log("\n🛑 Apagando motores...");
    pythonProcess.kill();
    webProcess.kill();
    process.exit();
});